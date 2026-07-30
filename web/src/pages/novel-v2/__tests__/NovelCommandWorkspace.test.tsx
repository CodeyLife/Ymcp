import { renderToStaticMarkup } from "react-dom/server";
import { App, ConfigProvider, theme as antdTheme } from "antd";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import NovelV2Studio from "../../NovelV2Studio";
import NovelProductionWorkspace, {
  artifactsForStage,
  deriveChapterWorkspaceState,
  deriveCurrentProgressDetail,
  findInterruptedChapterReviewRun,
  deriveQuality,
  deriveStageStates,
  novelRunDocumentId,
} from "../NovelPipelineBoard";
import { novelKeys, type NovelChapterWorkspace, type NovelProjectDetail, type NovelWorkflowRunRecord } from "@/lib/novelApi";

vi.stubGlobal("fetch", vi.fn());

const project: NovelProjectDetail = {
  id: "p1",
  title: "长篇测试作品",
  currentRevision: 7,
  updatedAt: "2026-07-29T10:00:00.000Z",
  documents: [
    { id: "d1", title: "雨夜审问", narrativeOrder: 1, status: "final", blockingIssueCount: 0, arcTitle: "第一卷" },
    { id: "d2", title: "城门失守", narrativeOrder: 2, status: "review", blockingIssueCount: 2, arcTitle: "第一卷" },
  ],
};

const runs: NovelWorkflowRunRecord[] = [
  { id: "r-active", workflowType: "novel-intent", projectId: "p1", temporalWorkflowId: "wf-active", status: "running", payload: { documentId: "d2" }, createdAt: "2026-07-29T08:00:00.000Z", updatedAt: "2026-07-29T10:00:00.000Z" },
  { id: "r-failed", workflowType: "chapter-review", projectId: "p1", temporalWorkflowId: "wf-failed", status: "failed", payload: { documentId: "d2" }, createdAt: "2026-07-29T08:00:00.000Z", updatedAt: "2026-07-29T09:00:00.000Z" },
  { id: "r-review", workflowType: "chapter-review", projectId: "p1", temporalWorkflowId: "wf-review", status: "manual-review-required", payload: { documentId: "d1", artifactId: "a1" }, createdAt: "2026-07-29T08:00:00.000Z", updatedAt: "2026-07-29T08:30:00.000Z" },
];

function renderWorkspace(entry = "/novels/p1?view=overview&document=d1&run=wf-review") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(novelKeys.project("p1"), project);
  client.setQueryData(novelKeys.runs("p1"), runs);
  client.setQueryData(novelKeys.run("wf-review"), { workflowId: "wf-review", status: "manual-review-required", record: runs[2] });
  client.setQueryData(novelKeys.runEvents("wf-review"), []);
  client.setQueryData(novelKeys.runArtifacts("wf-review"), []);
  client.setQueryData(novelKeys.factCandidates("p1", "d1"), []);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <ConfigProvider theme={{ algorithm: antdTheme.darkAlgorithm }}><App>
        <MemoryRouter initialEntries={[entry]}><Routes><Route path="/novels/:projectId" element={<NovelV2Studio />} /></Routes></MemoryRouter>
      </App></ConfigProvider>
    </QueryClientProvider>,
  );
}

function renderProduction() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(novelKeys.project("p1"), project);
  client.setQueryData(novelKeys.runs("p1"), runs);
  client.setQueryData(novelKeys.run("wf-review"), { workflowId: "wf-review", status: "manual-review-required", record: runs[2] });
  client.setQueryData(novelKeys.runEvents("wf-review"), []);
  client.setQueryData(novelKeys.runArtifacts("wf-review"), []);
  client.setQueryData(novelKeys.factCandidates("p1", "d1"), []);
  return renderToStaticMarkup(<QueryClientProvider client={client}><ConfigProvider theme={{ algorithm: antdTheme.darkAlgorithm }}><App><MemoryRouter><NovelProductionWorkspace embedded projectId="p1" documentId="d1" workflowId="wf-review" stage="review" /></MemoryRouter></App></ConfigProvider></QueryClientProvider>);
}

function renderRunningProduction() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(novelKeys.project("p1"), project);
  client.setQueryData(novelKeys.runs("p1"), runs);
  client.setQueryData(novelKeys.run("wf-active"), { workflowId: "wf-active", status: "running", record: runs[0] });
  client.setQueryData(novelKeys.runEvents("wf-active"), []);
  client.setQueryData(novelKeys.runArtifacts("wf-active"), []);
  return renderToStaticMarkup(<QueryClientProvider client={client}><ConfigProvider theme={{ algorithm: antdTheme.darkAlgorithm }}><App><MemoryRouter><NovelProductionWorkspace embedded projectId="p1" documentId="d2" /></MemoryRouter></App></ConfigProvider></QueryClientProvider>);
}

function renderInterruptedRepairProduction() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const interrupted = { ...runs[1], temporalWorkflowId: "wf-targeted-cancelled", status: "cancelled", payload: { documentId: "d1", mode: "targeted", targetIssueIds: ["issue-1", "issue-2"] }, updatedAt: "2026-07-29T09:00:00.000Z" };
  const accidentalCreation = { ...runs[0], temporalWorkflowId: "wf-creation-cancelled", status: "cancelled", payload: { intent: { target: { kind: "chapter", id: "d1" } } }, updatedAt: "2026-07-29T10:00:00.000Z" };
  client.setQueryData(novelKeys.project("p1"), project);
  client.setQueryData(novelKeys.runs("p1"), [interrupted, accidentalCreation]);
  client.setQueryData(novelKeys.run("wf-creation-cancelled"), { workflowId: "wf-creation-cancelled", status: "cancelled", record: accidentalCreation });
  client.setQueryData(novelKeys.runEvents("wf-creation-cancelled"), []);
  client.setQueryData(novelKeys.runArtifacts("wf-creation-cancelled"), []);
  client.setQueryData(novelKeys.factCandidates("p1", "d1"), []);
  return renderToStaticMarkup(<QueryClientProvider client={client}><ConfigProvider theme={{ algorithm: antdTheme.darkAlgorithm }}><App><MemoryRouter><NovelProductionWorkspace embedded projectId="p1" documentId="d1" /></MemoryRouter></App></ConfigProvider></QueryClientProvider>);
}

function renderReviewedFinalProduction() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const workspace: NovelChapterWorkspace = {
    document: project.documents[0],
    content: { revisionId: "rev-1", revision: 8, contentHash: "hash-1", byteLength: 120, plainText: "第一段。\n\n第二段。" },
    spec: { chapterGoal: "测试章节", blueprint: {}, blueprintFingerprint: "bp" },
    review: {
      id: "review-1",
      reviewedContentHash: "hash-1",
      artifactFingerprint: "artifact-1",
      verdict: "revise",
      complete: true,
      overallScore: 4.1,
      dimensionScores: { readerRetention: 4.1 },
      reviewerRoles: ["reader-reviewer"],
      reviewedAt: "2026-07-29T09:00:00.000Z",
      stale: false,
      issues: [
        { id: "issue-1", fingerprint: "fp-1", severity: "major", title: "人物反应太直白", evidenceQuote: "第二段。", paragraph: 2, revisionRanges: [{ start: 2, end: 2 }], suggestion: "改为动作呈现", sourceRoles: ["reader-reviewer"], status: "pending", updatedAt: "2026-07-29T09:00:00.000Z" },
        { id: "issue-2", fingerprint: "fp-2", severity: "warning", title: "已处理的节奏问题", evidenceQuote: "第一段。", paragraph: 1, revisionRanges: [{ start: 1, end: 1 }], suggestion: "保留", sourceRoles: ["author"], status: "resolved", updatedAt: "2026-07-29T09:00:00.000Z" },
      ],
    },
    versions: [],
  };
  client.setQueryData(novelKeys.project("p1"), project);
  client.setQueryData(novelKeys.runs("p1"), []);
  client.setQueryData(novelKeys.chapterWorkspace("p1", "d1"), workspace);
  return renderToStaticMarkup(<QueryClientProvider client={client}><ConfigProvider theme={{ algorithm: antdTheme.darkAlgorithm }}><App><MemoryRouter><NovelProductionWorkspace embedded projectId="p1" documentId="d1" /></MemoryRouter></App></ConfigProvider></QueryClientProvider>);
}

describe("Novel command workspace", () => {
  it("derives author-facing chapter states from the latest related run", () => {
    const planned = { id: "planned", title: "未开始", narrativeOrder: 3, status: "planned" };
    const final = { id: "final", title: "已定稿", narrativeOrder: 4, status: "final" };
    expect(deriveChapterWorkspaceState(planned, []).mode).toBe("planned");
    expect(deriveChapterWorkspaceState(final, []).mode).toBe("final");
    expect(deriveChapterWorkspaceState({ ...planned, status: "draft" }, []).mode).toBe("stalled");

    const oldFailure = { ...runs[1], id: "old", temporalWorkflowId: "wf-old", payload: { documentId: "planned" }, updatedAt: "2026-07-29T08:00:00.000Z" };
    const currentRun = { ...runs[0], id: "new", temporalWorkflowId: "wf-new", payload: { documentId: "planned" }, updatedAt: "2026-07-29T11:00:00.000Z" };
    expect(deriveChapterWorkspaceState(planned, [oldFailure, currentRun])).toMatchObject({ mode: "running", latestRun: currentRun });

    const interruptedRepair = { ...runs[1], temporalWorkflowId: "wf-repair-failed", payload: { documentId: "final", mode: "targeted", targetIssueIds: ["issue-1"] } };
    expect(deriveChapterWorkspaceState(final, [interruptedRepair])).toMatchObject({ mode: "final", latestRun: interruptedRepair });
  });

  it("recovers the latest interrupted targeted review independently from later creation runs", () => {
    const interrupted = { ...runs[1], temporalWorkflowId: "wf-targeted", status: "cancelled", payload: { documentId: "d1", mode: "targeted", targetIssueIds: ["issue-1", "issue-2"] }, updatedAt: "2026-07-29T09:00:00.000Z" };
    const accidentalCreation = { ...runs[0], temporalWorkflowId: "wf-creation", status: "cancelled", payload: { intent: { target: { kind: "chapter", id: "d1" } } }, updatedAt: "2026-07-29T10:00:00.000Z" };
    expect(findInterruptedChapterReviewRun("d1", [interrupted, accidentalCreation])).toBe(interrupted);

    const completedRepair = { ...interrupted, temporalWorkflowId: "wf-targeted-completed", status: "completed", updatedAt: "2026-07-29T11:00:00.000Z" };
    expect(findInterruptedChapterReviewRun("d1", [interrupted, accidentalCreation, completedRepair])).toBeUndefined();
  });

  it("separates manuscript and fact approval before other chapter states", () => {
    const document = { id: "review", title: "待审", narrativeOrder: 5, status: "final" };
    const manuscript = { ...runs[2], payload: { documentId: "review", reasonCode: "quality-gate-not-passed" } };
    const facts = { ...runs[2], payload: { documentId: "review", reasonCode: "fact-approval-pending" } };
    expect(deriveChapterWorkspaceState(document, [manuscript]).mode).toBe("manuscript-review");
    expect(deriveChapterWorkspaceState(document, [facts]).mode).toBe("fact-review");
  });

  it("binds intent runs to their target chapter and marks preflight failures on context", () => {
    const failedRun = {
      workflowId: "wf-failed",
      status: "failed",
      record: {
        ...runs[1],
        payload: { error: "高风险任务缺少记忆维度（关键）：fact", intent: { target: { kind: "chapter", id: "d2" } } },
      },
    };
    expect(novelRunDocumentId(failedRun.record)).toBe("d2");
    expect(deriveStageStates(failedRun, []).context).toBe("failed");

    const approvedRun = {
      workflowId: "wf-approved",
      status: "running",
      record: { ...runs[2], status: "running", payload: { documentId: "d1", stage: "author-decision-submitted" } },
    };
    expect(deriveStageStates(approvedRun, []).context).toBe("done");
    expect(deriveStageStates(approvedRun, [])["fact-extraction"]).toBe("active");

    const revisingRun = {
      ...approvedRun,
      record: { ...approvedRun.record, payload: { documentId: "d1", stage: "author-decision-submitted", pendingHumanDecision: { decision: "revise" } } },
    };
    expect(deriveStageStates(revisingRun, []).revision).toBe("active");
  });

  it("summarizes the latest running workflow progress without a generic busy state", () => {
    const detail = deriveCurrentProgressDetail(
      { ...runs[0], payload: { documentId: "d2", stage: "review" } },
      [{ id: "draft", projectId: "p1", taskId: "bp:draft", kind: "draft" }],
      [{ id: "rv-style", artifactId: "draft", reviewerId: "style", identity: "internal", verdict: "passed", role: "style-reviewer", issues: [], createdAt: 1 }],
      [{ eventType: "workflow.running", payload: { stage: "review" }, createdAt: "2026-07-29T10:00:00.000Z" }],
    );
    expect(detail.stageLabel).toBe("专业审校");
    expect(detail.title).toContain("审校");
    expect(detail.facts).toContain("1 个产物");
    expect(detail.facts).toContain("1 位审校已返回");
  });

  it("uses persisted reviewer scores and issues for the concrete quality report", () => {
    const quality = deriveQuality(
      { workflowId: "wf-review", status: "completed", record: { ...runs[2], payload: { finalScore: 4.2 } } },
      [{ id: "summary-1", projectId: "p1", taskId: "draft:reflection", kind: "summary", structuredData: { critique: { issues: [{ severity: "major", dimension: "plot", title: "因果跳步" }] } } }],
      [
        { id: "rv-style", artifactId: "a1", reviewerId: "internal-style", identity: "internal", verdict: "passed", role: "style-reviewer", score: 4.5, issues: [], createdAt: 1 },
        { id: "rv-plot", artifactId: "a1", reviewerId: "internal-plot", identity: "internal", verdict: "revise", role: "plot-reviewer", score: 3.5, issues: [{ severity: "major", dimension: "plot", title: "因果跳步" }], createdAt: 2 },
      ],
    );
    expect(quality.overall).toBe(4.2);
    expect(quality.dims.find((item) => item.key === "sceneEmbodiment")?.score).toBe(4.5);
    expect(quality.dims.find((item) => item.key === "hookPayoff")?.score).toBe(3.5);
    expect(quality.issues).toHaveLength(1);
  });

  it("shows only artifacts related to the selected workflow stage", () => {
    const artifacts = [
      { id: "draft", projectId: "p1", taskId: "bp:draft", kind: "draft" },
      { id: "review", projectId: "p1", taskId: "bp:draft:reflection", kind: "summary" },
      { id: "revision", projectId: "p1", taskId: "bp:draft:revise", kind: "revision" },
    ];
    expect(artifactsForStage("review", artifacts).map((item) => item.id)).toEqual(["review"]);
    expect(artifactsForStage("manuscript-approval", artifacts).map((item) => item.id)).toEqual(["revision"]);
  });

  it("defaults to the operational overview and prioritizes human review before failures and active runs", () => {
    const html = renderWorkspace();
    expect(html).toContain("小说创作指挥台");
    expect(html).toContain("作品工作区");
    expect(html).toContain("长篇测试作品");
    expect(html.indexOf("作品工作区")).toBeLessThan(html.indexOf("总览"));
    expect(html).toContain("先处理会阻塞创作的事项");
    expect(html.indexOf("等待作者审批")).toBeLessThan(html.indexOf("运行异常"));
    expect(html.indexOf("运行异常")).toBeLessThan(html.indexOf("工作流执行中"));
    expect(html).toContain("批准并继续");
  });

  it("renders chapter production inside the unified workspace from URL state", () => {
    const html = renderWorkspace("/novels/p1?view=production&document=d1&run=wf-review&stage=review");
    expect(html).toContain("章节生产");
    expect(html).not.toContain("工作流全景");
    const productionHtml = renderProduction();
    expect(productionHtml).toContain("候选正文");
    expect(productionHtml).not.toContain("工作流内审批");
    expect(productionHtml).toContain("接受当前稿并定稿");
    expect(productionHtml).toContain("补充修改意见（可选）");
    expect(productionHtml).toContain("查看工作流");
    expect(productionHtml).not.toContain("运行详情");
    expect(productionHtml).not.toContain("11 阶段");
  });

  it("keeps an explicit cancellation path while a chapter workflow is running", () => {
    expect(renderRunningProduction()).toContain("取消本次运行");
  });

  it("keeps the formal manuscript visible and offers targeted recovery after an interrupted repair", () => {
    const html = renderInterruptedRepairProduction();
    expect(html).toContain("原文未变");
    expect(html).toContain("按原意见重新修复");
    expect(html).toContain("查看原文与建议");
    expect(html).toContain("关闭提示");
    expect(html).not.toContain("重新发起创作");
  });

  it("accepts supplemental author direction alongside selected review issues", () => {
    const html = renderInterruptedRepairProduction();
    expect(html).toContain("补充修改要求");
    expect(html).toContain("结合勾选的审核意见");
  });

  it("lets authors add review issues and regenerate from all pending issues", () => {
    const html = renderReviewedFinalProduction();
    expect(html).toContain("添加审核意见");
    expect(html).toContain("段落（可选）");
    expect(html).toContain("人物反应太直白");
    expect(html).toContain("一键重新生成");
    expect(html).toContain("待处理 1 条");
  });
});
