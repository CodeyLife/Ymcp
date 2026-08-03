import { createHash } from "node:crypto";
import Ajv from "ajv";
import type { Artifact, MemoryClaim } from "../protocol";
import type { ModelGateway } from "../model-gateway";
import type { ModelRoutingSnapshot } from "../model-routing";
import { NovelPostgresRepository } from "../postgres-repository";
import type { ContentObjectStore } from "../object-store";
import type { MemoryIndex } from "../qdrant-memory";
import { characterEnrichmentSchema, type CharacterEnrichmentOutput } from "../prompts/schemas";
import { buildCharacterEnrichmentPrompt } from "./prompt";
import { compileStageContext } from "../stage-context";

/**
 * 识别 motivationDelta 的"无变化"占位标记。
 *
 * 设计依据：AGENTS.md「root-cause analysis」——原下游用精确字符串匹配
 * `=== "本章无明显动机变化"`，但 LLM 常填变体（如"动机未变化""该角色无动机变化"），
 * 导致占位文本被当作真实动机写入 entities.payload，污染角色档案。
 * 改用正则覆盖所有"无 + 变化"语义变体，prompt 侧同步标准化为"无变化"三字。
 */
const NO_MOTIVATION_CHANGE_REGEX = /^\s*(无变化|.*无(明显)?(动机)?变化.*|.*动机未(发生)?变化.*)\s*$/u;

/**
 * V2 角色富化（character enrichment）模块。
 *
 * 设计依据：AGENTS.md「commitStageHandler → characterEnrichmentStageHandler」契约。
 *
 * 流程：
 * 1. 从 objectStore 取章节正文（commit 后已落库）
 * 2. LLM 结构化提取（purpose=facts.extract）：每个角色的 voiceAnchor/motivationDelta/newKnowledge/relationDeltas
 * 3. 回写角色档案：
 *    - voiceAnchor + motivationDelta → UPSERT 到 entities.payload（merge 现有 payload）
 *    - newKnowledge → 创建 MemoryClaim（knowledgeScope={characterId}），写入 memory_claims + Qdrant
 *    - relationDeltas → UPSERT 到 relations 表（时效关系，valid_from=当前 revision）
 *
 * 与 chapter memory 的区别：
 * - chapter memory 是章节级摘要（发生了什么）
 * - character enrichment 是角色级增量（角色怎么变了）
 * - 两者互补：chapter memory 用于跨章节事件一致性，character enrichment 用于角色声部/动机一致性
 *
 * 失败处理：失败不阻塞 commit（revision 已落库），只记录错误让上游 learning 闭环感知。
 * 符合 AGENTS.md「不阻塞 commit」契约。
 *
 * 设计原则（AGENTS.md「reusable contracts over case-specific examples」）：
 * - 本模块只做编排，提取规则在 prompt.ts 中独立维护
 * - voiceAnchor 四维是题材无关的语言特征，不内置网文套路
 * - 知识边界用 MemoryClaim（knowledgeScope={characterId}）而非 v1 character_knowledge 表（v1 facts 表已废弃）
 */

export interface EnrichCharactersInput {
  projectId: string;
  documentId: string;
  /** 定稿 revision id（commit-stage 产出）。 */
  revisionId: string;
  /** 章节顺序号（用于 narrativeRange）。 */
  narrativeOrder: number;
  /** 章节正文。 */
  text: string;
  /** 章节定稿 artifact。 */
  artifact: Artifact;
  model: ModelGateway;
  routingSnapshot?: ModelRoutingSnapshot;
  candidateStartIndex?: number;
  workflowRunId?: string;
  taskId?: string;
}

export interface EnrichCharactersDeps {
  repository: NovelPostgresRepository;
  objects: ContentObjectStore;
  /** Qdrant 索引（可选，缺失时跳过向量索引）。 */
  memoryIndex?: MemoryIndex;
}

/**
 * 单个角色的富化增量（提取后用于回写）。
 */
export interface CharacterEnrichmentDelta {
  characterId: string;
  voiceAnchor: CharacterEnrichmentOutput["characters"][number]["voiceAnchor"];
  motivationDelta: string;
  newKnowledge: CharacterEnrichmentOutput["characters"][number]["newKnowledge"];
  relationDeltas: CharacterEnrichmentOutput["characters"][number]["relationDeltas"];
}

export interface EnrichCharactersResult {
  deltas: CharacterEnrichmentDelta[];
  /** 回写产生的 MemoryClaim（角色知识边界），已写入 memory_claims。 */
  knowledgeClaims: MemoryClaim[];
  /** 回写产生的 relations 记录数。 */
  relationRecords: number;
  /** 回写更新的 entities 数量。 */
  entityUpdates: number;
}

/**
 * 从定稿章节中提取角色富化增量并回写角色档案。
 *
 * 返回值：成功返回 EnrichCharactersResult，失败抛错（由上游 try/catch 决定是否阻塞）。
 */
export async function enrichCharactersFromChapter(input: EnrichCharactersInput, deps: EnrichCharactersDeps): Promise<EnrichCharactersResult> {
  // 1. 取已有角色档案摘要（让 LLM 只提取增量）
  const existingCharacters = await deps.repository.pool.query<{ id: string; name: string; payload: Record<string, unknown> }>(
    "SELECT id, name, payload FROM entities WHERE project_id=$1 AND kind='character' ORDER BY name ASC LIMIT 20",
    [input.projectId],
  );
  const existingCharactersDigest = existingCharacters.rowCount
    ? existingCharacters.rows.map((row) => {
        const payload = row.payload ?? {};
        const voice = payload.voiceAnchor ? `声部：${JSON.stringify(payload.voiceAnchor)}` : "";
        const motivation = payload.motivation ? `动机：${payload.motivation}` : "";
        return `- ${row.name}：${voice} ${motivation}`.trim();
      }).join("\n")
    : undefined;

  // 2. LLM 结构化提取
  const prompt = buildCharacterEnrichmentPrompt({
    artifact: input.artifact,
    text: input.text,
    existingCharactersDigest,
  });
  const system = "你是角色富化提取 Worker。只输出符合 JSON Schema 的 JSON。只提取正文实际呈现的内容，不提取读者推断或作者意图。";
  const promptPackage = compileStageContext({ projectId: input.projectId, workflowId: input.workflowRunId ?? input.artifact.taskId, purpose: "facts.extract", stage: "fact-extraction", system, schema: characterEnrichmentSchema as unknown as Record<string, unknown>, maxInputTokens: 128_000, reservedOutputTokens: 4_096, sections: [{ id: "character-enrichment-fallback", kind: "manuscript", title: "角色变化回退提取", text: prompt, priority: "critical", provenanceRefs: [input.artifact.id, input.revisionId] }] });

  const generated = await input.model.generateStructured<CharacterEnrichmentOutput>({
    purpose: "facts.extract",
    system,
    prompt: promptPackage.instruction,
    schema: characterEnrichmentSchema as unknown as Record<string, unknown>,
    schemaName: "character-enrichment",
    routingSnapshot: input.routingSnapshot,
    candidateStartIndex: input.candidateStartIndex,
    workflowRunId: input.workflowRunId,
    taskId: input.taskId,
    promptContext: promptPackage.manifest,
  });

  const output = generated.value;
  validateCharacterEnrichmentOutput(output);

  const deltas: CharacterEnrichmentDelta[] = output.characters.map((character) => ({
    characterId: character.characterId,
    voiceAnchor: character.voiceAnchor,
    motivationDelta: character.motivationDelta,
    newKnowledge: character.newKnowledge,
    relationDeltas: character.relationDeltas,
  }));

  // 3. 回写角色档案
  const result = await persistCharacterEnrichment(input, deps, deltas);
  return result;
}

/**
 * 校验 LLM 输出符合 character enrichment schema 的基本约束。
 */
export function validateCharacterEnrichmentOutput(output: CharacterEnrichmentOutput): void {
  const validate = new Ajv({ allErrors: true, strict: false }).compile(characterEnrichmentSchema);
  if (!validate(output)) {
    throw new Error(`角色富化提取结果无效：${validate.errors?.map((item) => `${item.instancePath}:${item.message}`).join("；") ?? "未知错误"}`);
  }
}

/**
 * 把角色富化增量回写到 entities / memory_claims / relations。
 *
 * 设计依据：AGENTS.md「reusable contracts」——回写逻辑题材无关，只处理通用结构。
 *
 * 导出供 materializeExternalEnrichment 复用，避免 external-mcp 双路径下重复实现回写逻辑。
 */
export async function persistCharacterEnrichment(input: { projectId: string; documentId: string; revisionId: string; narrativeOrder: number; artifact: Artifact }, deps: EnrichCharactersDeps, deltas: CharacterEnrichmentDelta[]): Promise<EnrichCharactersResult> {
  let entityUpdates = 0;
  let relationRecords = 0;
  const knowledgeClaims: MemoryClaim[] = [];

  for (const delta of deltas) {
    // P1-D3: entity id 统一为 `entity:${projectId}:character:${characterId}` 格式，
    // relations.subject_id/object_id 必须使用同样的 entityId 格式才能与 entities.id 对齐，
    // 否则 GraphMemoryProvider 基于 relations 表的图检索会找不到对应 entity（id 不匹配）。
    // 设计依据：AGENTS.md「root-cause analysis」——id 不对齐是数据模型层机制错误，
    // 不是单点 bug，会影响所有依赖 relations.subject_id=entities.id 的图遍历逻辑。
    const subjectEntityId = `entity:${input.projectId}:character:${delta.characterId}`;
    const existingEntity = await deps.repository.pool.query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM entities WHERE id=$1",
      [subjectEntityId],
    );
    const existingPayload = existingEntity.rows[0]?.payload ?? {};
    const mergedPayload = {
      ...existingPayload,
      voiceAnchor: mergeVoiceAnchor(existingPayload.voiceAnchor, delta.voiceAnchor),
      motivation: NO_MOTIVATION_CHANGE_REGEX.test(delta.motivationDelta.trim())
        ? existingPayload.motivation ?? undefined
        : delta.motivationDelta,
    };
    await deps.repository.pool.query(
      `INSERT INTO entities(id, project_id, kind, name, payload)
       VALUES($1, $2, 'character', $3, $4)
       ON CONFLICT(id) DO UPDATE SET payload=EXCLUDED.payload, name=EXCLUDED.name`,
      [subjectEntityId, input.projectId, delta.characterId, mergedPayload],
    );
    entityUpdates += 1;

    // 3b. 创建 MemoryClaim（角色知识边界）
    for (const knowledge of delta.newKnowledge) {
      const contentHash = createHash("sha256").update(`knowledge:${delta.characterId}:${knowledge.description}`).digest("hex");
      const claim: MemoryClaim = {
        id: `claim:knowledge:${input.revisionId}:${contentHash.slice(0, 16)}`,
        projectId: input.projectId,
        kind: "episodic",
        title: `${delta.characterId} 的信息边界（第${input.narrativeOrder}章）`,
        content: knowledge.description,
        subjectRefs: [delta.characterId],
        narrativeRange: { start: input.narrativeOrder, end: input.narrativeOrder },
        knowledgeScope: { characterId: delta.characterId },
        authority: "derived",
        confidence: 0.85,
        sourceRevisionIds: [input.revisionId],
        contentHash,
        supersedes: [],
        predicate: "character-knows",
      };
      const recorded = await deps.repository.recordFactExtraction({
        projectId: input.projectId,
        artifact: input.artifact,
        claims: [claim],
        lifecycleStatus: "active",
        documentId: input.documentId,
        revisionId: input.revisionId,
        narrativeOrder: input.narrativeOrder,
      });
      if (recorded.length) {
        knowledgeClaims.push(recorded[0]);
        if (deps.memoryIndex) {
          try {
            await deps.memoryIndex.upsertClaims(input.projectId, recorded);
          } catch (error) {
            console.warn(`[character-enrichment] Qdrant 索引失败（不阻塞）：${(error as Error).message}`);
          }
        }
      }
    }

    // 3c. UPSERT relations（关系变化）
    // P1-D3: subject_id/object_id 使用 entityId 格式（与 entities.id 对齐），
    // 让 GraphMemoryProvider 的 BFS/DFS 能正确串联 entities 和 relations。
    //
    // P1-D4: relations.object_id 有 FK 约束引用 entities.id（010_fk_cascade.sql）。
    // relationDeltas 的 targetCharacterId 通常是本章"被提及但未作为富化主体"的角色
    // （如配角、首次出场角色），其 entity 可能尚未创建。原实现只对 subject 创建 entity，
    // 导致 relations INSERT 触发 FK 违反（observed: 江南男子/苏晚意 不在 entities 表），
    // 进而让 enrichCharacters activity 重试 3 次后失败、整个章节 workflow 终止。
    //
    // 根因（AGENTS.md「root-cause analysis」）：relations 要求两端 entity 都存在，
    // 这是数据模型层的引用完整性约束，而非单点 bug——任何"关系指向未富化角色"的章节
    // 都会触发同一类失败。修复在最低共享层（persistCharacterEnrichment 回写逻辑）：
    // 插入 relation 前对 object entity 做幂等 UPSERT（ON CONFLICT DO NOTHING）。
    // 已存在的 entity 不覆盖（保留历史富化数据），新 entity 写入 stub 标记
    // （payload.pendingEnrichment=true），待后续章节把它作为主体富化时补全
    // voiceAnchor/motivation。本修复题材无关，覆盖所有"关系指向未富化角色"的输入类。
    // 回归风险：无——ON CONFLICT DO NOTHING 对已存在 entity 无副作用；新 stub entity
    // 仅满足 FK + 图遍历可达性，不影响 character-reviewer（它按 subject 富化数据审校）。
    for (const relation of delta.relationDeltas) {
      const objectEntityId = `entity:${input.projectId}:character:${relation.targetCharacterId}`;
      await deps.repository.pool.query(
        `INSERT INTO entities(id, project_id, kind, name, payload)
         VALUES($1, $2, 'character', $3, $4)
         ON CONFLICT(id) DO NOTHING`,
        [
          objectEntityId,
          input.projectId,
          relation.targetCharacterId,
          { autoCreated: true, autoCreatedFrom: "relation", sourceRevisionId: input.revisionId, narrativeOrder: input.narrativeOrder, pendingEnrichment: true },
        ],
      );
      const relationId = `relation:${input.projectId}:${subjectEntityId}:${relation.predicate}:${objectEntityId}:${input.revisionId}`;
      await deps.repository.pool.query(
        `INSERT INTO relations(id, project_id, subject_id, predicate, object_id, valid_from, source_revision_id)
         VALUES($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT(id) DO NOTHING`,
        [
          relationId,
          input.projectId,
          subjectEntityId,
          relation.predicate,
          objectEntityId,
          Date.now(),
          input.revisionId,
        ],
      );
      relationRecords += 1;
    }
  }

  return { deltas, knowledgeClaims, relationRecords, entityUpdates };
}

/**
 * 合并 voiceAnchor：渐进式合并策略，保留历史观测避免单章漂移。
 *
 * 设计依据：AGENTS.md「root-cause analysis」——原实现"新值覆盖旧值"是机制错误，
 * 单章 LLM 提取的 voiceAnchor 可能因剧情需要偏离常态（如角色伪装、情绪爆发），
 * 直接覆盖会让 character-reviewer 在后续章节基于"伪装声部"审校，导致误判。
 *
 * 合并规则（题材无关的通用机制，不内置套路）：
 * - 维度相同：新旧值都保留，按时间拼接（最新在前），让审校器看到声部演变轨迹
 * - 维度新增（旧值缺失）：直接采用新值
 * - 维度未变（新值缺失）：保留旧值
 * - 历史轨迹上限 3 条（避免无限增长），超出时丢弃最旧
 *
 * 不通过 craft rule 配置——这是数据完整性约束，不是题材特化规则。
 *
 * 返回值存入 entities.payload.voiceAnchor（JSONB），结构为
 * `{ sentenceLength: { latest, history }, vocabulary: ..., directness: ..., avoidance: ... }`。
 * character-reviewer 读取时优先看 latest，必要时参考 history 判断是否单章偏离。
 */
type MergedVoiceAnchor = Record<string, { latest: string; history: string[] }>;
function mergeVoiceAnchor(existing: unknown, delta: CharacterEnrichmentDelta["voiceAnchor"]): MergedVoiceAnchor {
  const MAX_HISTORY = 3;
  if (typeof existing !== "object" || existing === null || Array.isArray(existing)) {
    // 旧值不是对象（首次写入或脏数据），返回带历史轨迹的 delta
    return appendHistory(undefined, delta, MAX_HISTORY);
  }
  return appendHistory(existing as Record<string, unknown>, delta, MAX_HISTORY);
}

/**
 * 把新观测的 voiceAnchor 维度追加到历史轨迹。
 *
 * 输出格式：每个维度是 `{ latest: string, history: string[] }`，
 * 让 character-reviewer 看到角色声部的演变轨迹而非单一快照。
 * 兼容旧格式（纯字符串）：读取时若旧值是字符串，转为 latest 单元素 history。
 */
function appendHistory(existing: Record<string, unknown> | undefined, delta: CharacterEnrichmentDelta["voiceAnchor"], maxHistory: number): MergedVoiceAnchor {
  const dimensions: Array<keyof CharacterEnrichmentDelta["voiceAnchor"]> = ["sentenceLength", "vocabulary", "directness", "avoidance"];
  const result: MergedVoiceAnchor = {};
  for (const dim of dimensions) {
    const newValue = delta[dim];
    const oldValue = existing?.[dim];
    if (typeof oldValue === "string") {
      // 旧格式：纯字符串，转为 latest + history
      result[dim] = {
        latest: newValue,
        history: dedupeHistory([oldValue, newValue], maxHistory),
      };
    } else if (oldValue && typeof oldValue === "object" && !Array.isArray(oldValue) && "latest" in oldValue) {
      // 已有轨迹格式：追加新值
      // 经 unknown 中转：oldValue 经 "latest" in 收窄后为 object & Record<"latest", unknown>，
      // 直接转 { history: string[] } 会被 TS 判定重叠不足，先转 unknown 再转目标类型。
      const oldRecord = oldValue as unknown as { history?: unknown };
      const oldHistory = Array.isArray(oldRecord.history) ? (oldRecord.history as string[]) : [];
      result[dim] = {
        latest: newValue,
        history: dedupeHistory([newValue, ...oldHistory], maxHistory),
      };
    } else {
      // 旧值缺失或脏数据，初始化轨迹
      result[dim] = {
        latest: newValue,
        history: [newValue],
      };
    }
  }
  return result;
}

/**
 * 去重并截断历史轨迹，避免同一观测值重复堆积。
 */
function dedupeHistory(values: string[], max: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const v of values) {
    if (!v || seen.has(v)) continue;
    seen.add(v);
    result.push(v);
    if (result.length >= max) break;
  }
  return result;
}

/**
 * 解析外部 MCP 提交的 character enrichment 结果（与 materializeExternalFacts 对称）。
 */
export function parseCharacterEnrichmentOutput(value: unknown): CharacterEnrichmentOutput {
  const output = value as CharacterEnrichmentOutput;
  validateCharacterEnrichmentOutput(output);
  return output;
}
