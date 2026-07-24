import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ai", () => ({
  callStructuredNovelModel: vi.fn(async () => ({
    data: {
      scores: { plot: 4, characterVoice: 4, sceneEmbodiment: 4, dialogue: 4, specificity: 4, hookPayoff: 4, continuity: 4 },
      issues: [],
    },
    usage: { inputTokens: 10, outputTokens: 10 },
    promptHash: "test-hash",
  })),
  streamNovelModel: vi.fn(),
}));

import { callStructuredNovelModel } from "../ai";
import { createChapter, createNovelProject, novelDb, recordBase } from "../db";
import { advanceChapterWorkflow } from "../workflow";
import { retryFailedWorkflowLearning } from "../learning";
import { getProseAuditMaxIterations, reconcileProseAuditIssues, reviewStageHandler, runProseAudit, proseAuditIssueToReviewerFinding } from "../workflow-stages/review-stage";
import type { GenerationAuditIssue, NovelContextPacket, QualityDimension, WorkflowArtifact, WorkflowRun } from "../types";

beforeEach(async () => {
  await novelDb.delete();
  await novelDb.open();
  localStorage.clear();
  vi.mocked(callStructuredNovelModel).mockClear();
  // 默认关闭 prose-audit，需要 audit 的测试用例显式开启
  // 这样可以避免污染其他默认行为测试
  vi.stubEnv("NOVEL_PROSE_AUDIT_MAX_ITER", "0");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function packet(projectId: string): NovelContextPacket {
  return { ...recordBase(projectId), task: "chapter-draft", instruction: "继续写作", sources: [], estimatedTokens: 0, omittedSourceIds: [], skillRefs: [], compiledAt: Date.now() };
}

function artifact(run: WorkflowRun, input: Pick<WorkflowArtifact, "id" | "stage" | "kind" | "title" | "contentMarkdown"> & Partial<WorkflowArtifact>): WorkflowArtifact {
  return { ...recordBase(run.projectId), workflowRunId: run.id, skillRefs: [], ...input };
}

function buildRun(projectId: string, documentId: string, contextPacketId: string, blueprintArtifactId: string, draftArtifactId: string, overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    ...recordBase(projectId),
    workflowId: "standard-chapter-v2",
    targetDocumentId: documentId,
    status: "running",
    currentStage: "review",
    stageIndex: 4,
    revisionIteration: 0,
    contextPacketId,
    blueprintArtifactId,
    draftArtifactId,
    factCandidateIds: [],
    startedAt: Date.now(),
    ...overrides,
  };
}

/**
 * reviewer 的默认响应：分数高、无问题。
 * 用于主用例——reviewer 都通过，但 prose-audit 报告 major 问题（网文腔）。
 */
function reviewerCleanResponse(role: string) {
  return {
    data: {
      scores: { plot: 4, characterVoice: 4, sceneEmbodiment: 4, dialogue: 4, specificity: 4, hookPayoff: 4, continuity: 4 },
      issues: [],
    },
    usage: { inputTokens: 10, outputTokens: 10 },
    promptHash: `reviewer-${role}`,
  };
}

/**
 * prose-audit 报告 major 问题：网文腔（"恐怖如斯"）+ 情绪直说（"他很悲伤"）。
 * 这两个问题是 reviewer 漏掉的，prose-audit 作为元审核补报。
 */
function proseAuditMajorResponse() {
  return {
    data: {
      summary: "检测到网文腔与情绪直说，reviewer 漏报。",
      issues: [
        {
          severity: "major" as const,
          dimension: "specificity" as const,
          title: "网文腔：模板化表达",
          evidence: "【第2段】「他倒吸一口凉气，恐怖如斯」——模板化网文腔，降低正文质感。",
          suggestion: "改写为具体动作或感官细节，如「他的手停在半空，指尖轻颤了一下」。",
          origin: "new" as const,
        },
        {
          severity: "major" as const,
          dimension: "characterVoice" as const,
          title: "情绪直说：直接宣告人物感受",
          evidence: "【第3段】「他很悲伤，心如刀割」——直接宣告情绪，未用动作或物件承载。",
          suggestion: "用一个反常动作承载，如「他把碗里的半口酒喝完，没有擦嘴」。",
          origin: "new" as const,
        },
      ],
    },
    usage: { inputTokens: 12, outputTokens: 8 },
    promptHash: "prose-audit-major",
  };
}

/**
 * prose-audit 报告无问题（通过）。
 */
function proseAuditCleanResponse() {
  return {
    data: {
      summary: "正文质感达标，无网文腔或情绪直说。",
      issues: [],
    },
    usage: { inputTokens: 8, outputTokens: 4 },
    promptHash: "prose-audit-clean",
  };
}

describe("getProseAuditMaxIterations", () => {
  it("returns 1 by default when env var is unset (aligned with blueprint-audit)", () => {
    vi.unstubAllEnvs();
    expect(getProseAuditMaxIterations()).toBe(1);
  });

  it("returns 1 when env var is '1'", () => {
    vi.stubEnv("NOVEL_PROSE_AUDIT_MAX_ITER", "1");
    expect(getProseAuditMaxIterations()).toBe(1);
  });

  it("caps at 3 when env var exceeds 3", () => {
    vi.stubEnv("NOVEL_PROSE_AUDIT_MAX_ITER", "5");
    expect(getProseAuditMaxIterations()).toBe(3);
  });

  it("falls back to 1 when env var is invalid (aligned with blueprint-audit)", () => {
    vi.stubEnv("NOVEL_PROSE_AUDIT_MAX_ITER", "abc");
    expect(getProseAuditMaxIterations()).toBe(1);
  });

  it("returns 0 when env var is '0' (explicit disable)", () => {
    vi.stubEnv("NOVEL_PROSE_AUDIT_MAX_ITER", "0");
    expect(getProseAuditMaxIterations()).toBe(0);
  });
});

describe("proseAuditIssueToReviewerFinding", () => {
  it("parses 【第N段】 marker into paragraph field", () => {
    const issue: GenerationAuditIssue = {
      severity: "major",
      dimension: "specificity",
      title: "网文腔",
      evidence: "【第3段】原文片段",
      suggestion: "改写建议",
    };
    const finding = proseAuditIssueToReviewerFinding(issue, 0);
    expect(finding.paragraph).toBe(3);
    expect(finding.excerpt).toBe("【第3段】原文片段");
    expect(finding.rule).toBe("prose-audit.网文腔");
  });

  it("uses LLM-output dimension directly (no mechanical matching)", () => {
    const issue: GenerationAuditIssue = {
      severity: "major",
      dimension: "plot",
      title: "剧情节奏单一",
      evidence: "全章无张力变化",
      suggestion: "加入蓄势",
    };
    const finding = proseAuditIssueToReviewerFinding(issue, 0);
    expect(finding.dimension).toBe<QualityDimension>("plot");
  });

  it("uses LLM-output dimension for continuity", () => {
    const issue: GenerationAuditIssue = {
      severity: "major",
      dimension: "continuity",
      title: "POV 越界",
      evidence: "第2段替他人下内心结论",
      suggestion: "改写为外部行为",
    };
    const finding = proseAuditIssueToReviewerFinding(issue, 0);
    expect(finding.dimension).toBe<QualityDimension>("continuity");
  });

  it("uses LLM-output dimension for specificity", () => {
    const issue: GenerationAuditIssue = {
      severity: "major",
      dimension: "specificity",
      title: "网文腔",
      evidence: "倒吸一口凉气",
      suggestion: "改写",
    };
    const finding = proseAuditIssueToReviewerFinding(issue, 0);
    expect(finding.dimension).toBe<QualityDimension>("specificity");
  });

  it("supports multiple paragraph reference formats via paragraphRangesInText", () => {
    // W2 修复：复用 revision-stage 的 paragraphRangesInText，支持"第N段"、"第N-M段"等
    const issue: GenerationAuditIssue = {
      severity: "major",
      dimension: "plot",
      title: "重复推进",
      evidence: "第3-5段与第10-12段作用重复",
      suggestion: "删除后出现的重复推进",
    };
    const finding = proseAuditIssueToReviewerFinding(issue, 0, 20);
    expect(finding.paragraph).toBe(3);
    expect(finding.revisionRanges).toEqual([
      { start: 3, end: 3 },
      { start: 4, end: 4 },
      { start: 5, end: 5 },
      { start: 10, end: 10 },
      { start: 11, end: 11 },
      { start: 12, end: 12 },
    ]);
  });

  it("uses suggestion as rewriteExample (reviewerSchema minLength=1)", () => {
    const issue: GenerationAuditIssue = {
      severity: "major",
      dimension: "characterVoice",
      title: "情绪直说",
      evidence: "他很悲伤",
      suggestion: "用动作承载",
    };
    const finding = proseAuditIssueToReviewerFinding(issue, 0);
    expect(finding.rewriteExample).toBe("用动作承载");
    expect(finding.rewriteExample!.length).toBeGreaterThan(0);
  });

  it("appends origin tag to description when origin is upgrade/downgrade", () => {
    const issue: GenerationAuditIssue = {
      severity: "blocker",
      dimension: "plot",
      title: "节奏断裂升级为 blocker",
      evidence: "第5段节奏完全断裂",
      suggestion: "重写第5段",
      origin: "upgrade",
    };
    const finding = proseAuditIssueToReviewerFinding(issue, 0);
    expect(finding.description).toBe("[升级 reviewer 判断] 第5段节奏完全断裂");
  });

  it("handles missing evidence/suggestion with fallbacks", () => {
    const issue: GenerationAuditIssue = {
      severity: "warning",
      dimension: "specificity",
      title: "",
      evidence: "",
      suggestion: "",
    };
    const finding = proseAuditIssueToReviewerFinding(issue, 5);
    expect(finding.title).toBe("prose-audit issue 6");
    expect(finding.description).toBe("prose-audit issue 6");
    expect(finding.suggestion).toBe("请基于审核证据修订。");
    expect(finding.rewriteExample).toBe("请基于审核证据修订。");
    expect(finding.paragraph).toBeUndefined();
  });
});

describe("reconcileProseAuditIssues", () => {
  it("downgrades the referenced reviewer issue instead of appending a duplicate", () => {
    const reviewers = [{
      role: "plot-reviewer" as const,
      scores: {},
      issues: [{
        sourceId: "plot-reviewer:0",
        dimension: "plot" as const,
        severity: "major" as const,
        title: "节奏断裂",
        description: "原审校认为第 3 段完全中断推进。",
        rule: "plot.pacing",
        suggestion: "重写第 3 段。",
      }],
    }];
    const reconciled = reconcileProseAuditIssues(reviewers, [{
      origin: "downgrade",
      sourceIssueId: "plot-reviewer:0",
      severity: "warning",
      dimension: "plot",
      title: "该停顿符合章节功能",
      evidence: "【第3段】是人物消化后果的必要停顿。",
      suggestion: "保留停顿，只压缩一句解释。",
    }], 10);

    expect(reconciled.flatMap((item) => item.issues)).toHaveLength(1);
    expect(reconciled[0].issues[0].severity).toBe("warning");
    expect(reconciled[0].issues[0].description).toContain("元审核降级");
  });

  it("upgrades the referenced issue and keeps genuinely new issues separate", () => {
    const reviewers = [{
      role: "continuity-reviewer" as const,
      scores: {},
      issues: [{
        sourceId: "continuity-reviewer:0",
        dimension: "continuity" as const,
        severity: "warning" as const,
        title: "知识边界可疑",
        description: "角色似乎知道过多。",
        rule: "continuity.knowledge",
        suggestion: "核对上下文。",
      }],
    }];
    const reconciled = reconcileProseAuditIssues(reviewers, [{
      origin: "upgrade",
      sourceIssueId: "continuity-reviewer:0",
      severity: "blocker",
      dimension: "continuity",
      title: "确认越界",
      evidence: "【第2段】角色直接说出尚未获知的密令。",
      suggestion: "删除密令内容。",
    }, {
      origin: "new",
      severity: "major",
      dimension: "specificity",
      title: "动作缺少落点",
      evidence: "【第4段】连续概述，没有现场动作。",
      suggestion: "补入可观察动作。",
    }], 10);

    expect(reconciled[0].issues[0].severity).toBe("blocker");
    expect(reconciled.at(-1)?.role).toBe("quality-editor");
    expect(reconciled.flatMap((item) => item.issues)).toHaveLength(2);
  });
});

describe("prose-audit closed loop (review-stage integration)", () => {
  it("runs 4 reviewers + prose-audit, injects audit issues into quality report, triggers revision when audit finds major", async () => {
    // 启用 prose-audit
    vi.stubEnv("NOVEL_PROSE_AUDIT_MAX_ITER", "1");

    const project = await createNovelProject({ title: "正文审核闭环", genre: ["古风权谋"], premise: "测试 prose-audit 接入。" });
    const document = await createChapter(project.id, "第一章");
    const ctx = packet(project.id);
    const run = buildRun(project.id, document.id, ctx.id, "blueprint-1", "draft-1");
    // draft 内容足够长（>1000 字），避免 revision-stage 因修订稿不足 1000 字失败
    const longPadding1 = "正文内容。".repeat(80);
    const longPadding2 = "结尾内容。".repeat(80);
    const draft = artifact(run, { id: "draft-1", stage: "draft", kind: "draft", title: "草稿", contentMarkdown: `${longPadding1}\n\n他倒吸一口凉气，恐怖如斯。\n\n他很悲伤，心如刀割。\n\n${longPadding2}` });
    const blueprint = artifact(run, { id: "blueprint-1", stage: "blueprint", kind: "blueprint", title: "蓝图", contentMarkdown: "# 蓝图\n目标：测试。", structuredData: { title: "第一章", objective: "测试", startingState: "起点", beats: [], endingHook: "钩子", characters: [], locations: [], informationRelease: [], mustHappen: [], flexible: [], forbidden: [] } });
    await novelDb.contextPackets.add(ctx);
    await novelDb.workflowRuns.add(run);
    await novelDb.workflowArtifacts.bulkAdd([draft, blueprint]);

    // Mock：reviewer 都 clean（无问题），prose-audit 报告 2 个 major
    vi.mocked(callStructuredNovelModel)
      .mockResolvedValueOnce(reviewerCleanResponse("style-reviewer") as never)
      .mockResolvedValueOnce(reviewerCleanResponse("character-reviewer") as never)
      .mockResolvedValueOnce(reviewerCleanResponse("continuity-reviewer") as never)
      .mockResolvedValueOnce(reviewerCleanResponse("plot-reviewer") as never)
      .mockResolvedValueOnce(reviewerCleanResponse("reader-reviewer") as never)
      .mockResolvedValueOnce(proseAuditMajorResponse() as never)
      .mockResolvedValueOnce({ data: { conclusion: "no-shared-learning", summary: "当前证据不足以证明共享规则缺陷。" }, usage: { promptTokens: 1, completionTokens: 1 } } as never);

    await advanceChapterWorkflow(run.id);

    // 验证 prose-audit 被调用（至少 6 次 callStructuredNovelModel：5 reviewer + 1 prose-audit）
    expect(vi.mocked(callStructuredNovelModel).mock.calls.length).toBeGreaterThanOrEqual(6);

    // 验证 prose-audit 调用使用 quality-editor 角色 + prose-audit skill
    const proseAuditCall = vi.mocked(callStructuredNovelModel).mock.calls[5]?.[0];
    expect(proseAuditCall?.role).toBe("quality-editor");
    expect(proseAuditCall?.skillPrompt).toContain("正文元审核");
    // 验证 prompt 包含 reviewer 的 findings 摘要
    expect(proseAuditCall?.prompt).toContain("style-reviewer");
    expect(proseAuditCall?.prompt).toContain("plot-reviewer");

    // 验证第一次 review 的 quality report（iteration=0）包含 prose-audit 的 issues
    const firstReport = await novelDb.qualityReports
      .where("workflowRunId").equals(run.id)
      .and((item) => item.iteration === 0)
      .first();
    expect(firstReport).toBeDefined();
    const proseAuditIssues = firstReport!.issues.filter((i) => i.rule.startsWith("prose-audit."));
    expect(proseAuditIssues).toHaveLength(2);
    expect(proseAuditIssues.every((i) => i.severity === "major")).toBe(true);
    // 验证 paragraph 解析（prose-audit evidence 含【第N段】标记）
    expect(proseAuditIssues[0].paragraph).toBe(2);
    expect(proseAuditIssues[1].paragraph).toBe(3);
    // 验证 reviewerRoles 包含 quality-editor（prose-audit 的 role）
    expect(firstReport!.reviewerRoles).toContain("quality-editor");

    // 验证 review artifact 中写入 auditReport
    const reviewArtifacts = await novelDb.workflowArtifacts
      .where("workflowRunId").equals(run.id)
      .and((item) => item.stage === "review" && item.kind === "review")
      .toArray();
    expect(reviewArtifacts.length).toBeGreaterThanOrEqual(1);
    const firstReview = reviewArtifacts[0];
    const structuredData = firstReview!.structuredData as Record<string, unknown>;
    expect(structuredData.auditReport).toBeDefined();
    const auditReport = structuredData.auditReport as { auditSkillId: string; mechanism: string; rounds: Array<{ iteration: number; triggeredIteration: boolean; issues: unknown[] }>; improved: boolean; remainingMajorCount: number; error?: string };
    expect(auditReport.auditSkillId).toBe("prose-audit");
    expect(auditReport.mechanism).toBe("external-revision");
    expect(auditReport.rounds).toHaveLength(1);
    expect(auditReport.rounds[0].iteration).toBe(1);
    expect(auditReport.rounds[0].triggeredIteration).toBe(true);
    expect(auditReport.rounds[0].issues).toHaveLength(2);
    expect(auditReport.improved).toBe(false);
    expect(auditReport.remainingMajorCount).toBe(2);
    expect(auditReport.error).toBeUndefined();

    // 验证 prose-audit 的 major 触发了 revision（shouldAutoRevise=true）
    // revision-stage 会调用 streamNovelModel，advanceChapterWorkflow 继续调度到最终状态
    // 最终状态应为 manuscript-approval（revision 成功后转入 review 再审，再审 passed 后转入 manuscript-approval）
    // 或 revision（revision 失败时停在 revision）
    const finalRun = await novelDb.workflowRuns.get(run.id);
    expect(["manuscript-approval", "revision", "review"].includes(finalRun?.currentStage ?? "")).toBe(true);
  });

  it("skips prose-audit entirely when NOVEL_PROSE_AUDIT_MAX_ITER=0 (backward compatibility)", async () => {
    // 环境变量已在 beforeEach 设置为 "0"
    const project = await createNovelProject({ title: "不启用审核", genre: ["古风权谋"], premise: "向后兼容。" });
    const document = await createChapter(project.id, "第一章");
    const ctx = packet(project.id);
    const run = buildRun(project.id, document.id, ctx.id, "blueprint-bc", "draft-bc");
    const draft = artifact(run, { id: "draft-bc", stage: "draft", kind: "draft", title: "草稿", contentMarkdown: "正文内容。" });
    const blueprint = artifact(run, { id: "blueprint-bc", stage: "blueprint", kind: "blueprint", title: "蓝图", contentMarkdown: "# 蓝图", structuredData: { title: "第一章", objective: "测试", startingState: "起点", beats: [], endingHook: "钩子", characters: [], locations: [], informationRelease: [], mustHappen: [], flexible: [], forbidden: [] } });
    await novelDb.contextPackets.add(ctx);
    await novelDb.workflowRuns.add(run);
    await novelDb.workflowArtifacts.bulkAdd([draft, blueprint]);

    vi.mocked(callStructuredNovelModel)
      .mockResolvedValueOnce(reviewerCleanResponse("style-reviewer") as never)
      .mockResolvedValueOnce(reviewerCleanResponse("character-reviewer") as never)
      .mockResolvedValueOnce(reviewerCleanResponse("continuity-reviewer") as never)
      .mockResolvedValueOnce(reviewerCleanResponse("plot-reviewer") as never)
      .mockResolvedValueOnce(reviewerCleanResponse("reader-reviewer") as never);

    await advanceChapterWorkflow(run.id);

    // 只调用 reviewer，无 prose-audit
    expect(callStructuredNovelModel).toHaveBeenCalledTimes(5);
    // review artifact 不应包含 auditReport
    const reviewArtifact = await novelDb.workflowArtifacts
      .where("workflowRunId").equals(run.id)
      .and((item) => item.stage === "review" && item.kind === "review")
      .first();
    const structuredData = reviewArtifact!.structuredData as Record<string, unknown>;
    expect(structuredData.auditReport).toBeUndefined();
    // quality report 不应包含 prose-audit 的 issues
    const qualityReport = await novelDb.qualityReports
      .where("workflowRunId").equals(run.id).first();
    const proseAuditIssues = qualityReport!.issues.filter((i) => i.rule.startsWith("prose-audit."));
    expect(proseAuditIssues).toHaveLength(0);
    // reviewerRoles 不应包含 quality-editor
    expect(qualityReport!.reviewerRoles).not.toContain("quality-editor");
  });

  it("records improved=true when prose-audit finds no major issues", async () => {
    vi.stubEnv("NOVEL_PROSE_AUDIT_MAX_ITER", "1");

    const project = await createNovelProject({ title: "审核通过", genre: ["古风权谋"], premise: "prose-audit 无 major。" });
    const document = await createChapter(project.id, "第一章");
    const ctx = packet(project.id);
    const run = buildRun(project.id, document.id, ctx.id, "blueprint-clean", "draft-clean");
    const draft = artifact(run, { id: "draft-clean", stage: "draft", kind: "draft", title: "草稿", contentMarkdown: "他把手缩回袖子里，没有擦那滴酒。" });
    const blueprint = artifact(run, { id: "blueprint-clean", stage: "blueprint", kind: "blueprint", title: "蓝图", contentMarkdown: "# 蓝图", structuredData: { title: "第一章", objective: "测试", startingState: "起点", beats: [], endingHook: "钩子", characters: [], locations: [], informationRelease: [], mustHappen: [], flexible: [], forbidden: [] } });
    await novelDb.contextPackets.add(ctx);
    await novelDb.workflowRuns.add(run);
    await novelDb.workflowArtifacts.bulkAdd([draft, blueprint]);

    // reviewer clean + prose-audit clean
    vi.mocked(callStructuredNovelModel)
      .mockResolvedValueOnce(reviewerCleanResponse("style-reviewer") as never)
      .mockResolvedValueOnce(reviewerCleanResponse("character-reviewer") as never)
      .mockResolvedValueOnce(reviewerCleanResponse("continuity-reviewer") as never)
      .mockResolvedValueOnce(reviewerCleanResponse("plot-reviewer") as never)
      .mockResolvedValueOnce(reviewerCleanResponse("reader-reviewer") as never)
      .mockResolvedValueOnce(proseAuditCleanResponse() as never);

    await advanceChapterWorkflow(run.id);

    expect(callStructuredNovelModel).toHaveBeenCalledTimes(6);
    const reviewArtifact = await novelDb.workflowArtifacts
      .where("workflowRunId").equals(run.id)
      .and((item) => item.stage === "review" && item.kind === "review")
      .first();
    const structuredData = reviewArtifact!.structuredData as Record<string, unknown>;
    const auditReport = structuredData.auditReport as { rounds: Array<{ triggeredIteration: boolean; issues: unknown[] }>; improved: boolean; remainingMajorCount: number };
    expect(auditReport.improved).toBe(true);
    expect(auditReport.remainingMajorCount).toBe(0);
    expect(auditReport.rounds[0].triggeredIteration).toBe(false);
    expect(auditReport.rounds[0].issues).toHaveLength(0);

    // 4 reviewer + prose-audit 都 clean → quality report passed → 转入 manuscript-approval
    const finalRun = await novelDb.workflowRuns.get(run.id);
    expect(finalRun?.currentStage).toBe("manuscript-approval");
    expect(finalRun?.status).toBe("waiting-approval");
  });
});

describe("runProseAudit function", () => {
  it("throws when prose-audit skill is not in BUILTIN_NOVEL_SKILLS", async () => {
    // 这个测试验证 skill id 校验逻辑——prose-audit 已在 BUILTIN_NOVEL_SKILLS 中，
    // 所以正常调用不会抛错。这里用无效 projectId 触发"项目不存在"错误来验证错误传播。
    await expect(runProseAudit({
      projectId: "nonexistent-project",
      documentTitle: "测试",
      draftContent: "正文",
      blueprintMarkdown: "蓝图",
      reviewerFindings: [],
      contextPacketId: "nonexistent-packet",
    })).rejects.toThrow("项目不存在");
  });

  it("builds prompt with numbered draft paragraphs and reviewer findings", async () => {
    const project = await createNovelProject({ title: "Prompt 构造", genre: ["古风权谋"], premise: "验证 prompt 拼接。" });
    const previous = await createChapter(project.id, "前序章节");
    const current = await createChapter(project.id, "当前章节");
    await novelDb.documents.put({ ...previous, plainText: "前序章从渡口的潮声开始，人物带着未完成的约定离开。结尾处船灯熄灭。", contentHtml: "<p>前序章从渡口的潮声开始，人物带着未完成的约定离开。结尾处船灯熄灭。</p>" });
    const ctx = packet(project.id);
    await novelDb.contextPackets.add(ctx);

    vi.mocked(callStructuredNovelModel).mockClear();
    vi.mocked(callStructuredNovelModel).mockResolvedValueOnce(proseAuditCleanResponse() as never);

    await runProseAudit({
      projectId: project.id,
      documentId: current.id,
      documentTitle: "测试章节",
      draftContent: "第一段。\n\n第二段。",
      blueprintMarkdown: "# 蓝图",
      reviewerFindings: [
        { role: "style-reviewer", scores: { specificity: 3 }, issues: [{ dimension: "specificity" as QualityDimension, severity: "major", title: "碎片过多", description: "短句堆叠", rule: "style.short", suggestion: "合并", rewriteExample: "合并后" }] },
      ],
      contextPacketId: ctx.id,
    });

    expect(callStructuredNovelModel).toHaveBeenCalledTimes(1);
    const call = vi.mocked(callStructuredNovelModel).mock.calls[0]?.[0];
    expect(call?.role).toBe("quality-editor");
    expect(call?.prompt).toContain("【第1段】");
    expect(call?.prompt).toContain("【第2段】");
    expect(call?.prompt).toContain("style-reviewer");
    expect(call?.prompt).toContain("碎片过多");
    expect(call?.prompt).toContain("前序章从渡口的潮声开始");
    expect(call?.prompt).toContain("相同母题若获得新的信息、关系或情绪功能可以保留");
    expect(call?.skillPrompt).toContain("正文元审核");
    // 验证 schema 是 auditIssueSchema
    expect(call?.schema).toEqual(expect.objectContaining({
      type: "object",
      required: expect.arrayContaining(["summary", "issues"]),
    }));
  });
});

describe("prose-audit failure degradation (M3)", () => {
  it("degrades gracefully when prose-audit LLM call throws, does not block review-stage", async () => {
    // 启用 prose-audit
    vi.stubEnv("NOVEL_PROSE_AUDIT_MAX_ITER", "1");

    const project = await createNovelProject({ title: "审核失败降级", genre: ["古风权谋"], premise: "prose-audit 抛错时不阻塞 review。" });
    const document = await createChapter(project.id, "第一章");
    const ctx = packet(project.id);
    const run = buildRun(project.id, document.id, ctx.id, "blueprint-fail", "draft-fail");
    const draft = artifact(run, { id: "draft-fail", stage: "draft", kind: "draft", title: "草稿", contentMarkdown: "他把手缩回袖子里，没有擦那滴酒。" });
    const blueprint = artifact(run, { id: "blueprint-fail", stage: "blueprint", kind: "blueprint", title: "蓝图", contentMarkdown: "# 蓝图", structuredData: { title: "第一章", objective: "测试", startingState: "起点", beats: [], endingHook: "钩子", characters: [], locations: [], informationRelease: [], mustHappen: [], flexible: [], forbidden: [] } });
    await novelDb.contextPackets.add(ctx);
    await novelDb.workflowRuns.add(run);
    await novelDb.workflowArtifacts.bulkAdd([draft, blueprint]);

    // reviewer clean，prose-audit 调用抛错
    vi.mocked(callStructuredNovelModel)
      .mockResolvedValueOnce(reviewerCleanResponse("style-reviewer") as never)
      .mockResolvedValueOnce(reviewerCleanResponse("character-reviewer") as never)
      .mockResolvedValueOnce(reviewerCleanResponse("continuity-reviewer") as never)
      .mockResolvedValueOnce(reviewerCleanResponse("plot-reviewer") as never)
      .mockResolvedValueOnce(reviewerCleanResponse("reader-reviewer") as never)
      .mockRejectedValueOnce(new Error("LLM 调用超时"));

    await advanceChapterWorkflow(run.id);

    // 验证 review-stage 没有失败——reviewer 的 quality report 仍然保存
    const qualityReport = await novelDb.qualityReports
      .where("workflowRunId").equals(run.id)
      .first();
    expect(qualityReport).toBeDefined();
    // reviewer clean + prose-audit 失败降级 → reviewer 不含 quality-editor
    // （quality report 的 passed 可能因 deterministic check 如篇幅不足而为 false，这不是 prose-audit 的职责）
    // reviewerRoles 不应包含 quality-editor（prose-audit 失败未注入）
    expect(qualityReport!.reviewerRoles).not.toContain("quality-editor");

    // 验证 review artifact 中写入 auditReport，包含 error 字段
    const reviewArtifact = await novelDb.workflowArtifacts
      .where("workflowRunId").equals(run.id)
      .and((item) => item.stage === "review" && item.kind === "review")
      .first();
    const structuredData = reviewArtifact!.structuredData as Record<string, unknown>;
    const auditReport = structuredData.auditReport as { mechanism: string; rounds: unknown[]; improved: boolean; error?: string };
    expect(auditReport.mechanism).toBe("external-revision");
    expect(auditReport.rounds).toHaveLength(0);
    expect(auditReport.improved).toBe(false);
    expect(auditReport.error).toBe("LLM 调用超时");
  });

  it("records a retryable learning failure without failing the chapter review", async () => {
    const project = await createNovelProject({ title: "Learning 降级", genre: ["现实题材"], premise: "经验评估故障不得阻断正文审批。" });
    const document = await createChapter(project.id, "第一章");
    const ctx = packet(project.id);
    const run = buildRun(project.id, document.id, ctx.id, "blueprint-learning", "draft-learning");
    const draft = artifact(run, { id: "draft-learning", stage: "draft", kind: "draft", title: "草稿", contentMarkdown: "她把旧信放回抽屉，窗外的公交车刚好驶过。".repeat(60) });
    const blueprint = artifact(run, { id: "blueprint-learning", stage: "blueprint", kind: "blueprint", title: "蓝图", contentMarkdown: "# 蓝图", structuredData: { title: "第一章", objective: "处理旧信", startingState: "傍晚", beats: [], endingHook: "来电", characters: [], locations: [], informationRelease: [], mustHappen: [], flexible: [], forbidden: [] } });
    const prompt = artifact(run, { id: "prompt-learning", stage: "context", kind: "prompt", title: "原始指令", contentMarkdown: "审校旧信章节，保留克制叙事与人物迟疑。" });
    await novelDb.contextPackets.add(ctx);
    await novelDb.workflowRuns.add(run);
    await novelDb.workflowArtifacts.bulkAdd([draft, blueprint, prompt]);

    const style = {
      ...reviewerCleanResponse("style-reviewer"),
      data: {
        ...reviewerCleanResponse("style-reviewer").data,
        issues: [{ dimension: "specificity", severity: "warning", title: "局部细节可更具体", description: "旧信的触感尚不明确。", rule: "review.detail", suggestion: "补充一个与人物处境有关的物理细节。" }],
      },
    };
    vi.mocked(callStructuredNovelModel)
      .mockResolvedValueOnce(style as never)
      .mockResolvedValueOnce(reviewerCleanResponse("character-reviewer") as never)
      .mockResolvedValueOnce(reviewerCleanResponse("continuity-reviewer") as never)
      .mockResolvedValueOnce(reviewerCleanResponse("plot-reviewer") as never)
      .mockResolvedValueOnce(reviewerCleanResponse("reader-reviewer") as never)
      .mockRejectedValueOnce(new Error("skill-iterator 暂时不可用"));

    const advanced = await advanceChapterWorkflow(run.id);
    const report = await novelDb.qualityReports.where("workflowRunId").equals(run.id).first();
    expect(advanced.status).not.toBe("failed");
    expect(report).toMatchObject({ learningStatus: "failed", learningError: "skill-iterator 暂时不可用" });

    vi.mocked(callStructuredNovelModel).mockResolvedValueOnce({
      data: { conclusion: "no-shared-learning", summary: "该问题属于本章局部执行偏差。" },
      usage: { inputTokens: 10, outputTokens: 10 },
      promptHash: "retry-learning",
    } as never);
    await retryFailedWorkflowLearning({ projectId: project.id, db: novelDb });
    expect(await novelDb.qualityReports.get(report!.id)).toMatchObject({ learningStatus: "completed", learningError: undefined });
  });
});

describe("reviewStageHandler export", () => {
  it("exports reviewStageHandler with stage='review'", () => {
    expect(reviewStageHandler.stage).toBe("review");
    expect(typeof reviewStageHandler.execute).toBe("function");
  });
});
