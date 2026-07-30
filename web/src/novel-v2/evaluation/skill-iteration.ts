/**
 * V2 技能迭代：LLM 驱动的 skill prompt 迭代。
 *
 * 设计依据：AGENTS.md + Phase B-1.3 重构计划。
 *
 * 职责：
 * - buildIterationPrompt：列出 skills + review issues + learning.underlyingMechanism
 * - runSkillIteration：查询实验 schema skills → 调用 LLM → 校验 → 写入 iterated_skills
 *
 * AGENTS.md 强制契约：
 * 1. buildIterationPrompt 必须追加 learning 段落（underlyingMechanism 而非仅 issue 症状）
 * 2. learning.underlyingMechanism/affectedInputClass 在 conclusion=propose-improvement 时必填
 * 3. 若 learningAssessment 缺少 underlyingMechanism，在 prompt 中标注"缺少机制分析"
 *
 * 与 v1 的区别：v1 从 Dexie 实验库读取 skill/qualityReport，v2 从 Postgres 实验 schema
 * 读取 skill_definitions，reviews 作为参数传入。iterated_skills 写入公共表（非实验 schema）。
 */
import { randomUUID } from "node:crypto";
import type {
  IteratedSkill,
  Review,
  RuntimeLearningAssessmentV2,
  SkillDescriptor,
} from "../protocol";
import type { ModelGateway } from "../model-gateway";
import type { NovelPostgresRepository } from "../postgres-repository";
import type { ExperimentWorkspaceHandle } from "./experiment-workspace";
import { serializePromptSections } from "./prompt-sections";
import { compileStageContext } from "../stage-context";

// ===== 类型 =====

export interface SkillIterationOutput {
  iterations: Array<{
    skillId: string;
    promptSections: Record<string, string>;
    rationale: string;
    triggeredByIssueIds: string[];
  }>;
}

// ===== Schema =====

/**
 * LLM 返回的迭代结果 schema：选择 1-3 个 skill 提供修订后的完整 prompt。
 *
 * promptSections 直接以结构化对象返回，序列化只发生在数据库边界。
 */
export const skillIterationSchema = {
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
        required: ["skillId", "promptSections", "rationale", "triggeredByIssueIds"],
        properties: {
          skillId: { type: "string", minLength: 3, maxLength: 80 },
          promptSections: {
            type: "object",
            additionalProperties: false,
            minProperties: 1,
            properties: {
              foundation: { type: "string", minLength: 20, maxLength: 10000 },
              planning: { type: "string", minLength: 20, maxLength: 10000 },
              drafting: { type: "string", minLength: 20, maxLength: 10000 },
              review: { type: "string", minLength: 20, maxLength: 10000 },
              revision: { type: "string", minLength: 20, maxLength: 10000 },
              "fact-extraction": { type: "string", minLength: 20, maxLength: 10000 },
            },
          },
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
} as const;

function schemaForSkills(skillIds: string[]): Record<string, unknown> {
  const schema = structuredClone(skillIterationSchema) as unknown as {
    properties: { iterations: { items: { properties: { skillId: Record<string, unknown> } } } };
  };
  schema.properties.iterations.items.properties.skillId.enum = skillIds;
  return schema as unknown as Record<string, unknown>;
}

// ===== Prompt 构建 =====

/**
 * 构造 LLM 输入 prompt：列出当前 skills + review issues + learning 段落。
 *
 * AGENTS.md 强制要求：learning 段落必须包含 underlyingMechanism 而非仅 issue 症状。
 * 若 learningAssessment.conclusion === "propose-improvement" 但缺少 underlyingMechanism，
 * 在 prompt 中标注"缺少机制分析"，降级为仅 issue 症状但不臆造通用规则。
 */
export function buildIterationPrompt(params: {
  skills: SkillDescriptor[];
  reviews: Review[];
  learningAssessment?: RuntimeLearningAssessmentV2;
}): string {
  // Skills 段落
  const skillsSection = params.skills.length > 0
    ? params.skills.map((skill) => {
        const promptEntries = Object.entries(skill.promptSections ?? {});
        const promptText = promptEntries.length > 0
          ? promptEntries.map(([stage, text]) => `  [${stage}] ${text}`).join("\n")
          : "  (无 prompt 定义)";
        return `## Skill: ${skill.skillId}@${skill.version}
- capabilities: ${skill.capabilities.join(", ") || "(无)"}
- applicableTasks: ${skill.applicableTasks.join(", ") || "(无)"}
- qualityGates: ${skill.qualityGates.join(", ") || "(无)"}
- 当前 prompt：
${promptText}`;
      }).join("\n\n")
    : "(无激活的 skills)";

  // Issues 段落：从 reviews 中提取 blocker/major issues
  const allIssues = params.reviews.flatMap((review) =>
    review.issues
      .filter((issue) => issue.severity === "blocker" || issue.severity === "major")
      .map((issue, index) => {
        const reviewLabel = `[${review.identity}/${review.id}]`;
        const range = issue.revisionRanges?.length
          ? ` 段落范围：${issue.revisionRanges.map((r) => `${r.start}-${r.end}`).join(", ")}`
          : "";
        const excerpt = issue.excerpt ? `\n  摘录：${issue.excerpt}` : "";
        const suggestion = issue.suggestion ? `\n  建议：${issue.suggestion}` : "";
        const rule = issue.rule ? ` rule="${issue.rule}"` : "";
        return `${index + 1}. ${reviewLabel} severity=${issue.severity}${rule}
  标题：${issue.title}
  描述：${issue.description ?? "(无描述)"}${excerpt}${range}${suggestion}`;
      }),
  );
  const issuesSection = allIssues.length > 0 ? allIssues.join("\n") : "(无 blocker/major issues)";

  // Learning 段落（AGENTS.md 强制要求：underlyingMechanism 而非仅 issue 症状）
  let learningSection: string;
  const learning = params.learningAssessment;
  if (!learning) {
    learningSection = "## 可复用经验判断\n尚无 learning assessment；不得仅凭 issue 症状臆造通用规则。";
  } else if (learning.conclusion === "no-shared-learning") {
    learningSection = `## 可复用经验判断\nconclusion=no-shared-learning\n${learning.symptom ?? "(无症状描述)"}\n本轮 issues 不反映可迁移的共享缺陷，不要为单次偏差创建规则。`;
  } else {
    // conclusion === "propose-improvement"
    const mechanism = learning.underlyingMechanism;
    const inputClass = learning.affectedInputClass;
    if (!mechanism || !inputClass) {
      // AGENTS.md 契约：propose-improvement 必须包含 underlyingMechanism/affectedInputClass
      // 缺失时降级为标注"缺少机制分析"，不臆造规则
      learningSection = `## 可复用经验判断\nconclusion=propose-improvement\n⚠️ 缺少机制分析：underlyingMechanism 或 affectedInputClass 缺失。\nsymptom: ${learning.symptom ?? "(无)"}\nfailingLayer: ${learning.failingLayer ?? "(无)"}\n不得在缺少机制分析的情况下臆造通用规则；仅基于 issue 证据做最小化修订。`;
    } else {
      const boundaries = learning.boundaries ?? "(未定义)";
      const regressionRisks = learning.regressionRisks?.length ? learning.regressionRisks.join("；") : "(无)";
      const candidate = learning.candidate
        ? `\n已提议目标：${learning.candidate.targetKind}/${learning.candidate.targetId}\n提议内容：${learning.candidate.afterText}\n提议理由：${learning.candidate.rationale}`
        : "";
      learningSection = `## 可复用经验判断\nconclusion=propose-improvement\n影响输入类别：${inputClass}\n底层机制：${mechanism}\n边界：${boundaries}\n回归风险：${regressionRisks}${candidate}`;
    }
  }

  return `基于本次章节审校发现的问题，迭代相关 skill 的 prompt，让未来章节生成不再犯同类错误。

## 当前 skills
${skillsSection}

## 本次审校发现的问题（blocker/major）
${issuesSection}

${learningSection}

## 任务
1. 选择 1-3 个与 issues 最直接相关的 skill 进行迭代。优先选择 issue.rule 命中的 skill。
2. 为每个选中的 skill 提供修订后的完整 prompt（不是 diff，是完整新版本）。
3. 修订必须针对可复用经验中的底层机制和影响输入类别，issue 只作为证据；不得把样例标题、角色、固定措辞或章节位置写成规则。
4. 不要修改与 issue 无关的部分，保持原 prompt 的整体结构、语气和长度量级。
5. promptSections 必须直接输出为 JSON 对象，key 只能是 foundation/planning/drafting/review/revision/fact-extraction；value 是该阶段的完整 prompt，不能是"在原 prompt 基础上增加..."这样的指令。
6. rationale 简洁说明本次修订的理由，triggeredByIssueIds 列出触发的 issue 标识（可用 issue 标题或序号）。
7. promptSections 序列化后的总长度必须 ≥ 100 字符。
8. skillId 必须严格选自上方“当前 skills”；若 learning candidate.targetId 命中其中一个 skill，必须优先迭代该 skill。

输出 JSON：{ "iterations": [{ "skillId": "...", "promptSections": { "drafting": "完整的新 prompt" }, "rationale": "...", "triggeredByIssueIds": ["issue-id-1"] }] }`;
}

// ===== 行类型 =====

type SkillRow = {
  skill_id: string;
  version: string;
  capabilities: string[] | null;
  applicable_tasks: string[] | null;
  required_memory_kinds: string[] | null;
  conflicts: string[] | null;
  quality_gates: string[] | null;
  prompt_sections: Record<string, unknown> | null;
  enabled: boolean;
};

function mapSkillRow(row: SkillRow): SkillDescriptor {
  return {
    skillId: row.skill_id,
    version: row.version,
    capabilities: row.capabilities ?? [],
    applicableTasks: (row.applicable_tasks ?? []) as SkillDescriptor["applicableTasks"],
    requiredMemoryKinds: (row.required_memory_kinds ?? []) as SkillDescriptor["requiredMemoryKinds"],
    conflicts: row.conflicts ?? [],
    qualityGates: row.quality_gates ?? [],
    promptSections: (row.prompt_sections ?? {}) as SkillDescriptor["promptSections"],
    enabled: row.enabled,
  };
}

// ===== 主接口 =====

/**
 * 运行技能迭代：基于 reviews 的 issues，让 LLM 提出相关 skill 的 prompt 修订。
 *
 * 步骤：
 * 1. 从实验 schema 查询当前 skill_definitions
 * 2. 若无 blocker/major issues，返回空数组（无需迭代）
 * 3. 调用 model.generateStructured<SkillIterationOutput>
 * 4. 校验每个 afterPrompt 长度 ≥ 100
 * 5. 写入公共 iterated_skills 表（注意：不在实验 schema 内）
 * 6. 返回 IteratedSkill[]
 *
 * @throws 若 LLM 调用失败或输出校验失败
 */
export async function runSkillIteration(input: {
  workspace: ExperimentWorkspaceHandle;
  repository: NovelPostgresRepository;
  reviews: Review[];
  learningAssessment?: RuntimeLearningAssessmentV2;
  model: ModelGateway;
}): Promise<IteratedSkill[]> {
  const { workspace, repository, reviews, learningAssessment, model } = input;
  const s = workspace.schemaName;

  // 1. 查询实验 schema 内的 skill_definitions
  const skillResult = await workspace.query<SkillRow>(
    `SELECT skill_id, version, capabilities, applicable_tasks, required_memory_kinds,
            conflicts, quality_gates, prompt_sections, enabled
     FROM ${s}.skill_definitions
     WHERE enabled = TRUE
     ORDER BY skill_id`,
  );
  const skills = skillResult.rows.map(mapSkillRow);

  if (skills.length === 0) {
    return [];
  }

  // 2. 检查是否有 blocker/major issues
  const hasBlockingIssues = reviews.some((review) =>
    review.issues.some((issue) => issue.severity === "blocker" || issue.severity === "major"),
  );
  if (!hasBlockingIssues) {
    return [];
  }

  // 3. 构造 prompt 并调用 LLM
  const prompt = buildIterationPrompt({ skills, reviews, learningAssessment });
  const system = "你是长篇小说 skill prompt 迭代器，基于审校 issues 和 learning 机制分析修订 skill prompt。";
  const iterationSchema = schemaForSkills(skills.map((skill) => skill.skillId));
  const promptPackage = compileStageContext({
    projectId: workspace.projectId,
    workflowId: `skill-iteration:${workspace.id}`,
    purpose: "skill.iterate",
    stage: "review",
    system,
    schema: iterationSchema,
    maxInputTokens: 128_000,
    reservedOutputTokens: 8_192,
    sections: [{ id: "skill-iteration-evidence", kind: "review", title: "技能、审校证据与底层机制", text: prompt, priority: "required", provenanceRefs: [workspace.id, ...reviews.map((review) => review.id), learningAssessment?.id ?? ""] }],
  });

  const result = await model.generateStructured<SkillIterationOutput>({
    purpose: "skill.iterate",
    system,
    prompt: promptPackage.instruction,
    schema: iterationSchema,
    schemaName: "skill-iteration",
    temperature: 0.4,
    workflowRunId: `skill-iteration:${workspace.id}`,
    taskId: `${workspace.id}:skill-iteration`,
    promptContext: promptPackage.manifest,
  });

  // 4. 校验每个 iteration
  const skillMap = new Map(skills.map((skill) => [skill.skillId, skill]));
  const validatedIterations: Array<{
    skill: SkillDescriptor;
    afterPrompt: string;
    rationale: string;
    triggeredByIssueIds: string[];
  }> = [];

  for (const iteration of result.value.iterations) {
    const skill = skillMap.get(iteration.skillId);
    if (!skill) throw new Error(`skill iteration 返回未知 skillId：${iteration.skillId}`);

    const afterPrompt = serializePromptSections(iteration.promptSections, `skill ${iteration.skillId} 的 promptSections`);
    if (afterPrompt.length < 100) throw new Error(`skill ${iteration.skillId} 的 promptSections 总长度少于 100 字符`);

    // beforePrompt 与 afterPrompt 不能相同
    const beforePrompt = JSON.stringify(skill.promptSections ?? {});
    if (afterPrompt === beforePrompt) throw new Error(`skill ${iteration.skillId} 的 prompt 未发生变化`);

    validatedIterations.push({
      skill,
      afterPrompt,
      rationale: iteration.rationale,
      triggeredByIssueIds: iteration.triggeredByIssueIds,
    });
  }

  if (validatedIterations.length === 0) {
    return [];
  }

  // 5. 写入公共 iterated_skills 表
  const records: IteratedSkill[] = [];
  const now = Date.now();
  for (const iteration of validatedIterations) {
    const id = randomUUID();
    const beforePrompt = JSON.stringify(iteration.skill.promptSections ?? {});

    await repository.pool.query(
      `INSERT INTO iterated_skills(id, experiment_id, skill_id, before_prompt, after_prompt, rationale, triggered_by_issue_ids, learning_mechanism, created_at)
       VALUES($1, $2, $3, $4, $5, $6, $7, $8, to_timestamp($9 / 1000.0))`,
      [
        id,
        workspace.id,
        iteration.skill.skillId,
        beforePrompt,
        iteration.afterPrompt,
        iteration.rationale,
        iteration.triggeredByIssueIds,
        learningAssessment?.underlyingMechanism ?? null,
        now,
      ],
    );

    records.push({
      id,
      experimentId: workspace.id,
      skillId: iteration.skill.skillId,
      beforePrompt,
      afterPrompt: iteration.afterPrompt,
      rationale: iteration.rationale,
      triggeredByIssueIds: iteration.triggeredByIssueIds,
      learningMechanism: learningAssessment?.underlyingMechanism,
      createdAt: now,
    });
  }

  // 6. 同步更新实验 schema 内的 skill_definitions（让后续实验步骤使用新 prompt）
  for (const iteration of validatedIterations) {
    const promptSectionsJson = iteration.afterPrompt;
    await workspace.query(
      `UPDATE ${s}.skill_definitions SET prompt_sections = $2::jsonb, updated_at = now() WHERE skill_id = $1`,
      [iteration.skill.skillId, promptSectionsJson],
    );
  }

  return records;
}
