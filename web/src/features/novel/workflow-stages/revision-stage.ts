import { streamNovelModel } from "../ai";
import { novelDb } from "../db";
import { formatSkillPrompt, resolveNovelSkills } from "../skills";
import { asBlueprint } from "../workflow-shared";
import type { QualityIssue } from "../types";
import type { StageContext, StageHandler, StageResult } from "../workflow-stages";

function splitParagraphs(text: string): string[] {
  return text.split(/\n\s*\n/).map((item) => item.trim()).filter(Boolean);
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, "").replace(/[，。！？；：、""''《》【】（）()"'.,!?;:\-—…]/g, "");
}

function tokenize(text: string): string[] {
  return Array.from(text.replace(/\s+/g, "")).filter((ch) => ch.trim());
}

export function findIssueParagraph(issue: QualityIssue, paragraphs: string[]): number {
  if (typeof issue.paragraph === "number" && issue.paragraph >= 1 && issue.paragraph <= paragraphs.length) {
    return issue.paragraph - 1;
  }
  if (!issue.excerpt) return -1;

  const excerptNorm = normalizeText(issue.excerpt);
  if (excerptNorm.length >= 8) {
    const normParagraphs = paragraphs.map((p) => normalizeText(p));
    for (const len of [Math.min(60, excerptNorm.length), 40, 20]) {
      const prefix = excerptNorm.slice(0, len);
      const index = normParagraphs.findIndex((p) => p.includes(prefix));
      if (index >= 0) return index;
    }
  }

  const excerptTokens = tokenize(issue.excerpt);
  if (excerptTokens.length >= 4) {
    let bestIndex = -1;
    let bestScore = 0;
    for (let i = 0; i < paragraphs.length; i += 1) {
      const paraTokens = tokenize(paragraphs[i]);
      if (paraTokens.length === 0) continue;
      const setB = new Set(paraTokens);
      const overlap = excerptTokens.filter((t) => setB.has(t)).length;
      const score = overlap / Math.min(excerptTokens.length, paraTokens.length);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    if (bestScore >= 0.5) return bestIndex;
  }

  return -1;
}

export const revisionStageHandler: StageHandler = {
  stage: "revision",
  async execute(ctx: StageContext): Promise<StageResult> {
    const { run, project, document } = ctx;
    const [draft, blueprint, report, feedback, skills] = await Promise.all([
      novelDb.workflowArtifacts.get(run.draftArtifactId!),
      novelDb.workflowArtifacts.get(run.blueprintArtifactId!),
      novelDb.qualityReports.get(run.qualityReportId!),
      ctx.latestArtifact(run.id, ["review"]),
      resolveNovelSkills({ projectId: run.projectId, stage: "revision", explicitSkillIds: ["embodied-prose", "style-specificity-audit", "imagery-aesthetics"] }),
    ]);
    if (!draft || !report) throw new Error("修订输入不完整");
    const blueprintData = blueprint?.structuredData ? asBlueprint(blueprint.structuredData) : undefined;

    const paragraphs = splitParagraphs(draft.contentMarkdown);
    const revisableIssues = report.issues.filter(
      (item) => !(item.deterministic && item.rule === "chapter-blueprint.mustHappen"),
    );
    const blockerAndMajor = revisableIssues.filter((item) => item.severity === "blocker" || item.severity === "major").slice(0, 8);

    const issueParagraphs = new Set<number>();
    for (const issue of blockerAndMajor) {
      const idx = findIssueParagraph(issue, paragraphs);
      if (idx >= 0) issueParagraphs.add(idx);
    }

    if (issueParagraphs.size === 0) {
      const nextIteration = run.revisionIteration + 1;
      const artifact = await ctx.saveArtifact({ ...run, revisionIteration: nextIteration }, {
        projectId: run.projectId,
        workflowRunId: run.id,
        stage: "revision",
        kind: "revision",
        title: `${document.title}无变更修订 ${nextIteration}`,
        contentMarkdown: draft.contentMarkdown,
        parentArtifactId: draft.id,
        model: project.settings.textModel,
        skillRefs: [],
        contextPacketId: run.contextPacketId,
      });
      await ctx.createApprovalProposal(run, artifact, "workflow-manuscript", blockerAndMajor.length
        ? "重大质量问题无法安全定位到具体段落，已保留原文并转交人工审阅"
        : "没有可安全自动修订的重大问题，已保留原文并转交人工审阅");
      const nextRun = await ctx.transition(run, "manuscript-approval", "waiting-approval", { draftArtifactId: artifact.id, revisionIteration: nextIteration });
      return { run: nextRun, continueLoop: false };
    }

    const mustHappenBlock = blueprintData?.mustHappen?.length
      ? `\n\n## 必须落实的节拍（硬约束，不可省略）\n${blueprintData.mustHappen.map((item) => `- ${item}`).join("\n")}\n修订后正文必须让以下每个节拍在文中以具体行动和可识别结果呈现。`
      : "";
    const forbiddenBlock = blueprintData?.forbidden?.length
      ? `\n\n## 禁止事项（硬约束，不可触犯）\n${blueprintData.forbidden.map((item) => `- ${item}`).join("\n")}`
      : "";

    const numberedText = paragraphs.map((p, i) => {
      const needsRevision = issueParagraphs.has(i);
      const marker = needsRevision ? `【第${i + 1}段·需修订】` : `【第${i + 1}段·保留】`;
      return `${marker}\n${p}`;
    }).join("\n\n");

    const issueList = blockerAndMajor.map((item) => {
      const paraInfo = typeof item.paragraph === "number" ? `（第${item.paragraph}段）` : item.excerpt ? `（涉及："${item.excerpt.slice(0, 30)}..."）` : "";
      return `- [${item.severity}] ${item.title}${paraInfo}：${item.description}；建议：${item.suggestion}`;
    }).join("\n");

    const preserveList = paragraphs.map((_, i) => i + 1).filter((i) => !issueParagraphs.has(i - 1)).join("、");
    const preserveInstruction = preserveList
      ? `- 标注为「保留」的段落（第${preserveList}段）必须原样输出，不改一字`
      : "- 每个段落都有明确的问题定位，只能按各段对应问题进行定向修改";

    const { agent } = await ctx.createAgentRecord({
      run,
      role: "revision-editor",
      goal: `定向修订 ${blockerAndMajor.length} 个问题（保留 ${paragraphs.length - issueParagraphs.size} 段不变）`,
      skillRefs: skills.skills.map((item) => `${item.skillId}@${item.version}`),
    });
    const result = await streamNovelModel({
      model: project.settings.textModel,
      temperature: 0.3,
      role: "revision-editor",
      skillPrompt: formatSkillPrompt(skills.skills),
      prompt: `定向修订以下章节正文。只修改标注为「需修订」的段落，标注为「保留」的段落必须原样输出，不得改动任何文字。${mustHappenBlock}${forbiddenBlock}

## 需要处理的问题
${issueList}

## 原文（带段落标注）
${numberedText}

## 修订要求
${preserveInstruction}
- 标注为「需修订」的段落，根据对应问题进行修改
- 如果需要在段落之间插入新内容，直接在对应位置添加新段落
- 不要输出段落标注标记（【第N段·xxx】），只输出正文
- 保持第三人称限知视角和已有文风
${feedback?.stage === "manuscript-approval" ? `\n## 用户意见\n${feedback.contentMarkdown}` : ""}`,
    });
    const nextIteration = run.revisionIteration + 1;
    const revisedRun = { ...run, revisionIteration: nextIteration };
    const artifact = await ctx.saveArtifact(revisedRun, {
      projectId: run.projectId,
      workflowRunId: run.id,
      stage: "revision",
      kind: "revision",
      title: `${document.title}定向修订稿 ${nextIteration}`,
      contentMarkdown: result.content,
      parentArtifactId: draft.id,
      model: project.settings.textModel,
      skillRefs: skills.skills.map((item) => `${item.skillId}@${item.version}`),
      contextPacketId: run.contextPacketId,
    });
    await ctx.finishAgent(agent, { ...result, artifactId: artifact.id });
    const nextRun = await ctx.transition(run, "deterministic-check", "running", { draftArtifactId: artifact.id, revisionIteration: nextIteration });
    return { run: nextRun };
  },
};
