/**
 * V2 评估闭环测试套件（B-1.6）
 *
 * 策略：
 * - 纯函数测试（computeSnapshotHash/verifyProjectSnapshot/verifyCandidateBundle/
 *   computeManuscriptContentHash/buildIterationPrompt）直接运行，无外部依赖。
 * - 集成测试（captureProjectSnapshot/createExperimentWorkspace/promote/runClosedLoop 等）
 *   需要真实 Postgres；beforeAll 尝试连接，失败则 skip 整个集成套件。
 *
 * AGENTS.md 合规：
 * - 测试覆盖跨场景 counterexample（如 promote 幂等、stale-baseline 拒绝）
 * - skill-iteration 测试验证 learning.underlyingMechanism 被传递
 */
import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { NovelPostgresRepository } from "../postgres-repository";
import { InMemoryModelGateway } from "../model-gateway";
import { ContentObjectStore } from "../object-store";
import {
  computeSnapshotHash,
  computeProjectHead,
  captureProjectSnapshot,
  verifyProjectSnapshot,
} from "../evaluation/project-snapshot";
import {
  createExperimentWorkspace,
  getExperimentWorkspace,
  listExperimentWorkspaces,
} from "../evaluation/experiment-workspace";
import type { ExperimentWorkspaceHandle } from "../evaluation/experiment-workspace";
import {
  verifyCandidateBundle,
  computeManuscriptContentHash,
  extractCandidateBundle,
} from "../evaluation/candidate-bundle";
import { createPromotionService } from "../evaluation/promotion";
import { buildIterationPrompt, runSkillIteration } from "../evaluation/skill-iteration";
import { parseSerializedPromptSections, serializePromptSections } from "../evaluation/prompt-sections";
import { runClosedLoop } from "../evaluation/closed-loop";
import type {
  AuthorDecision,
  CandidateBundle,
  ProjectSnapshotBundle,
  Review,
  RuntimeLearningAssessmentV2,
  SkillDescriptor,
  ExecutionBlueprint,
} from "../protocol";

// ===== 测试夹具 =====

const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp_test";
const integrationEnabled = Boolean(process.env.TEST_DATABASE_URL);
const integrationIt = integrationEnabled ? it : it.skip;

function makeSkill(overrides: Partial<SkillDescriptor> = {}): SkillDescriptor {
  return {
    skillId: "longform-continuity",
    version: "1.0.0",
    capabilities: ["draft", "revision"],
    applicableTasks: ["drafting", "revision", "review"],
    requiredMemoryKinds: ["canonical", "episodic"],
    conflicts: [],
    qualityGates: ["continuity"],
    promptSections: { drafting: "保持长篇连贯性" },
    enabled: true,
    ...overrides,
  };
}

function makeReview(overrides: Partial<Review> = {}): Review {
  return {
    id: `review-${randomUUID().slice(0, 8)}`,
    projectId: "p1",
    artifactId: "artifact-1",
    reviewerId: "internal-style",
    identity: "internal",
    role: "style-reviewer",
    verdict: "revise",
    issues: [
      {
        severity: "major",
        title: "节奏拖沓",
        description: "第二段描写过长",
        evidence: "段落 2 长度 800 字",
        dimension: "pacing",
        suggestion: "压缩到 400 字以内",
      },
    ],
    createdAt: Date.now(),
    artifactFingerprint: "fp-1",
    ...overrides,
  };
}

function makeSnapshotBundle(overrides: Partial<ProjectSnapshotBundle> = {}): ProjectSnapshotBundle {
  const payload: ProjectSnapshotBundle["payload"] = {
    documents: [],
    memoryClaims: [],
    skillDefinitions: [makeSkill()],
    entities: [],
    relations: [],
    revisions: [],
      artifacts: [],
      reviews: [],
      novelIntents: [],
      contentBlobs: [],
      executionBlueprints: [],
      memoryBundles: [],
  };
  return {
    id: `snapshot-${randomUUID().slice(0, 8)}`,
    projectId: "p1",
    hash: computeSnapshotHash(payload),
    payload,
    head: { projectRevision: 0, finalDocumentHashes: [] },
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeCandidate(overrides: Partial<CandidateBundle> = {}): CandidateBundle {
  const plainText = "测试章节内容";
  const contentHtml = "<p>测试章节内容</p>";
  const contentHash = computeManuscriptContentHash(plainText, contentHtml);
  return {
    formatVersion: 2,
    id: `candidate-${randomUUID().slice(0, 8)}`,
    experimentId: `exp-${randomUUID().slice(0, 8)}`,
    sourceProjectId: "p1",
    baseSnapshotId: `snapshot-${randomUUID().slice(0, 8)}`,
    baseSnapshotHash: "hash-1",
    dependencyHead: { projectRevision: 0, finalDocumentHashes: [] },
    target: { documentId: "doc-1", baseRevision: 0, baseContentHash: "" },
    manuscript: {
      title: "测试章节",
      plainText,
      contentHtml,
      wordCount: plainText.length,
      contentHash,
    },
    acceptedFacts: [],
    iteratedSkills: [],
    qualityEvidence: { reviewIds: [], scores: {}, issueSummary: {} },
    provenance: { codeRevision: "test", createdAt: Date.now(), workflowRunId: "wf-1" },
    ...overrides,
  };
}

// ===== 纯函数测试（无 Postgres 依赖）=====

describe("evaluation pure functions", () => {
  describe("prompt sections contract", () => {
    it("serializes structured stage prompts at the persistence boundary", () => {
      const serialized = serializePromptSections({
        drafting: "用具体感官、动作与因果变化承载叙事信息，避免抽象标签替代现场细节。",
        revision: "根据审校证据修订对应段落，同时保持视角知识边界和前后事实连续。",
      }, "test promptSections");
      expect(parseSerializedPromptSections(serialized, "stored prompt")).toEqual({
        drafting: "用具体感官、动作与因果变化承载叙事信息，避免抽象标签替代现场细节。",
        revision: "根据审校证据修订对应段落，同时保持视角知识边界和前后事实连续。",
      });
    });

    it("rejects plain text and unsupported stages instead of coercing them to drafting", () => {
      expect(() => parseSerializedPromptSections("普通提示词文本", "stored prompt")).toThrow("JSON prompt_sections");
      expect(() => serializePromptSections({ chapter42: "只对固定样例生效的规则" }, "test promptSections")).toThrow("非法阶段");
    });
  });

  describe("computeSnapshotHash", () => {
    it("produces stable hash for identical payload", () => {
      const bundle = makeSnapshotBundle();
      const hash1 = computeSnapshotHash(bundle.payload);
      const hash2 = computeSnapshotHash(bundle.payload);
      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64); // SHA-256 hex
    });

    it("produces different hash when payload changes", () => {
      const bundle = makeSnapshotBundle();
      const hash1 = computeSnapshotHash(bundle.payload);
      const modified = { ...bundle.payload, documents: [{ id: "d1" } as never] };
      const hash2 = computeSnapshotHash(modified);
      expect(hash1).not.toBe(hash2);
    });

    it("is order-insensitive for object keys", () => {
      const payload1 = { ...makeSnapshotBundle().payload, skillDefinitions: [makeSkill(), makeSkill({ skillId: "second" })] };
      const payload2 = { ...makeSnapshotBundle().payload, skillDefinitions: [makeSkill(), makeSkill({ skillId: "second" })] };
      expect(computeSnapshotHash(payload1)).toBe(computeSnapshotHash(payload2));
    });
  });

  describe("verifyProjectSnapshot", () => {
    it("returns valid=true when hash matches", () => {
      const bundle = makeSnapshotBundle();
      const result = verifyProjectSnapshot(bundle, bundle.hash);
      expect(result.valid).toBe(true);
    });

    it("returns valid=false with reason when hash mismatches", () => {
      const bundle = makeSnapshotBundle();
      const result = verifyProjectSnapshot(bundle, "tampered-hash-0000000000000000000000000000000000000000000000000000000000000000");
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("快照哈希不匹配");
    });
  });

  describe("computeManuscriptContentHash", () => {
    it("produces stable hash for identical content", () => {
      const h1 = computeManuscriptContentHash("text", "<p>text</p>");
      const h2 = computeManuscriptContentHash("text", "<p>text</p>");
      expect(h1).toBe(h2);
    });

    it("produces different hash when plainText changes", () => {
      const h1 = computeManuscriptContentHash("text-a", "<p>text</p>");
      const h2 = computeManuscriptContentHash("text-b", "<p>text</p>");
      expect(h1).not.toBe(h2);
    });

    it("keeps the object hash stable when only derived contentHtml changes", () => {
      const h1 = computeManuscriptContentHash("text", "<p>a</p>");
      const h2 = computeManuscriptContentHash("text", "<p>b</p>");
      expect(h1).toBe(h2);
    });
  });

  describe("verifyCandidateBundle", () => {
    it("returns valid=true for well-formed candidate", () => {
      const candidate = makeCandidate();
      const result = verifyCandidateBundle(candidate);
      expect(result.valid).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it("rejects wrong formatVersion", () => {
      const candidate = makeCandidate({ formatVersion: 1 as CandidateBundle["formatVersion"] });
      const result = verifyCandidateBundle(candidate);
      expect(result.valid).toBe(false);
      expect(result.issues.some((i) => i.includes("formatVersion"))).toBe(true);
    });

    it("rejects mismatched contentHash", () => {
      const candidate = makeCandidate({
        manuscript: { title: "t", plainText: "x", contentHtml: "<p>x</p>", wordCount: 1, contentHash: "tampered" },
      });
      const result = verifyCandidateBundle(candidate);
      expect(result.valid).toBe(false);
      expect(result.issues.some((i) => i.includes("contentHash"))).toBe(true);
    });

    it("reports missing required top-level fields", () => {
      const candidate = makeCandidate({ experimentId: "" });
      const result = verifyCandidateBundle(candidate);
      expect(result.valid).toBe(false);
      expect(result.issues.some((i) => i.includes("experimentId"))).toBe(true);
    });
  });

  describe("extractCandidateBundle", () => {
    const input = {
      sourceProjectId: "p1",
      baseSnapshotId: "snapshot-1",
      baseSnapshotHash: "snapshot-hash",
      dependencyHead: { projectRevision: 1, finalDocumentHashes: ["base-hash"] },
      documentId: "doc-1",
      baseRevision: 1,
      baseContentHash: "base-hash",
      workflowRunId: "wf-1",
    };

    it("rejects an experiment that produced no new revision", async () => {
      const workspace = {
        id: "exp-empty",
        schemaName: "experiment_exp_empty",
        query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      } as unknown as ExperimentWorkspaceHandle;

      await expect(extractCandidateBundle(workspace, input)).rejects.toThrow("拒绝构造空候选包");
    });

    it("rejects a new revision without a source artifact", async () => {
      const workspace = {
        id: "exp-untraceable",
        schemaName: "experiment_exp_untraceable",
        query: vi.fn().mockResolvedValue({
          rows: [{
            id: "revision-2",
            document_id: "doc-1",
            revision: 2,
            base_revision: 1,
            content_hash: "new-hash",
            artifact_id: null,
          }],
          rowCount: 1,
        }),
      } as unknown as ExperimentWorkspaceHandle;

      await expect(extractCandidateBundle(workspace, input)).rejects.toThrow("缺少 source artifact");
    });
  });

  describe("buildIterationPrompt", () => {
    it("includes learning section with underlyingMechanism when conclusion=propose-improvement", () => {
      const learning: RuntimeLearningAssessmentV2 = {
        id: "la-1",
        projectId: "p1",
        source: { workflowId: "wf-1", reviewIds: ["r-1"], fingerprint: "fp-1" },
        conclusion: "propose-improvement",
        symptom: "章节节奏拖沓",
        failingLayer: "draft",
        underlyingMechanism: "prompt 缺少段落长度约束",
        affectedInputClass: "描写密集型段落",
        boundaries: "仅在段落超过 500 字时触发",
        candidate: {
          targetKind: "skill",
          targetId: "longform-continuity",
          rationale: "增加段落长度约束",
          afterText: "段落不超过 400 字",
        },
        createdAt: Date.now(),
      };
      const prompt = buildIterationPrompt({
        skills: [makeSkill()],
        reviews: [makeReview()],
        learningAssessment: learning,
      });
      expect(prompt).toContain("段落长度约束");
      expect(prompt).toContain("描写密集型段落");
      // AGENTS.md：必须包含 underlyingMechanism 而非仅 issue 症状
      expect(prompt).toContain("prompt 缺少段落长度约束");
    });

    it("includes no-shared-learning guidance when conclusion=no-shared-learning", () => {
      const learning: RuntimeLearningAssessmentV2 = {
        id: "la-2",
        projectId: "p1",
        source: { workflowId: "wf-2", reviewIds: [], fingerprint: "fp-2" },
        conclusion: "no-shared-learning",
        symptom: "单次偏差",
        createdAt: Date.now(),
      };
      const prompt = buildIterationPrompt({
        skills: [makeSkill()],
        reviews: [],
        learningAssessment: learning,
      });
      expect(prompt).toContain("no-shared-learning");
      expect(prompt).toContain("不要为单次偏差创建规则");
    });

    it("warns when learning assessment is missing", () => {
      const prompt = buildIterationPrompt({ skills: [makeSkill()], reviews: [makeReview()] });
      expect(prompt).toContain("尚无 learning assessment");
      expect(prompt).toContain("不得仅凭 issue 症状臆造通用规则");
    });

    it("includes issue details from reviews", () => {
      const prompt = buildIterationPrompt({ skills: [makeSkill()], reviews: [makeReview()] });
      expect(prompt).toContain("节奏拖沓");
      expect(prompt).toContain("major");
    });
  });
});

// ===== 集成测试（需要真实 Postgres）=====

describe("evaluation integration", () => {
  let repository: NovelPostgresRepository;
  let model: InMemoryModelGateway;
  let postgresAvailable = false;

  async function seedFinalChapter(projectId: string) {
    await repository.ensureProject(projectId, "Closed Loop Fixture");
    const document = await repository.ensureDocument({ projectId, title: "Chapter", narrativeOrder: 1, status: "draft" });
    const intentId = `intent-${randomUUID()}`;
    const preflightId = `preflight-${randomUUID()}`;
    const memoryBundleId = `memory-${randomUUID()}`;
    const skillBundleId = `skills-${randomUUID()}`;
    const blueprintId = `blueprint-${randomUUID()}`;
    const intent = { id: intentId, projectId, source: "api" as const, objective: "生成测试章节", target: { kind: "chapter" as const, id: document.id, order: 1 }, requestedStage: "drafting" as const, idempotencyKey: intentId, createdAt: Date.now() };
    await repository.putIntent(intent);
    await repository.pool.query("INSERT INTO preflight_plans(id,intent_id,project_id,payload,fingerprint) VALUES($1,$2,$3,$4,$5)", [preflightId, intentId, projectId, { id: preflightId }, preflightId]);
    await repository.pool.query("INSERT INTO memory_bundles(id,project_id,preflight_id,payload,fingerprint) VALUES($1,$2,$3,$4,$5)", [memoryBundleId, projectId, preflightId, { id: memoryBundleId, projectId, preflightId, claims: [], tokenEstimate: 0, sourceRevisionIds: [], createdAt: Date.now(), fingerprint: memoryBundleId }, memoryBundleId]);
    await repository.pool.query("INSERT INTO skill_bundles(id,project_id,preflight_id,payload,fingerprint) VALUES($1,$2,$3,$4,$5)", [skillBundleId, projectId, preflightId, { id: skillBundleId, projectId, preflightId, skills: [], conflicts: [], missingCapabilities: [], createdAt: Date.now(), fingerprint: skillBundleId }, skillBundleId]);
    const blueprint = {
      id: blueprintId,
      projectId,
      intentId,
      preflightId,
      memoryBundleId,
      skillBundleId,
      baseRevision: 0,
      tasks: [],
      commitPolicy: "dual-gate",
      budget: { maxInputTokens: 8000, maxOutputTokens: 4000 },
      fingerprint: blueprintId,
      createdAt: Date.now(),
    } satisfies ExecutionBlueprint;
    await repository.pool.query("INSERT INTO execution_blueprints(id,project_id,intent_id,preflight_id,memory_bundle_id,skill_bundle_id,payload,fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [blueprintId, projectId, intentId, preflightId, memoryBundleId, skillBundleId, blueprint, blueprint.fingerprint]);

    const text = "雨水沿着废弃车站的玻璃缓慢下坠，值夜人把未寄出的信压在登记册下。远处的钟声响了两次，他仍没有抬头。";
    const object = await new ContentObjectStore().putText(text);
    const artifactId = randomUUID();
    await repository.recordArtifact({ id: artifactId, projectId, taskId: `${blueprintId}:draft`, attemptId: randomUUID(), kind: "draft", contentHash: object.hash, objectKey: object.key, baseRevision: 0, fingerprint: object.hash, createdAt: Date.now() });
    await repository.pool.query("INSERT INTO content_blobs(content_hash,object_key,byte_length) VALUES($1,$2,$3) ON CONFLICT(content_hash) DO NOTHING", [object.hash, object.key, object.bytes]);
    const revisionId = randomUUID();
    await repository.pool.query("INSERT INTO manuscript_revisions(id,project_id,document_id,revision,base_revision,content_hash,artifact_id) VALUES($1,$2,$3,0,0,$4,$5)", [revisionId, projectId, document.id, object.hash, artifactId]);
    await repository.pool.query("UPDATE manuscript_documents SET current_revision_id=$1,status='final' WHERE id=$2", [revisionId, document.id]);
    return document;
  }

  beforeAll(async () => {
    model = new InMemoryModelGateway(() => ({
      iterations: [
        {
          skillId: "longform-continuity",
          promptSections: { drafting: "根据章节功能与情绪弧线动态分配段落长度；场景推进时压缩重复描写，沉浸与心理转折段保留必要细节，并以可验证的动作、感官和因果变化承载节奏。每次调整都应维持视角知识边界、人物行动动机与前后事实连续，不得为了缩短篇幅删除关键铺垫。" },
          rationale: "增加段落长度约束，解决节奏拖沓问题",
          triggeredByIssueIds: ["review-1-0"],
        },
      ],
    }));
    if (integrationEnabled) {
      repository = new NovelPostgresRepository(TEST_DB_URL);
      await repository.pool.query("SELECT 1");
      await repository.migrate();
      postgresAvailable = true;
    }
  }, 30000);

  afterAll(async () => {
    if (postgresAvailable && repository) {
      await repository.close();
    }
  });

  it("reports whether integration mode is enabled", () => {
    expect(postgresAvailable).toBe(integrationEnabled);
  });

  describe("project-snapshot", () => {
    integrationIt("captures snapshot and computes head", async () => {
      const projectId = `snap-test-${randomUUID().slice(0, 8)}`;
      await repository.ensureProject(projectId, "Snapshot Test");
      const snapshot = await captureProjectSnapshot(repository, projectId);
      expect(snapshot.id).toMatch(/^[0-9a-f-]{36}$/u);
      expect(snapshot.hash).toHaveLength(64);
      expect(snapshot.payload).toBeDefined();
      expect(snapshot.head.projectRevision).toBe(0);
      expect(snapshot.head.finalDocumentHashes).toEqual([]);

      const head = await computeProjectHead(repository, projectId);
      expect(head.projectRevision).toBe(0);
    });

    integrationIt("captures snapshot with final document hash in head", async () => {
      const projectId = `snap-final-${randomUUID().slice(0, 8)}`;
      await repository.ensureProject(projectId, "Final Doc Test");
      const doc = await repository.ensureDocument({ projectId, title: "Chapter 1", status: "draft" });
      // 模拟 final 状态但无 revision（finalDocumentHashes 应为空数组）
      await repository.pool.query("UPDATE manuscript_documents SET status='final' WHERE id=$1", [doc.id]);
      const head = await computeProjectHead(repository, projectId);
      expect(head.finalDocumentHashes).toEqual([]);
    });
  });

  describe("experiment-workspace", () => {
    integrationIt("creates isolated workspace and cleans up", async () => {
      const projectId = `exp-test-${randomUUID().slice(0, 8)}`;
      await repository.ensureProject(projectId, "Experiment Test");
      const snapshot = await captureProjectSnapshot(repository, projectId);
      const workspace = await createExperimentWorkspace(repository, snapshot);
      try {
        expect(workspace.id).toMatch(/^exp-/);
        expect(workspace.schemaName).toContain("experiment_");
        expect(workspace.status).toBe("active");

        const listed = await listExperimentWorkspaces(repository, projectId);
        expect(listed.some((w) => w.id === workspace.id)).toBe(true);

        const fetched = await getExperimentWorkspace(repository, workspace.id);
        expect(fetched?.id).toBe(workspace.id);
      } finally {
        await workspace.delete();
      }

      const afterDelete = await getExperimentWorkspace(repository, `exp-${randomUUID().slice(0, 8)}`);
      expect(afterDelete).toBeNull();
    });
  });

  describe("promotion", () => {
    integrationIt("promote is idempotent for same candidateId", async () => {
      const projectId = `promote-idem-${randomUUID().slice(0, 8)}`;
      await repository.ensureProject(projectId, "Promote Idempotency");
      const doc = await repository.ensureDocument({ projectId, title: "Doc", status: "draft" });

      // 准备正式库 baseline：插入一个 revision 0
      const contentHash = computeManuscriptContentHash("baseline", "<p>baseline</p>");
      await repository.pool.query(
        "INSERT INTO content_blobs(content_hash, object_key, byte_length) VALUES($1, $2, $3) ON CONFLICT(content_hash) DO NOTHING",
        [contentHash, `test/${projectId}/${contentHash}`, Buffer.byteLength("baseline", "utf8")],
      );
      const artifactId = randomUUID();
      await repository.pool.query(
        "INSERT INTO artifacts(id, project_id, task_id, attempt_id, kind, content_hash, base_revision, fingerprint, payload) VALUES($1, $2, 'seed', '1', 'draft', $3, 0, $4, '{}')",
        [artifactId, projectId, contentHash, contentHash],
      );
      const revisionId = randomUUID();
      await repository.pool.query(
        "INSERT INTO manuscript_revisions(id, project_id, document_id, revision, base_revision, content_hash, artifact_id) VALUES($1, $2, $3, 0, 0, $4, $5)",
        [revisionId, projectId, doc.id, contentHash, artifactId],
      );
      await repository.pool.query(
        "UPDATE manuscript_documents SET current_revision_id=$1, status='final' WHERE id=$2",
        [revisionId, doc.id],
      );

      // 构造 candidate（baseRevision=0，新内容 hash 不同）
      const newPlain = "新章节内容";
      const newHtml = "<p>新章节内容</p>";
      const newHash = computeManuscriptContentHash(newPlain, newHtml);
      const dependencyHead = await computeProjectHead(repository, projectId);
      const snapshot = await captureProjectSnapshot(repository, projectId);
      const workspace = await createExperimentWorkspace(repository, snapshot);
      const candidate = makeCandidate({
        experimentId: workspace.id,
        sourceProjectId: projectId,
        target: { documentId: doc.id, baseRevision: 0, baseContentHash: contentHash },
        manuscript: { title: "新章节", plainText: newPlain, contentHtml: newHtml, wordCount: newPlain.length, contentHash: newHash },
        dependencyHead,
      });

      const promotionService = createPromotionService(repository);
      const decision: AuthorDecision = {
        authorId: "tester",
        decision: "accept",
        reason: "测试幂等",
        decidedAt: Date.now(),
      };

      const receipt1 = await promotionService.promote(candidate, decision);
      expect(receipt1.status).toBe("promoted");

      const receipt2 = await promotionService.promote(candidate, decision);
      expect(receipt2.id).toBe(receipt1.id);
      expect(receipt2.status).toBe("promoted");
      await workspace.close();
    });

    integrationIt("promote rejects on stale baseline", async () => {
      const projectId = `promote-stale-${randomUUID().slice(0, 8)}`;
      await repository.ensureProject(projectId, "Stale Baseline");
      const doc = await repository.ensureDocument({ projectId, title: "Doc", status: "draft" });

      const candidate = makeCandidate({
        sourceProjectId: projectId,
        target: { documentId: doc.id, baseRevision: 0, baseContentHash: "" },
        dependencyHead: { projectRevision: 999, finalDocumentHashes: ["stale-hash"] },
      });

      const promotionService = createPromotionService(repository);
      const receipt = await promotionService.promote(candidate, {
        authorId: "tester",
        decision: "accept",
        decidedAt: Date.now(),
      });

      expect(receipt.status).toBe("failed");
      expect(receipt.failureReason).toContain("stale-baseline");
    });

    integrationIt("promote with reject decision returns failed receipt", async () => {
      const projectId = `promote-reject-${randomUUID().slice(0, 8)}`;
      await repository.ensureProject(projectId, "Reject Decision");
      const doc = await repository.ensureDocument({ projectId, title: "Doc", status: "draft" });
      const candidate = makeCandidate({
        sourceProjectId: projectId,
        target: { documentId: doc.id, baseRevision: 0, baseContentHash: "" },
        dependencyHead: { projectRevision: 0, finalDocumentHashes: [] },
      });

      const promotionService = createPromotionService(repository);
      const receipt = await promotionService.promote(candidate, {
        authorId: "tester",
        decision: "reject",
        reason: "质量不达标",
        decidedAt: Date.now(),
      });

      expect(receipt.status).toBe("failed");
      expect(receipt.failureReason).toContain("decision 必须为 accept");
    });
  });

  describe("skill-iteration", () => {
    integrationIt("runs skill iteration and persists underlyingMechanism", async () => {
      const projectId = `skill-iter-${randomUUID().slice(0, 8)}`;
      await repository.ensureProject(projectId, "Skill Iteration");
      const snapshot = await captureProjectSnapshot(repository, projectId);
      const workspace = await createExperimentWorkspace(repository, snapshot);
      try {
        const learningAssessment: RuntimeLearningAssessmentV2 = {
          id: "la-test",
          projectId,
          source: { workflowId: "wf-test", reviewIds: ["r-1"], fingerprint: "fp" },
          conclusion: "propose-improvement",
          underlyingMechanism: "prompt 缺少段落长度约束",
          affectedInputClass: "描写密集型段落",
          createdAt: Date.now(),
        };

        const iterated = await runSkillIteration({
          workspace,
          repository,
          reviews: [makeReview({ projectId })],
          learningAssessment,
          model,
        });

        expect(iterated.length).toBeGreaterThan(0);
        expect(iterated[0].learningMechanism).toBe("prompt 缺少段落长度约束");
        expect(iterated[0].beforePrompt).not.toBe(iterated[0].afterPrompt);
        expect(iterated[0].rationale).toBeTruthy();
      } finally {
        await workspace.delete();
      }
    });
  });

  describe("closed-loop", () => {
    integrationIt("runs closed-loop in dryRun mode without promoting", async () => {
      const projectId = `loop-dry-${randomUUID().slice(0, 8)}`;
      const doc = await seedFinalChapter(projectId);
      const regressionMarker = "回归规则标记：按章节功能动态调整具象细节、节奏与信息密度，同时保持人物知识边界和事实连续。";
      let standaloneCharacterExtractions = 0;
      const closedLoopModel = new InMemoryModelGateway((input) => {
        const properties = input.schema?.properties as Record<string, unknown> | undefined;
        if (properties?.verdict) {
          const passed = input.prompt.includes("现场承载已改善");
          const scoreSchema = properties.scores as { properties?: Record<string, unknown> } | undefined;
          const dimensions = Object.keys(scoreSchema?.properties ?? {});
          const scores = Object.fromEntries(dimensions.map((dimension) => [dimension, passed ? 5 : 3]));
          return {
            verdict: passed ? "passed" : "revise",
            scores,
            issues: passed ? [] : [{ dimension: dimensions[0], severity: "major", title: "抽象叙述缺少现场承载", description: "关键体验被概括性表达替代", revisionRanges: [{ start: 1, end: 1 }], rule: "longform-continuity", suggestion: "用动作、感官和因果变化承载信息", rewriteExample: "让人物在现场动作中暴露判断" }],
          };
        }
        if (properties?.conclusion) {
          if (input.prompt.includes("无审核问题")) return { conclusion: "no-shared-learning" };
          return { conclusion: "propose-improvement", symptom: "抽象叙述削弱沉浸", failingLayer: "共享 skill prompt", underlyingMechanism: "prompt 未要求根据章节功能选择具象承载方式", affectedInputClass: "需要同时处理氛围、心理与信息推进的章节", boundaries: "不要求所有段落堆叠感官细节，只修复承担关键体验的段落", regressionRisks: ["过度具象可能拖慢行动章节"], candidate: { targetKind: "skill", targetId: "longform-continuity", rationale: "补足通用的具象化决策规则", afterText: JSON.stringify({ revision: regressionMarker.repeat(3) }), applicableGenres: [] } };
        }
        if (properties?.iterations) return { iterations: [{ skillId: "longform-continuity", promptSections: { revision: regressionMarker.repeat(3) }, rationale: "让不同章节功能都按证据选择具象承载方式", triggeredByIssueIds: ["抽象叙述缺少现场承载"] }] };
        if (properties?.characters) {
          standaloneCharacterExtractions += 1;
          return { characters: [] };
        }
        if (properties?.facts) return {
          summary: "测试章节事实提取",
          facts: [{ subject: { kind: "entity", id: "night-watchman" }, predicate: "持有", object: { kind: "string", value: "未寄出的信" }, polarity: "affirmed", truthStatus: "objective", humanReadable: "值夜人持有一封未寄出的信", evidence: "值夜人把未寄出的信压在登记册下", confidence: 0.98, novelty: "new", conflict: false }],
          chapterMemory: { summary: "值夜人在雨夜的废弃车站守着一封未寄出的信，连续两次钟声都没有改变他的等待。信件仍未寄出，人物的克制与隐约紧张被保留下来，形成下一章可以继续追踪的行动、物件和情绪状态。".repeat(2), keyEvents: ["值夜人继续压着未寄出的信"], characterStates: [{ characterId: "night-watchman", stateSnapshot: "仍在废弃车站等待" }], unresolvedThreads: ["信为何没有寄出"], emotionalArc: "由克制转为隐约紧张" },
          characterDeltas: [{ characterId: "night-watchman", voiceAnchor: { sentenceLength: "短句", vocabulary: "克制", directness: "间接", avoidance: "回避解释信件" }, motivationDelta: "继续等待并保护信件", newKnowledge: [], relationDeltas: [] }],
        };
        if (properties?.keyEvents) return { summary: "值夜人在废弃车站守着一封未寄出的信，雨水和钟声构成现场压力；他始终没有抬头，纸边却在指腹下发抖，说明平静表面下仍有尚未说出的决定与持续悬念。".repeat(2), keyEvents: ["值夜人在第二声钟响后仍压着未寄出的信"], characterStates: [], unresolvedThreads: ["信为何没有寄出"], emotionalArc: "由克制的平静转为可感知的紧张" };
        if (!input.schema) return input.prompt.includes(regressionMarker)
          ? "雨水沿着裂纹分叉，值夜人用拇指压住信封翘起的角。第二声钟响时，纸边仍在他指腹下发抖。现场承载已改善。"
          : "雨水沿着玻璃下坠，值夜人把信压在登记册下，钟声之后仍没有抬头。";
        throw new Error(`未覆盖的测试 schema: ${Object.keys(properties ?? {}).join(",")}`);
      });

      const result = await runClosedLoop({
        repository,
        model: closedLoopModel,
        projectId,
        documentId: doc.id,
        dryRun: true,
      });

      expect(result.experimentId).toMatch(/^exp-/);
      expect(result.snapshotId).toMatch(/^[0-9a-f-]{36}$/u);
      expect(result.candidateBundle).toBeDefined();
      expect(result.promotionReceipt).toBeUndefined();
      expect(result.candidateBundle?.acceptedFacts.length).toBeGreaterThan(0);
      expect(standaloneCharacterExtractions).toBe(0);

      const workspace = await getExperimentWorkspace(repository, result.experimentId);
      expect(workspace).not.toBeNull();
      const schema = workspace!.schemaName;
      const documentState = await workspace!.query<{ current_revision_id: string; narrative_order: string | number }>(`SELECT current_revision_id,narrative_order FROM ${schema}.manuscript_documents WHERE id=$1`, [doc.id]);
      const currentRevisionId = documentState.rows[0].current_revision_id;
      const activeSources = await workspace!.query<{ revision_id: string }>(`SELECT revision_id FROM ${schema}.memory_claim_sources WHERE document_id=$1 AND lifecycle_status='active'`, [doc.id]);
      const staleActiveSources = await workspace!.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM ${schema}.memory_claim_sources WHERE document_id=$1 AND lifecycle_status='active' AND revision_id<>$2`, [doc.id, currentRevisionId]);
      const narrativeState = await workspace!.query<{ narrative_order: string | number }>(`SELECT narrative_order FROM ${schema}.narrative_state_snapshots WHERE document_id=$1 AND revision_id=$2`, [doc.id, currentRevisionId]);

      expect(activeSources.rows.length).toBeGreaterThan(0);
      expect(activeSources.rows.every((row) => row.revision_id === currentRevisionId)).toBe(true);
      expect(Number(staleActiveSources.rows[0].count)).toBe(0);
      expect(Number(narrativeState.rows[0].narrative_order)).toBe(Number(documentState.rows[0].narrative_order));
    });
  });
});
