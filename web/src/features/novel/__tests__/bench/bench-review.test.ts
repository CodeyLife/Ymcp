/**
 * Review 切片测试：复刻 review-stage.ts 核心路径，4 个 reviewer 并发审校 + 聚合质量报告。
 *
 * 默认 skip，通过 BENCH_STAGE=review 启用：
 *   BENCH_STAGE=review npx vitest run --config vitest.bench.config.ts bench-review.test.ts
 *
 * 前置依赖：foundation.json + ch1-blueprint.json + ch1-context-packet.json + ch1-draft.json
 * 输出：.novel-bench/runs/{ts}-review/ 目录（quality-report.json / prompts/*.md / metrics.json）
 * 滚动 fixture：保存 ch1-quality-report.json 供 revision 切片使用
 * 预期耗时：5-8 分钟（5 个结构化 LLM 调用）
 */
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_API_KEY } from "@/config/defaults";

// DEV 代理绕过：让 getEffectiveApiConfig 返回带显式 :443 端口的等价 URL
vi.mock("@/stores/ui", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getEffectiveApiConfig: () => ({
      baseUrl: "https://gpt.eromaa.com:443/v1",
      apiKey: DEFAULT_API_KEY,
      usesDefaultBaseUrl: false,
      hasOwnKey: true,
      modelContextWindow: 0,
    }),
  };
});

import { callStructuredNovelModel } from "../../ai";
import { buildChapterReviewPrompt } from "../../prose-prompts";
import { aggregateQuality, runDeterministicQualityChecks, type ReviewerFinding } from "../../quality";
import { compileNovelStagePrompt, resolveNovelSkills } from "../../skills";
import { asBlueprint, reviewerSchema } from "../../workflow-shared";
import { settleWithConcurrency } from "../../workflow-stages/settled-pool";
import type { QualityDimension, QualityIssue } from "../../types";
import {
  loadFixture,
  loadFoundationIntoDb,
  log,
  requireFixture,
  resetDb,
  runBench,
  saveFixture,
  type FoundationSnapshot,
} from "./bench-helpers";

const SHOULD_RUN = process.env.BENCH_STAGE === "review";
const describeOrSkip = SHOULD_RUN ? describe : describe.skip;
// 支持 BENCH_CHAPTER=ch2 选择不同章节 fixture（多场景验证）
const BENCH_CHAPTER = process.env.BENCH_CHAPTER === "ch2" ? "ch2" : "ch1";

interface BlueprintFixture {
  contentMarkdown: string;
  structuredData: Record<string, unknown>;
  targetWords: number;
  projectId: string;
  model: string;
  contentProfile: string;
}

interface ContextFixture {
  formattedContext: string;
  formattedReviewerContext: string;
  rawPacket: unknown;
}

interface DraftFixture {
  contentMarkdown: string;
  promptHash: string;
}

const REVIEW_ROLES: Array<Parameters<typeof buildChapterReviewPrompt>[0]["role"]> = [
  "style-reviewer",
  "character-reviewer",
  "continuity-reviewer",
  "plot-reviewer",
];

describeOrSkip("bench-review: 切片测试", { timeout: 1_800_000 }, () => {
  it("reviews chapter draft with 4 reviewers", async () => {
    // 前置检查
    requireFixture(`${BENCH_CHAPTER}-draft.json`, "npm run test:bench:draft");

    const { result: report, runId } = await runBench("review", "review", async (ctx) => {
      // 1. 加载 fixture + 初始化 DB
      log("review", "加载 fixture 并初始化 DB");
      await resetDb();
      const foundation = loadFixture<FoundationSnapshot>("foundation.json");
      await loadFoundationIntoDb(foundation);
      const blueprintFixture = loadFixture<BlueprintFixture>(`${BENCH_CHAPTER}-blueprint.json`);
      const contextFixture = loadFixture<ContextFixture>("ch1-context-packet.json");
      const draftFixture = loadFixture<DraftFixture>(`${BENCH_CHAPTER}-draft.json`);

      // 2. 机械检查 + numberedDraft（复刻 review-stage.ts）
      log("review", "机械检查 + 构建编号正文");
      const blueprintData = blueprintFixture.structuredData
        ? asBlueprint(blueprintFixture.structuredData)
        : undefined;
      const deterministic = runDeterministicQualityChecks({
        text: draftFixture.contentMarkdown,
        blueprint: blueprintData,
      });
      const numberedDraft = draftFixture.contentMarkdown
        .split(/\n\s*\n/)
        .map((paragraph, index) => `【第${index + 1}段】\n${paragraph.trim()}`)
        .filter((paragraph) => paragraph.trim())
        .join("\n\n");

      // 3. 4 个 reviewer 并发（concurrency=2）+ 失败重试（复刻 review-stage.ts）
      log("review", `启动 ${REVIEW_ROLES.length} 个 reviewer（concurrency=2）`);

      const reviewOne = async (
        role: (typeof REVIEW_ROLES)[number],
      ): Promise<ReviewerFinding> => {
        const skills = await resolveNovelSkills({
          projectId: blueprintFixture.projectId,
          stage: "review",
        });
        const skillPrompt = compileNovelStagePrompt(skills.skills, "review");
        const prompt = buildChapterReviewPrompt({
          role,
          blueprintMarkdown: blueprintFixture.contentMarkdown,
          numberedDraft,
          reviewerContext: contextFixture.formattedReviewerContext,
        });
        ctx.writeOutput(`prompts/${role}.md`, prompt);
        log("review", `→ ${role}`);
        const result = await callStructuredNovelModel<Record<string, unknown>>({
          model: blueprintFixture.model,
          temperature: 0.15,
          role,
          skillPrompt,
          schema: reviewerSchema,
          prompt,
        });
        const data = result.data as {
          scores: Partial<Record<QualityDimension, number>>;
          issues: Array<Omit<QualityIssue, "id" | "deterministic">>;
        };
        return { role, scores: data.scores, issues: data.issues };
      };

      const settled = await settleWithConcurrency(REVIEW_ROLES, 2, reviewOne);

      // 失败重试（concurrency=1）——与 review-stage.ts 一致
      const failedIndexes = settled.flatMap((result, index) =>
        result.status === "rejected" ? [index] : [],
      );
      if (failedIndexes.length > 0) {
        log("review", `重试 ${failedIndexes.length} 个失败的 reviewer`);
        const retries = await settleWithConcurrency(failedIndexes, 1, (index) =>
          reviewOne(REVIEW_ROLES[index]),
        );
        retries.forEach((result, retryIndex) => {
          settled[failedIndexes[retryIndex]] = result;
        });
      }

      // 降级处理：失败的 reviewer 返回 warning issue（复刻 review-stage.ts）
      const reviewers: ReviewerFinding[] = settled.map((result, index) => {
        if (result.status === "fulfilled") return result.value;
        const role = REVIEW_ROLES[index];
        const message = result.reason instanceof Error ? result.reason.message : "未知错误";
        log("review", `⚠ ${role} 降级：${message}`);
        return {
          role,
          scores: {},
          issues: [
            {
              dimension: "continuity",
              severity: "warning",
              title: `${role} 审校不可用`,
              description: `该审校维度因调用失败而降级：${message}`,
              rule: "reviewer.unavailable",
              suggestion: "可重试该维度或进行人工审阅。其它维度的审校结果仍然有效。",
              rewriteExample:
                "结构问题，审校调用失败需人工复核后再决定改写方向。",
            },
          ],
        };
      });

      // 4. 聚合质量报告（复刻 review-stage.ts 的 saveQualityReport 逻辑，但不写 DB）
      log("review", "聚合质量报告");
      const aggregated = aggregateQuality({
        deterministic,
        reviewers,
        threshold: 3.7,
      });

      // 5. 输出 + 指标
      ctx.writeOutput("quality-report.json", aggregated);
      const dimensions = Object.keys(aggregated.scores) as QualityDimension[];
      const avgScore =
        Object.values(aggregated.scores).reduce((a, b) => a + b, 0) / dimensions.length;
      ctx.setMetrics({
        weightedScore: aggregated.weightedScore,
        avgScore: Number(avgScore.toFixed(2)),
        blockerCount: aggregated.blockerCount,
        majorCount: aggregated.issues.filter((i) => i.severity === "major").length,
        warningCount: aggregated.issues.filter((i) => i.severity === "warning").length,
        issueCount: aggregated.issues.length,
        reviewerCoverage: reviewers.filter((r) => !r.issues.some((i) => i.rule === "reviewer.unavailable")).length,
      });
      ctx.setMeta({
        model: blueprintFixture.model,
        contentProfile: blueprintFixture.contentProfile,
      });

      // 6. 保存滚动 fixture 供 revision 切片使用
      saveFixture(`${BENCH_CHAPTER}-quality-report.json`, aggregated);

      log(
        "review",
        `评分：weighted=${aggregated.weightedScore} avg=${avgScore.toFixed(2)} blocker=${aggregated.blockerCount} issues=${aggregated.issues.length}`,
      );
      return aggregated;
    });

    log("review", `完成：runId=${runId} weightedScore=${report.weightedScore}`);
    expect(report.issues.length).toBeGreaterThanOrEqual(0);
    expect(report.weightedScore).toBeGreaterThan(0);
  });
});
