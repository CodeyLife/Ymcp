import { describe, expect, it } from "vitest";
import { assessRuntimeLearningWithModel, parseRuntimeLearningAssessmentV2 } from "../learning-assessment";
import type { Artifact, Review } from "../protocol";
import type { ModelGateway, ModelUsage } from "../model-gateway";
import type { ModelExecutionProvenance, ModelRoutingSnapshot } from "../model-routing";

const usage: ModelUsage = { model: "test", inputTokens: 1, outputTokens: 1, costUsd: 0, latencyMs: 1 };
const mockProvenance: ModelExecutionProvenance = {
  routeSnapshotId: "test-snapshot",
  purpose: "learning.assess",
  candidateIndex: 0,
  executor: "api",
  model: "test",
  promptFingerprint: "test-fingerprint",
};
const mockRoutingSnapshot: ModelRoutingSnapshot = {
  id: "test-snapshot",
  configVersion: 1,
  profiles: [],
  routes: {},
  createdAt: 0,
};
const artifact: Artifact = { id: "artifact-1", projectId: "p1", taskId: "task-1", attemptId: "attempt-1", kind: "draft", contentHash: "hash", objectKey: "obj", baseRevision: 0, createdAt: 1, fingerprint: "fp-1" };
const blockingReview: Review = { id: "review-1", projectId: "p1", artifactId: artifact.id, reviewerId: "internal", identity: "internal", verdict: "blocked", issues: [{ severity: "blocker", title: "视角越界", evidence: "章节写出 POV 角色无法知道的幕后真相。" }], createdAt: 2, artifactFingerprint: artifact.fingerprint };

function base() {
  return { projectId: "p1", source: { workflowId: "wf-1", artifactId: artifact.id, reviewIds: ["review-1"], fingerprint: artifact.fingerprint }, createdAt: 3 };
}

describe("V2 runtime learning assessment", () => {
  it("requires mechanism and affected input class before proposing an improvement", () => {
    expect(() => parseRuntimeLearningAssessmentV2({
      conclusion: "propose-improvement",
      symptom: "视角越界",
      failingLayer: "review",
      affectedInputClass: "限知视角章节",
      boundaries: "仅限 POV 知识边界",
      regressionRisks: ["可能误伤全知叙事"],
      candidate: { targetKind: "skill", targetId: "pov", rationale: "补足规则", afterText: "x".repeat(120) },
    }, base())).toThrow(/underlyingMechanism/);
  });

  it("does not hardcode propose-improvement when the model gateway is unavailable", async () => {
    const { assessment, validationError } = await assessRuntimeLearningWithModel({ projectId: "p1", workflowId: "wf-1", artifact, reviews: [blockingReview], now: 4 });
    expect(assessment.conclusion).toBe("no-shared-learning");
    expect(assessment.symptom).toContain("视角越界");
    expect(validationError).toContain("模型网关未配置");
  });

  it("uses model output only after parser validation succeeds", async () => {
    const model: ModelGateway = {
      getRoutingSnapshot: () => mockRoutingSnapshot,
      generateStructured: async <T,>() => ({ value: {
        conclusion: "propose-improvement",
        symptom: "限知视角章节泄漏幕后真相",
        failingLayer: "review",
        underlyingMechanism: "审核规则只要求发现视角越界，但 drafting skill 没有把 POV 角色知识边界转化为写作前自检与替换决策，导致长篇章节在铺陈反派行动时绕过了冻结记忆的角色可知范围。",
        affectedInputClass: "采用限知 POV 且存在作者已知但角色未知事实的章节正文",
        boundaries: "仅覆盖限知 POV 的知识边界；全知叙事、插叙旁白或已明确授权的戏剧反讽不适用。",
        regressionRisks: ["可能让合法的悬念铺垫过度保守"],
        candidate: {
          targetKind: "skill",
          targetId: "pov-boundary",
          rationale: "把审校机制前移到 drafting 自检",
          afterText: "通用原则：生成限知视角章节时，先列出 POV 角色在当前叙事截止点已经亲历、听闻或可合理推断的信息，再写正文。决策规则：凡是只存在于作者全局记忆、反派私下行动或未来章节的事实，除非通过可观察痕迹被 POV 角色感知，否则不得直接进入叙述、心理判断或解释性旁白。验证方式：完成草稿后逐段检查信息来源，无法标注来源的句子必须改写为可观察现象、角色误判或暂时留白。",
        },
      } as T, usage, provenance: mockProvenance }),
      generateText: async () => ({ value: "", text: "", usage, provenance: mockProvenance }),
      embed: async () => ({ value: [], vectors: [], usage, provenance: mockProvenance }),
      rerank: async () => ({ value: [], scores: [], usage, provenance: mockProvenance }),
    };
    const { assessment } = await assessRuntimeLearningWithModel({ projectId: "p1", workflowId: "wf-1", artifact, reviews: [blockingReview], model, now: 5 });
    expect(assessment).toMatchObject({
      conclusion: "propose-improvement",
      underlyingMechanism: expect.stringContaining("POV"),
      affectedInputClass: expect.stringContaining("限知 POV"),
      candidate: { targetKind: "skill", targetId: "pov-boundary" },
    });
  });

  it("falls back to no-shared-learning when model output fails validation", async () => {
    const model: ModelGateway = {
      getRoutingSnapshot: () => mockRoutingSnapshot,
      generateStructured: async <T,>() => ({ value: { conclusion: "propose-improvement", symptom: "视角越界" } as T, usage, provenance: mockProvenance }),
      generateText: async () => ({ value: "", text: "", usage, provenance: mockProvenance }),
      embed: async () => ({ value: [], vectors: [], usage, provenance: mockProvenance }),
      rerank: async () => ({ value: [], scores: [], usage, provenance: mockProvenance }),
    };
    const { assessment, validationError } = await assessRuntimeLearningWithModel({ projectId: "p1", workflowId: "wf-1", artifact, reviews: [blockingReview], model, now: 6 });
    expect(assessment.conclusion).toBe("no-shared-learning");
    expect(validationError).toContain("underlyingMechanism");
  });
});
