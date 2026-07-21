import { beforeEach, describe, expect, it } from "vitest";
import Ajv from "ajv";

import { addEntity, createChapter, createNovelProject, novelDb, recordBase, saveApprovedDocumentRevision } from "../db";
import { commitAcceptedFacts, setFactCandidateStatus, storeFactCandidates } from "../facts";
import { factSchema } from "../workflow-shared";

beforeEach(async () => {
  await novelDb.delete();
  await novelDb.open();
  localStorage.clear();
});

describe("approved manuscript provenance", () => {
  it("creates an immutable approved revision and links the current document", async () => {
    const project = await createNovelProject({ title: "修订来源", genre: ["悬疑"], premise: "每个事实都能回到正文。" });
    const chapter = await createChapter(project.id, "第一章");
    const first = await saveApprovedDocumentRevision({ ...chapter, plainText: "雨停了。", contentHtml: "<p>雨停了。</p>", wordCount: 4, status: "review" }, "第一次批准", "ai");
    const assertion = {
      ...recordBase(project.id),
      id: "fact-first-revision",
      subject: { kind: "project" as const, id: project.id },
      predicate: "weather.raining",
      object: { kind: "boolean" as const, value: false },
      polarity: "affirmed" as const,
      truthStatus: "objective" as const,
      timeMode: "point" as const,
      sourceRevisionId: first.revision.id,
      provenance: "approved-revision" as const,
      evidence: "雨停了。",
      confidence: 1,
      humanReadable: "雨已经停了",
      status: "active" as const,
      derivedFromCandidateId: "candidate-first-revision",
    };
    await novelDb.factAssertions.add(assertion);
    await novelDb.knowledgeAssertions.add({
      ...recordBase(project.id),
      id: "knowledge-first-revision",
      characterId: "character-1",
      factAssertionId: assertion.id,
      stance: "known",
      sourceRevisionId: first.revision.id,
      status: "active",
    });
    const second = await saveApprovedDocumentRevision({ ...first.document, plainText: "雨停后，陆沉去了北港。", contentHtml: "<p>雨停后，陆沉去了北港。</p>", wordCount: 11 }, "第二次批准", "manual");

    expect(second.revision.parentRevisionId).toBe(first.revision.id);
    expect((await novelDb.revisions.get(first.revision.id))?.approvalStatus).toBe("superseded");
    expect((await novelDb.revisions.get(second.revision.id))?.approvalStatus).toBe("approved");
    expect((await novelDb.documents.get(chapter.id))?.approvedRevisionId).toBe(second.revision.id);
    expect((await novelDb.factAssertions.get(assertion.id))?.status).toBe("stale");
    expect((await novelDb.knowledgeAssertions.get("knowledge-first-revision"))?.status).toBe("stale");
  });
});

describe("formal fact assertion ledger", () => {
  it("requires domain semantics in structured extractor output", () => {
    const validate = new Ajv({ strict: false }).compile(factSchema);
    const fact = {
      targetTable: "entities", targetId: "character-1", field: "character.state.location", after: "北港",
      subject: { kind: "entity", id: "character-1" }, predicate: "character.located_at", object: { kind: "string", value: "北港" },
      polarity: "affirmed", truthStatus: "objective", timeMode: "point", humanReadable: "陆沉抵达北港",
      evidence: "陆沉抵达北港。", confidence: 0.99, novelty: "update", conflict: false,
    };
    expect(validate({ summary: "位置变化", facts: [fact] })).toBe(true);
    expect(validate({ summary: "旧补丁", facts: [{ targetTable: "entities", field: "summary", after: "北港", evidence: "证据", confidence: 1, novelty: "update", conflict: false }] })).toBe(false);
  });

  it("writes one idempotent assertion alongside the legacy state projection", async () => {
    const project = await createNovelProject({ title: "事实账本", genre: ["都市"], premise: "状态变化保留证据。" });
    const character = await addEntity(project.id, "character", "陆沉");
    const chapter = await createChapter(project.id, "第一章");
    const approved = await saveApprovedDocumentRevision({ ...chapter, plainText: "陆沉抵达北港。", contentHtml: "<p>陆沉抵达北港。</p>", wordCount: 7, status: "review" }, "批准正文", "ai");
    const run = { ...recordBase(project.id), workflowId: "standard-chapter-v2", targetDocumentId: chapter.id, status: "running" as const, currentStage: "commit" as const, stageIndex: 10, revisionIteration: 0, factCandidateIds: [], startedAt: Date.now() };
    await novelDb.workflowRuns.add(run);
    const [candidate] = await storeFactCandidates({
      projectId: project.id,
      workflowRunId: run.id,
      sourceArtifactId: "draft-artifact",
      sourceRevisionId: approved.revision.id,
      defaultRevealedAt: { chapterId: chapter.id, narrativeOrder: chapter.order, precision: "exact" },
      facts: [{
        targetTable: "entities", targetId: character.id, field: "character.state.location", before: "", after: "北港",
        subject: { kind: "entity", id: character.id }, predicate: "character.located_at", object: { kind: "entity-ref", value: "北港" },
        polarity: "affirmed", truthStatus: "objective", timeMode: "point", validFrom: { chapterId: chapter.id, narrativeOrder: chapter.order, precision: "exact" },
        humanReadable: "陆沉抵达北港", knowledgeDeltas: [{ characterId: character.id, stance: "known", learnedAt: { chapterId: chapter.id, narrativeOrder: chapter.order, precision: "exact" } }],
        evidence: "陆沉抵达北港。", confidence: 0.99, novelty: "update", conflict: false,
      }],
    });
    await setFactCandidateStatus(candidate.id, "accepted");

    expect((await commitAcceptedFacts(project.id, run.id)).committedCandidateIds).toEqual([candidate.id]);
    expect((await commitAcceptedFacts(project.id, run.id)).committedCandidateIds).toEqual([]);

    const assertion = await novelDb.factAssertions.where("derivedFromCandidateId").equals(candidate.id).first();
    expect(assertion).toMatchObject({
      subject: { kind: "entity", id: character.id },
      predicate: "character.located_at",
      object: { kind: "entity-ref", value: "北港" },
      timeMode: "point",
      revealedAt: { chapterId: chapter.id, narrativeOrder: chapter.order, precision: "exact" },
      sourceRevisionId: approved.revision.id,
      provenance: "approved-revision",
      status: "active",
    });
    expect(await novelDb.knowledgeAssertions.where("factAssertionId").equals(assertion!.id).first()).toMatchObject({ characterId: character.id, stance: "known", sourceRevisionId: approved.revision.id, status: "active" });
    expect((await novelDb.entities.get(character.id))?.character?.state.location).toBe("北港");
  });
});
