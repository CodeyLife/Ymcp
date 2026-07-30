import { describe, expect, it } from "vitest";
import { classifyFactCandidates, classifyFactRisk } from "../fact-extraction/classify";
import {
  dedupeFactCandidates,
  evidenceFingerprint,
  factFingerprint,
  humanReadableFingerprint,
} from "../fact-extraction/dedupe";
import { extractFactsFromText, extractFactsWithStats, computeClaimContentHash } from "../fact-extraction";
import { InMemoryModelGateway } from "../model-gateway";
import type { Artifact, MemoryClaim } from "../protocol";
import type { ChapterStateDelta, FactExtractionOutput } from "../prompts/schemas";

const artifact: Artifact = { id: "artifact-1", projectId: "p1", taskId: "task-1", attemptId: "attempt-1", kind: "draft", contentHash: "hash", objectKey: "obj", baseRevision: 7, createdAt: 1, fingerprint: "fp-1" };

function fact(overrides: Partial<FactExtractionOutput["facts"][number]> = {}): FactExtractionOutput["facts"][number] {
  return {
    subject: { kind: "entity", id: "hero" },
    predicate: "持有",
    object: { kind: "entity-ref", value: "sword-1" },
    polarity: "affirmed",
    truthStatus: "objective",
    humanReadable: "主角持有古剑承影",
    evidence: "他从匣中取出承影，剑身冷光一闪。",
    paragraph: 1,
    confidence: 0.9,
    novelty: "new",
    conflict: false,
    ...overrides,
  };
}

describe("fact-extraction dedupe fingerprints", () => {
  it("factFingerprint normalizes object values of any type", () => {
    const a = factFingerprint(fact({ object: { kind: "string", value: "x" } }));
    const b = factFingerprint(fact({ object: { kind: "string", value: "x" } }));
    expect(a).toBe(b);

    const c = factFingerprint(fact({ object: { kind: "json", value: { k: 1 } } }));
    expect(c).not.toBe(a);
    expect(c).toContain("json");
  });

  it("evidenceFingerprint strips punctuation and lowercases", () => {
    expect(evidenceFingerprint("他，从匣中。取出！")).toBe(evidenceFingerprint("他从匣中取出"));
    expect(evidenceFingerprint("Hello World")).toBe("helloworld");
  });

  it("humanReadableFingerprint truncates to 32 chars after normalization", () => {
    const long = "A".repeat(64);
    const fp = humanReadableFingerprint(long);
    expect(fp).toHaveLength(32);
    expect(fp).toBe(humanReadableFingerprint(`${long}更多内容`));
  });
});

describe("fact-extraction dedupeFactCandidates covers 11 failure classes", () => {
  it("drops low-confidence facts (L6)", () => {
    const result = dedupeFactCandidates({ candidates: [fact({ confidence: 0.4 })] });
    expect(result.kept).toHaveLength(0);
    expect(result.discardedLowConfidenceCount).toBe(1);
  });

  it("drops facts with evidence shorter than 8 chars (L7)", () => {
    const result = dedupeFactCandidates({ candidates: [fact({ evidence: "短" })] });
    expect(result.kept).toHaveLength(0);
    expect(result.discardedShortEvidenceCount).toBe(1);
  });

  it("drops facts with pronoun or empty subject id (L8)", () => {
    const result = dedupeFactCandidates({ candidates: [fact({ subject: { kind: "entity", id: "主角" } }), fact({ subject: { kind: "entity", id: "" } })] });
    expect(result.kept).toHaveLength(0);
    expect(result.discardedInvalidSubjectCount).toBe(2);
  });

  it("drops facts with empty object value (L9)", () => {
    const result = dedupeFactCandidates({ candidates: [fact({ object: { kind: "string", value: "" } }), fact({ object: { kind: "string", value: null as unknown as string } })] });
    expect(result.kept).toHaveLength(0);
    expect(result.discardedInvalidObjectCount).toBe(2);
  });

  it("drops duplicates by humanReadable fingerprint (L1)", () => {
    const a = fact({ humanReadable: "主角持有古剑承影" });
    const b = fact({ humanReadable: "主角 持有 古剑 承影！" });
    const result = dedupeFactCandidates({ candidates: [a, b] });
    expect(result.kept).toHaveLength(1);
    expect(result.discardedDuplicateCount).toBe(1);
  });

  it("drops duplicates by subject+predicate+object fingerprint (L2/L3)", () => {
    const a = fact({ humanReadable: "陈述一" });
    const b = fact({ humanReadable: "陈述二", evidence: "另外一段足够长的证据文本。" });
    const result = dedupeFactCandidates({ candidates: [a, b] });
    expect(result.kept).toHaveLength(1);
    expect(result.discardedDuplicateCount).toBe(1);
  });

  it("drops duplicates by evidence fingerprint (L4)", () => {
    const a = fact({ humanReadable: "陈述一" });
    const b = fact({ humanReadable: "陈述二", subject: { kind: "entity", id: "mentor" }, object: { kind: "string", value: "另一物" }, evidence: "他从匣中取出承影，剑身冷光一闪。" });
    const result = dedupeFactCandidates({ candidates: [a, b] });
    expect(result.kept).toHaveLength(1);
    expect(result.discardedDuplicateCount).toBe(1);
  });

  it("drops facts whose content hash already exists in the store (L11)", () => {
    const candidate = fact();
    const existingHash = evidenceFingerprint(`${candidate.subject.id}:${candidate.predicate}:${candidate.humanReadable}`);
    const result = dedupeFactCandidates({ candidates: [candidate], existingContentHashes: new Set([existingHash]) });
    expect(result.kept).toHaveLength(0);
    expect(result.discardedExistingHashCount).toBe(1);
  });

  it("reports totalCandidates across mixed accept/discard outcomes", () => {
    const result = dedupeFactCandidates({
      candidates: [
        fact(),
        fact({ confidence: 0.3 }),
        fact({ humanReadable: "重复的陈述" }),
        fact({ humanReadable: "重复的陈述", evidence: "另外一段足够长的证据文本。" }),
      ],
    });
    expect(result.totalCandidates).toBe(4);
    expect(result.kept.length + result.discardedLowConfidenceCount + result.discardedDuplicateCount).toBe(4);
  });
});

describe("fact-extraction classifyFactRisk maps to risk tiers", () => {
  it("marks conflict=true facts as high risk", () => {
    const { risk, riskReason, claim } = classifyFactRisk({ fact: fact({ conflict: true }), projectId: "p1", artifactId: artifact.id, baseRevision: 1 });
    expect(risk).toBe("high");
    expect(riskReason).toContain("冲突");
    expect(claim.authority).toBe("candidate");
  });

  it("marks non-objective truthStatus as high risk", () => {
    const { risk } = classifyFactRisk({ fact: fact({ truthStatus: "claim" }), projectId: "p1", artifactId: artifact.id, baseRevision: 1 });
    expect(risk).toBe("high");
  });

  it("marks novelty=update as medium risk", () => {
    const { risk, claim } = classifyFactRisk({ fact: fact({ novelty: "update", truthStatus: "objective" }), projectId: "p1", artifactId: artifact.id, baseRevision: 1, existingClaimIndex: new Map([["hero|持有", ["claim-old-location"]]]) });
    expect(risk).toBe("medium");
    expect(claim.authority).toBe("candidate");
    expect(claim.predicate).toBe("持有");
    expect(claim.supersedes).toEqual(["claim-old-location"]);
  });

  it("marks objective affirmed new facts as low risk with derived authority", () => {
    const { risk, claim } = classifyFactRisk({ fact: fact(), projectId: "p1", artifactId: artifact.id, baseRevision: 1 });
    expect(risk).toBe("low");
    expect(claim.authority).toBe("derived");
  });

  it("classifies hierarchical memory when humanReadable matches longform patterns", () => {
    const { claim } = classifyFactRisk({
      fact: fact({ humanReadable: "主角与师父约定三年后归来" }),
      projectId: "p1",
      artifactId: artifact.id,
      baseRevision: 1,
    });
    expect(claim.kind).toBe("hierarchical");
  });

  it("classifies episodic memory for ordinary factual statements", () => {
    const { claim } = classifyFactRisk({
      fact: fact({ humanReadable: "主角走进客栈要了一壶酒" }),
      projectId: "p1",
      artifactId: artifact.id,
      baseRevision: 1,
    });
    expect(claim.kind).toBe("episodic");
  });

  it("classifyFactCandidates projects a stable MemoryClaim list", () => {
    const classified = classifyFactCandidates({
      facts: [fact(), fact({ subject: { kind: "entity", id: "mentor" }, humanReadable: "师父交还信物", evidence: "师父把玉佩放回桌上，未发一言。" })],
      projectId: "p1",
      artifactId: artifact.id,
      baseRevision: 1,
    });
    expect(classified).toHaveLength(2);
    expect(classified[0].claim.projectId).toBe("p1");
    expect(classified[0].claim.subjectRefs).toContain("hero");
    expect(classified[1].claim.subjectRefs).toContain("mentor");
  });
});

describe("fact-extraction extractFactsWithStats orchestration", () => {
  it("returns chapter memory and character deltas from the same extraction", async () => {
    const output: ChapterStateDelta = {
      summary: "统一提取",
      facts: [fact()],
      chapterMemory: {
        summary: "本章围绕一次受阻的会面展开，双方通过选择与行动确认了当前关系边界，并留下下一阶段仍需处理的冲突。".repeat(2),
        keyEvents: ["双方完成会面"],
        characterStates: [{ characterId: "hero", stateSnapshot: "决定继续追查" }],
        unresolvedThreads: ["信物来源"],
        emotionalArc: "戒备转为有限信任",
      },
      characterDeltas: [{ characterId: "hero", voiceAnchor: { sentenceLength: "短句", vocabulary: "克制", directness: "间接", avoidance: "回避承诺" }, motivationDelta: "继续追查信物", newKnowledge: [], relationDeltas: [] }],
    };
    const result = await extractFactsWithStats({ projectId: "p1", artifact, text: "正文略。", model: new InMemoryModelGateway(() => output) });
    expect(result.chapterMemory?.keyEvents).toEqual(["双方完成会面"]);
    expect(result.characterDeltas?.[0].characterId).toBe("hero");
  });

  it("returns claims and stats end-to-end through the model gateway", async () => {
    const output: FactExtractionOutput = {
      summary: "提取到 2 条事实",
      facts: [
        fact(),
        fact({ subject: { kind: "entity", id: "mentor" }, humanReadable: "师父交还信物", evidence: "师父把玉佩放回桌上，未发一言。" }),
        fact({ confidence: 0.3 }), // 被 L6 丢弃
        fact({ humanReadable: "主角持有古剑承影" }), // 被 L1 丢弃
      ],
    };
    const model = new InMemoryModelGateway(() => output);
    const result = await extractFactsWithStats({
      projectId: "p1",
      artifact,
      text: "正文略。",
      model,
    });
    expect(result.claims).toHaveLength(2);
    expect(result.stats.totalCandidates).toBe(4);
    expect(result.stats.kept).toBe(2);
    expect(result.stats.discardedLowConfidence).toBe(1);
    expect(result.stats.discardedDuplicate).toBe(1);
  });

  it("returns an empty claim list when the model produces nothing", async () => {
    const model = new InMemoryModelGateway(() => ({ summary: "无事实", facts: [] }));
    const result = await extractFactsFromText({ projectId: "p1", artifact, text: "正文略。", model });
    expect(result).toEqual([] satisfies MemoryClaim[]);
  });

  it("rejects model output that fails schema validation", async () => {
    const model = new InMemoryModelGateway(() => ({ summary: "缺字段" }));
    await expect(extractFactsWithStats({ projectId: "p1", artifact, text: "x", model })).rejects.toThrow(/InMemoryModelGateway structured|facts/);
  });

  it("computeClaimContentHash is stable across calls with the same claim", () => {
    const claim: MemoryClaim = {
      id: "claim-1",
      projectId: "p1",
      kind: "episodic",
      title: "t",
      content: "c",
      subjectRefs: ["hero"],
      knowledgeScope: "author",
      authority: "derived",
      confidence: 0.9,
      sourceRevisionIds: [],
      contentHash: "x",
      supersedes: [],
    };
    expect(computeClaimContentHash(claim)).toBe(computeClaimContentHash(claim));
    expect(computeClaimContentHash({ ...claim, subjectRefs: ["mentor"] })).not.toBe(computeClaimContentHash(claim));
  });
});
