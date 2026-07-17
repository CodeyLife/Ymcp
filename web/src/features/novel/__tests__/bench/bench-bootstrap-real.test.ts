/**
 * Real-project fixture 生成测试：从真实小说项目快照 JSON 加载记录，
 * 跳过 9 阶段地基（已有），直接运行 context → blueprint 阶段生成 bench fixture。
 *
 * 默认 skip，通过 BENCH_BOOTSTRAP_REAL=true 启用：
 *   BENCH_BOOTSTRAP_REAL=true npx vitest run --config vitest.bench.config.ts bench-bootstrap-real.test.ts
 *
 * 输入：.goal/goals/novel-real-bench-iter/tmp/baseline-evaluation.json
 * 输出：fixtures/foundation.json + ch1-blueprint.json + ch1-context-packet.json + ch1-baseline-original.json
 * 预期耗时：3-6 分钟（context + blueprint 两次 LLM 调用）
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_API_KEY } from "@/config/defaults";

// DEV 代理绕过：让 getEffectiveApiConfig 返回带显式 :443 端口的等价 URL
vi.mock("@/stores/ui", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getEffectiveApiConfig: () => ({
      baseUrl: "https://gpt.eromaa.com:443/v1",
      apiKey: DEFAULT_API_KEY,
      hasOwnKey: true,
      modelContextWindow: 0,
      usesDefaultBaseUrl: false,
    }),
  };
});

import { novelDb } from "../../db";
import { startChapterWorkflow } from "../../workflow";
import { novelMemoryService } from "../../memory-service";
import { formatContextPacket, formatReviewerContext } from "../../context";
import {
  FIXTURE_DIR,
  fixtureExists,
  saveFixture,
  resetDb,
  log,
} from "./bench-helpers";
import { mkdirSync } from "node:fs";

const SHOULD_RUN = process.env.BENCH_BOOTSTRAP_REAL === "true";
const FORCE_REGEN = process.env.FORCE_REGEN === "true";
const describeOrSkip = SHOULD_RUN ? describe : describe.skip;

// 真实项目快照路径（goal tmp 目录）
const BASELINE_JSON_PATH = join(
  process.cwd(),
  ".goal/goals/novel-real-bench-iter/tmp/baseline-evaluation.json",
);

interface EvaluationSnapshot {
  records: {
    projects: unknown[];
    architectures: unknown[];
    entities: unknown[];
    relations: unknown[];
    outlineNodes: unknown[];
    scenes: unknown[];
    documents: unknown[];
    revisions: unknown[];
    plotThreads: unknown[];
    foreshadowing: unknown[];
    timelineEvents: unknown[];
    preferenceSignals: unknown[];
  };
}

interface RealProject {
  id: string;
  title: string;
  settings: {
    textModel: string;
    temperature: number;
    contentProfile: "general-serial" | "progression" | "emotional";
  };
  tone: string;
  languageStyle: string;
}

interface RealDocument {
  id: string;
  projectId: string;
  order: number;
  title: string;
  blueprint: {
    objective: string;
    endingHook?: string;
    mustHappen: string[];
    forbidden: string[];
    targetWords: number;
    characterIds: string[];
    locationIds: string[];
  };
  status: string;
  approvedRevisionId?: string;
  contentHtml: string;
  plainText: string;
  wordCount: number;
  plotSegmentId?: string;
}

interface RealEntity {
  id: string;
  projectId: string;
  kind: string;
  name: string;
}

/**
 * 加载真实项目快照，重置章节 1 为待生成状态（清除已批准内容），
 * 返回 foundation snapshot + 章节1 + 沈砚 + 原始正文。
 */
function loadRealSnapshot(): {
  foundation: {
    project: unknown;
    architectures: unknown[];
    entities: unknown[];
    relations: unknown[];
    outlineNodes: unknown[];
    scenes: unknown[];
    plotThreads: unknown[];
    foreshadowing: unknown[];
    timelineEvents: unknown[];
    documents: unknown[];
  };
  chapter1: RealDocument;
  shenyanEntity: RealEntity;
  originalPlainText: string;
} {
  const raw = readFileSync(BASELINE_JSON_PATH, "utf-8");
  const snapshot = JSON.parse(raw) as EvaluationSnapshot;
  const r = snapshot.records;

  const project = r.projects[0] as RealProject;
  const architectures = r.architectures;
  const entities = r.entities as RealEntity[];
  const documents = r.documents as RealDocument[];

  // 章节1 是 order 最小的文档
  const chapter1 = documents
    .slice()
    .sort((a, b) => (a as RealDocument).order - (b as RealDocument).order)[0] as RealDocument;

  if (!chapter1) throw new Error("快照中未找到章节1");
  if (!chapter1.blueprint) throw new Error("章节1 缺少 blueprint 字段");

  // 沈砚 = 主角 character 实体
  const shenyanEntity = entities.find(
    (e) => e.kind === "character" && e.name.includes("沈砚"),
  );
  if (!shenyanEntity) throw new Error("未找到沈砚角色实体");

  const originalPlainText = chapter1.plainText || "";

  // 重置章节1 为待生成状态：保留 blueprint，清除已批准内容，避免工作流边缘问题
  const chapter1Reset: RealDocument = {
    ...chapter1,
    status: "outline",
    approvedRevisionId: undefined,
    contentHtml: "",
    plainText: "",
    wordCount: 0,
  };

  // 替换 documents 中的章节1
  const documentsReset = documents.map((d) =>
    d.id === chapter1.id ? chapter1Reset : d,
  );

  return {
    foundation: {
      project,
      architectures,
      entities,
      relations: r.relations,
      outlineNodes: r.outlineNodes,
      scenes: r.scenes,
      plotThreads: r.plotThreads,
      foreshadowing: r.foreshadowing,
      timelineEvents: r.timelineEvents,
      documents: documentsReset,
    },
    chapter1: chapter1Reset,
    shenyanEntity,
    originalPlainText,
  };
}

describeOrSkip("bench-bootstrap-real: 真实项目 fixture 生成", { timeout: 1_200_000 }, () => {
  it("loads real snapshot and runs context + blueprint stages", async () => {
    // 检查 fixture 是否已存在
    if (
      !FORCE_REGEN &&
      fixtureExists("foundation.json") &&
      fixtureExists("ch1-blueprint.json") &&
      fixtureExists("ch1-context-packet.json")
    ) {
      log("bootstrap-real", "fixture 已存在，跳过生成（使用 FORCE_REGEN=true 强制重新生成）");
      return;
    }

    mkdirSync(FIXTURE_DIR, { recursive: true });
    await resetDb();

    // === 1. 加载真实快照 + 初始化 DB ===
    log("bootstrap-real", "加载真实项目快照");
    const { foundation, chapter1, shenyanEntity, originalPlainText } = loadRealSnapshot();

    // 写入 foundation 到 DB（与 loadFoundationIntoDb 等价）
    const FOUNDATION_TABLES = [
      "architectures",
      "entities",
      "relations",
      "outlineNodes",
      "scenes",
      "plotThreads",
      "foreshadowing",
      "timelineEvents",
      "documents",
    ] as const;
    await novelDb.projects.put(foundation.project as never);
    for (const table of FOUNDATION_TABLES) {
      const records = (foundation as Record<string, unknown[]>)[table];
      if (records && records.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (novelDb as any)[table].bulkPut(records);
      }
    }
    log("bootstrap-real", `项目已加载：${(foundation.project as RealProject).title}`);
    log("bootstrap-real", `章节1：${chapter1.title}（POV: ${shenyanEntity.name}）`);

    // 保存原始批准正文作为对比基准
    saveFixture("ch1-baseline-original.json", {
      plainText: originalPlainText,
      wordCount: originalPlainText.length,
      documentTitle: chapter1.title,
      documentId: chapter1.id,
      projectId: chapter1.projectId,
    });
    log("bootstrap-real", `原始批准正文已保存：${originalPlainText.length} 字`);

    // === 2. 序列化 foundation fixture ===
    saveFixture("foundation.json", foundation);
    log("bootstrap-real", "foundation.json 已保存");

    // === 3. 创建协作对话 + 创作简报 ===
    const project = foundation.project as RealProject;
    const thread = await novelMemoryService.getOrCreateThread({
      projectId: project.id,
      targetDocumentId: chapter1.id,
    });

    // 从项目 tone/languageStyle + 章节 blueprint 构建简报
    const languageRequirements = project.languageStyle
      ? project.languageStyle.split(/[；;。。\n]/).map((s) => s.trim()).filter((s) => s.length > 2).slice(0, 5)
      : [];

    const draftBrief = await novelMemoryService.getDraftBrief(thread.id);
    const updatedBrief = await novelMemoryService.updateBrief(draftBrief.id, {
      goal: `${chapter1.blueprint.objective}`,
      povCharacterId: shenyanEntity.id,
      tone: project.tone || "克制、清澈、沉浸而有张力",
      languageRequirements:
        languageRequirements.length > 0
          ? languageRequirements
          : ["融合中文古典江湖意境与现代清晰叙事节奏", "重视环境细节、生活质感、人物动作和对白潜台词", "避免单纯解释设定"],
      mustHappen: [...chapter1.blueprint.mustHappen],
      forbidden: [...chapter1.blueprint.forbidden],
      targetWords: chapter1.blueprint.targetWords || 5000,
    });
    const confirmedBrief = await novelMemoryService.confirmBrief(updatedBrief.id);
    log("bootstrap-real", "创作简报已确认");

    // === 4. 启动章节 workflow（blocking，运行 context → blueprint，停在 blueprint-approval） ===
    log("bootstrap-real", "→ startChapterWorkflow (context → blueprint → blueprint-approval)");
    const run = await startChapterWorkflow({
      projectId: project.id,
      documentId: chapter1.id,
      threadId: thread.id,
      briefId: confirmedBrief.id,
      instruction: confirmedBrief.goal,
      blocking: true,
    });

    if (run.status !== "waiting-approval" || run.currentStage !== "blueprint-approval") {
      throw new Error(
        `预期停在 blueprint-approval，实际：stage=${run.currentStage} status=${run.status} error=${run.error ?? "无"}`,
      );
    }
    log("bootstrap-real", "蓝图已生成，工作流停在 blueprint-approval");

    // === 5. 提取 blueprint artifact 与 context packet ===
    const blueprintArtifact = run.blueprintArtifactId
      ? await novelDb.workflowArtifacts.get(run.blueprintArtifactId)
      : undefined;
    if (!blueprintArtifact) throw new Error("蓝图 artifact 不存在");

    const contextPacket = run.contextPacketId
      ? await novelDb.contextPackets.get(run.contextPacketId)
      : undefined;
    if (!contextPacket) throw new Error("context packet 不存在");

    // === 6. 序列化 blueprint fixture ===
    log("bootstrap-real", "序列化 ch1-blueprint.json");
    saveFixture("ch1-blueprint.json", {
      contentMarkdown: blueprintArtifact.contentMarkdown,
      structuredData: blueprintArtifact.structuredData,
      targetWords: chapter1.blueprint.targetWords || 5000,
      documentTitle: chapter1.title,
      documentId: chapter1.id,
      projectId: project.id,
      povCharacterId: shenyanEntity.id,
      model: project.settings.textModel,
      temperature: project.settings.temperature,
      contentProfile: project.settings.contentProfile,
    });

    // === 7. 序列化 context packet fixture ===
    log("bootstrap-real", "序列化 ch1-context-packet.json");
    saveFixture("ch1-context-packet.json", {
      formattedContext: formatContextPacket(contextPacket),
      formattedReviewerContext: formatReviewerContext(contextPacket),
      rawPacket: contextPacket,
    });

    log("bootstrap-real", "fixture 生成完成 ✓");
    expect(blueprintArtifact.contentMarkdown.length).toBeGreaterThan(100);
    expect(contextPacket.sources.length).toBeGreaterThan(0);
    expect(originalPlainText.length).toBeGreaterThan(1000);
  });
});
