import { novelDb, recordBase } from "./db";
import { vectorSearch } from "./retrieval";
import { resolveNovelSkills } from "./skills";
import type { ContextSource, NovelContextPacket, NovelSkillManifest, NovelSkillStage } from "./types";

function estimateTokens(text: string) {
  const cjk = (text.match(/[\u3400-\u9fff]/g) ?? []).length;
  return Math.ceil(cjk * 1.1 + (text.length - cjk) / 4);
}

function source(
  kind: ContextSource["kind"],
  id: string,
  title: string,
  content: string,
  weight: number,
  pinned = false,
  reason = "与当前任务相关",
  priorityClass: ContextSource["priorityClass"] = "relevant",
): ContextSource {
  let hash = 2166136261;
  for (let index = 0; index < content.length; index += 1) hash = Math.imul(hash ^ content.charCodeAt(index), 16777619);
  return { id, kind, title, content, weight, pinned, estimatedTokens: estimateTokens(content), reason, priorityClass, contentHash: (hash >>> 0).toString(16).padStart(8, "0") };
}

export async function compileNovelContext(params: {
  projectId: string;
  task: string;
  instruction: string;
  targetDocumentId?: string;
  pinnedSourceIds?: string[];
  stage?: NovelSkillStage;
  explicitSkillIds?: string[];
  resolvedSkills?: NovelSkillManifest[];
}): Promise<NovelContextPacket> {
  const { projectId, task, instruction, targetDocumentId, pinnedSourceIds = [] } = params;
  const [project, architecture, entities, relations, outline, scenes, threads, clues, snapshots, documents] = await Promise.all([
    novelDb.projects.get(projectId),
    novelDb.architectures.where("projectId").equals(projectId).first(),
    novelDb.entities.where("projectId").equals(projectId).toArray(),
    novelDb.relations.where("projectId").equals(projectId).toArray(),
    novelDb.outlineNodes.where("projectId").equals(projectId).sortBy("order"),
    novelDb.scenes.where("projectId").equals(projectId).sortBy("order"),
    novelDb.plotThreads.where("projectId").equals(projectId).toArray(),
    novelDb.foreshadowing.where("projectId").equals(projectId).toArray(),
    novelDb.snapshots.where("projectId").equals(projectId).reverse().sortBy("createdAt"),
    novelDb.documents.where("projectId").equals(projectId).reverse().sortBy("updatedAt"),
  ]);
  if (!project) throw new Error("项目不存在");
  const stage = params.stage ?? (task.includes("review") || task === "continuity" ? "review" : task === "draft" ? "drafting" : "planning");
  const resolvedSkills = params.resolvedSkills ?? (await resolveNovelSkills({ projectId, stage, explicitSkillIds: params.explicitSkillIds })).skills;

  const target = targetDocumentId ? documents.find((item) => item.id === targetDocumentId) : undefined;
  const terms = `${instruction} ${target?.title ?? ""} ${target?.plainText.slice(-3000) ?? ""}`
    .toLowerCase()
    .split(/[\s，。；、！？,.!?;:“”"'（）()\[\]]+/)
    .filter((item) => item.length > 1);
  const relevance = (text: string) => terms.reduce((score, term) => score + (text.toLowerCase().includes(term) ? 8 : 0), 0);

  // 向量语义检索：与关键词匹配形成混合检索，提升长篇后期上下文质量。
  // 失败时（API 错误、空 embedding 表）降级为空数组，行为与纯关键词一致。
  const vectorResults = await vectorSearch({
    projectId,
    query: instruction,
    targetTables: ["entities", "outlineNodes", "documents", "plotThreads", "foreshadowing"],
    topK: 30,
  }).catch(() => [] as Array<{ targetId: string; targetTable: string; score: number }>);
  const vectorScoreMap = new Map<string, number>();
  for (const r of vectorResults) vectorScoreMap.set(r.targetId, r.score);

  const candidates: ContextSource[] = [
    source("instruction", "instruction", "本次任务", instruction, 100, true, "用户本次明确指令", "invariant"),
    source("style", project.id, "项目定位与文风", [project.premise, `题材：${project.genre.join("、")}`, `主题：${project.themes.join("、")}`, `视角：${project.pov}`, `基调：${project.tone}`, project.languageStyle].filter(Boolean).join("\n"), 90, true, "项目级创作契约", "invariant"),
  ];

  if (architecture) {
    candidates.push(source(
      "architecture",
      architecture.id,
      "已确认的全书架构",
      [
        `结构方法：${architecture.framework}`,
        `核心问题：${architecture.centralQuestion}`,
        `读者承诺：${architecture.readerPromise}`,
        `核心冲突：${architecture.centralConflict}`,
        `失败代价：${architecture.stakes}`,
        `结局承诺：${architecture.endingPromise}`,
        `全书梗概：${architecture.synopsis}`,
        `结构阶段：\n${architecture.phases.map((phase) => `${phase.order + 1}. ${phase.title}：${phase.purpose}；转折：${phase.turningPoint}`).join("\n")}`,
      ].join("\n"),
      architecture.status === "approved" ? 96 : 78,
      architecture.status === "approved",
      architecture.status === "approved" ? "用户已批准的全书结构" : "当前全书结构草案",
      architecture.status === "approved" ? "invariant" : "working",
    ));
  }

  for (const skill of resolvedSkills) {
    const item = source("skill", skill.id, `创作技能：${skill.name}`, skill.prompt, 82 + Math.min(18, skill.priority / 50), skill.priority >= 900, `${stage} 阶段启用 · ${skill.source}`, skill.priority >= 900 ? "invariant" : "working");
    item.skillId = skill.skillId;
    candidates.push(item);
  }

  if (target) candidates.push(source("document", target.id, `当前章节：${target.title}`, target.plainText, 95, true, "当前工作正文", "working"));
  for (const entity of entities) {
    const detail = [entity.summary, entity.description, ...entity.lockedFacts, entity.character ? JSON.stringify(entity.character) : ""].filter(Boolean).join("\n");
    const invariant = entity.lockedFacts.length > 0 || entity.kind === "rule";
    const vScore = vectorScoreMap.get(entity.id) ?? 0;
    candidates.push(source("entity", entity.id, `${entity.kind}：${entity.name}`, detail, (invariant ? 86 : 50) + relevance(`${entity.name} ${detail}`) + vScore * 40, invariant || pinnedSourceIds.includes(entity.id), invariant ? "锁定事实或世界规则" : "实体名称或内容与任务相关", invariant ? "invariant" : "relevant"));
  }
  for (const relation of relations) {
    const from = entities.find((item) => item.id === relation.fromEntityId)?.name ?? "未知";
    const to = entities.find((item) => item.id === relation.toEntityId)?.name ?? "未知";
    candidates.push(source("relation", relation.id, `${from} → ${to}`, `${relation.relationType}\n表面：${relation.publicLabel}\n真相：${relation.privateTruth}`, 45 + relevance(`${from} ${to}`), pinnedSourceIds.includes(relation.id), "关系人物与任务相关", "relevant"));
  }
  for (const node of outline.filter((item) => item.status !== "resolved").slice(0, 30)) {
    const vScore = vectorScoreMap.get(node.id) ?? 0;
    candidates.push(source("outline", node.id, `${node.kind}：${node.title}`, `${node.summary}\n因果：${node.causality}\n结果：${node.outcome}`, 55 + relevance(`${node.title} ${node.summary}`) + vScore * 40, pinnedSourceIds.includes(node.id), "未来未完成故事节点", "working"));
  }
  const targetChapterId = target?.id;
  for (const scene of scenes.filter((item) => !targetChapterId || item.chapterId === targetChapterId)) {
    const characterNames = scene.characterIds.map((id) => entities.find((item) => item.id === id)?.name).filter(Boolean).join("、");
    candidates.push(source(
      "scene",
      scene.id,
      `场景：${scene.title}`,
      [`功能：${scene.purpose}`, `冲突：${scene.conflict}`, `结果：${scene.outcome}`, `POV：${entities.find((item) => item.id === scene.povCharacterId)?.name ?? "未设置"}`, `角色：${characterNames || "未设置"}`, `时间：${scene.storyTime ?? "未设置"}`, `节拍：${(scene.beats ?? []).map((beat) => beat.text).join(" → ")}`].join("\n"),
      targetChapterId === scene.chapterId ? 92 : 48,
      targetChapterId === scene.chapterId,
      targetChapterId === scene.chapterId ? "当前章节场景计划" : "相关场景计划",
      "working",
    ));
  }
  for (const thread of threads.filter((item) => item.status === "active" || item.status === "planned")) {
    const vScore = vectorScoreMap.get(thread.id) ?? 0;
    candidates.push(source("thread", thread.id, `剧情线：${thread.title}`, `${thread.summary}\n下一步：${thread.nextMove}`, 65 + thread.priority + relevance(thread.title) + vScore * 40, pinnedSourceIds.includes(thread.id), "活跃或计划中的剧情线", "working"));
  }
  for (const clue of clues.filter((item) => !["resolved", "abandoned"].includes(item.status))) {
    const vScore = vectorScoreMap.get(clue.id) ?? 0;
    candidates.push(source("foreshadowing", clue.id, `伏笔：${clue.title}`, `${clue.clue}\n真相：${clue.truth}\n状态：${clue.status}`, 60 + clue.urgency + relevance(clue.title) + vScore * 40, pinnedSourceIds.includes(clue.id), "尚未回收的伏笔", "working"));
  }
  if (snapshots[0]) candidates.push(source("snapshot", snapshots[0].id, `当前故事状态：${snapshots[0].label}`, `${snapshots[0].storyTime}\n${snapshots[0].recentSummary}\n未解决冲突：${snapshots[0].unresolvedConflicts.join("；")}`, 88, true, "最新正式故事快照", "invariant"));
  const taste = await novelDb.tasteProfiles.where("projectId").equals(projectId).and((item) => item.status === "confirmed").last();
  if (taste) candidates.push(source("taste", taste.id, "项目写作偏好", `${taste.summary}\n偏好：${taste.preferredPatterns.join("；")}\n避免：${taste.avoidedPatterns.join("；")}`, 84, true, "用户已确认的项目内偏好", "invariant"));

  const recentDocs = documents.filter((item) => item.id !== target?.id).slice(0, project.settings.recentChapterCount);
  for (const doc of recentDocs) {
    const vScore = vectorScoreMap.get(doc.id) ?? 0;
    candidates.push(source("document", doc.id, `近期章节：${doc.title}`, doc.summary || doc.plainText.slice(0, 1200), 72 + vScore * 40, pinnedSourceIds.includes(doc.id), "近期章节摘要或原文", "background"));
  }

  const sorted = candidates.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.weight - a.weight);
  const included: ContextSource[] = [];
  const omitted: string[] = [];
  let used = 0;
  for (const candidate of sorted) {
    if (used + candidate.estimatedTokens <= project.settings.contextBudget || candidate.pinned) {
      if (used + candidate.estimatedTokens > project.settings.contextBudget && candidate.content.length > 1600) {
        candidate.content = `${candidate.content.slice(0, 1600)}\n[内容已按上下文预算截断]`;
        candidate.estimatedTokens = estimateTokens(candidate.content);
        candidate.truncated = true;
      }
      included.push(candidate);
      used += candidate.estimatedTokens;
    } else {
      omitted.push(candidate.id);
    }
  }

  const packet: NovelContextPacket = {
    ...recordBase(projectId),
    task,
    instruction,
    targetId: targetDocumentId,
    sources: included,
    tokenBudget: project.settings.contextBudget,
    estimatedTokens: used,
    omittedSourceIds: omitted,
    skillRefs: resolvedSkills.map((skill) => ({ id: skill.skillId, version: skill.version, name: skill.name, source: skill.source })),
    compiledAt: Date.now(),
  };
  await novelDb.contextPackets.add(packet);
  return packet;
}

export function formatContextPacket(packet: NovelContextPacket) {
  return packet.sources.map((item) => `## ${item.title}\n[来源理由：${item.reason}；层级：${item.priorityClass}；哈希：${item.contentHash}]\n${item.content}`).join("\n\n");
}
