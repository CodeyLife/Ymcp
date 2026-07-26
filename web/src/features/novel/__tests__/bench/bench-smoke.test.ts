/**
 * 章节冒烟测试：复用真实 workflow 调度器跑完整章节流程，通过预加载 foundation
 * fixture 跳过 9 阶段地基（约 20 分钟），将总耗时压缩到 10-20 分钟。
 *
 * 默认 skip，通过 BENCH_SMOKE=true 启用：
 *   BENCH_SMOKE=true npx vitest run --config vitest.bench.config.ts bench-smoke.test.ts
 *
 * 前置依赖：foundation.json（由 bench-bootstrap 生成）
 * 输出：.novel-bench/runs/{ts}-smoke/ 目录（artifacts/*.json / final.md / quality-report.json / metrics.json）
 * 预期耗时：10-20 分钟
 *
 * 目的：验证完整 workflow 连通性（context→blueprint→draft→review→revision→fact-extraction→commit→character-enrichment→completed）
 */
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_API_KEY } from "@/config/defaults";

// DEV 代理绕过：让 getEffectiveApiConfig 返回带显式 :443 端口的等价 URL
vi.mock("@/stores/ui", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getEffectiveApiConfig: () => ({
      baseUrl: "https://chat.yujin8.top/v1",
      apiKey: DEFAULT_API_KEY,
      usesDefaultBaseUrl: false,
      hasOwnKey: true,
      modelContextWindow: 0,
    }),
  };
});

import { novelDb } from "../../db";
import { approveWorkflowStage, startChapterWorkflow } from "../../workflow";
import { novelMemoryService } from "../../memory-service";
import { autoAcceptSafeFactCandidates, bulkSetFactCandidateStatus, setFactCandidateStatus } from "../../facts";
import {
  loadFixture,
  loadFoundationIntoDb,
  log,
  resetDb,
  runBench,
  type FoundationSnapshot,
} from "./bench-helpers";

const SHOULD_RUN = process.env.BENCH_SMOKE === "true";
const describeOrSkip = SHOULD_RUN ? describe : describe.skip;

interface FoundationProject {
  id: string;
  title?: string;
  [key: string]: unknown;
}

describeOrSkip("bench-smoke: 章节冒烟测试", { timeout: 1_800_000 }, () => {
  it("runs full chapter 1 workflow with preseeded foundation", async () => {
    await runBench("smoke", "smoke", async (ctx) => {
      // 1. 加载 foundation 到 DB（跳过 9 阶段地基）
      await resetDb();
      const foundation = loadFixture<FoundationSnapshot>("foundation.json");
      await loadFoundationIntoDb(foundation);
      const projectId = (foundation.project as FoundationProject).id;
      log("smoke", `projectId=${projectId}`);

      // 2. 取第 1 章 + 创建协作对话 + 创作简报（复刻 e2e-chapter1）
      const documents = await novelDb.documents.where("projectId").equals(projectId).sortBy("order");
      if (!documents.length) throw new Error("foundation.json 中没有 documents，请确认 bootstrap 是否含 plot-design 阶段");
      const chapter1 = documents[0];
      log("smoke", `chapter1=${chapter1.title} (order=${chapter1.order})`);

      const thread = await novelMemoryService.getOrCreateThread({
        projectId,
        targetDocumentId: chapter1.id,
      });
      log("smoke", `thread=${thread.id}`);

      // 复刻 e2e-chapter1 的 brief 流程：getDraftBrief → updateBrief → confirmBrief
      const draftBrief = await novelMemoryService.getDraftBrief(thread.id);
      const povCharacter = await novelDb.entities
        .where("projectId").equals(projectId)
        .filter((e) => e.kind === "character").first();
      const updatedBrief = await novelMemoryService.updateBrief(draftBrief.id, {
        goal: `完成《${chapter1.title}》正文。`,
        povCharacterId: povCharacter?.id,
        tone: "克制而诡谲",
        languageRequirements: ["古风文言质感", "对白区分阶层"],
        mustHappen: ["章节承担叙事功能"],
        forbidden: ["使用现代词汇", "AI 痕迹明显的对仗排比"],
        targetWords: 6000,
      });
      const confirmedBrief = await novelMemoryService.confirmBrief(updatedBrief.id);
      log("smoke", `brief=${confirmedBrief.id}`);

      // 3. 启动章节 workflow（context → blueprint → blueprint-approval）
      log("smoke", "→ startChapterWorkflow");
      let run = await startChapterWorkflow({
        projectId,
        documentId: chapter1.id,
        threadId: thread.id,
        briefId: confirmedBrief.id,
        instruction: confirmedBrief.goal,
        blocking: true,
      });
      log("smoke", `paused at stage=${run.currentStage} status=${run.status}`);

      // 保存每阶段 artifact
      const dumpArtifacts = async (label: string) => {
        const artifacts = await novelDb.workflowArtifacts
          .where("workflowRunId").equals(run.id).sortBy("createdAt");
        ctx.writeOutput(`artifacts/${label}.json`, artifacts.map((a) => ({
          id: a.id, stage: a.stage, kind: a.kind, title: a.title,
          contentPreview: a.contentMarkdown?.slice(0, 400),
          contentLength: a.contentMarkdown?.length ?? 0,
          structuredDataKeys: a.structuredData ? Object.keys(a.structuredData) : [],
        })));
        // 关键正文产物单独保存
        for (const a of artifacts) {
          if (a.kind === "blueprint" || a.kind === "draft" || a.kind === "revision" || a.kind === "fact-delta" || a.kind === "review") {
            ctx.writeOutput(`artifacts/${label}-${a.stage}-${a.kind}.md`, a.contentMarkdown ?? "");
          }
        }
      };
      await dumpArtifacts("01-blueprint");

      if (run.status !== "waiting-approval" || run.currentStage !== "blueprint-approval") {
        throw new Error(`预期停在 blueprint-approval，实际：stage=${run.currentStage} status=${run.status} error=${run.error ?? "无"}`);
      }

      // 4. 批准蓝图 → manuscript-approval（draft → review → revision）
      log("smoke", "→ approve blueprint");
      run = await approveWorkflowStage(run.id, { approved: true });
      log("smoke", `paused at stage=${run.currentStage} status=${run.status} iteration=${run.revisionIteration}`);
      await dumpArtifacts("02-manuscript");

      if (run.status !== "waiting-approval" || run.currentStage !== "manuscript-approval") {
        throw new Error(`预期停在 manuscript-approval，实际：stage=${run.currentStage} status=${run.status} error=${run.error ?? "无"}`);
      }

      // 5. 读取并保存质量报告
      let qualityReport: { weightedScore?: number; blockerCount?: number; issues?: unknown[]; scores?: Record<string, number>; passed?: boolean } | undefined;
      if (run.qualityReportId) {
        qualityReport = await novelDb.qualityReports.get(run.qualityReportId);
        ctx.writeOutput("quality-report.json", qualityReport ?? {});
        if (qualityReport) {
          const dims = qualityReport.scores ? Object.keys(qualityReport.scores) : [];
          const avgScore = qualityReport.scores && dims.length
            ? Object.values(qualityReport.scores).reduce((a, b) => a + b, 0) / dims.length
            : 0;
          log("smoke", `quality: score=${qualityReport.weightedScore} avg=${avgScore.toFixed(2)} blockers=${qualityReport.blockerCount} issues=${qualityReport.issues?.length ?? 0}`);
        }
      }

      // 6. 批准正文 → fact-approval（fact-extraction）
      log("smoke", "→ approve manuscript");
      run = await approveWorkflowStage(run.id, { approved: true });
      log("smoke", `paused at stage=${run.currentStage} status=${run.status}`);
      await dumpArtifacts("03-fact");

      if (run.status !== "waiting-approval" || run.currentStage !== "fact-approval") {
        throw new Error(`预期停在 fact-approval，实际：stage=${run.currentStage} status=${run.status} error=${run.error ?? "无"}`);
      }

      // 7. 处理 fact candidates（safe 自动 + conflict 排除 + 剩余接受）
      const factCandidates = await novelDb.factCandidates.where("workflowRunId").equals(run.id).toArray();
      log("smoke", `fact candidates=${factCandidates.length}`);
      ctx.writeOutput("fact-candidates.json", factCandidates);

      const safeAcceptedIds = await autoAcceptSafeFactCandidates(factCandidates);
      log("smoke", `safe accepted=${safeAcceptedIds.length}`);

      const remainingCandidates = await novelDb.factCandidates
        .where("workflowRunId").equals(run.id)
        .and((c) => c.status === "pending").toArray();
      const conflictIds = remainingCandidates.filter((c) => c.conflict).map((c) => c.id);
      const highRiskAcceptIds = remainingCandidates.filter((c) => !c.conflict).map((c) => c.id);
      for (const id of conflictIds) await setFactCandidateStatus(id, "rejected");
      if (highRiskAcceptIds.length) await bulkSetFactCandidateStatus(highRiskAcceptIds, "accepted");
      log("smoke", `conflict rejected=${conflictIds.length} high-risk accepted=${highRiskAcceptIds.length}`);

      const decidedCandidates = await novelDb.factCandidates.where("workflowRunId").equals(run.id).toArray();
      ctx.writeOutput("fact-candidates-decided.json", decidedCandidates.map((c) => ({
        id: c.id, status: c.status, risk: c.risk, conflict: c.conflict, novelty: c.novelty,
        targetTable: c.targetTable, field: c.field, humanReadable: c.humanReadable, riskReason: c.riskReason,
      })));

      // 8. 批准事实 → completed（commit → character-enrichment）
      log("smoke", "→ approve facts");
      run = await approveWorkflowStage(run.id, { approved: true });
      log("smoke", `finished stage=${run.currentStage} status=${run.status}`);
      await dumpArtifacts("04-final");

      // 9. 输出指标汇总
      const finalDoc = await novelDb.documents.get(chapter1.id);
      const finalArtifact = run.draftArtifactId
        ? await novelDb.workflowArtifacts.get(run.draftArtifactId)
        : undefined;
      const wordCount = finalDoc?.wordCount
        ?? (finalArtifact?.contentMarkdown ? (finalArtifact.contentMarkdown.match(/[\u3400-\u9fff]|[a-zA-Z0-9]+/g) ?? []).length : 0);

      ctx.writeOutput("final.md", finalArtifact?.contentMarkdown ?? finalDoc?.plainText ?? "");
      ctx.writeOutput("final-document.json", finalDoc ?? {});

      const dimScores = qualityReport?.scores ?? {};
      const dimensions = Object.keys(dimScores);
      const avgScore = dimensions.length
        ? Object.values(dimScores).reduce((a, b) => a + b, 0) / dimensions.length
        : 0;

      ctx.setMetrics({
        wordCount,
        weightedScore: qualityReport?.weightedScore ?? 0,
        avgScore,
        blockerCount: qualityReport?.blockerCount ?? 0,
        majorCount: Array.isArray(qualityReport?.issues)
          ? (qualityReport.issues as Array<{ severity?: string }>).filter((i) => i.severity === "major").length
          : 0,
        warningCount: Array.isArray(qualityReport?.issues)
          ? (qualityReport.issues as Array<{ severity?: string }>).filter((i) => i.severity === "warning").length
          : 0,
        issueCount: qualityReport?.issues?.length ?? 0,
        revisionIteration: run.revisionIteration,
        factCandidateCount: factCandidates.length,
        factSafeAccepted: safeAcceptedIds.length,
        factConflictRejected: conflictIds.length,
        factHighRiskAccepted: highRiskAcceptIds.length,
      });
      ctx.setMeta({
        runId: run.id,
        currentStage: run.currentStage,
        status: run.status,
        projectId,
        documentId: chapter1.id,
        threadId: thread.id,
        briefId: confirmedBrief.id,
        povCharacterId: povCharacter?.id ?? null,
        chapterTitle: chapter1.title,
      });

      log("smoke", `done wordCount=${wordCount} stage=${run.currentStage} status=${run.status}`);

      // 验证完成状态
      expect(run.status).toBe("completed");
      expect(finalDoc?.status).toBe("final");
      expect(wordCount).toBeGreaterThan(1000);
    });
  });
});
