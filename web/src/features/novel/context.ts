import { normalizeArchitecturePhases, novelDb, recordBase } from "./db";
import { vectorSearch } from "./retrieval";
import { resolveNovelSkills } from "./skills";
import type { ContextSource, DerivedMemory, FactAssertion, NovelAgentRole, NovelContextPacket, NovelRetrievalHit, NovelSkillManifest, NovelSkillStage, StoryEntity, WorkflowStage } from "./types";

const LAYERS: ContextSource["layer"][] = ["mandatory", "working", "continuity", "retrieval", "background"];

const ROLE_SOURCE_KINDS: Partial<Record<NovelAgentRole, Set<ContextSource["kind"]>>> = {
  architect: new Set(["instruction", "style", "architecture", "entity", "relation", "outline", "scene", "thread", "foreshadowing", "fact", "memory", "creative-brief", "skill", "conversation-memory"]),
  writer: new Set(["instruction", "style", "taste", "architecture", "document", "entity", "relation", "scene", "thread", "foreshadowing", "fact", "knowledge", "memory", "creative-brief", "skill", "conversation-memory"]),
  "style-reviewer": new Set(["instruction", "style", "taste", "document", "creative-brief", "skill", "conversation-memory"]),
  "character-reviewer": new Set(["instruction", "style", "document", "entity", "relation", "fact", "knowledge", "memory", "creative-brief", "skill", "conversation-memory"]),
  "continuity-reviewer": new Set(["instruction", "architecture", "document", "entity", "relation", "outline", "scene", "thread", "foreshadowing", "snapshot", "fact", "knowledge", "memory", "creative-brief", "skill"]),
  "plot-reviewer": new Set(["instruction", "architecture", "document", "outline", "scene", "thread", "foreshadowing", "memory", "creative-brief", "skill"]),
  "pacing-reviewer": new Set(["instruction", "architecture", "document", "outline", "scene", "thread", "memory", "creative-brief", "skill"]),
  "revision-editor": new Set(["instruction", "style", "taste", "architecture", "document", "entity", "relation", "scene", "thread", "foreshadowing", "fact", "knowledge", "memory", "creative-brief", "skill", "conversation-memory"]),
  "fact-extractor": new Set(["instruction", "document", "fact", "creative-brief", "skill"]),
  "character-enricher": new Set(["instruction", "document", "entity", "fact", "knowledge", "creative-brief", "skill"]),
};

/**
 * 按 taskKey 排除与任务焦点无关的 skill。
 * TODO P2: 后续可改为在 generation task 定义中声明 excludedSkills 字段，由 task 自治声明，
 * 而非在此硬编码映射表。
 */
const TASK_SKILL_EXCLUSIONS: Record<string, Set<string>> = {
  // 世界观完善任务聚焦地点/组织/规则/物品/物种/能力/术语，人物塑造技能与此无关
  worldview: new Set(["classic-character-ensemble", "character-desire-engine"]),
};

function estimateTokens(text: string) {
  const cjk = (text.match(/[\u3400-\u9fff]/g) ?? []).length;
  return Math.ceil(cjk * 1.1 + (text.length - cjk) / 4);
}

function source(params: {
  kind: ContextSource["kind"];
  id: string;
  title: string;
  content: string;
  weight: number;
  layer: ContextSource["layer"];
  pinned?: boolean;
  reason?: string;
  priorityClass?: ContextSource["priorityClass"];
  visibilityReason?: string;
  authority?: ContextSource["authority"];
  sourceRevisionId?: string;
  narrativeOrder?: number;
  evidenceRefs?: string[];
  retrieval?: ContextSource["retrieval"];
}): ContextSource {
  let hash = 2166136261;
  for (let index = 0; index < params.content.length; index += 1) hash = Math.imul(hash ^ params.content.charCodeAt(index), 16777619);
  return {
    id: params.id,
    kind: params.kind,
    title: params.title,
    content: params.content,
    weight: params.weight,
    pinned: params.pinned ?? false,
    estimatedTokens: estimateTokens(params.content),
    reason: params.reason ?? "与当前任务相关",
    priorityClass: params.priorityClass ?? "relevant",
    contentHash: (hash >>> 0).toString(16).padStart(8, "0"),
    layer: params.layer,
    visibilityReason: params.visibilityReason ?? params.reason ?? "当前信息视角允许读取",
    authority: params.authority ?? "working",
    sourceRevisionId: params.sourceRevisionId,
    narrativeOrder: params.narrativeOrder,
    evidenceRefs: params.evidenceRefs,
    retrieval: params.retrieval,
  };
}

function searchTerms(instruction: string, targetText: string) {
  return `${instruction} ${targetText}`.toLowerCase().split(/[\s，。；、！？,.!?;:“”"'（）()\[\]]+/).filter((item) => item.length > 1);
}

function relevance(terms: string[], text: string) {
  const lower = text.toLowerCase();
  return terms.reduce((score, term) => score + (lower.includes(term) ? 8 : 0), 0);
}

function defaultInformationView(stage: NovelSkillStage, target?: { blueprint?: { povCharacterId?: string } }) {
  if (stage === "drafting" || stage === "revision") return target?.blueprint?.povCharacterId ? "character" as const : "reader" as const;
  return "author" as const;
}

function entityContent(entity: StoryEntity, mode: "author" | "reader" | "character", selectedCharacterId?: string, options?: { compactCharacter?: boolean }) {
  if (mode === "author") {
    // 世界观等非人物焦点任务下，character 实体只暴露摘要与描述，省略 lockedFacts 与完整 character JSON
    if (entity.kind === "character" && options?.compactCharacter) return [entity.summary, entity.description].filter(Boolean).join("\n");
    return [entity.summary, entity.description, ...entity.lockedFacts, entity.character ? JSON.stringify(entity.character) : ""].filter(Boolean).join("\n");
  }
  if (entity.kind === "rule") return [entity.summary, entity.description, ...entity.lockedFacts].filter(Boolean).join("\n");
  if (entity.kind !== "character" || !entity.character) return [entity.summary, entity.description].filter(Boolean).join("\n");
  const shared = [`摘要：${entity.summary}`, `外观：${entity.character.appearance}`, `声音：${entity.character.voice}`];
  if (mode === "character" && entity.id === selectedCharacterId) shared.push(`当前目标：${entity.character.desire}`, `动机：${entity.character.motivation}`);
  return shared.filter(Boolean).join("\n");
}

function memoryText(memory: DerivedMemory) {
  const details = [
    ...memory.content.sceneOutcomes,
    ...memory.content.stateChanges,
    ...memory.content.knowledgeChanges,
    ...memory.content.relationshipChanges,
    ...memory.content.threadProgress,
    ...memory.content.foreshadowingProgress,
    ...memory.content.inheritedPressures.map((item) => `继承压力：${item}`),
  ];
  return [memory.summary, ...details].filter(Boolean).join("\n");
}

function revealOrder(assertion: FactAssertion, documentOrderByRevision: Map<string, number>) {
  return assertion.revealedAt?.narrativeOrder ?? documentOrderByRevision.get(assertion.sourceRevisionId);
}

function allocateContext(candidates: ContextSource[]) {
  const unique = [...new Map(candidates.map((candidate) => [candidate.id, candidate])).values()];
  const layerUsage = Object.fromEntries(LAYERS.map((layer) => [layer, 0])) as Record<ContextSource["layer"], number>;
  const included: ContextSource[] = [];
  for (const layer of LAYERS) {
    const ranked = unique.filter((candidate) => candidate.layer === layer).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.weight - a.weight);
    for (const candidate of ranked) {
      included.push(candidate);
      layerUsage[layer] += candidate.estimatedTokens;
    }
  }
  const estimatedTokens = included.reduce((sum, candidate) => sum + candidate.estimatedTokens, 0);
  return { included, omissions: [] as NonNullable<NovelContextPacket["omissions"]>, layerUsage, estimatedTokens };
}

export async function compileNovelContext(params: {
  projectId: string;
  task: string;
  instruction: string;
  targetDocumentId?: string;
  pinnedSourceIds?: string[];
  excludedSourceIds?: string[];
  stage?: NovelSkillStage;
  explicitSkillIds?: string[];
  resolvedSkills?: NovelSkillManifest[];
  informationView?: "author" | "reader" | "character";
  viewCharacterId?: string;
  threadId?: string;
  creativeBriefId?: string;
  retrievalRunId?: string;
  retrievalSourceIds?: string[];
  retrievalHits?: NovelRetrievalHit[];
  factCutoffOrder?: number;
  consumer?: { workflowRunId?: string; stage?: WorkflowStage; role?: NovelAgentRole | string; messageId?: string };
}): Promise<NovelContextPacket> {
  const { projectId, task, instruction, targetDocumentId, pinnedSourceIds = [], excludedSourceIds = [] } = params;
  const [project, architecture, entities, relations, outline, scenes, threads, clues, snapshots, documents, revisions, assertions, knowledge, memories, units] = await Promise.all([
    novelDb.projects.get(projectId),
    novelDb.architectures.where("projectId").equals(projectId).first(),
    novelDb.entities.where("projectId").equals(projectId).toArray(),
    novelDb.relations.where("projectId").equals(projectId).toArray(),
    novelDb.outlineNodes.where("projectId").equals(projectId).sortBy("order"),
    novelDb.scenes.where("projectId").equals(projectId).sortBy("order"),
    novelDb.plotThreads.where("projectId").equals(projectId).toArray(),
    novelDb.foreshadowing.where("projectId").equals(projectId).toArray(),
    novelDb.snapshots.where("projectId").equals(projectId).reverse().sortBy("createdAt"),
    novelDb.documents.where("projectId").equals(projectId).sortBy("order"),
    novelDb.revisions.where("projectId").equals(projectId).toArray(),
    novelDb.factAssertions.where("projectId").equals(projectId).and((item) => item.status === "active").toArray(),
    novelDb.knowledgeAssertions.where("projectId").equals(projectId).and((item) => item.status === "active").toArray(),
    novelDb.derivedMemories.where("projectId").equals(projectId).and((item) => item.status === "active" || item.status === "cold").toArray(),
    novelDb.narrativeUnits.where("projectId").equals(projectId).toArray(),
  ]);
  if (!project) throw new Error("项目不存在");
  const target = targetDocumentId ? documents.find((item) => item.id === targetDocumentId) : undefined;
  const stage = params.stage ?? (task.includes("review") || task === "continuity" ? "review" : task === "draft" ? "drafting" : "planning");
  const mode = params.informationView ?? defaultInformationView(stage, target);
  const characterId = params.viewCharacterId ?? (mode === "character" ? target?.blueprint.povCharacterId : undefined);
  if (mode === "character" && !characterId) throw new Error("角色视角需要指定角色");
  const cutoffOrder = params.factCutoffOrder ?? (target ? target.order - 1 : undefined);
  const resolvedSkills = params.resolvedSkills ?? (await resolveNovelSkills({ projectId, stage, explicitSkillIds: params.explicitSkillIds })).skills;
  const terms = searchTerms(instruction, `${target?.title ?? ""} ${target?.plainText.slice(-3000) ?? ""}`);
  const vectorResults = await vectorSearch({ projectId, query: instruction, targetTables: ["entities", "outlineNodes", "documents", "plotThreads", "foreshadowing"], topK: 30 }).catch(() => [] as Array<{ targetId: string; targetTable: string; score: number }>);
  const vectorScoreMap = new Map(vectorResults.map((result) => [result.targetId, result.score]));
  const pinned = new Set(pinnedSourceIds);
  const excluded = new Set(excludedSourceIds);
  const retrieved = params.retrievalSourceIds ? new Set(params.retrievalSourceIds) : undefined;
  const candidates: ContextSource[] = [];
  const push = (candidate: ContextSource) => {
    const role = params.consumer?.role as NovelAgentRole | undefined;
    const allowedKinds = role ? ROLE_SOURCE_KINDS[role] : undefined;
    if (allowedKinds && !allowedKinds.has(candidate.kind)) return;
    if (pinned.has(candidate.id)) { candidate.pinned = true; candidate.layer = "mandatory"; candidate.priorityClass = "invariant"; candidate.visibilityReason = "作者为本次任务临时固定"; }
    if (retrieved && candidate.layer !== "mandatory" && !retrieved.has(candidate.id) && !candidate.pinned) return;
    if (!excluded.has(candidate.id) || candidate.layer === "mandatory") candidates.push(candidate);
  };

  push(source({ kind: "instruction", id: "instruction", title: "本次任务", content: instruction, weight: 100, layer: "mandatory", pinned: true, reason: "作者本次明确指令", priorityClass: "invariant", authority: "author" }));
  push(source({ kind: "style", id: `style:${project.id}`, title: "项目定位与文风", content: [project.premise, `题材：${project.genre.join("、")}`, `主题：${project.themes.join("、")}`, `视角：${project.pov}`, `基调：${project.tone}`, project.languageStyle].filter(Boolean).join("\n"), weight: 95, layer: "mandatory", pinned: true, reason: "已确认的创作契约", priorityClass: "invariant", authority: "approved", evidenceRefs: [project.id] }));
  if (params.creativeBriefId) {
    const brief = await novelDb.creativeBriefs.get(params.creativeBriefId);
    if (!brief || brief.status !== "confirmed" || brief.projectId !== projectId) throw new Error("创作简报不存在或尚未确认");
    push(source({ kind: "creative-brief", id: brief.id, title: "本次已确认创作简报", content: [`目标：${brief.goal}`, brief.povCharacterId ? `POV：${brief.povCharacterId}` : "", `事实截止点：章节顺序 ${brief.factCutoffOrder ?? cutoffOrder ?? "未指定"}`, `基调：${brief.tone || "沿用项目基调"}`, `语言要求：${brief.languageRequirements.join("；") || "沿用项目文风"}`, `必写：${brief.mustHappen.join("；") || "无"}`, `禁写：${brief.forbidden.join("；") || "无"}`, `目标字数：${brief.targetWords}`].filter(Boolean).join("\n"), weight: 100, layer: "mandatory", pinned: true, reason: "作者确认的本次章节生产契约", priorityClass: "invariant", authority: "author", evidenceRefs: brief.sourceMessageIds }));
  }
  for (const hit of params.retrievalHits ?? []) {
    push(source({ kind: hit.kind, id: hit.sourceId, title: hit.title, content: hit.content, weight: 70 + hit.fusedScore * 100, layer: "retrieval", reason: hit.reason, priorityClass: "relevant", authority: hit.authority, narrativeOrder: hit.narrativeOrder, evidenceRefs: hit.evidenceRefs, retrieval: { runId: params.retrievalRunId ?? "", round: hit.round, lexicalRank: hit.lexicalRank, vectorRank: hit.vectorRank, entityRank: hit.entityRank, fusedScore: hit.fusedScore } }));
  }
  if (params.consumer?.stage === "draft" && mode === "character") {
    push(source({ kind: "instruction", id: "pov-boundary", title: "POV 行为边界", content: "作者层真相和未来创作契约只能约束叙事铺垫，当前 POV 角色的判断、对白和主动行为只能依据其已知、怀疑或误解的内容。不得让角色利用尚未得知的信息。", weight: 100, layer: "mandatory", pinned: true, reason: "正文阶段必须隔离作者知识与角色知识", priorityClass: "invariant", authority: "approved" }));
  }
  if (params.threadId) {
    const conversationMemories = await novelDb.conversationMemories.where("projectId").equals(projectId).and((memory) => memory.status === "active" && (!memory.threadId || memory.threadId === params.threadId || memory.scope === "project")).toArray();
    for (const memory of conversationMemories) push(source({ kind: "conversation-memory", id: memory.id, title: memory.title, content: memory.content, weight: 78 + memory.confidence * 12, layer: params.retrievalSourceIds?.includes(memory.id) ? "working" : "retrieval", reason: "作者对话中提炼并仍然有效的偏好", priorityClass: "working", authority: "author", evidenceRefs: memory.sourceMessageIds }));
  }
  if (architecture) push(source({ kind: "architecture", id: architecture.id, title: architecture.status === "approved" ? "已批准全书架构（创作契约，不是已发生事实）" : "全书架构草案", content: [`结构方法：${architecture.framework}`, `核心问题：${architecture.centralQuestion}`, `核心冲突：${architecture.centralConflict}`, `全书梗概：${architecture.synopsis}`, `结构阶段：\n${normalizeArchitecturePhases(architecture.phases).map((phase) => `${phase.order + 1}. ${phase.title}：${phase.purpose}；转折：${phase.turningPoint}`).join("\n")}`].join("\n"), weight: architecture.status === "approved" ? 96 : 72, layer: architecture.status === "approved" ? "mandatory" : "working", pinned: architecture.status === "approved", reason: architecture.status === "approved" ? "作者批准的未来创作契约" : "尚未批准的工作规划", priorityClass: architecture.status === "approved" ? "invariant" : "working" }));
  for (const skill of resolvedSkills) {
    if (TASK_SKILL_EXCLUSIONS[task]?.has(skill.skillId)) continue;
    const item = source({ kind: "skill", id: `skill:${skill.id}`, title: `创作技能：${skill.name}`, content: skill.prompt, weight: 82 + Math.min(18, skill.priority / 50), layer: "mandatory", pinned: true, reason: `${stage} 阶段启用 · ${skill.source}`, priorityClass: "invariant" });
    item.skillId = skill.skillId;
    push(item);
  }
  if (target) push(source({ kind: "document", id: target.id, title: `当前章节：${target.title}`, content: target.plainText, weight: 98, layer: "mandatory", pinned: true, reason: "当前工作正文", priorityClass: "working" }));

  for (const entity of entities) {
    const detail = entityContent(entity, mode, characterId, { compactCharacter: task === "worldview" });
    const invariant = entity.kind === "rule" || (mode === "author" && entity.lockedFacts.length > 0);
    const related = target?.blueprint.characterIds.includes(entity.id) || target?.blueprint.locationIds.includes(entity.id) || target?.blueprint.povCharacterId === entity.id;
    // worldview 任务下，已有世界观设定（非 character）是生成新设定的直接参考，提升为 working 层
    const worldviewReference = task === "worldview" && entity.kind !== "character";
    const layer = invariant ? "mandatory" : related || worldviewReference ? "working" : "retrieval";
    const baseWeight = invariant ? 90 : related ? 82 : worldviewReference ? 75 : 48;
    const reason = invariant ? "锁定世界规则或作者事实" : related ? "当前章节直接关联对象" : worldviewReference ? "已有世界观设定，生成新设定时必须参考以保持一致" : "实体语义或关键词相关";
    push(source({ kind: "entity", id: entity.id, title: `${entity.kind}：${entity.name}`, content: detail, weight: baseWeight + relevance(terms, `${entity.name} ${detail}`) + (vectorScoreMap.get(entity.id) ?? 0) * 40, layer, pinned: invariant, reason, priorityClass: invariant ? "invariant" : related || worldviewReference ? "working" : "relevant" }));
  }
  for (const relation of relations) {
    const from = entities.find((item) => item.id === relation.fromEntityId)?.name ?? "未知";
    const to = entities.find((item) => item.id === relation.toEntityId)?.name ?? "未知";
    const content = mode === "author" ? `${relation.relationType}\n表面：${relation.publicLabel}\n真相：${relation.privateTruth}` : `${relation.relationType}\n表面：${relation.publicLabel}`;
    // worldview 任务下，已有实体关系也是生成新设定的参考
    const relationLayer = task === "worldview" ? "working" : "retrieval";
    push(source({ kind: "relation", id: relation.id, title: `${from} → ${to}`, content, weight: (task === "worldview" ? 70 : 48) + relevance(terms, `${from} ${to}`), layer: relationLayer, reason: task === "worldview" ? "已有实体关系，生成新设定时参考" : "关系人物与当前任务相关" }));
  }
  if (mode === "author") {
    for (const node of outline.slice(0, 60)) push(source({ kind: "outline", id: node.id, title: `${node.kind}：${node.title}`, content: node.summary, weight: 55 + relevance(terms, `${node.title} ${node.summary}`) + (vectorScoreMap.get(node.id) ?? 0) * 40, layer: "retrieval", reason: "作者视角中的未来创作契约", priorityClass: "working" }));
  }
  for (const scene of scenes.filter((item) => !target || item.chapterId === target.id)) {
    const characterNames = scene.characterIds.map((id) => entities.find((item) => item.id === id)?.name).filter(Boolean).join("、");
    push(source({ kind: "scene", id: scene.id, title: `场景：${scene.title}`, content: [`功能：${scene.purpose}`, `冲突：${scene.conflict}`, `结果：${scene.outcome}`, `角色：${characterNames || "未设置"}`, `节拍：${(scene.beats ?? []).map((beat) => beat.text).join(" → ")}`].join("\n"), weight: 92, layer: target ? "working" : "retrieval", pinned: Boolean(target), reason: target ? "当前章节场景创作契约" : "相关场景计划", priorityClass: "working" }));
  }
  for (const thread of threads.filter((item) => item.status === "active" || item.status === "planned")) push(source({ kind: "thread", id: thread.id, title: `剧情线：${thread.title}`, content: `${thread.summary}\n下一步：${thread.nextMove}`, weight: 66 + thread.priority + relevance(terms, thread.title) + (vectorScoreMap.get(thread.id) ?? 0) * 40, layer: "working", reason: "活跃剧情线", priorityClass: "working" }));
  for (const clue of clues.filter((item) => !["resolved", "abandoned"].includes(item.status))) {
    const content = mode === "author" ? `${clue.clue}\n真相：${clue.truth}\n状态：${clue.status}` : `${clue.clue}\n状态：${clue.status}`;
    push(source({ kind: "foreshadowing", id: clue.id, title: `伏笔：${clue.title}`, content, weight: 62 + clue.urgency + relevance(terms, clue.title) + (vectorScoreMap.get(clue.id) ?? 0) * 40, layer: "working", reason: mode === "author" ? "作者视角中的未回收伏笔" : "当前信息视角允许看到的伏笔表现", priorityClass: "working" }));
  }

  const documentById = new Map(documents.map((document) => [document.id, document]));
  const documentOrderByRevision = new Map(revisions.map((revision) => [revision.id, documentById.get(revision.documentId)?.order]).filter((entry): entry is [string, number] => typeof entry[1] === "number"));
  const readerVisibleFacts = assertions.filter((assertion) => (revealOrder(assertion, documentOrderByRevision) ?? Number.POSITIVE_INFINITY) <= (cutoffOrder ?? Number.POSITIVE_INFINITY));
  const cutoffVisibleFacts = assertions.filter((assertion) => (revealOrder(assertion, documentOrderByRevision) ?? Number.POSITIVE_INFINITY) <= (cutoffOrder ?? Number.POSITIVE_INFINITY));
  const visibleFacts = mode === "author" ? cutoffVisibleFacts : mode === "reader" ? readerVisibleFacts : [];
  for (const assertion of visibleFacts) push(source({ kind: "fact", id: assertion.id, title: `正式资料：${assertion.humanReadable}`, content: [`真值：${assertion.truthStatus}`, `时间：${assertion.timeMode}`, `证据：${assertion.evidence}`].join("\n"), weight: assertion.truthStatus === "objective" ? 88 : 72, layer: assertion.truthStatus === "objective" ? "continuity" : "retrieval", reason: mode === "author" ? "作者视角可见全部有效事实" : "揭示点不晚于当前事实截止点", priorityClass: assertion.truthStatus === "objective" ? "invariant" : "relevant", authority: "approved", sourceRevisionId: assertion.sourceRevisionId, narrativeOrder: assertion.revealedAt?.narrativeOrder, evidenceRefs: [assertion.sourceRevisionId] }));
  if (mode === "character" && characterId) {
    const assertionById = new Map(assertions.map((assertion) => [assertion.id, assertion]));
    const knowledgeCutoffOrder = cutoffOrder ?? Number.POSITIVE_INFINITY;
    for (const item of knowledge.filter((entry) => {
      if (entry.characterId !== characterId) return false;
      const learnedOrder = entry.learnedAt?.narrativeOrder
        ?? (entry.learnedAt?.chapterId ? documentById.get(entry.learnedAt.chapterId)?.order : undefined);
      return learnedOrder !== undefined && learnedOrder <= knowledgeCutoffOrder;
    })) {
      const assertion = assertionById.get(item.factAssertionId);
      if (!assertion) continue;
      push(source({ kind: "knowledge", id: item.id, title: `角色认知：${assertion.humanReadable}`, content: `认知状态：${item.stance}\n${assertion.humanReadable}\n证据：${assertion.evidence}`, weight: 94, layer: "mandatory", pinned: true, reason: "当前 POV 角色在目标时点的认知边界", priorityClass: "invariant", visibilityReason: `角色 ${characterId} 的 ${item.stance} 认知` }));
    }
  }

  const unitById = new Map(units.map((unit) => [unit.id, unit]));
  const currentUnitIds = new Set<string>();
  let cursor = target?.primaryNarrativeUnitId ? unitById.get(target.primaryNarrativeUnitId) : undefined;
  while (cursor) { currentUnitIds.add(cursor.id); cursor = cursor.parentId ? unitById.get(cursor.parentId) : undefined; }
  const eligibleMemories = memories.filter((memory) => mode === "author" || (memory.coverage.endOrder ?? Number.POSITIVE_INFINITY) <= (cutoffOrder ?? Number.POSITIVE_INFINITY));
  const currentMemories = eligibleMemories.filter((memory) => memory.level === "book" || Boolean(memory.narrativeUnitId && currentUnitIds.has(memory.narrativeUnitId)));
  const recentLeaves = eligibleMemories.filter((memory) => memory.level === "chapter").sort((a, b) => (b.coverage.endOrder ?? -1) - (a.coverage.endOrder ?? -1)).slice(0, project.settings.recentChapterCount);
  for (const memory of [...new Map([...currentMemories, ...recentLeaves].map((item) => [item.id, item])).values()]) push(source({ kind: "memory", id: memory.id, title: `${memory.level}记忆：${memory.summary.slice(0, 40)}`, content: memoryText(memory), weight: memory.level === "book" ? 90 : memory.level === "chapter" ? 76 : 86, layer: "continuity", reason: memory.level === "chapter" ? "近期章节叶级记忆" : "当前叙事单元的活跃整合记忆", priorityClass: "working" }));
  for (const memory of eligibleMemories.filter((item) => item.status === "cold" && !currentMemories.some((current) => current.id === item.id) && relevance(terms, memoryText(item)) > 0).slice(0, 12)) push(source({ kind: "memory", id: memory.id, title: `冷记忆命中：${memory.summary.slice(0, 40)}`, content: memoryText(memory), weight: 55 + relevance(terms, memoryText(memory)), layer: "retrieval", reason: "冷记忆被当前任务精确命中" }));

  if (!eligibleMemories.length) {
    const recentDocs = documents.filter((item) => item.id !== target?.id && (mode === "author" || target === undefined || item.order < target.order)).slice(-project.settings.recentChapterCount).reverse();
    for (const document of recentDocs) push(source({ kind: "document", id: `legacy-summary:${document.id}`, title: `旧式近期章节：${document.title}`, content: document.summary || document.plainText, weight: 45, layer: "background", reason: "项目尚未建立章节记忆，临时回退到旧式章节资料" }));
  }
  if (snapshots[0] && !eligibleMemories.length) push(source({ kind: "snapshot", id: snapshots[0].id, title: `旧式故事快照：${snapshots[0].label}`, content: `${snapshots[0].storyTime}\n${snapshots[0].recentSummary}`, weight: 40, layer: "background", reason: "项目尚未建立章节记忆，临时回退到旧式快照" }));
  const taste = await novelDb.tasteProfiles.where("projectId").equals(projectId).and((item) => item.status === "confirmed").last();
  if (taste) push(source({ kind: "taste", id: taste.id, title: "已确认写作偏好", content: `${taste.summary}\n偏好：${taste.preferredPatterns.join("；")}\n避免：${taste.avoidedPatterns.join("；")}`, weight: 88, layer: "mandatory", pinned: true, reason: "作者已确认的文风偏好", priorityClass: "invariant" }));

  const allocated = allocateContext(candidates);
  const packet: NovelContextPacket = {
    ...recordBase(projectId),
    task,
    instruction,
    targetId: targetDocumentId,
    sources: allocated.included,
    estimatedTokens: allocated.estimatedTokens,
    omittedSourceIds: allocated.omissions.map((item) => item.sourceId),
    omissions: allocated.omissions,
    layerUsage: allocated.layerUsage,
    informationView: { mode, targetDocumentId, targetNarrativeOrder: target?.order, characterId },
    skillRefs: resolvedSkills.map((skill) => ({ id: skill.skillId, version: skill.version, name: skill.name, source: skill.source })),
    compiledAt: Date.now(),
    threadId: params.threadId,
    creativeBriefId: params.creativeBriefId,
    retrievalRunId: params.retrievalRunId,
    factCutoffOrder: cutoffOrder,
    consumer: params.consumer ? { ...params.consumer, role: params.consumer.role as NovelAgentRole | undefined } : undefined,
  };
  await novelDb.contextPackets.add(packet);
  return packet;
}

export function formatContextPacket(packet: NovelContextPacket) {
  const view = packet.informationView ? `# 信息视角\n${packet.informationView.mode}${packet.informationView.characterId ? ` · 角色 ${packet.informationView.characterId}` : ""}${packet.informationView.targetNarrativeOrder !== undefined ? ` · 截止章节顺序 ${packet.informationView.targetNarrativeOrder - 1}` : ""}\n\n` : "";
  return `${view}${packet.sources.map((item) => `## ${item.title}\n[层级：${item.layer}；权威：${item.authority ?? "working"}；来源理由：${item.reason}；可见理由：${item.visibilityReason}；哈希：${item.contentHash}]\n${item.content}`).join("\n\n")}`;
}

export function formatReviewerContext(packet: NovelContextPacket) {
  return packet.sources.filter((item) => item.kind !== "skill").map((item) => `## ${item.title}\n[${item.layer} · ${item.visibilityReason}]\n${item.content}`).join("\n\n");
}
