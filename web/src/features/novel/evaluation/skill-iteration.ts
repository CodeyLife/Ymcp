/**
 * 技能迭代服务：基于质量报告中的 issues，LLM 自动迭代相关 skill 的 prompt。
 *
 * 设计依据：docs/novel-real-data-evaluation-architecture.md §3.3 / §4.3。
 *
 * 接入点：独立服务函数 `runSkillIteration`，不修改 chapter-workflow stages。
 * 调用方（CLI/UI/闭环测试）在 commit-stage 完成后或 chapter-workflow 结束后触发，
 * 作为 post-commit side-effect 产生 IteratedSkillRecord 写入实验库。
 *
 * 与正式库的关系：IteratedSkillRecord 只存在于实验库，不直接覆盖正式库 NovelSkillManifest。
 * CandidateBundle 导出时从实验库 iteratedSkills 表读取，PromotionService 晋升时根据
 * IteratedSkillRecord 更新正式库 NovelSkillManifest.prompt 字段并递增 revision。
 *
 * 验证策略：每个 IteratedSkillRecord 的 afterPrompt 必须能与原 skill 元数据组合成
 * 完整的 NovelSkillManifest，通过 parseNovelSkill 验证（确保晋升时能写入正式库）。
 */
import { callStructuredNovelModel } from "../ai";
import { novelDb, recordBase, type NovelDatabase } from "../db";
import { parseNovelSkill, resolveNovelSkills } from "../skills";
import type {
  IteratedSkillRecord,
  NovelSkillManifest,
  NovelSkillStage,
  QualityIssue,
  LearningAssessment,
} from "../types";

/**
 * LLM 返回的迭代结果 schema：选择 1-3 个 skill 提供修订后的完整 prompt。
 */
const skillIterationSchema = {
  type: "object",
  additionalProperties: false,
  required: ["iterations"],
  properties: {
    iterations: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["skillId", "afterPrompt", "rationale", "triggeredByIssueIds"],
        properties: {
          skillId: { type: "string", minLength: 3, maxLength: 80 },
          afterPrompt: { type: "string", minLength: 20, maxLength: 30000 },
          rationale: { type: "string", minLength: 10, maxLength: 1000 },
          triggeredByIssueIds: {
            type: "array",
            minItems: 1,
            items: { type: "string", minLength: 1 },
          },
        },
      },
    },
  },
};

/**
 * 构造 LLM 输入 prompt：列出当前 skills + review issues，要求选择并修订相关 skill。
 */
export function buildIterationPrompt(params: {
  skills: NovelSkillManifest[];
  issues: QualityIssue[];
  blueprintGoal?: string;
  draftExcerpt: string;
  learning?: LearningAssessment;
}): string {
  const skillsSection = params.skills
    .map((skill) => {
      return `## Skill: ${skill.name} (${skill.skillId}@${skill.version})
- category: ${skill.category}
- stages: ${skill.stages.join(", ")}
- priority: ${skill.priority}
- 当前 prompt：
${skill.prompt}`;
    })
    .join("\n\n");

  const issuesSection = params.issues
    .map((issue, index) => {
      const range = issue.revisionRanges?.length
        ? ` 段落范围：${issue.revisionRanges.map((r) => `${r.start}-${r.end}`).join(", ")}`
        : "";
      const excerpt = issue.excerpt ? `\n  摘录：${issue.excerpt}` : "";
      return `${index + 1}. [id=${issue.id}] severity=${issue.severity} dimension=${issue.dimension} rule="${issue.rule}"
  标题：${issue.title}
  描述：${issue.description}${excerpt}${range}
  建议：${issue.suggestion}`;
    })
    .join("\n");

  const blueprintLine = params.blueprintGoal ? `\n章节目标：${params.blueprintGoal}\n` : "";
  const learningSection = params.learning?.conclusion === "propose-improvement"
    ? `## 可复用经验判断\n影响输入类别：${params.learning.affectedInputClass}\n底层机制：${params.learning.underlyingMechanism}\n判断摘要：${params.learning.summary}\n边界：${params.learning.proposal.boundaries.join("；")}\n非目标：${params.learning.proposal.nonGoals.join("；")}`
    : `## 可复用经验判断\n${params.learning?.summary ?? "尚无已验证的共享机制；不得仅凭 issue 症状臆造通用规则。"}`;

  return `基于本次章节审校发现的问题，迭代相关 skill 的 prompt，让未来章节生成不再犯同类错误。

${blueprintLine}

## 当前 skills（仅列出本次 stage 激活的 skills）
${skillsSection}

## 本次审校发现的问题（来自最新 quality report）
${issuesSection}

${learningSection}

## 正文摘录（供参考）
${params.draftExcerpt}

## 任务
1. 选择 1-3 个与 issues 最直接相关的 skill 进行迭代。优先选择 issue.rule 命中的 skill。
2. 为每个选中的 skill 提供修订后的完整 prompt（不是 diff，是完整新版本）。
3. 修订必须针对可复用经验中的底层机制和影响输入类别，issue 只作为证据；不得把样例标题、角色、固定措辞或章节位置写成规则。
4. 不要修改与 issue 无关的部分，保持原 prompt 的整体结构、语气和长度量级。
5. afterPrompt 必须是完整的 prompt 文本，不能是"在原 prompt 基础上增加..."这样的指令。
6. rationale 简洁说明本次修订的理由，triggeredByIssueIds 列出触发的 issue id。

输出 JSON：{ "iterations": [{ "skillId": "...", "afterPrompt": "...", "rationale": "...", "triggeredByIssueIds": ["issue-id-1"] }] }`;
}

/**
 * 用原 skill 元数据 + afterPrompt 构造完整的 skill draft 对象，通过 parseNovelSkill 验证。
 *
 * parseNovelSkill 期望输入是 YAML frontmatter 或 JSON，包含 skillId/version/name/description/
 * locale/category/stages/prompt 等必填字段。我们用 JSON 格式构造，把原 skill 的所有元数据
 * 原样保留，只替换 prompt 字段。
 */
function validateIteratedPrompt(skill: NovelSkillManifest, afterPrompt: string): void {
  const draft = {
    skillId: skill.skillId,
    version: skill.version,
    name: skill.name,
    description: skill.description,
    locale: skill.locale,
    category: skill.category,
    stages: skill.stages,
    triggers: skill.triggers,
    requires: skill.requires,
    conflicts: skill.conflicts,
    priority: skill.priority,
    inputSchema: skill.inputSchema,
    outputSchema: skill.outputSchema,
    prompt: afterPrompt,
    qualityChecks: skill.qualityChecks,
    sourceUrl: skill.sourceUrl,
    license: skill.license,
  };
  // parseNovelSkill 内部会跑 AJV schema 验证 + forbiddenSkillPatterns 检查
  // 如果 afterPrompt 包含脚本注入或忽略系统指令的模式，会抛出错误
  parseNovelSkill(JSON.stringify(draft));
}

/**
 * 运行技能迭代：基于最新 quality report 的 issues，让 LLM 提出相关 skill 的 prompt 修订。
 *
 * @param params.projectId 项目 ID
 * @param params.workflowRunId 实验库中的 workflowRunId（用于读取 quality report + draft + 关联 IteratedSkillRecord）
 * @param params.stage 用于解析激活 skills 的 stage（默认 "drafting"，因为大部分 issue 来自正文审校）
 * @param params.db 实验库 NovelDatabase 实例（默认全局 novelDb）
 * @returns 写入实验库的 IteratedSkillRecord 数组（至少 1 条；空数组表示无 issue 或 LLM 未选择迭代）
 */
export async function runSkillIteration(params: {
  projectId: string;
  workflowRunId: string;
  stage?: NovelSkillStage;
  db?: NovelDatabase;
}): Promise<IteratedSkillRecord[]> {
  const db = params.db ?? novelDb;
  const stage: NovelSkillStage = params.stage ?? "drafting";

  // 1. 读取最新 quality report + draft artifact + 激活的 skills
  const run = await db.workflowRuns.get(params.workflowRunId);
  if (!run) throw new Error("工作流不存在");
  if (!run.qualityReportId) throw new Error("工作流缺少 quality report，无法迭代 skills");

  const [qualityReport, draftArtifact, resolved] = await Promise.all([
    db.qualityReports.get(run.qualityReportId),
    run.draftArtifactId ? db.workflowArtifacts.get(run.draftArtifactId) : undefined,
    resolveNovelSkills({ projectId: params.projectId, stage, db }),
  ]);

  if (!qualityReport) throw new Error("质量报告不存在");
  if (!draftArtifact) throw new Error("draft artifact 不存在");

  // 2. 过滤出非 deterministic 的 reviewer issues（deterministic issues 是规则引擎发现的，
  //    已经在 quality.ts 中有明确规则；我们只迭代 LLM reviewer 发现的 issue，因为这些
  //    反映了 prompt 在引导 LLM 时的真实缺陷）
  const candidateIssues = qualityReport.issues.filter((issue) => !issue.deterministic);
  if (candidateIssues.length === 0) {
    return [];
  }

  // 3. 调用 LLM 提出迭代
  const project = await db.projects.get(params.projectId);
  if (!project) throw new Error("项目不存在");

  const draftExcerpt = draftArtifact.contentMarkdown.slice(0, 2000);
  const prompt = buildIterationPrompt({
    skills: resolved.skills,
    issues: candidateIssues,
    blueprintGoal: undefined, // 后续可从 blueprintArtifact 读出
    draftExcerpt,
    learning: qualityReport.learning,
  });

  const result = await callStructuredNovelModel<{
    iterations: Array<{
      skillId: string;
      afterPrompt: string;
      rationale: string;
      triggeredByIssueIds: string[];
    }>;
  }>({
    model: project.settings.textModel,
    temperature: 0.4,
    role: "skill-iterator",
    schema: skillIterationSchema,
    prompt,
  });

  // 4. 验证每个 iteration：skillId 必须在激活的 skills 中，afterPrompt 必须通过 parseNovelSkill
  const skillMap = new Map(resolved.skills.filter((skill) => !skill.skillId.startsWith("system-prompt:")).map((skill) => [skill.skillId, skill]));
  const issueMap = new Map(qualityReport.issues.map((issue) => [issue.id, issue]));
  const validatedIterations: Array<{
    skill: NovelSkillManifest;
    afterPrompt: string;
    rationale: string;
    triggeredIssues: QualityIssue[];
  }> = [];

  for (const iteration of result.data.iterations) {
    const skill = skillMap.get(iteration.skillId);
    if (!skill) continue; // LLM 编造了不存在的 skillId，跳过

    // afterPrompt 必须与 beforePrompt 不同
    if (iteration.afterPrompt.trim() === skill.prompt.trim()) continue;

    // 通过 parseNovelSkill 验证 afterPrompt（组合完整 skill 对象）
    try {
      validateIteratedPrompt(skill, iteration.afterPrompt);
    } catch {
      continue; // 验证失败，跳过此 iteration
    }

    // triggeredByIssueIds 必须都是真实存在的 issue id
    const triggeredIssues = iteration.triggeredByIssueIds
      .map((id) => issueMap.get(id))
      .filter((issue): issue is QualityIssue => Boolean(issue));
    if (triggeredIssues.length === 0) continue;

    validatedIterations.push({
      skill,
      afterPrompt: iteration.afterPrompt,
      rationale: iteration.rationale,
      triggeredIssues,
    });
  }

  if (validatedIterations.length === 0) {
    return [];
  }

  // 5. 写入实验库 iteratedSkills 表
  const records: IteratedSkillRecord[] = validatedIterations.map((iteration) => {
    const base = recordBase(params.projectId);
    return {
      ...base,
      skillId: iteration.skill.skillId,
      beforePrompt: iteration.skill.prompt,
      afterPrompt: iteration.afterPrompt,
      rationale: iteration.rationale,
      triggeredByIssueIds: iteration.triggeredIssues.map((issue) => issue.id),
      triggeredByIssueSummaries: iteration.triggeredIssues.map(
        (issue) => `[${issue.severity}] ${issue.dimension}: ${issue.title} (rule=${issue.rule})`,
      ),
      sourceWorkflowRunId: params.workflowRunId,
      model: project.settings.textModel,
    };
  });

  await db.iteratedSkills.bulkPut(records);
  return records;
}

/**
 * 读取实验库中指定 workflowRun 产生的所有 IteratedSkillRecord。
 * CandidateBundle 导出时调用此函数。
 */
export async function listIteratedSkills(params: {
  workflowRunId: string;
  db?: NovelDatabase;
}): Promise<IteratedSkillRecord[]> {
  const db = params.db ?? novelDb;
  return db.iteratedSkills.where("sourceWorkflowRunId").equals(params.workflowRunId).toArray();
}
