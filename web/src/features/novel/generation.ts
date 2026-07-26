import Ajv, { type ValidateFunction } from "ajv";
import type { Table } from "dexie";
import { callStructuredNovelModel } from "./ai";
import { compileNovelContext, formatContextPacket } from "./context";
import { appendOperation, DEFAULT_CHAPTER_TARGET_WORDS, emptyChapterBlueprint, normalizeArchitecturePayload, normalizeChapterOrderByPlanning, novelDb, recordBase, retireChapterDependencies } from "./db";
import { sanitizeApprovalMetaInPlace } from "./db-schema";
import { resolveTaskEvidence } from "./memory-service";
import { assertProposalReferences, assertResolvedPayloadReferences, buildProjectReferenceCatalogs, catalogWithResolvedProposalItems, emptyReferenceCatalog, repairProposalCharacterReferences, repairTimelineAndOutlineNodeReferences, repairUnresolvableTempRefs } from "./reference-integrity";
import { compileNovelStagePrompt, formatSkillPrompt, resolveNovelSkills } from "./skills";
import type {
  AIProposal,
  AgentRun,
  ArchitecturePhase,
  GenerationAuditIssue,
  GenerationAuditReport,
  GenerationAuditRound,
  NovelAgentRole,
  NovelGenerationScope,
  NovelGenerationTaskKey,
  NovelSkillStage,
  ProposalItem,
  ProposalTargetTable,
  RefinementSnapshot,
  RefinementSnapshotInput,
} from "./types";
import { repairDraftStructureOnce } from "./workflow-stages/draft-structure-repair";
import { auditIssueSchema, formatAuditFindingsForRerun, hasMajorOrBlocker } from "./workflow-shared";

export interface GenerationTaskDefinition {
  key: NovelGenerationTaskKey;
  label: string;
  scope: NovelGenerationScope;
  role: NovelAgentRole;
  skillStage: NovelSkillStage;
  allowedTables: ProposalTargetTable[];
  defaultInstruction: string;
  refinable?: boolean;
}

// 标题文学性共享约束（书名与章节标题复用同一规则）。
// 根因：直陈式命名把故事核心机制/职业/技术名词直接搬进标题，丢失隐喻空间与文学意境。
// 通用规则，适用任意题材：标题须通过文学手法指向主题，而非直陈故事机制；
// 具体手法（典籍化用/现代意象/科幻隐喻/悬疑双关）由项目题材与文风决定，不在本层硬编码。
const NAMING_LITERARY_CONSTRAINT = `【标题文学性约束】书名与章节标题须通过隐喻、意象、对偶、双关或化用等文学手法指向主题，不得直陈故事核心机制、职业、技术名词或事件摘要作为标题主体。
- 标题须能独立成趣，有韵律感与回味空间；与项目设定的文风、时代、地域保持一致——古风/历史题材可化用典籍诗词，都市/现代题材用当代意象，科幻/悬疑题材用未来感隐喻或双关，不得跨题材套用不属当时代的词汇。
- 章节标题禁止"第X章：事件摘要"式纯说明性白话；须让标题成为本章的意境落点或情感锚点，而非功能标签。
- 判定标准：(a) 若把标题替换为事件摘要后读者感受不变，则违规；(b) 若标题只是把故事核心机制/职业/技术名词直接搬上去而缺乏隐喻转化，则违规。改写路径：保留主题内核，寻找能承载该内核的意象、典故或对偶结构。`;

const TASKS: GenerationTaskDefinition[] = [
  { key: "project-positioning", label: "完善项目定位", scope: "bible", role: "architect", skillStage: "foundation", allowedTables: ["projects"], defaultInstruction: `根据核心创意完善题材定位、目标读者、主题、卖点、叙事视角、基调和语言风格。${NAMING_LITERARY_CONSTRAINT}`, refinable: true },
  { key: "architecture", label: "生成全书架构", scope: "architecture", role: "architect", skillStage: "foundation", allowedTables: ["architectures"], defaultInstruction: "为长篇生成与项目体量相称、可持续展开的全书架构。先勾勒人物处境、世态背景与情感底色，再由此自然引出贯穿全书的张力线与阶段流向；核心问题与冲突应藏在人物境遇与选择里，而非作为主题宣告直白写出。每个阶段的 turningPoint 字段必须用文学化叙事书写，同时落到具体资源控制、秘密公开、组织裂变或关系承诺的不可逆变化；不得只写抽象感悟，也不得写成\"接下来会发生什么\"的事件预告。\n\n【架构层硬约束】(1) 多权力中心：权力网络容量必须与项目体量相称；百万字长篇至少包含 5 个独立权力中心（不限于商界/政界/武林/朝廷/家族/宗教/超自然势力/技术集团，依题材而定），每个权力中心有自己的利益、资源、行动能力与底线，能独立推动剧情——不可全部围绕主角或单一反派。权力中心之间至少存在一组非二元对立关系（既有合作又有冲突），避免简单正邪分明的阵营结构。(2) 跨组织反馈：百万字长篇至少包含 3 条反馈链，写明触发条件、跨中心传导步骤、受影响中心与故事压力；affectedCenters 必须引用已建模中心的 id 或准确名称。(3) 长线伏笔钩子：百万字长篇至少留出 3 条可在后续百章缓慢发酵的长线伏笔钩子，以日常细节形态埋设，不自我标榜；其回收路径不得在架构阶段就被锁死单一解释，affectedCenters 同样必须闭合引用。(4) 张力线交织：架构中的多条张力线（主线/支线/对抗线/共谋线/感情线等）必须通过共享人物、资源、秘密或选择相互改变，不得只是平行推进。(5) 第二增长曲线（结构化字段强制）：百万字长篇必须有至少 2 条独立增长曲线，必须在 payload.growthCurves 数组中显式声明——1 条 kind=\"main\"（主线增长曲线）+ 至少 1 条 kind=\"ecological\"（生态增长曲线）。每条曲线必须填写：subject（生态主体，如权力生态、商业生态、制度生态、修炼体系、江湖格局、社会变革、行业演化等，依题材而定）、resourceLoop（资源循环——此曲线运转所依赖的资源获取/流转/消耗机制）、stageGoals（此曲线在架构各阶段的推进目标）、irreversibleChange（此曲线结束时世界已回不去的结构性变化）。ecological 曲线的四个字段必须独立于主线主角命运——判定标准：若删除主线后，该 ecological 曲线能否独立支撑至少一个阶段的推进？若不能，则重构。每个 phase 的 primaryCurveId 必须引用 growthCurves[].id，标注此阶段主要由哪条曲线推进；至少 1 个 phase 的 primaryCurveId 必须引用 ecological 曲线（即至少一个阶段主要由生态曲线推进，而非全部围绕主线）。(6) 穿插节奏约束：架构层应规划剧情段之间的穿插节奏——相邻主线推进剧情段之间应有非主线推进剧情段（世界观穿插/群像塑造/支线编织/呼吸节奏）穿插，稀释主线推进速度。单一 phase 内，主线推进剧情段不建议连续超过 2 个而不穿插。非主线推进剧情段也必须有自身完整的人物处境、矛盾和因果链，不能只是主线休息站或填充章。支线可以独立承担世界观铺陈或群像塑造，不必机械反哺主线。若作品涉及感情线，架构层的感情阶段绑定与多权力中心约束见 stage prompt 的 ## 感情线 section（属于创作契约，非叙事事实）。", refinable: true },
  { key: "plot-design", label: "设计剧情段与章节", scope: "plot-design", role: "architect", skillStage: "planning", allowedTables: ["outlineNodes", "documents"], defaultInstruction: "在选中的幕下设计一个剧情段及其章节。先明确本剧情段的功能类型（主线推进型/世界观穿插型/群像塑造型/支线编织型/呼吸节奏型），在 summary 首行用【功能类型】标注。功能类型决定本剧情段是否推进主线：主线推进型承担阶段转折或关键事件；世界观穿插型纯铺陈世界、群像塑造型深化人物、支线编织型讲支线小故事、呼吸节奏型积累日常与情感——后四者不必推进主线，但必须有自身完整的人物处境、矛盾和因果链。参考前序剧情段的功能类型，若已有连续主线推进剧情段，建议生成交织型剧情段稀释推进速度。章节数量由剧情段需要承载的独立叙事功能、因果跨度、人物视角、篇幅预算和连载回报共同决定，不按固定范围凑数或压缩。若剧情段跨越多种功能或强度，应安排行动、余波、蓄势、兑现等有差异的呼吸；若它本身是单一过渡、完整高潮、短促插曲或实验性结构，则服从该功能，不强制补入低强度章。每章都必须有不可替代的叙事职责和清晰落点。" },
  { key: "story-bible", label: "生成故事资料", scope: "bible", role: "architect", skillStage: "foundation", allowedTables: ["entities", "relations"], defaultInstruction: "生成故事所需的核心角色、地点、组织、物品与世界规则，并建立关键关系。", refinable: true },
  { key: "characters", label: "设计角色", scope: "characters", role: "architect", skillStage: "foundation", allowedTables: ["entities"], defaultInstruction: "为本作设计至少 5 位核心角色，每位角色作为独立的 entity 提案项返回（百万字长篇群像规模硬约束——这是首要要求，不得只返回 1-2 位）。每位角色必须有：明确欲望(desire)、恐惧(weakness)、错误信念、秘密(secret)、人物弧(arc)和差异化声音(voice)；完整的初始 state（location 引用世界观已有 location 实体名 / physical 具体身体状态 / emotional 具体情绪基调 / objective 即时目标 / inventory 随身物品，均不可写\"未指定\"）。角色名不得与地名、朝代名、年号、官职、典章制度重名——古风/历史/架空题材尤其要避免用都城名（长安、洛阳、汴梁、建康等）作人名，因为读者会先想到城市而非人物。\n\n【群像独立性硬约束】核心角色之间必须至少存在两组非二元对立关系（既有合作又有冲突），避免所有关系都收敛至主角与单一反派的对立。至少 1 位核心角色应能独立推动一条非主线驱动的生态增长曲线（如权力生态、商业生态、江湖格局等），其欲望、资源与行动不服务主角目标。判定标准：若所有核心角色的欲望都服务或阻碍同一主角目标，则群像缺失独立性，应重构。若作品涉及感情线，主恋爱角色的恋爱维度字段要求见 stage prompt 的 ## 感情线 section（属于创作契约，非叙事事实）。", refinable: true },
  { key: "relations", label: "设计人物关系", scope: "relations", role: "architect", skillStage: "foundation", allowedTables: ["relations"], defaultInstruction: "为已生成的核心角色设计至少 5 条会推动选择和冲突的人物关系，每条关系作为独立的 relation 提案项返回（这是首要要求，不得只返回 1-2 条）。每条关系需有 publicLabel（明面关系）和 privateTruth（私下隐情），关系类型(relationType)不得雷同。若作品涉及感情线，主恋爱关系的 bond 字段需标注当前感情阶段与关系状态（中文描述），privateTruth 承载尚未公开的情感真相；具体要求见 stage prompt 的 ## 感情线 section（属于创作契约，非叙事事实）。", refinable: true },
  { key: "timeline", label: "规划时间线", scope: "timeline", role: "architect", skillStage: "planning", allowedTables: ["timelineEvents"], defaultInstruction: "生成有明确先后、持续时间、原因和后果的故事时间线。", refinable: true },
  { key: "worldview", label: "完善世界观", scope: "worldview", role: "architect", skillStage: "foundation", allowedTables: ["entities", "relations"], defaultInstruction: "完善地点、组织、阵营、物品、物种、规则、能力与术语，并保持世界设定之间的关系一致。百万字长篇至少返回 8 个可独立引用的世界观实体，其中至少包含 2 个地点、3 个组织或阵营、2 个规则/能力/术语；不能用一个总称替代所有地域文化圈，也不能只生成名称而缺少生产方式、制度职责、资源依赖或能力边界。", refinable: true },
  { key: "plot-threads", label: "规划剧情线", scope: "threads", role: "architect", skillStage: "planning", allowedTables: ["plotThreads"], defaultInstruction: "为本作规划至少 4 条剧情线，每条剧情线作为独立的 plotThread 提案项返回（百万字长篇必备结构：1 主线(kind=main) + 1 支线(kind=subplot) + 1 对抗线(kind=antagonist) + 1 共谋线(kind=conspiracy)——这是首要要求，不得只返回 1-2 条；若作品含感情线可额外增加 kind=romance）。每条剧情线需明确参与者、当前状态、优先级与下一步推进。\n\n【剧情线硬约束】(1) 支线独立性约束：支线可以独立承担世界观铺陈、群像塑造、生态厚度或主题回声，不必机械反哺主线；但支线必须有自身完整的人物处境、矛盾和因果链，不能只是主线休息站或同时发生的平行事件。支线与主线的关联方式灵活：可通过共享人物、资源、秘密或选择相互改变，也可只通过主题对照或世界厚度独立成立。(2) 对抗线独立生态：对抗线（kind=antagonist 或独立反派支线）必须有自己的独立生态——反派有自己的目标、资源、行动能力、底线与盟友，不能只是\"阻碍主角\"的工具人。nextMove 字段强制约束：对抗线的 nextMove 必须描述反派推进自身目标的行动（如\"整合北境三族兵力，完成南征准备\"\"收编西域商路，截断对手财源\"），不得以主角为行动对象或主语（如\"派人监视主角\"\"判断主角是否危险\"\"阻止主角获取 X\"等均违规——这些只是阻碍主角，不是推进自身目标）。判定标准：若删除 nextMove 中的主角名字后，该行动是否仍有独立的战略意义？若没有，则该行动只是\"给主角制造困难\"，应改为推进反派自身目标的行动。反派至少有一条不碰的行为底线（这是读者共情的关键），反派的核心信念应形成前后不矛盾的闭环。(3) 共谋线独立生态：百万字长篇必须有至少 1 条 kind=conspiracy 的共谋线——一群角色暗中结盟或共谋，有独立于对抗线的目标、参与者(participantIds)、当前状态(status)与下一步推进(nextMove)。共谋线与对抗线的区别：对抗线是明面反派推进自身目标，共谋线是隐藏联盟暗中操纵/布局/合谋，其存在与目的在前期对主角和其他势力不可见。nextMove 字段强制约束：共谋线的 nextMove 必须描述共谋者推进其阴谋的行动（如\"暗中收买三名长老，在下次议事时联合发难\"\"伪造传承凭证，为篡夺正统铺路\"），不得以主角为行动对象或主语。判定标准：若删除 nextMove 中的主角名字后，该行动是否仍有独立的阴谋推进意义？共谋线必须与主线存在延迟揭示关系——其真相在中后期才被主角察觉，前期只以异常迹象呈现。若作品涉及感情线，romance 剧情线的字段级要求（kind=romance、priority、nextMove 标注感情阶段、progress 映射弧光进度）见 stage prompt 的 ## 感情线 section（属于创作契约，非叙事事实）。", refinable: true },
  { key: "foreshadowing", label: "规划伏笔", scope: "foreshadowing", role: "architect", skillStage: "planning", allowedTables: ["foreshadowing"], defaultInstruction: "为本作规划至少 4 条伏笔，每条伏笔作为独立的 foreshadowing 提案项返回（百万字长篇至少 1 条跨百章长线伏笔——这是首要要求，不得只返回 1-2 条）。每条伏笔涵盖线索(clue)、真相(truth)、误导、提醒与回收节点。\n\n【伏笔硬约束】(1) 延迟回收范式：伏笔埋设时必须以日常细节形态存在，不得自我标榜（禁止\"他不知道这个决定将改变一切\"\"这个细节后来证明至关重要\"等作者预告）；提醒应以不经意方式呈现（人物偶然瞥见、他人随口提及），不得让人物主动追查（除非该人物有明确动机）；回收应让读者产生\"原来如此\"的恍然，而非\"终于揭晓\"的被动接受——回收瞬间应触发情感爆发，而非信息确认。判定标准：若读者重读埋设段落时能立刻认出这是伏笔，则埋设过于刻意。(2) 长线伏笔多义真相：长篇（百万字以上）需至少规划 1 条跨百章以上的长线伏笔。truth 字段写最终真相，但 notes 字段必须显式列出至少 1 个中期误导解释（读者在百章以内可能推断出的错误结论）。长线伏笔不得全部服务同一条主线（如全部指向同一案件真相），至少 1 条应独立关联权力格局、人物关系或世界规则，能在回收时改变角色关系或权力平衡。所有长线伏笔的 truth 不得收敛至同一解释。短篇或单元剧不强制此要求。若作品涉及感情线，至少规划 1 条服务感情线弧光的伏笔，notes 标注关联感情阶段与回收方式；具体要求见 stage prompt 的 ## 感情线 section（属于创作契约，非叙事事实）。", refinable: true },
  { key: "story-control", label: "生成剧情控制资料", scope: "review", role: "architect", skillStage: "planning", allowedTables: ["plotThreads", "foreshadowing", "timelineEvents"], defaultInstruction: "根据已生成的剧情线(plot-threads 任务)、伏笔(foreshadowing 任务)和时间线(timeline 任务)，交叉校验三者一致性并补充控制元数据。严禁重复生成已存在的 plotThreads/foreshadowing/timelineEvents 记录——只允许对已有记录执行 update 操作。\n\n【story-control 职责边界】(1) 一致性校验：检查剧情线参与者在时间线事件中是否一致、伏笔回收节点是否与剧情线进度匹配、时间线因果链是否与剧情线 nextMove 对齐。(2) 控制元数据补充：为伏笔补充回收节点映射（哪个剧情段/章节回收）、为剧情线补充进度同步点（哪条时间线事件标志剧情线进度变化）、为时间线补充因果约束标注。(3) 冲突标注：识别并标注三者之间的逻辑冲突（如伏笔回收早于埋设、剧情线 nextMove 与时间线顺序矛盾），以 update 操作修正 status/progress/nextMove 字段。\n\n【保留性更新合同】只提交确有必要的字段补丁。不得用较短的控制说明覆盖已经更完整的 title、summary、description、clue 或 truth；已有 participantIds、locationId、causeIds、consequenceIds 一致时必须省略这些字段。向 notes 增加回收映射时，只提交以“控制映射：”开头的追加段即可，系统会把正式原 notes 确定性地置于前面；也可返回“原 notes + 控制映射”，但不能用 clue、truth、状态或映射文本替换原说明。没有矛盾的记录无需为了显得有改动而更新。\n\n【禁止行为】(a) 禁止创建新的 plotThreads 记录（kind/title/summary 不得与已有记录重复）。(b) 禁止创建新的 foreshadowing 记录（clue/truth 不得与已有记录重复）。(c) 禁止创建新的 timelineEvents 记录。如发现已有记录存在质量问题，应通过 update 操作修正字段值，而非创建新记录。", refinable: true },
  { key: "chapter-plan", label: "规划当前章节", scope: "chapters", role: "architect", skillStage: "planning", allowedTables: ["documents"], defaultInstruction: `结合已批准架构、故事大纲和当前写作进度，确定本章唯一的主导叙事功能与兑现边界；允许本章主要用于背景、人物、关系、情感、蓄势或余波。若本章 povCharacterId 是单一角色（第三人称限知 POV），则 mustHappen 中的所有动作必须是该 POV 角色亲自可观察、可推断或可被告知的事项，或该 POV 角色自身的内心动作——不得包含非 POV 角色的内心动作（\"X 意识到 / X 发现 / X 察觉 / X 心想\"等）。如需呈现多角色内心：方案 A 保持单 POV，把他人内心外化为 POV 角色可观察的行动；方案 B 显式标注本章为\"多视角切片\"，povCharacterId 留空，characterIds 列出全部视角人物，beats 中标注每个节拍的 POV。\n\n【POV 模式互斥硬约束】方案 A 与方案 B 互斥，不得混用：(1) 若 povCharacterId 填入具体角色 ID（非空、非\"multi\"），则必须使用方案 A——所有 mustHappen 项不得包含非 POV 角色的内心动作（\"X 意识到 / X 发现 / X 察觉 / X 心想\"等），只能包含 POV 角色可观察、可推断、可被告知的外部事项，或 POV 角色自身的决定/记忆/误读/回避。(2) 若本章需要呈现 ≥2 个角色的内心活动（如\"三线切片\"\"群像章节\"），则必须使用方案 B——povCharacterId 必须为空或填入\"multi\"占位，不得填具体角色 ID；characterIds 必须列出全部视角人物；beats 中每个节拍必须显式标注其 POV（如\"[POV:A] ...\"\"[POV:B] ...\"）。(3) 违规判定：povCharacterId 填具体角色 ID 但 mustHappen 含非 POV 角色内心动作 = 违规；povCharacterId 为空但 beats 未标注 POV = 违规；声称\"多视角切片\"但 povCharacterId 仍填单一角色 = 违规。若作品涉及感情线，章节 romance beat 的形态与字段级要求见 stage prompt 的 ## 感情线 section（属于创作契约，非叙事事实）。\n\n${NAMING_LITERARY_CONSTRAINT}`, refinable: true },
  { key: "scene-design", label: "设计场景", scope: "scenes", role: "architect", skillStage: "planning", allowedTables: ["scenes"], defaultInstruction: "为当前章节规划场景顺序、功能、冲突、结果、角色和行动节拍。", refinable: true },
  { key: "chapter-draft", label: "生成章节正文", scope: "writing", role: "writer", skillStage: "drafting", allowedTables: ["documents"], defaultInstruction: "依据当前章节蓝图和场景计划生成完整正文。" },
  { key: "review", label: "审校并提出修订", scope: "review", role: "quality-editor", skillStage: "review", allowedTables: ["documents"], defaultInstruction: "检查故事与正文的因果、人物、连续性、节奏和文风，并提供可选择采纳的定向修订。" },
];

export const NOVEL_GENERATION_TASKS = TASKS;

export function getGenerationTask(key: NovelGenerationTaskKey) {
  const task = TASKS.find((item) => item.key === key);
  if (!task) throw new Error(`未知生成任务：${key}`);
  return task;
}

export function tasksForScope(scope: NovelGenerationScope) {
  return TASKS.filter((item) => item.scope === scope);
}

const payloadContract = `字段契约：
- projects: title, subtitle, premise, genre, audience, themes, sellingPoints, pov, tense, tone, languageStyle, targetWords
- architectures: framework, status, centralQuestion, centralConflict, synopsis, powerCenters[{id,name,kind,interest,resources,actionCapacity,bottomLine,relationshipDynamics}], feedbackLoops[{id,name,trigger,transmission,affectedCenters,storyPressure,returnPath}], longHorizonHooks[{id,surfaceDetail,possibleInterpretations,affectedCenters,payoffWindow}], phases[{id,title,purpose,turningPoint,order,locked,primaryCurveId,stages[{title,summary}],romanceProgress[{romanceLineId,relationshipStage,irreversibleEvent,crossOverWith}],techGeneration{generation,name,unlockCondition,narrativeFunction},originTruthLayer{layer,revelation,revealerCenterId,consequence}}], growthCurves[{id,kind,subject,resourceLoop,stageGoals,irreversibleChange}], ideologicalFactions[{id,name,position,affectedCenterIds}]；数量按项目体量决定，百万字长篇至少为 powerCenters 5 个、feedbackLoops 3 条、longHorizonHooks 3 条；powerCenters.kind 标识势力存在层级（human-organization 人类组织 / supernatural 跨位面超自然存在 / ancient-legacy 跨纪元远古组织），百万字长篇至少 1 个 supernatural 类型以形成空间纵深，与人类组织型势力形成质的差异；affectedCenters 只能引用 powerCenters 中已有 id 或准确名称；phases.purpose 用文学化叙事描述该阶段的人物处境与情感走向，不要用"建立X""让Y做Z"等编剧指令腔；phases.turningPoint 必须写成可验证不可逆模板：[谁]失去/获得[具体资源/秘密/关系]，导致[什么组织]永久[裂变/公开/承诺/摧毁]，世界无法回到[什么状态]（至少30字）；禁止"获得...资格""承认...可能""成为...问题"等方向性描述；phases.primaryCurveId 引用 growthCurves[].id，标注此阶段主要由哪条增长曲线推进；phases.stages 为该幕的子阶段拆分，百万字长篇每幕必须提供 2-4 个 stages，每个 stage.summary 必须写出该子段自身矛盾与推进（谁面对什么阻力、付出什么代价、做出什么选择，至少20字），禁止只用一句事件摘要如"陈墨发现灵气规律。"，且全书必须在第三幕末或第四幕初的某个 stage 中设计一个中段崩塌点（all-is-lost，主角处境跌至最低、资源/关系/认知全面失守后再回升），不得只给单一 turningPoint 平铺直叙；feedbackLoops 必须形成闭环而非线性因果链——transmission 写跨中心传导步骤（至少 4 步），returnPath 必须写明闭合回触发源的不可逆状态变化（哪一方被迫永久改变什么行为/规则/结构，至少20字），禁止"新的X改变Y""X反过来影响Y"等无具体主体的套话；longHorizonHooks.possibleInterpretations 必须排除实际真相本身——真相不得作为候选解释之一直接出现，possibleInterpretations 至少 2 项且其中至少 1 项必须是读者中期可能误推的错误解释（误导项），surfaceDetail 以日常细节形态存在不自我标榜，不得用"这个细节后来证明至关重要"式预告；growthCurves 至少 2 条（kind=main 主线 + 至少 1 条 kind=ecological 生态曲线），ecological 曲线的 subject/resourceLoop/stageGoals/irreversibleChange 必须独立于主线主角命运——若删除主线后该曲线能否独立支撑至少一个阶段的推进，且 ecological 曲线必须在至少 2 个 phases 中作为 primaryCurveId 推进（不得只在单一 phase 从属主线）；当 growthCurves 主线涉及"本源真相"或核心谜题揭示时，stageGoals 必须把真相揭示分层绑定到多个技术代际/能力升级节点，不得在单一 phase 一次性揭晓；当项目涉及感情线时，phases.romanceProgress 必须为每个有感情进展的 phase 填写——romanceLineId 引用感情线标识、relationshipStage 标注该阶段关系阶段（如相识/相知/公开同盟/裂变/归宿）、irreversibleEvent 写明该阶段发生的不可逆情感事件（承诺/背叛/公开/牺牲），多线交叉用 crossOverWith 引用同期推进的其他 romanceLineId；当项目涉及技术/能力体系代际演进时，phases.techGeneration 必须绑定该阶段解锁的技术代际——generation 代际编号、name 代际名称、unlockCondition 解锁条件（须有前置代际基础）、narrativeFunction 该代际在叙事中的结构功能（推动哪条线/改变哪个权力中心），使技术升级有阶段纵深而非平铺字符串；当项目涉及多层真相递进揭示时，phases.originTruthLayer 必须绑定该阶段揭示的真相层级——layer 层级编号、revelation 揭示内容、revealerCenterId 揭示方 powerCenter id、consequence 揭示后果（哪一方永久失去/获得什么），使真相揭示分层绑定到各幕而非单点压缩在单一 phase；ideologicalFactions 必须填写（至少 3 个跨权力中心思想流派，无条件要求）——每个派系含 id/name/position/affectedCenterIds，affectedCenterIds 引用 powerCenters 中已有 id 且至少跨 2 个权力中心，position 须写出该派系的具体主张（非标签化如"灵气公有派"应写"灵气逻辑应公开传播，任何组织不得独占编译方法"）
- outlineNodes: phaseId, title, summary, order；每条记录只表示一个剧情段，phaseId 必须引用全书架构中的真实幕 ID
- documents: order, plotSegmentId(可用 ref:剧情段临时ID), title, summary, status, blueprint{objective,povCharacterId,locationIds,characterIds,plotThreadIds,foreshadowingIds,conflict,informationRelease,mustHappen,flexible,forbidden}；正文任务可额外给 plainText；章节目标字数由系统设置，不得返回 targetWords
- scenes: chapterId, title, order, status, povCharacterId, storyTime, locationId, characterIds, plotThreadIds, foreshadowingIds, purpose, conflict, outcome, wordTarget, beats[{id,text,order}]
- entities: kind, name, aliases, summary, description, tags, lockedFacts, attributes；角色需包含 character（role/appearance/personality/desire/motivation/weakness/secret/abilities/voice/arc/state）
- relations: fromEntityId/toEntityId 可用 ref:临时ID，另含 relationType, publicLabel, privateTruth, bond
- plotThreads: kind, title, summary, status, priority, participantIds, progress, nextMove
- foreshadowing: title, clue, truth, status, urgency, notes
- timelineEvents: title, storyDate, duration, narrativeOrder, participantIds, causeIds, consequenceIds, description`;

const stringArraySchema = { type: "array", items: { type: "string" } } as const;
const characterSchema = {
  type: "object", additionalProperties: false,
  required: ["role", "appearance", "personality", "desire", "motivation", "weakness", "secret", "abilities", "voice", "arc", "state"],
  properties: {
    role: { type: "string" }, appearance: { type: "string" }, personality: { type: "string" }, desire: { type: "string" }, motivation: { type: "string" }, weakness: { type: "string" }, secret: { type: "string" }, abilities: stringArraySchema, voice: { type: "string" }, arc: { type: "string" },
    state: { type: "object", additionalProperties: false, required: ["location", "physical", "emotional", "objective", "inventory"], properties: { location: { type: "string" }, physical: { type: "string" }, emotional: { type: "string" }, objective: { type: "string" }, inventory: stringArraySchema, relationshipNotes: stringArraySchema, lastChangedChapterId: { type: "string" } } },
  },
} as const;
// Layer 13 根因修复（Class B 类型多样性缺失）：
// 根因：powerCenters schema 不区分势力存在层级，LLM 只产出同质化人类组织型 center（朝堂/门派/商会/江湖盟），
// 缺少跨位面/超自然存在级别势力（如灵气本源意识、上古研究者集体意识），导致世界观空间纵深不足。
// 修复层：新增 kind enum 字段（human-organization | supernatural | ancient-legacy）并加入 required，
// 让 LLM "能"产出 supernatural 类型（解除 additionalProperties:false 的 HARD constraint）；
// 配合 validateArchitectureHardConstraints 新增 supernatural 检查让 LLM "必须"产出（强制生成而非可选）。
// 通用机制：不针对 origin_will 具体名称，LLM 可自由命名，只要 kind=supernatural。
// 回归风险：旧候选 powerCenters 无 kind 字段，refine/update 时 Ajv 校验失败 → DB migration 补默认值 human-organization
// 或 ArchitecturePayload 类型加 optional kind；新 operation "全新重生成" 不受影响。
const architecturePowerCenterSchema = { type: "object", additionalProperties: false, required: ["id", "name", "kind", "interest", "resources", "actionCapacity", "bottomLine", "relationshipDynamics"], properties: { id: { type: "string", minLength: 1 }, name: { type: "string", minLength: 1 }, kind: { enum: ["human-organization", "supernatural", "ancient-legacy"] }, interest: { type: "string", minLength: 1 }, resources: { ...stringArraySchema, minItems: 1 }, actionCapacity: { type: "string", minLength: 1 }, bottomLine: { type: "string", minLength: 1 }, relationshipDynamics: { type: "string", minLength: 1 } } } as const;
// Loop 2 根因修复：returnPath 移入 required + transmission minItems 2→4。
// 根因（required）：payloadContract 文本承诺 returnPath 闭环但 schema 未要求 → strict-mode LLM 系统性缺失。
// 根因（minItems）：payloadContract 承诺 transmission 至少 4 步，但 schema minItems=2 → LLM 恰好产出 2 步（schema 最小值）
// → validateArchitectureHardConstraints 反复拦截。修复层：让 schema minItems 与契约下限一致（名实相符）。
// 回归风险：旧 feedbackLoop 记录 transmission < 4 步时，refine/update 路径 Ajv 校验会要求补步数；架构任务默认"全新重生成"不受影响。
const architectureFeedbackLoopSchema = { type: "object", additionalProperties: false, required: ["id", "name", "trigger", "transmission", "affectedCenters", "storyPressure", "returnPath"], properties: { id: { type: "string", minLength: 1 }, name: { type: "string", minLength: 1 }, trigger: { type: "string", minLength: 1 }, transmission: { ...stringArraySchema, minItems: 4 }, affectedCenters: { ...stringArraySchema, minItems: 3 }, storyPressure: { type: "string", minLength: 1 }, returnPath: { type: "string", minLength: 1 } } } as const;
// Loop 5 根因修复（回退 Loop 4 的 minLength 内容深度层）：
// Loop 4 在 returnPath/turningPoint/stages.summary/resourceLoop/stageGoals 上添加 minLength:20/30，
// 意图强制 LLM 产出深度内容。iter6 确实改善（11→6 issues），但 iter7 因 LLM 偶尔产出短 stageGoals
// 触发 minLength 硬验证失败，整个生成被阻断——无候选可供 review，operation 卡住。
// 根因：strict-mode JSON schema 的 minLength 是 HARD constraint，将概率性的 LLM 输出长度转化为
// 硬性生成失败。失败的生成比短字段候选更糟（无 review 反馈循环）。
// 修复策略：移除 minLength>1 的字符串约束，保留 required（字段存在）+ minItems（数组下限），
// 因 LLM 可靠满足这两类结构性约束。内容深度交给 payloadContract 模板（引导）+ review 层（软强制+反馈循环）。
// review 反馈循环才是改善主驱动（iter4:11→iter5:11→iter6:6 的改善来自 review issues 被携带进 instruction）。
const architectureLongHorizonHookSchema = { type: "object", additionalProperties: false, required: ["id", "surfaceDetail", "possibleInterpretations", "affectedCenters", "payoffWindow"], properties: { id: { type: "string", minLength: 1 }, surfaceDetail: { type: "string", minLength: 1 }, possibleInterpretations: { ...stringArraySchema, minItems: 2 }, affectedCenters: { ...stringArraySchema, minItems: 1 }, payoffWindow: { type: "string", minLength: 1 } } } as const;
const TABLE_PAYLOAD_SCHEMAS: Record<ProposalTargetTable, Record<string, unknown>> = {
  projects: { type: "object", additionalProperties: false, properties: { title: { type: "string" }, subtitle: { type: "string" }, premise: { type: "string" }, genre: stringArraySchema, audience: { type: "string" }, themes: stringArraySchema, sellingPoints: stringArraySchema, pov: { type: "string" }, tense: { type: "string" }, tone: { type: "string" }, languageStyle: { type: "string" }, targetWords: { type: "number", minimum: 1 } } },
  // Loop 2 根因修复：phases.stages 移入 required + stages minItems: 2。
  // 根因（required）：payloadContract 承诺每幕须 2-4 个子阶段，但 schema 仅把 stages 声明为可选 property →
  // strict-mode LLM 系统性缺失 → 中段崩塌点无法落地 → 内部质量门反复拦截。
  // 根因（minItems）：stages 入 required 后 LLM 恰好产出 1 个 stage（schema 无 minItems 时的最小值）→
  // validateArchitectureHardConstraints 仍拦截（< 2）。修复层：schema minItems 与契约下限一致。
  // 回归风险：短篇架构也须 ≥2 stages/phase（slightly over-structured 但提升结构思维）；旧记录 refine 时需补 stages。
  // Layer 12 根因修复（Class A 结构缺失收尾）：
  // 根因：ideologicalFactions 在 schema 中是 optional property（无 required + 无 minItems），
  // strict-mode LLM 系统性不产出（Layer 10 已证 optional 字段 LLM 不填）。
  // 修复层：(1) 把 ideologicalFactions 加入 architectures 顶层 required 数组（驱动 LLM 必须产出）；
  // (2) 给 ideologicalFactions 数组加 minItems:3（与 payloadContract "至少 3 个跨权力中心思想流派" 一致）。
  // 依据：Layer 10 已证明 schema required 是驱动 LLM 填充 optional 字段的唯一可靠机制
  // （romanceProgress/techGeneration/originTruthLayer 从 0/N 提升到 required 后 LLM 首次产出）。
  // 回归风险：旧候选无 ideologicalFactions 时 refine/update 路径 Ajv 校验失败；新 operation "全新重生成" 不受影响。
  architectures: { type: "object", additionalProperties: false, required: ["ideologicalFactions"], properties: { framework: { enum: ["free", "three-act", "four-part", "save-the-cat", "snowflake"] }, status: { enum: ["draft", "approved"] }, centralQuestion: { type: "string" }, centralConflict: { type: "string" }, synopsis: { type: "string" }, powerCenters: { type: "array", minItems: 7, items: architecturePowerCenterSchema }, feedbackLoops: { type: "array", minItems: 1, items: architectureFeedbackLoopSchema }, longHorizonHooks: { type: "array", minItems: 1, items: architectureLongHorizonHookSchema }, phases: { type: "array", minItems: 5, items: { type: "object", additionalProperties: false, required: ["id", "title", "purpose", "turningPoint", "order", "locked", "primaryCurveId", "stages", "romanceProgress", "techGeneration", "originTruthLayer"], properties: { id: { type: "string" }, title: { type: "string" }, purpose: { type: "string" }, turningPoint: { type: "string", minLength: 1 }, order: { type: "integer", minimum: 0 }, locked: { type: "boolean" }, primaryCurveId: { type: "string", minLength: 1 }, stages: { type: "array", minItems: 3, items: { type: "object", additionalProperties: false, required: ["title", "summary"], properties: { title: { type: "string", minLength: 1 }, summary: { type: "string", minLength: 1 } } } }, romanceProgress: { type: "array", minItems: 2, items: { type: "object", additionalProperties: false, required: ["romanceLineId", "relationshipStage", "irreversibleEvent"], properties: { romanceLineId: { type: "string", minLength: 1 }, relationshipStage: { type: "string", minLength: 1 }, irreversibleEvent: { type: "string", minLength: 1 }, crossOverWith: stringArraySchema } } }, techGeneration: { type: "object", additionalProperties: false, required: ["generation", "name"], properties: { generation: { type: "string", minLength: 1 }, name: { type: "string", minLength: 1 }, unlockCondition: { type: "string", minLength: 1 }, narrativeFunction: { type: "string", minLength: 1 } } }, originTruthLayer: { type: "object", additionalProperties: false, required: ["layer", "revelation"], properties: { layer: { type: "string", minLength: 1 }, revelation: { type: "string", minLength: 1 }, revealerCenterId: { type: "string", minLength: 1 }, consequence: { type: "string", minLength: 1 } } } } } }, growthCurves: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false, required: ["id", "kind", "subject", "resourceLoop", "stageGoals", "irreversibleChange"], properties: { id: { type: "string", minLength: 1 }, kind: { enum: ["main", "ecological"] }, subject: { type: "string", minLength: 1 }, resourceLoop: { type: "string", minLength: 1 }, stageGoals: { type: "string", minLength: 1 }, irreversibleChange: { type: "string", minLength: 1 } } } }, ideologicalFactions: { type: "array", minItems: 3, items: { type: "object", additionalProperties: false, required: ["id", "name", "position", "affectedCenterIds"], properties: { id: { type: "string", minLength: 1 }, name: { type: "string", minLength: 1 }, position: { type: "string", minLength: 1 }, affectedCenterIds: { ...stringArraySchema, minItems: 2 } } } } } },
  // Loop 5 回退 Loop 4 minLength：移除 turningPoint/summary/resourceLoop/stageGoals 的 minLength:20/30。
  // 根因：strict-mode JSON schema minLength 是 HARD constraint，LLM 偶尔产出短字符串时整个生成失败（iter7 stageGoals<20 字触发），
  // 无候选可供 review。required（字段存在）+ minItems（数组下限）是 LLM 可靠满足的结构性约束，保留。
  // 内容深度交给 payloadContract 模板（L81 区域的操作化判据）+ review 层反馈循环（iter4:11→iter5:11→iter6:6 的改善主驱动）。
  // 回归风险：LLM 可能再次产出短字符串，但 review 层会标记为 issue 并在 regenerate 时反馈，不会阻断生成。
  outlineNodes: { type: "object", additionalProperties: false, properties: { phaseId: { type: "string", minLength: 1 }, title: { type: "string" }, summary: { type: "string" }, order: { type: "integer", minimum: 0 } } },
  documents: { type: "object", additionalProperties: false, properties: { order: { type: "integer", minimum: 0 }, plotSegmentId: { type: "string" }, title: { type: "string" }, summary: { type: "string" }, status: { enum: ["outline", "draft", "review", "final"] }, plainText: { type: "string" }, blueprint: { type: "object", additionalProperties: false, properties: { objective: { type: "string" }, povCharacterId: { type: "string" }, locationIds: stringArraySchema, characterIds: stringArraySchema, plotThreadIds: stringArraySchema, foreshadowingIds: stringArraySchema, conflict: { type: "string" }, informationRelease: stringArraySchema, mustHappen: stringArraySchema, flexible: stringArraySchema, forbidden: stringArraySchema, targetWords: { type: "number", minimum: 1 } } } } },
  scenes: { type: "object", additionalProperties: false, properties: { chapterId: { type: "string" }, title: { type: "string" }, order: { type: "integer", minimum: 0 }, status: { enum: ["idea", "planned", "drafting", "done"] }, povCharacterId: { type: "string" }, storyTime: { type: "string" }, locationId: { type: "string" }, characterIds: stringArraySchema, plotThreadIds: stringArraySchema, foreshadowingIds: stringArraySchema, purpose: { type: "string" }, conflict: { type: "string" }, outcome: { type: "string" }, wordTarget: { type: "number", minimum: 0 }, beats: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "text", "order"], properties: { id: { type: "string" }, text: { type: "string" }, order: { type: "integer", minimum: 0 } } } } } },
  entities: { type: "object", additionalProperties: false, properties: { kind: { enum: ["character", "location", "organization", "faction", "item", "species", "rule", "ability", "term"] }, name: { type: "string" }, aliases: stringArraySchema, summary: { type: "string" }, description: { type: "string" }, tags: stringArraySchema, lockedFacts: stringArraySchema, attributes: { type: "object" }, character: characterSchema }, allOf: [{ if: { properties: { kind: { const: "character" } }, required: ["kind"] }, then: { required: ["character"] } }] },
  relations: { type: "object", additionalProperties: false, properties: { fromEntityId: { type: "string" }, toEntityId: { type: "string" }, relationType: { type: "string" }, publicLabel: { type: "string" }, privateTruth: { type: "string" }, bond: { type: "string" } } },
  plotThreads: { type: "object", additionalProperties: false, properties: { kind: { enum: ["main", "subplot", "romance", "growth", "mystery", "antagonist", "conspiracy"] }, title: { type: "string" }, summary: { type: "string" }, status: { enum: ["planned", "active", "paused", "resolved", "abandoned"] }, priority: { type: "number", minimum: 0, maximum: 100 }, participantIds: stringArraySchema, startNodeId: { type: "string" }, targetNodeId: { type: "string" }, progress: { type: "number", minimum: 0, maximum: 100 }, nextMove: { type: "string" } } },
  foreshadowing: { type: "object", additionalProperties: false, properties: { title: { type: "string" }, clue: { type: "string" }, truth: { type: "string" }, status: { enum: ["seeded", "reminded", "misdirected", "advanced", "revealed", "resolved", "abandoned"] }, seededNodeId: { type: "string" }, targetNodeId: { type: "string" }, urgency: { type: "number", minimum: 0, maximum: 100 }, notes: { type: "string" } } },
  timelineEvents: { type: "object", additionalProperties: false, properties: { title: { type: "string" }, storyDate: { type: "string" }, duration: { type: "string" }, narrativeOrder: { type: "number" }, locationId: { type: "string" }, participantIds: stringArraySchema, causeIds: stringArraySchema, consequenceIds: stringArraySchema, description: { type: "string" }, parallelGroup: { type: "string" } } },
};

function modelPayloadSchema(table: ProposalTargetTable) {
  const schema = TABLE_PAYLOAD_SCHEMAS[table];
  if (table !== "documents") return schema;
  const properties = schema.properties as Record<string, Record<string, unknown>>;
  const blueprint = properties.blueprint;
  const blueprintProperties = blueprint.properties as Record<string, unknown>;
  return {
    ...schema,
    properties: {
      ...properties,
      blueprint: {
        ...blueprint,
        properties: Object.fromEntries(Object.entries(blueprintProperties).filter(([key]) => key !== "targetWords")),
      },
    },
  };
}

const MODEL_PAYLOAD_SCHEMAS = Object.fromEntries(
  (Object.keys(TABLE_PAYLOAD_SCHEMAS) as ProposalTargetTable[]).map((table) => [table, modelPayloadSchema(table)]),
) as Record<ProposalTargetTable, Record<string, unknown>>;

function partialObjectSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const partial = { ...schema };
  delete partial.required;
  if (partial.properties && typeof partial.properties === "object" && !Array.isArray(partial.properties)) {
    partial.properties = Object.fromEntries(Object.entries(partial.properties as Record<string, unknown>).map(([key, value]) => {
      if (!value || typeof value !== "object" || Array.isArray(value) || (value as Record<string, unknown>).type !== "object") return [key, value];
      return [key, partialObjectSchema(value as Record<string, unknown>)];
    }));
  }
  return partial;
}

const UPDATE_MODEL_PAYLOAD_SCHEMAS = Object.fromEntries(
  (Object.keys(MODEL_PAYLOAD_SCHEMAS) as ProposalTargetTable[]).map((table) => [table, partialObjectSchema(MODEL_PAYLOAD_SCHEMAS[table])]),
) as Record<ProposalTargetTable, Record<string, unknown>>;

const payloadAjv = new Ajv({ allErrors: true, strict: false });
const PAYLOAD_VALIDATORS = Object.fromEntries(Object.entries(TABLE_PAYLOAD_SCHEMAS).map(([table, schema]) => [table, payloadAjv.compile(schema)])) as Record<ProposalTargetTable, ValidateFunction>;
const CREATE_REQUIRED_FIELDS: Record<ProposalTargetTable, string[]> = {
  projects: ["title", "premise"],
  architectures: ["centralQuestion", "centralConflict", "synopsis", "powerCenters", "feedbackLoops", "longHorizonHooks", "phases", "growthCurves"],
  outlineNodes: ["phaseId", "title", "summary", "order"],
  documents: ["order", "plotSegmentId", "title", "summary", "blueprint"],
  scenes: ["chapterId", "title", "order", "purpose", "conflict", "outcome"],
  entities: ["kind", "name", "summary", "description"],
  relations: ["fromEntityId", "toEntityId", "relationType", "publicLabel", "privateTruth"],
  plotThreads: ["kind", "title", "summary", "status", "nextMove"],
  foreshadowing: ["title", "clue", "truth", "status", "notes"],
  timelineEvents: ["title", "storyDate", "narrativeOrder", "description"],
};
const CREATE_PAYLOAD_VALIDATORS = Object.fromEntries(Object.entries(TABLE_PAYLOAD_SCHEMAS).map(([table, schema]) => [table, payloadAjv.compile({ ...schema, required: CREATE_REQUIRED_FIELDS[table as ProposalTargetTable] })])) as Record<ProposalTargetTable, ValidateFunction>;

interface ArchitectureSystemCapacity {
  powerCenters: number;
  feedbackLoops: number;
  longHorizonHooks: number;
  feedbackAffectedCenters: number;
}

function architectureSystemCapacity(targetWords: number): ArchitectureSystemCapacity {
  if (targetWords >= 1_500_000) return { powerCenters: 7, feedbackLoops: 4, longHorizonHooks: 4, feedbackAffectedCenters: 3 };
  if (targetWords >= 1_000_000) return { powerCenters: 5, feedbackLoops: 3, longHorizonHooks: 3, feedbackAffectedCenters: 2 };
  return { powerCenters: 1, feedbackLoops: 1, longHorizonHooks: 1, feedbackAffectedCenters: 2 };
}

function timelineSystemCapacity(targetWords: number) {
  if (targetWords >= 1_500_000) return 7;
  if (targetWords >= 1_000_000) return 6;
  return 1;
}

function architecturePayloadSchema(capacity: ArchitectureSystemCapacity) {
  const base = MODEL_PAYLOAD_SCHEMAS.architectures;
  const properties = base.properties as Record<string, Record<string, unknown>>;
  const feedbackLoop = properties.feedbackLoops.items as Record<string, unknown>;
  const feedbackLoopProperties = feedbackLoop.properties as Record<string, Record<string, unknown>>;
  return {
    ...base,
    properties: {
      ...properties,
      powerCenters: { ...properties.powerCenters, minItems: capacity.powerCenters },
      feedbackLoops: {
        ...properties.feedbackLoops,
        minItems: capacity.feedbackLoops,
        items: {
          ...feedbackLoop,
          properties: {
            ...feedbackLoopProperties,
            affectedCenters: { ...feedbackLoopProperties.affectedCenters, minItems: capacity.feedbackAffectedCenters },
          },
        },
      },
      longHorizonHooks: { ...properties.longHorizonHooks, minItems: capacity.longHorizonHooks },
    },
  };
}

function proposalSchema(
  allowedTables: ProposalTargetTable[],
  requiredPayloadFields?: Partial<Record<ProposalTargetTable, string[]>>,
  architectureCapacity?: ArchitectureSystemCapacity,
) {
  const payloadSchemas = Object.fromEntries(allowedTables.map((table) => [
    table,
    table === "architectures" && architectureCapacity ? architecturePayloadSchema(architectureCapacity) : MODEL_PAYLOAD_SCHEMAS[table],
  ])) as Record<ProposalTargetTable, Record<string, unknown>>;
  return {
    type: "object",
    additionalProperties: false,
    required: ["summary", "items"],
    properties: {
      summary: { type: "string" },
      items: {
        type: "array",
        minItems: 1,
        maxItems: 120,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["label", "operation", "targetTable", "payload", "rationale"],
          properties: {
            label: { type: "string", minLength: 1 },
            operation: { enum: ["create", "update"] },
            targetTable: { enum: allowedTables },
            targetId: { type: "string" },
            tempId: { type: "string" },
            payload: { type: "object" },
            rationale: { type: "string" },
            dependencies: { type: "array", items: { type: "string" } },
          },
          allOf: [
            ...allowedTables.map((table) => ({ if: { properties: { targetTable: { const: table } } }, then: { properties: { payload: payloadSchemas[table] } } })),
            ...allowedTables.map((table) => ({ if: { properties: { targetTable: { const: table }, operation: { const: "create" } }, required: ["targetTable", "operation"] }, then: { properties: { payload: { ...payloadSchemas[table], required: CREATE_REQUIRED_FIELDS[table] } } } })),
            ...allowedTables.flatMap((table) => requiredPayloadFields?.[table]?.length
              ? [{ if: { properties: { targetTable: { const: table } }, required: ["targetTable"] }, then: { properties: { payload: { ...payloadSchemas[table], required: requiredPayloadFields[table] } } } }]
              : []),
            { if: { properties: { operation: { const: "update" } }, required: ["operation"] }, then: { required: ["targetId"], properties: { payload: { type: "object", minProperties: 1 } } } },
          ],
        },
      },
    },
  };
}

function refinementProposalSchema(allowedTables: ProposalTargetTable[]) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["summary", "items"],
    properties: {
      summary: { type: "string" },
      items: {
        type: "array",
        minItems: 1,
        maxItems: 120,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["label", "operation", "targetTable", "rationale"],
          properties: {
            label: { type: "string", minLength: 1 },
            operation: { enum: ["create", "update", "delete"] },
            targetTable: { enum: allowedTables },
            targetId: { type: "string" },
            tempId: { type: "string" },
            payload: { type: "object" },
            rationale: { type: "string" },
            dependencies: { type: "array", items: { type: "string" } },
          },
          allOf: [
            ...allowedTables.map((table) => ({ if: { properties: { targetTable: { const: table }, operation: { const: "create" } }, required: ["targetTable", "operation"] }, then: { required: ["payload"], properties: { payload: { ...MODEL_PAYLOAD_SCHEMAS[table], required: CREATE_REQUIRED_FIELDS[table] } } } })),
            ...allowedTables.map((table) => ({ if: { properties: { targetTable: { const: table }, operation: { const: "update" } }, required: ["targetTable", "operation"] }, then: { required: ["targetId", "payload"], properties: { payload: { ...UPDATE_MODEL_PAYLOAD_SCHEMAS[table], minProperties: 1 } } } })),
            { if: { properties: { operation: { const: "delete" } }, required: ["operation"] }, then: { required: ["targetId"] } },
          ],
        },
      },
    },
  };
}

function proposalMarkdown(title: string, summary: string, items: ProposalItem[]) {
  const operationLabel = { create: "新增", update: "更新", delete: "删除" } as const;
  return [`# ${title}`, summary, ...items.map((item, index) => `## ${index + 1}. ${item.label}\n\n${item.rationale}\n\n- 操作：${operationLabel[item.operation]}\n- 类型：${item.targetTable}${item.impact?.length ? `\n- 影响：${item.impact.join("；")}` : ""}\n\n### 内容\n${formatProposalPayload(item.targetTable, item.payload)}`)].join("\n\n");
}

function formatProposalPayload(table: ProposalTargetTable, payload: Record<string, unknown>): string {
  const fields = PROPOSAL_PREVIEW_FIELDS[table];
  if (!fields?.length) return Object.entries(payload).map(([k, v]) => `- ${k}：${formatValue(v)}`).join("\n") || "（空）";
  return fields.map(([field, label]) => {
    const value = payload[field];
    if (value === undefined || value === null || value === "") return "";
    return `**${label}**：${formatValue(value)}`;
  }).filter(Boolean).join("\n") || "（无关键字段）";
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.length ? value.map((item) => `- ${formatValue(item)}`).join("\n") : "（空）";
  if (typeof value === "object" && value !== null) return JSON.stringify(value, null, 2);
  return String(value ?? "");
}

// 每类实体在预览中重点展示的字段（payload 键 → 中文标签）
const PROPOSAL_PREVIEW_FIELDS: Partial<Record<ProposalTargetTable, Array<[string, string]>>> = {
  projects: [["premise", "前提"], ["genre", "题材"], ["themes", "主题"], ["audience", "受众"], ["pov", "视角"], ["tone", "基调"], ["languageStyle", "语言风格"]],
  architectures: [["framework", "结构方法"], ["centralQuestion", "核心问题"], ["centralConflict", "核心冲突"], ["synopsis", "梗概"], ["powerCenters", "权力中心"], ["feedbackLoops", "反馈链"], ["longHorizonHooks", "长期钩子"], ["phases", "阶段"], ["growthCurves", "增长曲线"]],
  entities: [["kind", "类型"], ["name", "名称"], ["summary", "摘要"], ["description", "描述"], ["aliases", "别名"], ["tags", "标签"], ["character", "角色设定"]],
  relations: [["fromEntityId", "主体"], ["toEntityId", "客体"], ["relationType", "关系类型"], ["publicLabel", "公开标签"], ["privateTruth", "隐情"], ["bond", "羁绊"]],
  outlineNodes: [["phaseId", "所属幕"], ["title", "剧情段标题"], ["summary", "剧情段摘要"]],
  documents: [["plotSegmentId", "所属剧情段"], ["title", "章节标题"], ["summary", "章节摘要"], ["blueprint", "章节蓝图"]],
  plotThreads: [["kind", "类型"], ["title", "标题"], ["summary", "摘要"], ["status", "状态"], ["priority", "优先级"], ["nextMove", "下一步"]],
  foreshadowing: [["title", "标题"], ["clue", "线索"], ["truth", "真相"], ["status", "状态"], ["urgency", "紧迫度"], ["notes", "备注"]],
  timelineEvents: [["title", "标题"], ["storyDate", "故事日期"], ["duration", "持续时间"], ["narrativeOrder", "叙事顺序"], ["description", "描述"]],
  scenes: [["title", "标题"], ["purpose", "目的"], ["conflict", "冲突"], ["outcome", "结果"], ["wordTarget", "目标字数"]],
};

async function existingInventory(projectId: string, tables: ProposalTargetTable[]) {
  const lines: string[] = [];
  for (const tableName of tables) {
    const project = tableName === "projects" ? await novelDb.projects.get(projectId) : undefined;
    const records = tableName === "projects"
      ? project ? [project as unknown as Record<string, unknown>] : []
      : await novelDb.table(tableName).where("projectId").equals(projectId).limit(120).toArray() as Array<Record<string, unknown>>;
    for (const record of records) lines.push(`${tableName} | id=${record.id} | revision=${record.revision} | ${String(record.title || record.name || record.id)}`);
  }
  return lines.join("\n") || "当前没有同类正式资料。";
}

async function projectReferenceCatalog(projectId: string) {
  const [entities, threads, clues, timelineEvents, outlineNodes] = await Promise.all([
    novelDb.entities.where("projectId").equals(projectId).toArray(),
    novelDb.plotThreads.where("projectId").equals(projectId).toArray(),
    novelDb.foreshadowing.where("projectId").equals(projectId).toArray(),
    novelDb.timelineEvents.where("projectId").equals(projectId).toArray(),
    novelDb.outlineNodes.where("projectId").equals(projectId).toArray(),
  ]);
  return buildProjectReferenceCatalogs(entities, threads, clues, timelineEvents, outlineNodes).get(projectId) ?? emptyReferenceCatalog();
}

async function projectCharacterNameToIdMap(projectId: string): Promise<Map<string, string>> {
  const entities = await novelDb.entities.where("projectId").equals(projectId).toArray();
  const map = new Map<string, string>();
  for (const entity of entities) {
    if (entity.kind !== "character" || !entity.name) continue;
    map.set(entity.name, entity.id);
    // 同时注册别名（aliases）以提高匹配率
    if (entity.aliases?.length) {
      for (const alias of entity.aliases) {
        if (alias && !map.has(alias)) map.set(alias, entity.id);
      }
    }
  }
  return map;
}

// 所有实体（含角色/地点/组织/物品等）的名→ID 映射，用于修复 LLM 凭空发明的 ref:tempId_* 引用
async function projectEntityNameToIdMap(projectId: string): Promise<Map<string, string>> {
  const entities = await novelDb.entities.where("projectId").equals(projectId).toArray();
  const map = new Map<string, string>();
  for (const entity of entities) {
    if (!entity.name) continue;
    map.set(entity.name, entity.id);
    if (entity.aliases?.length) {
      for (const alias of entity.aliases) {
        if (alias && !map.has(alias)) map.set(alias, entity.id);
      }
    }
  }
  return map;
}

async function referenceInventory(projectId: string) {
  const [entities, threads, clues, outlineNodes] = await Promise.all([
    novelDb.entities.where("projectId").equals(projectId).toArray(),
    novelDb.plotThreads.where("projectId").equals(projectId).toArray(),
    novelDb.foreshadowing.where("projectId").equals(projectId).toArray(),
    novelDb.outlineNodes.where("projectId").equals(projectId).sortBy("order"),
  ]);
  const characters = entities.filter((item) => item.kind === "character");
  const locations = entities.filter((item) => item.kind === "location");
  return [
    "角色（characterIds / povCharacterId / participantIds）：",
    ...(characters.length ? characters.map((item) => `- id=${item.id} | ${item.name}`) : ["- 暂无，不得填写角色 ID"]),
    "关系实体（fromEntityId / toEntityId）：",
    ...(entities.length ? entities.map((item) => `- id=${item.id} | ${item.kind} | ${item.name}`) : ["- 暂无，不得填写关系实体 ID"]),
    "地点（locationId）：",
    ...(locations.length ? locations.map((item) => `- id=${item.id} | ${item.name}`) : ["- 暂无，不得填写地点 ID"]),
    "剧情线（plotThreadIds）：",
    ...(threads.length ? threads.map((item) => `- id=${item.id} | ${item.title}`) : ["- 暂无，不得填写剧情线 ID"]),
    "伏笔（foreshadowingIds）：",
    ...(clues.length ? clues.map((item) => `- id=${item.id} | ${item.title}`) : ["- 暂无，不得填写伏笔 ID"]),
    "剧情段（startNodeId / targetNodeId / seededNodeId）：",
    ...(outlineNodes.length ? outlineNodes.map((item) => `- id=${item.id} | phaseId=${item.phaseId} | ${item.title}`) : ["- 暂无剧情段"]),
  ].join("\n");
}

function editablePayload(table: ProposalTargetTable, record: Record<string, unknown>) {
  const properties = TABLE_PAYLOAD_SCHEMAS[table].properties as Record<string, unknown>;
  return Object.fromEntries(Object.keys(properties).filter((key) => record[key] !== undefined).map((key) => [key, structuredClone(record[key])]));
}

function deepMergeRecord(base: Record<string, unknown>, changes: Record<string, unknown>): Record<string, unknown> {
  const next = { ...base };
  for (const [key, value] of Object.entries(changes)) {
    const current = next[key];
    next[key] = current && value && typeof current === "object" && typeof value === "object" && !Array.isArray(current) && !Array.isArray(value)
      ? deepMergeRecord(current as Record<string, unknown>, value as Record<string, unknown>)
      : structuredClone(value);
  }
  return next;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stableValue(item)]));
}

export async function fingerprintRefinementSnapshot(snapshot: RefinementSnapshot) {
  const content = JSON.stringify(stableValue(snapshot));
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return [...new Uint8Array(bytes)].map((item) => item.toString(16).padStart(2, "0")).join("");
}

async function refinementRecords(projectId: string, taskKey: NovelGenerationTaskKey, table: ProposalTargetTable, targetId?: string) {
  const project = table === "projects" ? await novelDb.projects.get(projectId) : undefined;
  let records = table === "projects"
    ? project ? [project as unknown as Record<string, unknown>] : []
    : await novelDb.table(table).where("projectId").equals(projectId).toArray() as Array<Record<string, unknown>>;
  if (taskKey === "characters" && table === "entities") records = records.filter((record) => record.kind === "character");
  if (taskKey === "worldview" && table === "entities") records = records.filter((record) => record.kind !== "character");
  if (taskKey === "worldview" && table === "relations") {
    const entityIds = new Set((await refinementRecords(projectId, taskKey, "entities")).map((record) => String(record.id)));
    records = records.filter((record) => entityIds.has(String(record.fromEntityId)) && entityIds.has(String(record.toEntityId)));
  }
  if (taskKey === "chapter-plan" && table === "documents") records = records.filter((record) => record.id === targetId);
  if (taskKey === "scene-design" && table === "scenes") records = records.filter((record) => record.chapterId === targetId);
  return records.sort((left, right) => Number(left.order ?? left.narrativeOrder ?? 0) - Number(right.order ?? right.narrativeOrder ?? 0));
}

export async function buildRefinementSnapshot(params: {
  projectId: string;
  taskKey: NovelGenerationTaskKey;
  targetId?: string;
  sourceOverrides?: RefinementSnapshotInput;
}): Promise<RefinementSnapshot> {
  const task = getGenerationTask(params.taskKey);
  if (!task.refinable) throw new Error("当前任务不支持结构化微调");
  const snapshot: RefinementSnapshot = {};
  for (const table of task.allowedTables) {
    const persisted = await refinementRecords(params.projectId, params.taskKey, table, params.targetId);
    const byId = new Map(persisted.map((record) => [String(record.id), record]));
    for (const override of params.sourceOverrides?.[table] ?? []) {
      if (override.id) byId.set(String(override.id), { ...byId.get(String(override.id)), ...structuredClone(override) });
    }
    const records = [...byId.values()].map((record) => {
      const data = editablePayload(table, record);
      if (table === "documents") delete data.plainText;
      return { id: String(record.id), revision: Number(record.revision ?? 0), data };
    });
    if (records.length) snapshot[table] = records;
  }
  return snapshot;
}

async function attachExpectedRevisions(items: ProposalItem[]) {
  for (const item of items) {
    if (item.operation !== "update" || !item.targetId) continue;
    const current = await novelDb.table(item.targetTable).get(item.targetId) as (Record<string, unknown> & { revision?: number }) | undefined;
    item.expectedRevision = current?.revision;
    if (current) item.before = sanitizePayload(current);
  }
}

async function assertStoryControlPreservesSources(items: ProposalItem[]) {
  const protectedFields: Partial<Record<ProposalTargetTable, string[]>> = {
    plotThreads: ["kind", "title", "summary", "participantIds"],
    foreshadowing: ["title", "clue", "truth"],
    timelineEvents: ["title", "storyDate", "duration", "narrativeOrder", "locationId", "participantIds", "description"],
  };
  for (const item of items) {
    if (item.operation !== "update" || !item.targetId) throw new Error("story-control 只能对已有记录提交 update 补丁");
    const source = await novelDb.table(item.targetTable).get(item.targetId) as Record<string, unknown> | undefined;
    if (!source) throw new Error(`story-control 尝试更新不存在的记录：${item.targetTable}/${item.targetId}`);
    for (const field of protectedFields[item.targetTable] ?? []) {
      if (Object.prototype.hasOwnProperty.call(item.payload, field) && JSON.stringify(item.payload[field]) !== JSON.stringify(source[field])) {
        throw new Error(`story-control 不得改写 ${item.targetTable}.${field}；只提交控制字段补丁`);
      }
    }
    if (item.targetTable === "foreshadowing" && typeof item.payload.notes === "string") {
      const existingNotes = String(source.notes ?? "");
      if (existingNotes && !item.payload.notes.startsWith(existingNotes)) {
        const mappingIndex = item.payload.notes.indexOf("控制映射：");
        if (mappingIndex < 0) throw new Error("story-control 更新 foreshadowing.notes 时必须提供明确的“控制映射：”追加段");
        const mergedNotes = `${existingNotes}\n${item.payload.notes.slice(mappingIndex).trim()}`;
        item.payload = { ...item.payload, notes: mergedNotes };
        item.after = { ...(item.after ?? item.payload), notes: mergedNotes };
      }
    }
  }
}

function parseProposalItems(data: Record<string, unknown>): ProposalItem[] {
  const rawItems = Array.isArray(data.items) ? (data.items as Array<Record<string, unknown>>) : [];
  return rawItems.map((raw) => ({
    id: crypto.randomUUID(),
    label: String(raw.label || "未命名候选"),
    operation: raw.operation === "update" ? "update" : "create",
    targetTable: raw.targetTable as ProposalTargetTable,
    targetId: typeof raw.targetId === "string" ? raw.targetId : undefined,
    tempId: typeof raw.tempId === "string" ? raw.tempId : undefined,
    status: "pending",
    payload: sanitizeModelPayload(raw.targetTable as ProposalTargetTable, (raw.payload ?? {}) as Record<string, unknown>),
    after: sanitizeModelPayload(raw.targetTable as ProposalTargetTable, (raw.payload ?? {}) as Record<string, unknown>),
    rationale: String(raw.rationale || ""),
    dependencies: Array.isArray(raw.dependencies) ? raw.dependencies.map(String) : [],
  }));
}

function namespaceTempIds(items: ProposalItem[], prefix: string): ProposalItem[] {
  const tempIdMap = new Map<string, string>();
  for (const item of items) {
    if (item.tempId) {
      const newTempId = `${prefix}${item.tempId}`;
      tempIdMap.set(item.tempId, newTempId);
      item.tempId = newTempId;
    }
  }
  const remap = (value: unknown): unknown => {
    if (typeof value === "string" && value.startsWith("ref:")) return `ref:${tempIdMap.get(value.slice(4)) ?? value.slice(4)}`;
    if (Array.isArray(value)) return value.map(remap);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, remap(entry)]));
    return value;
  };
  for (const item of items) {
    item.payload = remap(item.payload) as Record<string, unknown>;
    item.after = { ...item.payload };
  }
  return items;
}
export function validatePlotDesignItems(items: ProposalItem[], phaseId: string, segmentOrder: number, chapterOrder: number) {
  if (items.some((item) => item.operation !== "create")) throw new Error("剧情设计只能创建新资料，不能更新已有资料");
  if (items.some((item) => item.targetTable !== "outlineNodes" && item.targetTable !== "documents")) throw new Error("剧情设计只能创建剧情段和章节");
  const segments = items.filter((item) => item.targetTable === "outlineNodes");
  const chapters = items.filter((item) => item.targetTable === "documents");
  if (segments.length !== 1) throw new Error(`剧情设计必须且只能创建 1 个剧情段，当前为 ${segments.length} 个`);
  if (chapters.length < 1) throw new Error("剧情设计至少需要创建 1 个章节");
  const segment = segments[0];
  if (!segment.tempId) throw new Error("剧情段缺少 tempId");
  if (segment.payload.phaseId !== phaseId) throw new Error("剧情段必须归属于当前选中的幕");
  if (Number(segment.payload.order) !== segmentOrder) throw new Error(`剧情段顺序应为 ${segmentOrder}`);
  if (String(segment.payload.summary ?? "").length > 300) throw new Error("剧情段概要超过 300 字");
  const expectedSegment = `ref:${segment.tempId}`;
  for (const [index, chapter] of chapters.sort((left, right) => Number(left.payload.order) - Number(right.payload.order)).entries()) {
    if (chapter.payload.plotSegmentId !== expectedSegment) throw new Error("章节必须归属于本次新建的剧情段");
    if (Number(chapter.payload.order) !== chapterOrder + index) throw new Error(`章节顺序应从 ${chapterOrder} 连续排列`);
    if (!String(chapter.payload.title ?? "").trim()) throw new Error("章节必须提供章节标题");
    if (!String(chapter.payload.summary ?? "").trim()) throw new Error(`章节“${chapter.label}”必须提供章节摘要`);
    if (!chapter.payload.blueprint || typeof chapter.payload.blueprint !== "object") throw new Error(`章节“${chapter.label}”必须提供章节蓝图`);
  }
  return { segment, chapters };
}

/** 架构层硬约束校验 issue（与 RuntimeReviewIssue 结构兼容，dimension 为自定义字符串）。 */
export interface ArchitectureConstraintIssue {
  severity: "blocker" | "major" | "warning";
  dimension: string;
  title: string;
  evidence: string;
  suggestion: string;
}

/**
 * 校验架构候选 payload 是否满足架构层硬约束的语义要求。
 *
 * schema 校验只验证字段存在与类型正确，但 LLM 生成的候选可能形式满足 schema
 * 而内容违反硬约束（如 turningPoint 是事件摘要而非不可逆变化、ecological 曲线
 * 依附主线、反馈链仅 2 步、伏笔含暗示词）。本函数在 internalGate 阶段拦截
 * 这类「形式合规但内容违规」的候选，减少 externalReview 往返。
 *
 * 通用规则，不针对特定书名/角色/题材：检查逻辑基于字段结构而非具体内容。
 */
export function validateArchitectureHardConstraints(payload: Record<string, unknown>): ArchitectureConstraintIssue[] {
  const issues: ArchitectureConstraintIssue[] = [];
  // turningPoint 不可逆性：必须落到资源转移/秘密公开/组织裂变/关系承诺
  const IRREVERSIBLE_MARKERS = ["失去", "获得", "裂变", "公开", "承诺", "不可逆", "永久", "回不到", "剥夺", "交出", "签署", "摧毁", "破灭"];
  const phases = Array.isArray(payload.phases) ? payload.phases as Array<Record<string, unknown>> : [];
  for (const phase of phases) {
    const tp = typeof phase.turningPoint === "string" ? phase.turningPoint : "";
    if (tp && !IRREVERSIBLE_MARKERS.some((m) => tp.includes(m))) {
      issues.push({
        severity: "major",
        dimension: "structure.turningPoint",
        title: `阶段 ${String(phase.id ?? "?")} turningPoint 未落到不可逆变化`,
        evidence: tp,
        suggestion: "重写为：[谁]失去/获得[具体资源]→[组织]永久[裂变/公开/承诺]→世界回不到[什么状态]",
      });
    }
  }
  // 子阶段拆分（长篇硬约束）：powerCenters>=5 视为长篇信号，每幕必须有 stages（2-4 个），全书必须有中段崩塌点
  const powerCentersForCapacity = Array.isArray(payload.powerCenters) ? payload.powerCenters as unknown[] : [];
  const isLongForm = powerCentersForCapacity.length >= 5;
  const COLLAPSE_MARKERS = ["崩塌", "失守", "最低", "一无所有", "跌至", "溃败", "失去一切", "全盘", "倾覆", "陷落", "all-is-lost"];
  let hasMidCollapse = false;
  if (isLongForm) {
    // Layer 13 根因修复（Class B 类型多样性缺失）：
    // 长篇硬约束：至少 1 个 powerCenter.kind === "supernatural"，强制跨位面/超自然存在级别势力，
    // 与人类组织型势力形成质的差异，避免世界观空间纵深不足（所有 center 同质化为朝堂/门派/商会）。
    // 通用机制：不针对具体名称（如 origin_will），LLM 可自由命名，只要 kind=supernatural。
    const powerCentersTyped = powerCentersForCapacity as Array<Record<string, unknown>>;
    const hasSupernatural = powerCentersTyped.some((center) => center.kind === "supernatural");
    if (!hasSupernatural) {
      issues.push({
        severity: "major",
        dimension: "structure.powerCenters.supernatural",
        title: "缺少跨位面/超自然存在级别权力中心",
        evidence: `powerCenters 共 ${powerCentersTyped.length} 个，kind 分布：${powerCentersTyped.map((c) => String(c.kind ?? "未设置")).join(", ") || "空"}`,
        suggestion: "至少新增 1 个 kind=supernatural 的 powerCenter，作为跨位面/超自然存在级别势力（如灵气本源意识、上古研究者集体意识、沉睡的远古意志体），与人类组织型势力形成质的差异，使第4-5幕有真正的'世界扩大'感",
      });
    }
    for (const phase of phases) {
      const stages = Array.isArray(phase.stages) ? phase.stages as Array<Record<string, unknown>> : [];
      if (stages.length < 2) {
        issues.push({
          severity: "major",
          dimension: "structure.phase.stages",
          title: `阶段 ${String(phase.id ?? "?")} 缺少子阶段拆分`,
          evidence: `stages 仅 ${stages.length} 个`,
          suggestion: "百万字长篇每幕拆分为 2-4 个子阶段，每个 stage 用文学化叙事写该子阶段的人物处境与局部不可逆变化",
        });
      }
      for (const stage of stages) {
        const summary = typeof stage.summary === "string" ? stage.summary : "";
        if (COLLAPSE_MARKERS.some((m) => summary.includes(m))) hasMidCollapse = true;
      }
    }
    if (phases.length >= 3 && !hasMidCollapse) {
      issues.push({
        severity: "major",
        dimension: "structure.phase.midCollapse",
        title: "全书缺少中段崩塌点（all-is-lost）",
        evidence: "所有 phases.stages[].summary 均未体现中段崩塌语义",
        suggestion: "在第三幕末或第四幕初的某个 stage 设计中段崩塌点：主角处境跌至最低、资源/关系/认知全面失守后再回升",
      });
    }
  }
  // ecological 曲线独立性：resourceLoop/stageGoals 不得依赖主线主角或主线技术
  const growthCurves = Array.isArray(payload.growthCurves) ? payload.growthCurves as Array<Record<string, unknown>> : [];
  const eco = growthCurves.find((g) => g.kind === "ecological");
  if (eco) {
    const MAIN_DEPENDENCY = ["陈墨", "主角", "编译体系", "编译技术", "灵气编译"];
    const resourceLoop = typeof eco.resourceLoop === "string" ? eco.resourceLoop : "";
    const stageGoals = typeof eco.stageGoals === "string" ? eco.stageGoals : "";
    if (MAIN_DEPENDENCY.some((d) => resourceLoop.includes(d) || stageGoals.includes(d))) {
      issues.push({
        severity: "major",
        dimension: "structure.growthCurve.ecological",
        title: "ecological 曲线依赖主线主角或主线技术",
        evidence: `resourceLoop: ${resourceLoop}`,
        suggestion: "重设独立驱动力（灵脉枯竭/商会代际交接/人口结构变化），删除主线后仍能独立推进至少一个 phase",
      });
    }
    // ecological 曲线多阶段推进：长篇下必须在 >=2 个 phases 作为 primaryCurveId，不得只在单一 phase 从属主线
    if (isLongForm && typeof eco.id === "string") {
      const ecoPrimaryCount = phases.filter((p) => p.primaryCurveId === eco.id).length;
      if (ecoPrimaryCount < 2) {
        issues.push({
          severity: "major",
          dimension: "structure.growthCurve.ecological.primaryScope",
          title: "ecological 曲线缺少多阶段独立推进",
          evidence: `ecological(${eco.id}) 仅在 ${ecoPrimaryCount} 个 phase 作为 primaryCurveId`,
          suggestion: "让 ecological 曲线在至少 2 个 phases 作为 primaryCurveId 推进，使其在主线之外独立制造剧情压力",
        });
      }
    }
  }
  // 反馈链步数：transmission 至少 4 步
  const feedbackLoops = Array.isArray(payload.feedbackLoops) ? payload.feedbackLoops as Array<Record<string, unknown>> : [];
  for (const fl of feedbackLoops) {
    const transmission = Array.isArray(fl.transmission) ? fl.transmission as unknown[] : [];
    if (transmission.length < 4) {
      issues.push({
        severity: "major",
        dimension: "structure.feedbackLoop",
        title: `反馈链 ${String(fl.id ?? "?")} 传导步数不足`,
        evidence: `transmission 仅 ${transmission.length} 步`,
        suggestion: "扩展至 4-6 步传导，跨 3+ 中心形成闭环（甲→乙→丙→丁→甲）",
      });
    }
    // 反馈链闭环：returnPath 必须显式写明回压路径，否则只是线性因果链
    const returnPath = typeof fl.returnPath === "string" ? fl.returnPath.trim() : "";
    if (!returnPath) {
      issues.push({
        severity: "major",
        dimension: "structure.feedbackLoop.returnPath",
        title: `反馈链 ${String(fl.id ?? "?")} 缺少闭环回压路径`,
        evidence: `returnPath 为空；transmission=${transmission.join(" -> ")}`,
        suggestion: "补 returnPath 字段，写明 transmission 最后一步如何回压到 trigger 源头或改变 trigger 的再发生条件，使反馈形成闭环",
      });
    }
  }
  // 伏笔日常化：surfaceDetail 不得含暗示词
  const FORESHADOW_HINT_WORDS = ["异常", "关键", "无法解释", "神秘", "奇怪", "单独", "不该有", "可疑"];
  const longHorizonHooks = Array.isArray(payload.longHorizonHooks) ? payload.longHorizonHooks as Array<Record<string, unknown>> : [];
  for (const hook of longHorizonHooks) {
    const surfaceDetail = typeof hook.surfaceDetail === "string" ? hook.surfaceDetail : "";
    if (FORESHADOW_HINT_WORDS.some((w) => surfaceDetail.includes(w))) {
      issues.push({
        severity: "major",
        dimension: "structure.foreshadowing",
        title: `伏笔 ${String(hook.id ?? "?")} 含暗示词`,
        evidence: surfaceDetail,
        suggestion: "删除暗示词，伪装为完全不引人注意的日常细节（如账册中某条正常的例行记录）",
      });
    }
  }
  // 权力中心非二元关系：至少 1 组 relationshipDynamics 同时含「合作」与「冲突」语义
  const powerCenters = Array.isArray(payload.powerCenters) ? payload.powerCenters as Array<Record<string, unknown>> : [];
  const COOP_MARKERS = ["合作", "协同", "联盟", "联合", "互利"];
  const CONFLICT_MARKERS = ["冲突", "对抗", "竞争", "矛盾", "分歧"];
  const hasNonBinary = powerCenters.some((pc) => {
    const rd = typeof pc.relationshipDynamics === "string" ? pc.relationshipDynamics : "";
    return COOP_MARKERS.some((m) => rd.includes(m)) && CONFLICT_MARKERS.some((m) => rd.includes(m));
  });
  if (powerCenters.length >= 2 && !hasNonBinary) {
    issues.push({
      severity: "warning",
      dimension: "structure.powerCenter.relationship",
      title: "权力中心间缺少非二元对立的合作+冲突关系",
      evidence: "所有 powerCenters 的 relationshipDynamics 未同时包含合作与冲突语义",
      suggestion: "为至少 1 组权力中心对建模复合关系（如 A 与 B 在 X 上合作，在 Y 上冲突）",
    });
  }
  // 结构化字段软门：当项目内容信号表明涉及感情线/技术代际/真相递进时，检查 phases 是否填写对应结构化字段。
  // 检测基于项目自身内容的通用语义标记（非题材/书名特定），缺失时标记为 major 驱动 LLM 在 regenerate 时补全。
  const centralQuestion = typeof payload.centralQuestion === "string" ? payload.centralQuestion : "";
  const centralConflict = typeof payload.centralConflict === "string" ? payload.centralConflict : "";
  const synopsis = typeof payload.synopsis === "string" ? payload.synopsis : "";
  const projectText = `${centralQuestion} ${centralConflict} ${synopsis}`;
  const ROMANCE_SIGNALS = ["感情", "爱情", "恋", "情感", "承诺", "关系", "姻", "侣", "知己", "红颜", "挚爱"];
  const TECH_SIGNALS = ["代际", "技术", "体系", "升级", "演进", "编译", "修炼体系", "力量体系", "迭代", "突破"];
  const TRUTH_SIGNALS = ["真相", "谜", "本源", "秘密", "揭示", "深层", "层层", "递进", "隐秘", "起源"];
  const hasRomanceSignal = ROMANCE_SIGNALS.some((s) => projectText.includes(s));
  const hasTechSignal = TECH_SIGNALS.some((s) => projectText.includes(s)) || growthCurves.some((g) => {
    const sg = typeof g.stageGoals === "string" ? g.stageGoals : "";
    return TECH_SIGNALS.some((s) => sg.includes(s));
  });
  const hasTruthSignal = TRUTH_SIGNALS.some((s) => projectText.includes(s));
  if (hasRomanceSignal) {
    const phasesWithRomance = phases.filter((p) => Array.isArray(p.romanceProgress) && p.romanceProgress.length > 0).length;
    if (phasesWithRomance === 0) {
      issues.push({
        severity: "major",
        dimension: "structure.phase.romanceProgress",
        title: "项目涉及感情线但 phases.romanceProgress 全部缺失",
        evidence: `centralQuestion/Conflict 含感情信号但 0/${phases.length} phase 填写 romanceProgress`,
        suggestion: "为每个有感情进展的 phase 填写 romanceProgress：romanceLineId/relationshipStage/irreversibleEvent，多线交叉用 crossOverWith",
      });
    }
  }
  if (hasTechSignal) {
    const phasesWithTech = phases.filter((p) => p.techGeneration && typeof p.techGeneration === "object").length;
    if (phasesWithTech === 0) {
      issues.push({
        severity: "major",
        dimension: "structure.phase.techGeneration",
        title: "项目涉及技术/能力代际演进但 phases.techGeneration 全部缺失",
        evidence: `growthCurves/centralQuestion 含技术代际信号但 0/${phases.length} phase 填写 techGeneration`,
        suggestion: "为每个解锁新技术代际的 phase 填写 techGeneration：generation/name/unlockCondition/narrativeFunction",
      });
    }
  }
  if (hasTruthSignal) {
    const phasesWithTruth = phases.filter((p) => p.originTruthLayer && typeof p.originTruthLayer === "object").length;
    if (phasesWithTruth === 0) {
      issues.push({
        severity: "major",
        dimension: "structure.phase.originTruthLayer",
        title: "项目涉及多层真相递进但 phases.originTruthLayer 全部缺失",
        evidence: `centralQuestion/Conflict 含真相递进信号但 0/${phases.length} phase 填写 originTruthLayer`,
        suggestion: "为每个揭示真相层级的 phase 填写 originTruthLayer：layer/revelation/revealerCenterId/consequence",
      });
    }
  }
  return issues;
}

function plotDesignContext(phase: ArchitecturePhase, segments: Array<{ id: string; title: string; summary: string; order: number }>, chapters: Array<{ title: string; summary: string; plotSegmentId?: string; order: number }>) {
  return [
    `当前幕：${phase.title}\n叙事使命：${phase.purpose || "暂无"}\n不可逆转折：${phase.turningPoint || "暂无"}`,
    `已有剧情段：\n${segments.map((segment) => `- ${segment.title}：${segment.summary || "暂无概要"}`).join("\n") || "暂无"}`,
    `最近章节：\n${chapters.slice(-6).map((chapter) => `- ${chapter.title}：${chapter.summary || "暂无摘要"}`).join("\n") || "暂无"}`,
  ].join("\n\n");
}

/**
 * instruction 长度上限（字符数）。超过此值时触发分段，避免上游 API HTTP 500。
 * 选择 6000 是因为本次会话中架构生成 instruction 累积超 8000 字符触发 500；
 * 6000 留出 sectionContextBlock + payloadContract + formatContextPacket 的余量。
 */
export const MAX_INSTRUCTION_CHARS = 6000;

/**
 * instruction 过长时分段：把「详细审核意见」段从核心指令中分离。
 *
 * 分割协议（通用，不依赖特定书名/题材）：
 * 1. 查找 markdown 标题标记（# 审核意见 / # 审核反馈 / # 修订意见 / # 历史审核 / # 历史问题 / # 重生成意见）
 * 2. 找到标记时，标记及之后的内容移入 reviewFeedback，之前的内容作为核心指令
 * 3. 未找到标记但 instruction 超长时，保留前 MAX_INSTRUCTION_CHARS - 500 字符作为核心，剩余移入 reviewFeedback
 * 4. 未超长时返回 { core: instruction, detail: undefined }
 *
 * 返回的 core 末尾会追加指引，让 LLM 知道详细意见在 contextPacket.review-feedback source 中。
 */
export function splitInstruction(instruction: string): { core: string; detail?: string } {
  if (instruction.length <= MAX_INSTRUCTION_CHARS) return { core: instruction };
  // 常见审核意见段落标记（通用，不针对特定项目）
  const SECTION_MARKERS = [
    "# 审核意见",
    "# 审核反馈",
    "# 修订意见",
    "# 历史审核",
    "# 历史问题",
    "# 重生成意见",
    "# 详细审核",
    "# 本次审核",
  ];
  for (const marker of SECTION_MARKERS) {
    const index = instruction.indexOf(marker);
    if (index > 0) {
      const core = instruction.slice(0, index).trim();
      const detail = instruction.slice(index).trim();
      if (core.length > 0 && detail.length > 0) {
        return {
          core: `${core}\n\n# 详细审核意见\n见 contextPacket 中的「详细审核反馈」source（review-feedback kind），必须阅读并执行。`,
          detail,
        };
      }
    }
  }
  // 无标记但超长：保留前段作为核心，后段移入 detail
  const keepChars = MAX_INSTRUCTION_CHARS - 500;
  const core = instruction.slice(0, keepChars).trim();
  const detail = instruction.slice(keepChars).trim();
  if (core.length > 0 && detail.length > 0) {
    return {
      core: `${core}\n\n# 详细审核意见\n见 contextPacket 中的「详细审核反馈」source（review-feedback kind），必须阅读并执行。`,
      detail,
    };
  }
  return { core: instruction };
}

/**
 * 剧情段设计审核 schema——使用 workflow-shared.ts 的通用 auditIssueSchema。
 * 所有 audit skill（plot-segment-audit / blueprint-audit / prose-audit）共用同一 schema 结构。
 */
const PLOT_AUDIT_EVIDENCE_FIELDS = ["title", "summary", "blueprint.objective", "blueprint.conflict", "blueprint.mustHappen", "blueprint.informationRelease"] as const;
type PlotAuditEvidenceField = typeof PLOT_AUDIT_EVIDENCE_FIELDS[number];
type GroundedPlotAuditIssue = GenerationAuditIssue & {
  evidenceItemId: string;
  evidenceField: PlotAuditEvidenceField;
  evidenceQuote: string;
};

const plotSegmentAuditSchema = {
  ...auditIssueSchema,
  properties: {
    ...auditIssueSchema.properties,
    issues: {
      ...auditIssueSchema.properties.issues,
      items: {
        ...auditIssueSchema.properties.issues.items,
        required: [
          ...auditIssueSchema.properties.issues.items.required,
          "evidenceItemId",
          "evidenceField",
          "evidenceQuote",
        ],
        properties: {
          ...auditIssueSchema.properties.issues.items.properties,
          evidenceItemId: { type: "string", minLength: 1 },
          evidenceField: { enum: PLOT_AUDIT_EVIDENCE_FIELDS },
          evidenceQuote: { type: "string", minLength: 2 },
        },
      },
    },
  },
};

function plotAuditFieldText(item: ProposalItem, field: PlotAuditEvidenceField): string {
  if (field === "title" || field === "summary") return String(item.payload[field] ?? "");
  const blueprint = (item.payload.blueprint as Record<string, unknown> | undefined) ?? {};
  const key = field.slice("blueprint.".length);
  const value = blueprint[key];
  return Array.isArray(value) ? value.map(String).join("\n") : String(value ?? "");
}

export function retainGroundedPlotAuditIssues(items: ProposalItem[], issues: GroundedPlotAuditIssue[]): GroundedPlotAuditIssue[] {
  const byId = new Map(items.flatMap((item) => [item.id, item.tempId].filter(Boolean).map((id) => [String(id), item] as const)));
  return issues.filter((issue) => {
    const item = byId.get(issue.evidenceItemId);
    if (!item || !PLOT_AUDIT_EVIDENCE_FIELDS.includes(issue.evidenceField)) return false;
    const quote = issue.evidenceQuote.trim();
    return quote.length >= 2 && plotAuditFieldText(item, issue.evidenceField).includes(quote);
  });
}

/**
 * 调用 plot-segment-audit skill 对 plot-design 产出做独立 LLM 审核。
 * 通过 explicitSkillIds 显式启用 plot-segment-audit，避免污染 PROFILE_SKILLS 默认集合。
 */
export async function runPlotSegmentAudit(params: {
  projectId: string;
  phase: ArchitecturePhase;
  segment: ProposalItem;
  chapters: ProposalItem[];
  contextPacketId: string;
  signal?: AbortSignal;
}): Promise<GenerationAuditRound> {
  const project = await novelDb.projects.get(params.projectId);
  if (!project) throw new Error("项目不存在");
  const auditSkills = await resolveNovelSkills({ projectId: params.projectId, stage: "review", explicitSkillIds: ["plot-segment-audit"] });
  if (!auditSkills.skills.some((skill) => skill.skillId === "plot-segment-audit")) {
    throw new Error("plot-segment-audit skill 未在 BUILTIN_NOVEL_SKILLS 中找到");
  }
  const packet = await novelDb.contextPackets.get(params.contextPacketId);
  const contextMarkdown = packet ? formatContextPacket(packet) : "（无冻结上下文）";
  const segmentBrief = `【剧情段】\n标题：${params.segment.payload.title}\n顺序：${params.segment.payload.order}\n概要：${params.segment.payload.summary}`;
  const chapterBriefs = params.chapters
    .sort((left, right) => Number(left.payload.order) - Number(right.payload.order))
    .map((chapter, index) => {
      const blueprint = (chapter.payload.blueprint as Record<string, unknown> | undefined) ?? {};
      const mustHappen = Array.isArray(blueprint.mustHappen) ? (blueprint.mustHappen as string[]).join("；") : "无";
      const conflict = String(blueprint.conflict ?? "无");
      const objective = String(blueprint.objective ?? "无");
      return `### 第 ${index + 1} 章：${chapter.payload.title}\n顺序：${chapter.payload.order}\n概要：${chapter.payload.summary}\n主导功能：${objective}\n冲突：${conflict}\n必须发生：${mustHappen}`;
    })
    .join("\n\n");
  const evidenceIndex = [params.segment, ...params.chapters]
    .map((item) => `- ${item.tempId || item.id}：${String(item.payload.title || "未命名")}`)
    .join("\n");
  const prompt = `# 审核任务\n审核以下剧情段（OutlineNode）及其下章节（Document 列表）的设计质量。\n\n${segmentBrief}\n\n${chapterBriefs}\n\n# 当前幕上下文\n${params.phase.title}\n叙事使命：${params.phase.purpose || "暂无"}\n不可逆转折：${params.phase.turningPoint || "暂无"}\n\n# 冻结上下文摘要\n${contextMarkdown}\n\n# 审核证据索引\n${evidenceIndex}\n\n# 审核输出要求\n- 基于 plot-segment-audit skill 的弹性判断风格：网文经验（烽火/猫腻/超级大坦克科比）+ 项目语境\n- severity 由你基于问题影响和具体语境判断\n- 没问题的方面不必报告，避免凑数\n- 每个 issue 必须填写 evidenceItemId、evidenceField、evidenceQuote；evidenceQuote 必须从所指当前字段逐字复制，不能引用上一轮文本或自行改写\n- evidenceField 只能选择 schema 允许的字段路径；跨章问题也必须至少提供一个可核验的主证据\n- 必须给出具体修订建议\n\n按 schema 输出 summary 和 issues 数组。`;
  // builtin skill 的 prompt 不会被 compileNovelStagePrompt 拼接（review stage 只拼 custom skill），
  // 用 formatSkillPrompt 显式拼接 plot-segment-audit 的完整 prompt，让 LLM 拿到具体审核指导。
  const auditSkillPrompt = `${compileNovelStagePrompt(auditSkills.skills, "review")}\n\n${formatSkillPrompt(auditSkills.skills.filter((skill) => skill.skillId === "plot-segment-audit"))}`;
  const result = await callStructuredNovelModel<{ summary: string; issues: GroundedPlotAuditIssue[] }>({
    model: project.settings.textModel,
    temperature: 0.15,
    role: "quality-editor",
    skillPrompt: auditSkillPrompt,
    schema: plotSegmentAuditSchema,
    prompt,
    signal: params.signal,
    maxTokens: 4096,
  });
  const groundedIssues = retainGroundedPlotAuditIssues([params.segment, ...params.chapters], Array.isArray(result.data.issues) ? result.data.issues : []);
  const omittedCount = (result.data.issues?.length ?? 0) - groundedIssues.length;
  return {
    iteration: 0,
    summary: `${String(result.data.summary ?? "")}${omittedCount > 0 ? `（已忽略 ${omittedCount} 条无法由当前候选字段核验的问题）` : ""}`,
    issues: groundedIssues,
    triggeredIteration: false,
  };
}


export async function runPlotDesignTask(params: { projectId: string; phaseId: string; instruction?: string; signal?: AbortSignal; audit?: { maxIterations?: number } }) {
  const project = await novelDb.projects.get(params.projectId);
  if (!project) throw new Error("项目不存在");
  const [architecture, nodes, documents] = await Promise.all([
    novelDb.architectures.where("projectId").equals(params.projectId).first(),
    novelDb.outlineNodes.where("projectId").equals(params.projectId).toArray(),
    novelDb.documents.where("projectId").equals(params.projectId).sortBy("order"),
  ]);
  const phase = architecture?.phases.find((item) => item.id === params.phaseId);
  if (!phase) throw new Error("目标幕不存在，请先保存全书架构");
  const segments = nodes.filter((node) => node.phaseId === phase.id).sort((left, right) => left.order - right.order);
  const segmentOrder = segments.reduce((max, node) => Math.max(max, node.order), -1) + 1;
  const chapterOrder = documents.reduce((max, document) => Math.max(max, document.order), -1) + 1;
  const instruction = params.instruction?.trim() || "承接当前幕已有内容，设计下一个剧情段及其章节";
  const evidence = await resolveTaskEvidence({
    projectId: params.projectId,
    target: { kind: "architecture-phase", id: phase.id },
    task: "剧情设计",
    query: `${instruction}\n${phase.title}\n${phase.purpose}\n${phase.turningPoint}`,
    model: project.settings.textModel,
    role: "architect",
    allowedSourceKinds: ["architecture", "document", "entity", "relation", "outline", "thread", "foreshadowing", "fact", "memory", "conversation-memory"],
    gapPolicy: "creative-by-default",
    signal: params.signal,
  });
  const skills = await resolveNovelSkills({ projectId: params.projectId, stage: "planning" });
  if (skills.conflicts.length) throw new Error(`Skill 冲突：${skills.conflicts.map((item) => `${item.skillId} ↔ ${item.conflictsWith}`).join("；")}`);
  const packet = await compileNovelContext({
    projectId: params.projectId,
    task: "plot-design",
    instruction,
    stage: "planning",
    resolvedSkills: skills.skills,
    retrievalRunId: evidence.run.id,
    retrievalSourceIds: evidence.run.selectedSourceIds,
    retrievalHits: evidence.selectedHits,
    consumer: { role: "architect" },
  });
  const task = getGenerationTask("plot-design");
  const inventory = await existingInventory(params.projectId, task.allowedTables);
  const availableReferences = await referenceInventory(params.projectId);
  const acceptedRefs = await acceptedProjectReferences(params.projectId);
  const referenceAliases = [...acceptedRefs.entries()].map(([alias, id]) => `ref:${alias} -> ${id}`).join("\n") || "暂无已采纳临时引用。";
  const agent: AgentRun = { ...recordBase(params.projectId), goal: instruction, status: "running", model: project.settings.textModel, promptVersion: "novel-plot-design-v2", contextPacketId: packet.id, role: "architect", skillRefs: skills.skills.map((item) => `${item.skillId}@${item.version}`), artifactRefs: [], attempt: 1, startedAt: Date.now(), steps: [{ id: crypto.randomUUID(), title: "设计剧情段与章节", tool: "model.structured", status: "running" }] };
  await novelDb.agentRuns.add(agent);
  const basePrompt = `# 任务\n在幕“${phase.title}”下设计下一个剧情段，并把剧情段拆成可直接进入创作流程的章节。\n\n# 作者要求\n${instruction}\n\n# 当前规划上下文\n${plotDesignContext(phase, segments, documents)}\n\n# 结构要求\n1. 只创建 1 个 outlineNodes 剧情段，phaseId 必须为 ${phase.id}，order 必须为 ${segmentOrder}，并提供 tempId。\n2. 剧情段 summary 使用 100-200 字连贯说明人物处境、局部矛盾、需要积累的体验和结束时允许发生的变化。\n3. 创建至少 1 个 documents 章节；数量由独立叙事功能、因果跨度、人物视角、篇幅预算和连载回报决定，不得为固定范围凑数或压缩。plotSegmentId 必须使用 ref:剧情段tempId，order 从 ${chapterOrder} 连续排列。\n4. documents.title 就是正式章节标题；summary 说明本章主导叙事功能与结束状态；blueprint 写入探索或积累方向、本章兑现边界，以及相关 characterIds、plotThreadIds、foreshadowingIds。\n5. 每章只承担一个清晰的主导叙事功能；可以推进事件，也可以建立背景与常态、深化人物关系、积累情感压力或消化后果。章节之间必须可连续写作，不得把后续节点提前压入当前章节。\n5.5. 剧情段 summary 首行必须用【功能类型】标注，五类任选其一：主线推进型/世界观穿插型/群像塑造型/支线编织型/呼吸节奏型。功能类型决定本剧情段是否推进当前 phase 主线。参考前序剧情段功能类型：若前序已有连续主线推进剧情段，本次建议生成交织型剧情段（世界观穿插/群像塑造/支线编织/呼吸节奏）稀释推进速度。非主线推进剧情段也必须有自身完整的人物处境、矛盾和因果链，不能只是主线休息站。\n6. 当剧情段确实跨越多种功能或强度时，安排有差异的行动、余波、蓄势或兑现节奏；世界观穿插型/群像塑造型/呼吸节奏型剧情段的内部章节可全部为低强度铺陈章，只要它们深化读者对世界、人物或关系的理解，无需强行补入行动章。单一过渡、完整高潮、短促插曲或实验性结构无需为满足模板强行补入低强度章。\n7. 不得创建幕、场景、时间线事件或其它资料表，也不得更新已有资料。\n8. 每章目标字数由系统统一设为 ${DEFAULT_CHAPTER_TARGET_WORDS} 字，不得返回 targetWords。\n\n# 证据边界\n既有事实只能来自冻结上下文；以下创作空白允许设计为新候选：${evidence.creativeGaps.join("；") || "无特别标记"}\n\n# 允许生成的资料表\n${task.allowedTables.join("、")}\n\n${payloadContract}\n\n# 现有对象索引\n${inventory}\n\n# 可引用对象索引\n${availableReferences}\n\n# 已采纳引用别名\n${referenceAliases}\n\n# 输出要求\n所有项必须为 create。内容中禁止出现候选、待审核等审批元信息。\n\n# 冻结上下文\n${formatContextPacket(packet)}`;
  const auditEnabled = !!params.audit;
  const maxAuditIterations = Math.max(0, Math.min(3, params.audit?.maxIterations ?? 1));
  try {
    const characterNameMap = await projectCharacterNameToIdMap(params.projectId);
    const characterReferenceContract = characterNameMap.size
      ? `角色引用只能使用以下真实 ID，不得填写角色名或自造 ID：\n${[...characterNameMap.entries()].map(([name, id]) => `- ${name}: ${id}`).join("\n")}`
      : "当前没有角色时必须省略该字段；povCharacterId 不得返回空字符串，characterIds 必须为空数组。";
    const skillPrompt = `${compileNovelStagePrompt(skills.skills, "planning")}\n\n## 内部引用契约\n${characterReferenceContract}`;

    /**
     * 调用 LLM 生成 plot-design 候选项，含 3 次结构校验重试。
     * 当传入 auditFindings 时，prompt 末尾追加审核意见，引导 LLM 修正问题。
     */
    const generateItems = async (auditFindings?: string, minimumChapterCount = 1): Promise<{ items: ProposalItem[]; summary: string; promptHash: string; usage: { inputTokens: number; outputTokens: number } }> => {
      let lastError = "";
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const auditBlock = auditFindings ? `\n\n# 上一轮 LLM 审核意见\n请基于以下审核问题重新设计剧情段与章节，针对每个 major/blocker 问题在生成时落实修订；不要直接复述审核意见，而是把它转化为具体的章节结构调整、节奏功能覆盖或伏笔埋设。\n${auditFindings}` : "";
        const attemptPrompt = attempt ? `${basePrompt}${auditBlock}\n\n# 上次结构校验失败\n${lastError}\n请只修复结构和长度问题。` : `${basePrompt}${auditBlock}`;
        const result = await callStructuredNovelModel<Record<string, unknown>>({ model: project.settings.textModel, temperature: attempt ? 0.3 : 0.55, role: "architect", skillPrompt, schema: proposalSchema(task.allowedTables), prompt: attemptPrompt, signal: params.signal, maxTokens: 8192 });
        const items = namespaceTempIds(parseProposalItems(result.data), `plot_${phase.order}_${segmentOrder}_`);
        try {
          const segment = items.find((item) => item.targetTable === "outlineNodes");
          if (!segment) throw new Error("缺少剧情段候选");
          segment.payload = { ...segment.payload, phaseId: phase.id, order: segmentOrder };
          segment.after = { ...segment.payload };
          const chapters = items.filter((item) => item.targetTable === "documents").sort((left, right) => Number(left.payload.order) - Number(right.payload.order));
          if (chapters.length < minimumChapterCount) throw new Error(`审核修订不得把章节数从 ${minimumChapterCount} 章缩减为 ${chapters.length} 章；除非审核明确要求合并，否则应在原结构上修正问题。`);
          for (const [index, chapter] of chapters.entries()) {
            chapter.payload = { ...chapter.payload, plotSegmentId: `ref:${segment.tempId}`, order: chapterOrder + index, status: "outline" };
            chapter.after = { ...chapter.payload };
          }
          validatePlotDesignItems(items, phase.id, segmentOrder, chapterOrder);
          const catalog = await projectReferenceCatalog(params.projectId);
          repairProposalCharacterReferences(items, catalog, characterNameMap);
          repairTimelineAndOutlineNodeReferences(items, catalog);
          repairUnresolvableTempRefs(items, acceptedRefs, await projectEntityNameToIdMap(params.projectId));
          assertProposalReferences(items, catalog, acceptedRefs);
          return { items, summary: String(result.data.summary || "新的剧情段与章节"), promptHash: result.promptHash, usage: result.usage };
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
        }
      }
      throw new Error(`AI 返回的剧情段与章节结构无效：${lastError}`);
    };

    // 初次生成
    const initial = await generateItems();
    let items = initial.items;
    let summary = initial.summary;
    let promptHash = initial.promptHash;
    let usage = initial.usage;

    // audit+iterate 循环
    let auditReport: GenerationAuditReport | undefined;
    if (auditEnabled && maxAuditIterations > 0) {
      const rounds: GenerationAuditRound[] = [];
      // 第一轮审核（iteration=1）
      const segmentItem = items.find((item) => item.targetTable === "outlineNodes")!;
      const chapterItems = items.filter((item) => item.targetTable === "documents");
      let round = await runPlotSegmentAudit({
        projectId: params.projectId,
        phase,
        segment: segmentItem,
        chapters: chapterItems,
        contextPacketId: packet.id,
        signal: params.signal,
      });
      round.iteration = 1;
      round.triggeredIteration = hasMajorOrBlocker(round.issues);
      rounds.push(round);

      // 迭代循环：最多 maxAuditIterations 次重新生成
      let iterationsDone = 0;
      while (hasMajorOrBlocker(round.issues) && iterationsDone < maxAuditIterations) {
        iterationsDone += 1;
        const previousChapterCount = items.filter((item) => item.targetTable === "documents").length;
        const allowConsolidation = round.issues.some((issue) => /合并|删减|减少章节/.test(`${issue.title} ${issue.suggestion}`));
        const regenerated = await generateItems(formatAuditFindingsForRerun(round), allowConsolidation ? 1 : previousChapterCount);
        items = regenerated.items;
        summary = regenerated.summary;
        promptHash = regenerated.promptHash;
        usage = regenerated.usage;
        const newSegment = items.find((item) => item.targetTable === "outlineNodes")!;
        const newChapters = items.filter((item) => item.targetTable === "documents");
        round = await runPlotSegmentAudit({
          projectId: params.projectId,
          phase,
          segment: newSegment,
          chapters: newChapters,
          contextPacketId: packet.id,
          signal: params.signal,
        });
        round.iteration = iterationsDone + 1;
        round.triggeredIteration = hasMajorOrBlocker(round.issues) && iterationsDone < maxAuditIterations;
        rounds.push(round);
      }

      const lastRound = rounds[rounds.length - 1];
      auditReport = {
        auditSkillId: "plot-segment-audit",
        mechanism: "internal-iterate",
        rounds,
        improved: !hasMajorOrBlocker(lastRound.issues),
        remainingMajorCount: lastRound.issues.filter((issue) => issue.severity === "blocker" || issue.severity === "major").length,
      };
    }

    const proposal: AIProposal = { ...recordBase(params.projectId), title: "剧情段与章节设计", operation: "structured:plot-design", taskKey: "plot-design", scope: "plot-design", targetId: phase.id, status: "pending", previewMarkdown: proposalMarkdown("剧情段与章节设计", summary, items), patches: [], items, contextPacketId: packet.id, agentRunId: agent.id, model: project.settings.textModel, outlineGenerationMode: "plot-segment-append", architecturePhaseId: phase.id, architecturePhaseOrder: phase.order, auditReport };
    agent.status = "completed";
    agent.finishedAt = Date.now();
    agent.promptHash = promptHash;
    agent.usage = usage;
    agent.steps[0].status = "completed";
    agent.steps[0].output = `${items.length} 个候选项${auditReport ? `；审核 ${auditReport.rounds.length} 轮，剩余 ${auditReport.remainingMajorCount} 个 major+` : ""}`;
    await novelDb.transaction("rw", novelDb.proposals, novelDb.agentRuns, async () => { await novelDb.proposals.add(proposal); await novelDb.agentRuns.put({ ...agent, revision: agent.revision + 1, updatedAt: Date.now() }); });
    return { proposal, packet, agent };
  } catch (error) {
    agent.status = "failed";
    agent.finishedAt = Date.now();
    agent.steps[0].status = "failed";
    agent.steps[0].error = error instanceof Error ? error.message : String(error);
    await novelDb.agentRuns.put({ ...agent, revision: agent.revision + 1, updatedAt: Date.now() });
    throw error;
  }
}

/**
 * 多项任务的最低提案项数量。若 LLM 首次返回的提案项不足此数，会以更强的数量提示重试（最多 2 次）。
 * 这是对 defaultInstruction 中"至少 N 项"硬约束的执行层兜底——LLM 在长 prompt 中容易忽略埋在末尾的数量约束，
 * 重试时会把数量不足明确注入 instruction 首部，确保 LLM 看到。
 */
const MIN_PROPOSAL_ITEMS: Partial<Record<NovelGenerationTaskKey, number>> = {
  characters: 5,
  relations: 5,
  worldview: 8,
  "plot-threads": 4,
  foreshadowing: 4,
};
const MIN_ITEM_RETRY_MAX = 2;

/**
 * 统计与任务语义相关的提案项数量。
 *
 * 根因修复：characters 任务的 allowedTables=["entities"] 允许所有 entity kind
 * （character/location/organization/faction/item/species/rule/ability/term）。
 * LLM 可能返回 5 个 entity 但只 1 个是 character，其余是 location/organization——
 * 此时 items.length>=5 不会触发重试，但实际角色数 <5，不满足群像硬约束。
 *
 * 此函数按任务语义统计相关项：
 * - characters：只算 payload.kind === "character" 的项（防止 LLM 用 location/organization 凑数）
 * - 其他任务（relations/plot-threads/foreshadowing）：allowedTables 只有一种表，全部项都相关
 *
 * 判定标准：若 LLM 返回的项中存在与任务核心目标不匹配的子类型，按相关子类型计数而非总数。
 */
function countRelevantProposalItems(taskKey: NovelGenerationTaskKey, items: ProposalItem[]): number {
  if (taskKey === "characters") {
    return items.filter((item) => item.payload.kind === "character").length;
  }
  return items.length;
}

/**
 * 校验架构 payload 的第二增长曲线结构化约束。
 *
 * 根因修复（Loop 4 Major #2）：第二增长曲线约束此前仅为文字要求，无结构化字段。
 * LLM 即使理解了约束，也没有地方放置生态曲线信息，导致所有阶段都围绕主线主角命运。
 * 现在架构 payload 新增 growthCurves 数组 + phases.primaryCurveId 字段，
 * 此函数在执行层校验：(1) 至少 2 条曲线；(2) 至少 1 条 ecological；
 * (3) 至少 1 个 phase 的 primaryCurveId 引用 ecological 曲线。
 *
 * 返回 null 表示校验通过，返回 string 表示错误描述（用于重试 instruction）。
 */
function validateArchitectureGrowthCurves(payload: Record<string, unknown>): string | null {
  const curves = Array.isArray(payload.growthCurves) ? payload.growthCurves as Array<Record<string, unknown>> : [];
  if (curves.length < 2) {
    return `growthCurves 只有 ${curves.length} 条，要求至少 2 条（1 条 kind="main" 主线 + 至少 1 条 kind="ecological" 生态曲线）。请在 payload.growthCurves 数组中补充。`;
  }
  const ecologicalCurves = curves.filter((c) => c.kind === "ecological");
  if (ecologicalCurves.length === 0) {
    return `growthCurves 缺少 kind="ecological" 的生态增长曲线——至少需要 1 条独立于主线的生态曲线。当前 ${curves.length} 条曲线全部是主线，请将至少 1 条改为 kind="ecological" 并填写独立的 subject/resourceLoop/stageGoals/irreversibleChange。`;
  }
  const ecologicalIds = new Set(ecologicalCurves.map((c) => String(c.id)));
  const phases = Array.isArray(payload.phases) ? payload.phases as Array<Record<string, unknown>> : [];
  const phasesOnEcological = phases.filter((p) => ecologicalIds.has(String(p.primaryCurveId ?? "")));
  if (phasesOnEcological.length === 0) {
    const ecoIdList = [...ecologicalIds].join(", ");
    return `所有 ${phases.length} 个阶段的 primaryCurveId 都引用主线曲线，没有阶段由生态曲线推进。至少需要 1 个阶段的 primaryCurveId 引用 ecological 曲线（可用 id: ${ecoIdList}）。`;
  }
  return null;
}

function validateArchitectureSystems(payload: Record<string, unknown>, targetWords: number): string | null {
  const isMillionWordProject = targetWords >= 1_000_000;
  const required = architectureSystemCapacity(targetWords);
  const powerCenters = Array.isArray(payload.powerCenters) ? payload.powerCenters as Array<Record<string, unknown>> : [];
  if (powerCenters.length < required.powerCenters) return `powerCenters 只有 ${powerCenters.length} 个，${isMillionWordProject ? "百万字" : "当前体量"}架构至少需要 ${required.powerCenters} 个可独立行动的权力中心；请逐项填写 name/interest/resources/actionCapacity/bottomLine/relationshipDynamics。`;
  const centerRefs = powerCenters.flatMap((center) => [String(center.id ?? "").trim(), String(center.name ?? "").trim()]).filter(Boolean);
  if (new Set(centerRefs).size !== centerRefs.length) return "powerCenters 的 id 与 name 必须各自唯一，且不得互相重名，以便反馈链和长期钩子准确引用。";

  const feedbackLoops = Array.isArray(payload.feedbackLoops) ? payload.feedbackLoops as Array<Record<string, unknown>> : [];
  if (feedbackLoops.length < required.feedbackLoops) return `feedbackLoops 只有 ${feedbackLoops.length} 条，${isMillionWordProject ? "百万字" : "当前体量"}架构至少需要 ${required.feedbackLoops} 条跨组织反馈链；每条需写清 trigger、至少两步 transmission、受影响中心和产生的故事压力。`;
  const narrowFeedback = feedbackLoops.find((loop) => !Array.isArray(loop.affectedCenters) || loop.affectedCenters.length < required.feedbackAffectedCenters);
  if (narrowFeedback) return `feedbackLoops 中 ${String(narrowFeedback.id ?? narrowFeedback.name ?? "未命名项")} 只连接了 ${Array.isArray(narrowFeedback.affectedCenters) ? narrowFeedback.affectedCenters.length : 0} 个权力中心；当前体量要求每条反馈链至少跨 ${required.feedbackAffectedCenters} 个中心，避免退化为两方直线冲突。`;
  const longHorizonHooks = Array.isArray(payload.longHorizonHooks) ? payload.longHorizonHooks as Array<Record<string, unknown>> : [];
  if (longHorizonHooks.length < required.longHorizonHooks) return `longHorizonHooks 只有 ${longHorizonHooks.length} 条，${isMillionWordProject ? "百万字" : "当前体量"}架构至少需要 ${required.longHorizonHooks} 条长期钩子；每条需以具体 surfaceDetail 出现，并保留至少两种 possibleInterpretations。`;

  const knownCenters = new Set(centerRefs);
  // 根因修复（iter14 引用完整性循环）：原错误消息只说"引用了未建模中心"，
  // 没列出已有合法 powerCenter 的 id/name，LLM 难以决定是"新增 center"还是"改引用"，
  // 导致连续 3 次重复同一错误。修复：错误消息列出已有合法 id/name 供 LLM 直接引用，
  // 同时给出"新增 center 须补全字段"的可操作指引，降低 LLM 决策成本。
  // 判定信号：validateArchitectureSystems 连续拦截 affectedCenters 引用未建模中心，
  // 且重试消息不含已有合法选项列表 → LLM 无可操作路径 → 重复错误。
  const knownCenterList = centerRefs.length ? centerRefs.join("、") : "（当前 powerCenters 为空）";
  for (const [collectionName, records] of [["feedbackLoops", feedbackLoops], ["longHorizonHooks", longHorizonHooks]] as const) {
    for (const record of records) {
      const affectedCenters = Array.isArray(record.affectedCenters) ? record.affectedCenters.map(String) : [];
      const unknownCenters = affectedCenters.filter((center) => !knownCenters.has(center));
      if (unknownCenters.length > 0) {
        return `${collectionName} 中 ${String(record.id ?? record.name ?? "未命名项")} 的 affectedCenters 引用了未建模中心：${unknownCenters.join("、")}。当前已建模的合法 powerCenter id/名称为：${knownCenterList}。修复方式（二选一）：(A) 把 affectedCenters 中的未建模引用改为上述已有 id/名称之一；(B) 若该未建模中心确属故事必需的独立行动者，在 powerCenters 数组中新增完整条目（含 id/name/interest/resources/actionCapacity/bottomLine/relationshipDynamics 全部必填字段），然后保留该引用。不得在 feedbackLoops/longHorizonHooks 中引用未在 powerCenters 建模的势力。`;
      }
    }
  }
  return null;
}

/**
 * 校验剧情线 payload 的共谋线结构化约束。
 *
 * 根因修复（Loop 5 Major #2，复发于 Loop 4）：共谋线缺失在历史权谋(Loop 4)和玄幻修真(Loop 5)
 * 两个不同题材复发，证伪了 Loop 4 audit "内容深度问题非结构缺陷" 的判断。
 * 根因是 plot-threads instruction 此前仅将共谋线作为"建议"（"共谋线/感情线"二选一），
 * LLM 选 romance 即可跳过共谋线，且无执行层校验，PlotThreadKind 也无 conspiracy 类型。
 * 现新增 kind=conspiracy 类型 + 执行层校验：百万字长篇必须有 ≥1 条 kind=conspiracy 共谋线，
 * 且该线有非空 nextMove（共谋者推进阴谋的独立行动，不得以主角为行动对象）。
 *
 * 返回 null 表示校验通过，返回 string 表示错误描述（用于重试 instruction）。
 */
function validatePlotThreadsConspiracy(items: ProposalItem[]): string | null {
  const threadItems = items.filter((i) => i.targetTable === "plotThreads");
  const conspiracyItems = threadItems.filter((i) => i.payload?.kind === "conspiracy");
  if (conspiracyItems.length === 0) {
    const existingKinds = threadItems.map((i) => String(i.payload?.kind ?? "?")).join(", ");
    return `剧情线缺少 kind="conspiracy" 的共谋线——百万字长篇必须有至少 1 条独立共谋线（一群角色暗中结盟/共谋，有独立于对抗线的目标与 nextMove）。当前 ${threadItems.length} 条剧情线的 kind 为 [${existingKinds}]，请新增 1 条 kind="conspiracy" 的共谋线，其 nextMove 必须描述共谋者推进阴谋的独立行动（不得以主角为行动对象）。`;
  }
  const missingNextMove = conspiracyItems.filter((i) => !String(i.payload?.nextMove ?? "").trim());
  if (missingNextMove.length > 0) {
    return `kind="conspiracy" 的共谋线缺少 nextMove 字段——共谋线必须有描述共谋者推进阴谋行动的 nextMove（不得为空）。请为每条共谋线补充 nextMove。`;
  }
  return null;
}

function validateWorldviewCoverage(items: ProposalItem[]): string | null {
  const entities = items.filter((item) => item.targetTable === "entities");
  const locations = entities.filter((item) => item.payload?.kind === "location");
  const organizations = entities.filter((item) => item.payload?.kind === "organization" || item.payload?.kind === "faction");
  const systems = entities.filter((item) => ["rule", "ability", "term"].includes(String(item.payload?.kind ?? "")));
  if (locations.length < 2) return `worldview 只有 ${locations.length} 个地点实体，百万字长篇至少需要 2 个可独立引用、具有不同生产方式或文化制度的地域。`;
  if (organizations.length < 3) return `worldview 只有 ${organizations.length} 个组织/阵营实体，百万字长篇至少需要 3 个能独立行动并拥有资源与职责的组织或阵营。`;
  if (systems.length < 2) return `worldview 只有 ${systems.length} 个规则/能力/术语实体，百万字长篇至少需要 2 个可约束行动的制度、能力或术语，不能只列地点和组织名。`;
  return null;
}

function validateTimelineStructure(items: ProposalItem[], targetWords: number): string | null {
  const events = items.filter((item) => item.targetTable === "timelineEvents");
  const requiredEvents = timelineSystemCapacity(targetWords);
  if (events.length < requiredEvents) return `timeline 只有 ${events.length} 个事件，当前体量至少需要 ${requiredEvents} 个分布在全书阶段中的骨干事件，不能只规划开篇。`;
  const orders = events.map((item) => Number(item.payload.narrativeOrder));
  if (orders.some((order) => !Number.isFinite(order)) || new Set(orders).size !== orders.length) return "timelineEvents.narrativeOrder 必须逐项提供且互不重复，以便建立明确叙事顺序。";
  if (targetWords >= 1_000_000) {
    const locatedEvents = events.filter((item) => typeof item.payload.locationId === "string" && item.payload.locationId.trim());
    if (locatedEvents.length < 2) return `timeline 只有 ${locatedEvents.length} 个事件提供 locationId；百万字长篇至少需要 2 个使用真实地点 ID 的地域锚点，避免跨地域变化只存在于标题散文中。`;
  }
  const tempIds = new Set(events.map((item) => item.tempId).filter((id): id is string => Boolean(id)));
  if (tempIds.size !== events.length) return "每个 timelineEvents 候选都必须提供唯一 tempId，供同批事件建立 causeIds/consequenceIds 因果引用。";
  const edges = new Set<string>();
  for (const event of events) {
    const source = event.tempId!;
    for (const field of ["causeIds", "consequenceIds"] as const) {
      const refs = Array.isArray(event.payload[field]) ? event.payload[field].map(String) : [];
      for (const raw of refs) {
        const target = raw.startsWith("ref:") ? raw.slice(4) : raw;
        if (!tempIds.has(target) || target === source) continue;
        edges.add([source, target].sort().join("::"));
      }
    }
  }
  if (edges.size < events.length - 1) return `timeline 的同批事件只有 ${edges.size} 条有效因果连接；${events.length} 个骨干事件至少需要 ${events.length - 1} 条通过 ref:tempId 建立的 causeIds/consequenceIds 连接，允许并行但不能彼此孤立。`;
  return null;
}

/**
 * 统一的重试原因检测——将多项任务数量兜底与架构 payload 结构校验合并为单一入口。
 *
 * 返回 null 表示无需重试，返回 { message } 表示需要重试并附带给 LLM 的修正指令。
 */
function getGenerationRetryReason(taskKey: NovelGenerationTaskKey, items: ProposalItem[], minItems: number, targetWords: number): { message: string } | null {
  const enforceMillionWordStructure = targetWords >= 1_000_000;
  if (!enforceMillionWordStructure) return null;
  // 1. 多项任务数量兜底（characters/relations/plot-threads/foreshadowing）
  if (minItems > 0) {
    const relevantCount = countRelevantProposalItems(taskKey, items);
    if (relevantCount < minItems) {
      const label = taskKey === "characters" ? "角色（payload.kind=\"character\"）" : "提案项";
      const suffix = taskKey === "characters"
        ? "每个 item 的 payload.kind 必须为 \"character\"，不要返回 location/organization/item 等非角色实体来凑数。"
        : "不要只生成 1-2 项就停止。";
      return { message: `上次只生成了 ${relevantCount} 个相关${label}，不满足至少 ${minItems} 个的硬要求。请务必生成至少 ${minItems} 个独立的${label}，每项作为独立的 JSON 对象返回。${suffix}` };
    }
  }
  // 2. 架构 payload 结构校验（第二增长曲线结构化字段强制）
  if (taskKey === "architecture") {
    const archItem = items.find((i) => i.targetTable === "architectures");
    if (archItem) {
      const systemError = validateArchitectureSystems(archItem.payload, targetWords);
      if (systemError) return { message: systemError };
      const error = validateArchitectureGrowthCurves(archItem.payload);
      if (error) return { message: error };
    }
  }
  // 3. 剧情线共谋线结构校验（百万字长篇必备 kind=conspiracy 独立共谋线）
  if (taskKey === "plot-threads") {
    const error = validatePlotThreadsConspiracy(items);
    if (error) return { message: error };
  }
  if (taskKey === "worldview") {
    const error = validateWorldviewCoverage(items);
    if (error) return { message: error };
  }
  if (taskKey === "timeline") {
    const error = validateTimelineStructure(items, targetWords);
    if (error) return { message: error };
  }
  return null;
}

export async function runGenerationTask(params: {
  projectId: string;
  taskKey: NovelGenerationTaskKey;
  instruction: string;
  targetId?: string;
  targetField?: string;
  signal?: AbortSignal;
  requiredPayloadFields?: Partial<Record<ProposalTargetTable, string[]>>;
}) {
  const task = getGenerationTask(params.taskKey);
  const project = await novelDb.projects.get(params.projectId);
  if (!project) throw new Error("项目不存在");
  const skills = await resolveNovelSkills({ projectId: params.projectId, stage: task.skillStage });
  if (skills.conflicts.length) throw new Error(`Skill 冲突：${skills.conflicts.map((item) => `${item.skillId} ↔ ${item.conflictsWith}`).join("；")}`);
  // P1-1: instruction 过长时分段，避免上游 API HTTP 500。
  // 核心指令保留在 instruction，详细审核意见移入 contextPacket 的 review-feedback source。
  const { core: coreInstruction, detail: reviewFeedbackDetail } = splitInstruction(params.instruction);
  const packet = await compileNovelContext({
    projectId: params.projectId,
    task: params.taskKey,
    instruction: coreInstruction,
    targetDocumentId: params.targetId,
    stage: task.skillStage,
    resolvedSkills: skills.skills,
    reviewFeedback: reviewFeedbackDetail,
  });
  const inventory = await existingInventory(params.projectId, task.allowedTables);
  const availableReferences = await referenceInventory(params.projectId);
  const acceptedRefs = await acceptedProjectReferences(params.projectId);
  const referenceAliases = [...acceptedRefs.entries()].map(([alias, id]) => `ref:${alias} -> ${id}`).join("\n") || "暂无已采纳临时引用。";

  const effectiveInstruction = params.instruction;
  let sectionContextBlock = "";
  sectionContextBlock += `\n# 项目身份边界\n当前正式项目名为《${project.title}》。候选标题、摘要、标签和 payload 必须沿用这个项目身份，不得引入另一个作品名、测试名或未获授权的改名。\n`;
  const enforceMillionWordStructure = project.targetWords >= 1_000_000;
  sectionContextBlock += enforceMillionWordStructure
    ? `\n# 项目体量边界\n本项目目标字数为 ${project.targetWords.toLocaleString()}，属于明确配置的百万字长篇；角色、关系、剧情线、伏笔、生态增长曲线和共谋线的长篇结构门禁生效。\n`
    : `\n# 项目体量边界\n本项目目标字数为 ${project.targetWords.toLocaleString()}，不属于百万字长篇。任务文本中针对“百万字长篇”的最低数量、生态增长曲线、共谋线和跨百章伏笔要求均为可选建议，不得为满足这些建议扩张项目结构；按本项目实际题材、体量和作者要求决定数量。\n`;
  if (params.taskKey === "chapter-plan") {
    sectionContextBlock += `\n# 章节规划边界\n- 每章目标字数由系统统一设置为 ${DEFAULT_CHAPTER_TARGET_WORDS} 字。请按该篇幅规划章节，但不要在 payload 中返回 targetWords。\n- 本任务只规划当前章节的标题、摘要和蓝图；order、plotSegmentId、status 等文档结构字段由系统继承，不能借章节规划移动章节、改变归属或推进写作状态。\n`;
  }
  if (params.taskKey === "architecture") {
    const capacity = architectureSystemCapacity(project.targetWords);
    const architectureCapacity = enforceMillionWordStructure
      ? `本项目体量对应的架构容量为：powerCenters 至少 ${capacity.powerCenters} 个、feedbackLoops 至少 ${capacity.feedbackLoops} 条、longHorizonHooks 至少 ${capacity.longHorizonHooks} 条；每条 feedbackLoops.affectedCenters 至少引用 ${capacity.feedbackAffectedCenters} 个已建模中心。`
      : "本项目不是百万字长篇：结构数量服从真实叙事需要，不得为长篇门槛强行扩张。";
    sectionContextBlock += `\n# 架构字段落点\n- ${architectureCapacity}\n- centralConflict 或 synopsis 必须呈现可辨认的权力中心，以及各自的利益、关键资源、行动能力和底线；至少一组关系必须同时包含合作与冲突。\n- 必须写清资源如何在这些权力中心之间流转、短缺或被截断，以及局部行动如何反馈到其他中心，不能只写抽象的“旧秩序”与“新秩序”。feedbackLoops 和 longHorizonHooks 的 affectedCenters 只能引用 powerCenters 中已有的 id 或准确名称，不得引用只在散文中出现、却没有建模的势力。\n- 长期钩子须以允许多种解释的具体异常或日常细节出现，供后续伏笔阶段展开；不得提前锁死唯一回收答案。\n- phases.purpose 必须分别说明该阶段由哪项资源、秘密、关系或不可兼得的选择把主线、群像行动和感情线连在一起；若含感情线，写出由双方职责、边界或价值承诺导致的关系阶段变化。\n- phases.turningPoint 保持文学表达，但必须明确哪项资源控制已经易手、哪桩秘密已经公开、哪个组织已经裂变，或哪份关系承诺已经使旧选择不再可能；不能只写“人物理解了”“世界改变了”等抽象感悟。\n`;
    // 根因修复（iter15 发现）：payloadContract 的"当项目涉及..."条件指令太含糊，
    // LLM 不认为项目"涉及"该要素 → 不填充 optional 字段。LLM 注意力位置偏差假设已证伪
    // （iter13 issues 置首 techGeneration/originTruthLayer，iter14/15 仍 0/5）。
    // 修复：百万字长篇项目无条件要求填充 phases.romanceProgress/techGeneration/originTruthLayer。
    // 百万字长篇几乎必然涉及感情线/技术代际/真相递进；若个别项目不涉及，LLM 可填"不适用"。
    // 判定信号：schema 已解锁 + issues 已注入 + maxTokens 充足 + 仍不填充 → 条件指令解读失败。
    if (enforceMillionWordStructure) {
      sectionContextBlock += `\n# 百万字长篇结构化字段强制填充（无条件）\n百万字长篇项目必须为每个 phase 填写以下三个结构化字段，不得留空，不得以"本项目不涉及"为由跳过：\n- phases[].romanceProgress：每个 phase 必须至少 1 条 romanceProgress（romanceLineId/relationshipStage/irreversibleEvent）。即使本 phase 感情线无进展，也须填写 relationshipStage="停滞" + irreversibleEvent="无" + crossOverWith=[]，标注该阶段感情线状态。\n- phases[].techGeneration：每个 phase 必须绑定 1 个 techGeneration（generation/name/unlockCondition/narrativeFunction）。即使本 phase 无技术升级，也须填写 generation="延续" + name="前代技术延续" + unlockCondition="无新解锁" + narrativeFunction="维持既有技术格局"。\n- phases[].originTruthLayer：每个 phase 必须绑定 1 个 originTruthLayer（layer/revelation/revealerCenterId/consequence）。即使本 phase 无真相揭示，也须填写 layer="延续" + revelation="无新揭示" + revealerCenterId="无" + consequence="维持既有认知"。\n上述字段是百万字长篇结构化展开的硬性要求，不是可选建议。缺失任何一个 phase 的任何一个字段都会被审核标记为 major issue。\n`;
    }
  }
  if (params.taskKey === "worldview") {
    const architecture = await novelDb.architectures.where("projectId").equals(params.projectId).first();
    const powerCenterNames = (architecture?.powerCenters ?? [])
      .map((center) => center.name.trim())
      .filter(Boolean);
    const canonicalCenters = powerCenterNames.length ? powerCenterNames.join("、") : "暂无已建模权力中心";
    sectionContextBlock += `\n# 世界观连续性合同\n- 已接受架构中的权力中心为：${canonicalCenters}。\n- 世界观阶段负责把架构中的抽象行动中心落成可引用实体。组织或阵营候选应优先使用上述正式名称；不得仅改几个字就创建职能相同的平行组织。\n- 如确需创建从属机构、历史前身或地方分支，必须在 summary 或 description 中明确写出它与对应正式权力中心的隶属、继承或对抗关系，不能让读者猜测二者是否同一组织。\n- 地点、制度、术语与能力需要说明它们具体约束或供给哪些既有中心，但不得用标签堆砌代替生产方式、资源成本、治理职责和行为边界。\n`;
  }
  if (params.taskKey === "timeline") {
    const architecture = await novelDb.architectures.where("projectId").equals(params.projectId).first();
    const phases = [...(architecture?.phases ?? [])].sort((left, right) => left.order - right.order);
    const phaseLines = phases.length
      ? phases.map((phase) => `- ${phase.title}：${phase.purpose}；不可逆转折=${phase.turningPoint}`).join("\n")
      : "- 暂无已接受阶段";
    sectionContextBlock += `\n# 长篇时间线合同\n- 当前体量至少返回 ${timelineSystemCapacity(project.targetWords)} 个骨干事件，分布到故事前、中、后部；不能把时间线等同于开篇事件清单。\n- 已接受架构阶段如下：\n${phaseLines}\n- 每个事件提供唯一 tempId。除真正的起点外，事件须通过 causeIds 或前序事件的 consequenceIds 使用 ref:tempId 接入同批因果图；允许并行事件，但不能留下彼此孤立的事件岛。\n- storyDate 与 duration 要让旅行、调查、组织决策、关系变化和余波拥有可信时间，不得让跨地域制度变化在数日内完成。\n- participantIds 只引用真实角色；地点使用 locationId，组织、规则和资源写入 description。\n`;
  }
  if (params.taskKey === "plot-threads") {
    sectionContextBlock += `\n# 剧情线与规划关联\n- 每条剧情线的 startNodeId 和 targetNodeId 应引用"可引用对象索引"中的剧情段真实 ID。\n- startNodeId 标记剧情线起始剧情段，targetNodeId 标记剧情线目标达成剧情段。\n- 如剧情线贯穿全卷，可只填 startNodeId，targetNodeId 留空。\n`;
  }
  if (params.taskKey === "foreshadowing") {
    sectionContextBlock += `\n# 伏笔与规划关联\n- 每条伏笔的 seededNodeId 应引用"可引用对象索引"中埋设伏笔的剧情段真实 ID。\n- targetNodeId 应引用伏笔回收的剧情段真实 ID。\n- 如回收剧情段尚未规划，targetNodeId 可留空。\n`;
  }

  const agent: AgentRun = { ...recordBase(params.projectId), goal: effectiveInstruction, status: "running", model: project.settings.textModel, promptVersion: "novel-structured-v4", contextPacketId: packet.id, role: task.role, skillRefs: skills.skills.map((item) => `${item.skillId}@${item.version}`), artifactRefs: [], attempt: 1, startedAt: Date.now(), steps: [{ id: crypto.randomUUID(), title: task.label, tool: "model.structured", status: "running" }] };
  await novelDb.agentRuns.add(agent);
  try {
    const skillPrompt = compileNovelStagePrompt(skills.skills, task.skillStage);
    const minItems = MIN_PROPOSAL_ITEMS[params.taskKey] ?? 0;
    // 生成兜底重试：LLM 容易在长 prompt 中忽略埋在末尾的"至少 N 项"约束或架构结构化字段。
    // 若首次返回不满足约束（数量不足 / 架构 growthCurves 结构不符），以更强的提示重试（最多 MIN_ITEM_RETRY_MAX 次）。
    // 统一通过 getGenerationRetryReason 检测重试原因——涵盖多项任务数量兜底 + 架构第二增长曲线结构校验。
    let result: Awaited<ReturnType<typeof callStructuredNovelModel<Record<string, unknown>>>> | undefined;
    let items: ReturnType<typeof parseProposalItems> | undefined;
    for (let countAttempt = 0; ; countAttempt += 1) {
      const retryReason = items ? getGenerationRetryReason(params.taskKey, items, minItems, project.targetWords) : null;
      const currentInstruction = countAttempt === 0
        ? effectiveInstruction
        : `${effectiveInstruction}\n\n【重要 - 需要修正】${retryReason!.message}`;
      const basePrompt = `# 任务\n${currentInstruction}\n${params.targetId ? `\n# 当前目标 ID\n${params.targetId}\n` : ""}${sectionContextBlock}\n# 允许生成的资料表\n${task.allowedTables.join("、")}\n\n${payloadContract}\n\n# 现有对象索引\n${inventory}\n\n# 可引用对象索引\n${availableReferences}\n\n# 已采纳引用别名\n${referenceAliases}\n\n# 输出要求\n本次生成的候选项由系统统一标记为待审核状态，你无需在内容里自行声明。payload 各字段（title、summary、description、rationale 等）只写故事内容本身，禁止出现“候选”“待审核”“待确认”“未批准”“仅供参考”等审批元信息，这些状态由系统管理。创建的对象如需互相引用，为每个对象提供 tempId，并使用 ref:tempId 引用。引用现有角色、剧情线和伏笔时，只能复制“可引用对象索引”中的真实 ID，不得把名称、英文别名或规则名当成 ID；没有可用对象时对应数组必须为空。也可使用上方已明确列出的 ref:别名；不得自行发明 ref: 标识。更新必须使用现有对象索引中的真实 targetId。\n\n# 冻结上下文\n${formatContextPacket(packet)}`;
      result = await callStructuredNovelModel<Record<string, unknown>>({
        model: project.settings.textModel,
        temperature: task.role === "writer" ? project.settings.temperature : 0.55,
        role: task.role,
        skillPrompt,
        schema: proposalSchema(task.allowedTables, params.requiredPayloadFields, architectureSystemCapacity(project.targetWords)),
        prompt: basePrompt,
        signal: params.signal,
        // Loop 7 修复 #11：角色生成需输出 5 个角色完整字段（appearance/personality/desire/motivation/weakness/secret/abilities/voice/arc/state），180s 默认超时不足
        timeoutMs: params.taskKey === "characters" ? 300_000 : undefined,
        // Loop 20 修复：Layer 10 把 romanceProgress/techGeneration/originTruthLayer 提升为 schema required 后，
        // 每个 phase 的 token 成本显著上升（含 stages + 3 个结构化字段对象）。默认 maxTokens=8192 下 LLM
        // 为产出完整合法 JSON 会自我截断 phases 数组长度（iter21 退化到 1 phase）。
        // 通用规则：schema required 越多 → 单项 token 成本越高 → 固定预算下可容纳 item 数越少；
        // 需让 maxTokens 随结构丰富度缩放。architecture 是最复杂的结构化生成任务，提升到 16384。
        // TODO P2：可按 architectureSystemCapacity(project.targetWords) 动态计算 maxTokens，而非硬编码。
        maxTokens: params.taskKey === "architecture" ? 16384 : undefined,
      });
      items = parseProposalItems(result.data);
      const nextRetryReason = getGenerationRetryReason(params.taskKey, items, minItems, project.targetWords);
      if (!nextRetryReason || countAttempt >= MIN_ITEM_RETRY_MAX) break;
      agent.steps[0].output = `attempt ${countAttempt + 1}: ${nextRetryReason.message.slice(0, 100)}，将重试`;
    }
    // 循环至少执行一次，result 和 items 必定已赋值
    if (!result || !items) throw new Error("生成循环未产出结果（不可达）");
    const finalRetryReason = getGenerationRetryReason(params.taskKey, items, minItems, project.targetWords);
    if (finalRetryReason) throw new Error(`生成结果连续 ${MIN_ITEM_RETRY_MAX + 1} 次未满足结构约束：${finalRetryReason.message}`);
    if (params.taskKey === "chapter-draft") {
      for (const item of items) {
        if (item.targetTable !== "documents" || typeof item.payload.plainText !== "string") continue;
        const repaired = await repairDraftStructureOnce({ content: item.payload.plainText, model: project.settings.textModel, skillPrompt });
        item.payload = { ...item.payload, plainText: repaired.content };
        item.after = { ...item.after, plainText: repaired.content };
      }
    }
    if (["project-positioning", "architecture", "chapter-plan", "chapter-draft"].includes(params.taskKey)) items.splice(1);
    if (params.taskKey === "project-positioning") for (const item of items) { item.operation = "update"; item.targetId = project.id; item.targetTable = "projects"; }
    if (params.taskKey === "architecture") {
      const architecture = await novelDb.architectures.where("projectId").equals(params.projectId).first();
      for (const item of items) { item.operation = architecture ? "update" : "create"; item.targetId = architecture?.id; item.targetTable = "architectures"; }
    }
    if (params.taskKey === "scene-design" && params.targetId) for (const item of items) item.payload = { ...item.payload, chapterId: params.targetId };
    if (params.taskKey === "chapter-plan" && params.targetId) {
      const target = await novelDb.documents.get(params.targetId);
      if (!target) throw new Error("章节规划目标不存在");
      for (const item of items) {
        const blueprint = item.payload.blueprint && typeof item.payload.blueprint === "object" && !Array.isArray(item.payload.blueprint)
          ? item.payload.blueprint as Record<string, unknown>
          : {};
        item.operation = "update";
        item.targetTable = "documents";
        item.targetId = params.targetId;
        item.payload = {
          ...item.payload,
          order: target.order,
          plotSegmentId: target.plotSegmentId,
          status: target.status,
          blueprint: { ...blueprint, targetWords: DEFAULT_CHAPTER_TARGET_WORDS },
        };
        item.after = structuredClone(item.payload);
      }
    }
    if (params.taskKey === "chapter-draft" && params.targetId) for (const item of items) { item.operation = "update"; item.targetTable = "documents"; item.targetId = params.targetId; }
    if (params.taskKey === "review") {
      const documents = await novelDb.documents.where("projectId").equals(params.projectId).sortBy("order");
      if (!documents.length) throw new Error("请先建立至少一个章节，再执行审校");
      for (const [index, item] of items.entries()) {
        const target = item.targetId ? documents.find((document) => document.id === item.targetId) : documents[index % documents.length];
        item.operation = "update";
        item.targetTable = "documents";
        item.targetId = target?.id ?? documents[0].id;
      }
    }
    if (!items.length) throw new Error("AI 没有返回可审核的候选项");
    if (params.taskKey === "story-control") await assertStoryControlPreservesSources(items);
    {
      const [catalog, nameMap, entityNameMap] = await Promise.all([
        projectReferenceCatalog(params.projectId),
        projectCharacterNameToIdMap(params.projectId),
        projectEntityNameToIdMap(params.projectId),
      ]);
      repairProposalCharacterReferences(items, catalog, nameMap);
      repairTimelineAndOutlineNodeReferences(items, catalog);
      repairUnresolvableTempRefs(items, acceptedRefs, entityNameMap);
      for (const item of items) {
        if (item.operation === "create" && item.after) item.payload = structuredClone(item.after);
      }
      assertProposalReferences(items, catalog, acceptedRefs);
    }
    await attachExpectedRevisions(items);
    const summary = String(result.data.summary || task.defaultInstruction);
    const proposal: AIProposal = {
      ...recordBase(params.projectId),
      title: task.label,
      operation: `structured:${params.taskKey}`,
      taskKey: params.taskKey,
      scope: task.scope,
      targetId: params.targetId,
      status: "pending",
      previewMarkdown: proposalMarkdown(task.label, summary, items),
      patches: [],
      items,
      contextPacketId: packet.id,
      agentRunId: agent.id,
      model: project.settings.textModel,
    };
    agent.status = "completed";
    agent.finishedAt = Date.now();
    agent.promptHash = result.promptHash;
    agent.usage = result.usage;
    agent.steps[0].status = "completed";
    agent.steps[0].output = `${items.length} 个候选项`;
    await novelDb.transaction("rw", novelDb.proposals, novelDb.agentRuns, async () => {
      await novelDb.proposals.add(proposal);
      await novelDb.agentRuns.put({ ...agent, revision: agent.revision + 1, updatedAt: Date.now() });
    });
    return { proposal, packet, agent };
  } catch (error) {
    agent.status = "failed";
    agent.finishedAt = Date.now();
    agent.steps[0].status = "failed";
    agent.steps[0].error = error instanceof Error ? error.message : "生成失败";
    await novelDb.agentRuns.put({ ...agent, revision: agent.revision + 1, updatedAt: Date.now() });
    throw error;
  }
}

async function analyzeDeleteImpact(projectId: string, table: ProposalTargetTable, targetId: string) {
  const impact: string[] = [];
  if (table === "outlineNodes") {
    const chapters = await novelDb.documents.where("projectId").equals(projectId).filter((document) => document.plotSegmentId === targetId).count();
    if (chapters) impact.push(`将 ${chapters} 个章节移入待整理章节`);
  }
  if (table === "documents") {
    const [scenes, revisions, workflows] = await Promise.all([
      novelDb.scenes.where("chapterId").equals(targetId).count(),
      novelDb.revisions.where("documentId").equals(targetId).count(),
      novelDb.workflowRuns.where("targetDocumentId").equals(targetId).count(),
    ]);
    if (scenes) impact.push(`同时删除 ${scenes} 个场景`);
    if (revisions) impact.push(`同时删除 ${revisions} 个正文版本`);
    if (workflows) impact.push(`同时清理 ${workflows} 个章节流程`);
  }
  if (table === "entities") {
    const [relations, documents, scenes, threads, timeline] = await Promise.all([
      novelDb.relations.where("projectId").equals(projectId).filter((item) => item.fromEntityId === targetId || item.toEntityId === targetId).count(),
      novelDb.documents.where("projectId").equals(projectId).filter((item) => item.blueprint.characterIds.includes(targetId) || item.blueprint.locationIds.includes(targetId) || item.blueprint.povCharacterId === targetId).count(),
      novelDb.scenes.where("projectId").equals(projectId).filter((item) => item.characterIds.includes(targetId) || item.povCharacterId === targetId || item.locationId === targetId).count(),
      novelDb.plotThreads.where("projectId").equals(projectId).filter((item) => item.participantIds.includes(targetId)).count(),
      novelDb.timelineEvents.where("projectId").equals(projectId).filter((item) => item.participantIds.includes(targetId) || item.locationId === targetId).count(),
    ]);
    if (relations) impact.push(`同时删除 ${relations} 条关联关系`);
    const references = documents + scenes + threads + timeline;
    if (references) impact.push(`解除 ${references} 处结构化引用`);
  }
  if (table === "plotThreads") {
    const [documents, scenes] = await Promise.all([
      novelDb.documents.where("projectId").equals(projectId).filter((item) => item.blueprint.plotThreadIds.includes(targetId)).count(),
      novelDb.scenes.where("projectId").equals(projectId).filter((item) => item.plotThreadIds?.includes(targetId) ?? false).count(),
    ]);
    if (documents + scenes) impact.push(`解除 ${documents + scenes} 处剧情线引用`);
  }
  if (table === "foreshadowing") {
    const [documents, scenes] = await Promise.all([
      novelDb.documents.where("projectId").equals(projectId).filter((item) => item.blueprint.foreshadowingIds.includes(targetId)).count(),
      novelDb.scenes.where("projectId").equals(projectId).filter((item) => item.foreshadowingIds?.includes(targetId) ?? false).count(),
    ]);
    if (documents + scenes) impact.push(`解除 ${documents + scenes} 处伏笔引用`);
  }
  if (table === "timelineEvents") {
    const references = await novelDb.timelineEvents.where("projectId").equals(projectId).filter((item) => item.causeIds.includes(targetId) || item.consequenceIds.includes(targetId)).count();
    if (references) impact.push(`解除 ${references} 处时间因果引用`);
  }
  return impact;
}

function assertLockedArchitecturePreserved(before: Record<string, unknown>, after: Record<string, unknown>) {
  const locked = Array.isArray(before.phases) ? before.phases.filter((phase) => Boolean((phase as Record<string, unknown>).locked)) as Array<Record<string, unknown>> : [];
  const afterPhases = Array.isArray(after.phases) ? after.phases as Array<Record<string, unknown>> : [];
  for (const phase of locked) {
    const next = afterPhases.find((candidate) => candidate.id === phase.id);
    if (!next || JSON.stringify(stableValue(next)) !== JSON.stringify(stableValue(phase))) throw new Error(`锁定阶段“${String(phase.title || phase.id)}”不能被微调`);
  }
}

export async function runRefinementTask(params: {
  projectId: string;
  taskKey: NovelGenerationTaskKey;
  instruction: string;
  targetId?: string;
  sourceOverrides?: RefinementSnapshotInput;
}) {
  const instruction = params.instruction.trim();
  if (!instruction) throw new Error("请输入具体的微调要求");
  const task = getGenerationTask(params.taskKey);
  if (!task.refinable) throw new Error("当前任务不支持结构化微调");
  const project = await novelDb.projects.get(params.projectId);
  if (!project) throw new Error("项目不存在");
  const snapshot = await buildRefinementSnapshot(params);
  const sourceJson = JSON.stringify(snapshot, null, 2);
  if (!Object.keys(snapshot).length) throw new Error("当前板块还没有可微调的原数据");
  const sourceFingerprint = await fingerprintRefinementSnapshot(snapshot);
  const skills = await resolveNovelSkills({ projectId: params.projectId, stage: task.skillStage });
  if (skills.conflicts.length) throw new Error(`Skill 冲突：${skills.conflicts.map((item) => `${item.skillId} ↔ ${item.conflictsWith}`).join("；")}`);
  const packet = await compileNovelContext({ projectId: params.projectId, task: params.taskKey, instruction, targetDocumentId: params.targetId, stage: task.skillStage, resolvedSkills: skills.skills });
  const availableReferences = await referenceInventory(params.projectId);
  const acceptedRefs = await acceptedProjectReferences(params.projectId);
  const agent: AgentRun = { ...recordBase(params.projectId), goal: instruction, status: "running", model: project.settings.textModel, promptVersion: "novel-refinement-v1", contextPacketId: packet.id, role: task.role, skillRefs: skills.skills.map((item) => `${item.skillId}@${item.version}`), artifactRefs: [], attempt: 1, startedAt: Date.now(), steps: [{ id: crypto.randomUUID(), title: `微调：${task.label}`, tool: "model.structured", status: "running" }] };
  await novelDb.agentRuns.add(agent);
  try {
    const result = await callStructuredNovelModel<Record<string, unknown>>({
      model: project.settings.textModel,
      temperature: 0.35,
      role: task.role,
      skillPrompt: compileNovelStagePrompt(skills.skills, task.skillStage),
      schema: refinementProposalSchema(task.allowedTables),
      // Loop 7 修复 #11：角色微调也可能涉及多角色完整字段重写
      timeoutMs: params.taskKey === "characters" ? 300_000 : undefined,
      prompt: `# 微调任务\n${instruction}\n\n# 原始结构化数据\n${sourceJson}\n\n${payloadContract}\n\n# 可引用对象索引\n${availableReferences}\n\n# 输出要求\n只返回提示词实际要求发生变化的候选项，未提及的数据必须保持不变。update 和 delete 只能使用原始数据中存在的真实 targetId；create 必须提供 tempId。update 的 payload 只放需要变化的字段，系统会与原数据合并。角色、剧情线和伏笔引用只能使用索引中的真实 ID 或同一候选中的有效 ref:tempId，不得自行发明。delete 不要输出 payload。不得删除 projects 或 architectures。用户本次微调指令授权提出候选变更，但锁定内容仍不可更改。审批状态由系统统一管理，payload 各字段只写故事内容本身，禁止出现“候选”“待审核”“待确认”“未批准”“仅供参考”等元信息。\n\n# 冻结上下文\n${formatContextPacket(packet)}`,
    });
    const rawItems = Array.isArray(result.data.items) ? result.data.items as Array<Record<string, unknown>> : [];
    const seenTargets = new Set<string>();
    const items: ProposalItem[] = [];
    for (const raw of rawItems) {
      const targetTable = raw.targetTable as ProposalTargetTable;
      if (!task.allowedTables.includes(targetTable)) throw new Error(`AI 返回了不允许修改的资料表：${String(raw.targetTable)}`);
      const operation = raw.operation === "delete" ? "delete" : raw.operation === "update" ? "update" : "create";
      const targetId = typeof raw.targetId === "string" ? raw.targetId : undefined;
      const sourceRecord = targetId ? snapshot[targetTable]?.find((record) => record.id === targetId) : undefined;
      if ((operation === "update" || operation === "delete") && !sourceRecord) throw new Error(`AI 尝试修改未提供的对象：${targetTable}/${targetId || "未指定"}`);
      if (operation === "delete" && (targetTable === "projects" || targetTable === "architectures")) throw new Error("项目定位和全书架构不能由微调整体删除");
      if (targetId && operation !== "create") {
        const key = `${targetTable}:${targetId}`;
        if (seenTargets.has(key)) throw new Error(`AI 对同一对象返回了多项冲突操作：${key}`);
        seenTargets.add(key);
      }
      const payload = operation === "delete" ? {} : sanitizeModelPayload(targetTable, (raw.payload ?? {}) as Record<string, unknown>);
      const after = operation === "update" && sourceRecord ? deepMergeRecord(sourceRecord.data, payload) : operation === "create" ? payload : undefined;
      if (after) {
        const validate = CREATE_PAYLOAD_VALIDATORS[targetTable];
        if (!validate(after)) throw new Error(`“${String(raw.label || "未命名候选")}”字段无效：${validate.errors?.map((error) => `${error.instancePath || "root"} ${error.message}`).join("；")}`);
        if (targetTable === "architectures" && sourceRecord) assertLockedArchitecturePreserved(sourceRecord.data, after);
        if (operation === "update" && sourceRecord && JSON.stringify(stableValue(after)) === JSON.stringify(stableValue(sourceRecord.data))) continue;
      }
      items.push({
        id: crypto.randomUUID(),
        label: String(raw.label || "未命名候选"),
        operation,
        targetTable,
        targetId,
        tempId: operation === "create" ? String(raw.tempId || `refine_${crypto.randomUUID()}`) : undefined,
        expectedRevision: sourceRecord?.revision,
        before: sourceRecord?.data,
        status: "pending",
        payload: after ?? {},
        after,
        rationale: String(raw.rationale || "按微调要求调整"),
        dependencies: Array.isArray(raw.dependencies) ? raw.dependencies.map(String) : [],
        impact: operation === "delete" && targetId ? await analyzeDeleteImpact(params.projectId, targetTable, targetId) : undefined,
      });
    }
    if (!items.length) throw new Error("AI 返回的微调结果没有产生实际变化，请换一种更明确的描述后重试");
    {
      const [catalog, nameMap, entityNameMap] = await Promise.all([
        projectReferenceCatalog(params.projectId),
        projectCharacterNameToIdMap(params.projectId),
        projectEntityNameToIdMap(params.projectId),
      ]);
      repairProposalCharacterReferences(items, catalog, nameMap);
      repairTimelineAndOutlineNodeReferences(items, catalog);
      repairUnresolvableTempRefs(items, acceptedRefs, entityNameMap);
      assertProposalReferences(items, catalog, acceptedRefs);
    }
    const summary = String(result.data.summary || instruction);
    const proposal: AIProposal = {
      ...recordBase(params.projectId),
      title: `微调：${task.label}`,
      operation: `structured-refine:${params.taskKey}`,
      taskKey: params.taskKey,
      scope: task.scope,
      targetId: params.targetId,
      status: "pending",
      previewMarkdown: proposalMarkdown(`微调：${task.label}`, summary, items),
      patches: [],
      items,
      contextPacketId: packet.id,
      agentRunId: agent.id,
      model: project.settings.textModel,
      generationMode: "refine",
      sourceFingerprint,
    };
    agent.status = "completed";
    agent.finishedAt = Date.now();
    agent.promptHash = result.promptHash;
    agent.usage = result.usage;
    agent.steps[0].status = "completed";
    agent.steps[0].output = `${items.length} 个微调候选项`;
    await novelDb.transaction("rw", novelDb.proposals, novelDb.agentRuns, async () => {
      await novelDb.proposals.add(proposal);
      await novelDb.agentRuns.put({ ...agent, revision: agent.revision + 1, updatedAt: Date.now() });
    });
    return { proposal, packet, agent, snapshot };
  } catch (error) {
    agent.status = "failed";
    agent.finishedAt = Date.now();
    agent.steps[0].status = "failed";
    agent.steps[0].error = error instanceof Error ? error.message : "微调失败";
    await novelDb.agentRuns.put({ ...agent, revision: agent.revision + 1, updatedAt: Date.now() });
    throw error;
  }
}

function resolveReferences(value: unknown, refs: Map<string, string>): unknown {
  if (typeof value === "string" && value.startsWith("ref:")) {
    const resolved = refs.get(value.slice(4));
    if (!resolved) throw new Error(`候选项引用了未选择或不存在的临时对象：${value}`);
    return resolved;
  }
  if (Array.isArray(value)) return value.map((item) => resolveReferences(item, refs));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveReferences(item, refs)]));
  return value;
}

async function acceptedProjectReferences(projectId: string) {
  const refs = new Map<string, string>();
  const proposals = await novelDb.proposals.where("projectId").equals(projectId).toArray();
  const acceptedItems = proposals.flatMap((proposal) => proposal.items.filter((item) => item.status === "accepted" && item.tempId));
  for (const item of acceptedItems) {
    if (item.targetId) {
      refs.set(item.tempId!, item.targetId);
      continue;
    }
    const payload = (item.after ?? item.payload) as Record<string, unknown>;
    const identity = String(payload.name ?? payload.title ?? "").trim();
    if (!identity) continue;
    const matches = await novelDb.table(item.targetTable).where("projectId").equals(projectId).filter((record: Record<string, unknown>) => record.name === identity || record.title === identity).primaryKeys();
    if (matches.length === 1) refs.set(item.tempId!, String(matches[0]));
  }
  return refs;
}

function sanitizePayload(payload: Record<string, unknown>) {
  const protectedFields = new Set(["id", "projectId", "schemaVersion", "revision", "createdAt", "updatedAt", "createdBy", "updatedBy", "deletedAt"]);
  return Object.fromEntries(Object.entries(payload).filter(([key]) => !protectedFields.has(key)));
}

function sanitizeModelPayload(table: ProposalTargetTable, payload: Record<string, unknown>) {
  const sanitized = sanitizePayload(payload);
  // 剥离 LLM 在内容字段里添加的"候选/待审核"等审批元信息（状态应由系统管理）
  sanitizeApprovalMetaInPlace(sanitized);
  if (table === "architectures") return normalizeArchitecturePayload(sanitized);
  if (table === "outlineNodes") {
    for (const retiredField of ["parentId", "kind", "status", "storyTime", "tags", "characterIds", "plotThreadIds", "foreshadowingIds"]) delete sanitized[retiredField];
    return sanitized;
  }
  if (table !== "documents" || !sanitized.blueprint || typeof sanitized.blueprint !== "object" || Array.isArray(sanitized.blueprint)) return sanitized;
  const blueprint = { ...sanitized.blueprint as Record<string, unknown> };
  delete blueprint.targetWords;
  return { ...sanitized, blueprint };
}

function textToHtml(text: string) {
  const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return text.split(/\n{2,}/).map((paragraph) => `<p>${escape(paragraph).replace(/\n/g, "<br>")}</p>`).join("");
}

function normalizeDocumentPayload(payload: Record<string, unknown>) {
  if (typeof payload.plainText !== "string") return payload;
  const wordCount = (payload.plainText.match(/[\u3400-\u9fff]|[a-zA-Z0-9]+/g) ?? []).length;
  return { ...payload, contentHtml: textToHtml(payload.plainText), wordCount, status: payload.status ?? "draft" };
}

export function normalizedCreate(table: ProposalTargetTable, projectId: string, id: string, payload: Record<string, unknown>) {
  const base = { ...recordBase(projectId), id };
  if (table === "architectures") return normalizeArchitecturePayload({ ...base, framework: "free", status: "draft", centralQuestion: "", centralConflict: "", synopsis: "", phases: [], ...payload });
  if (table === "outlineNodes") {
    return { ...base, phaseId: "", title: "未命名剧情段", summary: "", order: 0, ...payload };
  }
  if (table === "documents") {
    const { blueprint, ...rest } = payload;
    return { ...base, order: 0, title: "未命名章节", contentHtml: "", plainText: "", summary: "", status: "outline", wordCount: 0, branch: "main", yjsDocumentId: crypto.randomUUID(), ...rest, blueprint: { ...emptyChapterBlueprint(), ...(blueprint as Record<string, unknown> | undefined) } };
  }
  if (table === "scenes") return { ...base, chapterId: "", title: "未命名场景", order: 0, status: "idea", characterIds: [], plotThreadIds: [], foreshadowingIds: [], purpose: "", conflict: "", outcome: "", wordTarget: 800, beats: [], ...payload };
  if (table === "entities") {
    const characterDefaults = { role: "", appearance: "", personality: "", desire: "", motivation: "", weakness: "", secret: "", abilities: [], voice: "", arc: "", state: { location: "", physical: "", emotional: "", objective: "", inventory: [], relationshipNotes: [] } };
    const record = { ...base, kind: "term", name: "未命名资料", aliases: [], summary: "", description: "", tags: [], lockedFacts: [], attributes: {}, ...payload } as Record<string, unknown>;
    if (record.kind === "character") {
      const character = (payload.character ?? {}) as Record<string, unknown>;
      record.character = { ...characterDefaults, ...character, state: { ...characterDefaults.state, ...(character.state as Record<string, unknown> | undefined) } };
    }
    return record;
  }
  if (table === "relations") return { ...base, fromEntityId: "", toEntityId: "", relationType: "关联", publicLabel: "", privateTruth: "", bond: "", ...payload };
  if (table === "plotThreads") return { ...base, kind: "subplot", title: "未命名剧情线", summary: "", status: "planned", priority: 50, participantIds: [], progress: 0, nextMove: "", ...payload };
  if (table === "foreshadowing") return { ...base, title: "未命名伏笔", clue: "", truth: "", status: "seeded", urgency: 30, notes: "", ...payload };
  if (table === "timelineEvents") return { ...base, title: "未命名事件", storyDate: "", duration: "", narrativeOrder: 0, participantIds: [], causeIds: [], consequenceIds: [], description: "", ...payload };
  return { ...base, ...payload };
}

function embeddingText(table: ProposalTargetTable, record: Record<string, unknown>) {
  if (!(["entities", "outlineNodes", "documents", "scenes", "plotThreads", "foreshadowing"] as string[]).includes(table)) return "";
  return [record.title, record.name, record.summary, record.description, record.plainText, record.causality, record.outcome, record.clue, record.truth, record.nextMove].filter(Boolean).join("\n");
}

export async function updateProposalItemPayload(proposalId: string, itemId: string, payload: Record<string, unknown>) {
  const proposal = await novelDb.proposals.get(proposalId);
  if (!proposal || proposal.status !== "pending") throw new Error("提案已不可编辑");
  proposal.items = proposal.items.map((item) => item.id === itemId ? { ...item, payload, after: payload } : item);
  await novelDb.proposals.put({ ...proposal, auditReport: undefined, revision: proposal.revision + 1, updatedAt: Date.now() });
}

export async function rejectProposal(proposalId: string) {
  const proposal = await novelDb.proposals.get(proposalId);
  if (!proposal || proposal.status !== "pending") return proposal;
  const next = { ...proposal, status: "rejected" as const, items: proposal.items.map((item) => ({ ...item, status: "rejected" as const })), revision: proposal.revision + 1, updatedAt: Date.now() };
  await novelDb.proposals.put(next);
  return next;
}

export async function regenerateProposalItem(proposalId: string, itemId: string, instruction: string, sourceOverrides?: RefinementSnapshotInput) {
  const proposal = await novelDb.proposals.get(proposalId);
  const current = proposal?.items.find((item) => item.id === itemId);
  if (!proposal?.taskKey || !current || proposal.status !== "pending") throw new Error("候选项已不可重新生成");
  const replacementInstruction = `${instruction}\n\n只返回 1 个候选项，用于替换“${current.label}”。目标表必须是 ${current.targetTable}，操作类型保持 ${current.operation}。`;
  const result = proposal.generationMode === "refine"
    ? await runRefinementTask({ projectId: proposal.projectId, taskKey: proposal.taskKey, targetId: proposal.targetId, instruction: replacementInstruction, sourceOverrides })
    : await runGenerationTask({ projectId: proposal.projectId, taskKey: proposal.taskKey, targetId: proposal.targetId, instruction: replacementInstruction });
  const replacement = result.proposal.items[0];
  if (!replacement) throw new Error("AI 没有返回替换候选项");
  const lockedReplacement: ProposalItem = { ...replacement, id: current.id, operation: current.operation, targetTable: current.targetTable, targetId: current.targetId, tempId: current.tempId, dependencies: current.dependencies };
  if (proposal.generationMode !== "refine") await attachExpectedRevisions([lockedReplacement]);
  let updatedItem: ProposalItem | undefined;
  await novelDb.transaction("rw", novelDb.proposals, async () => {
    const latest = await novelDb.proposals.get(proposalId);
    await novelDb.proposals.delete(result.proposal.id);
    if (!latest || latest.status !== "pending" || latest.revision !== proposal.revision || !latest.items.some((item) => item.id === itemId)) return;
    const items = latest.items.map((item) => item.id === itemId ? lockedReplacement : item);
    await novelDb.proposals.put({ ...latest, items, sourceFingerprint: result.proposal.sourceFingerprint ?? latest.sourceFingerprint, previewMarkdown: proposalMarkdown(latest.title, "已重新生成指定候选项。", items), revision: latest.revision + 1, updatedAt: Date.now() });
    updatedItem = lockedReplacement;
  });
  if (!updatedItem) throw new Error("提案在重新生成期间已被其他操作处理");
  return updatedItem;
}

function withoutId(values: string[] | undefined, id: string) {
  return (values ?? []).filter((value) => value !== id);
}

async function putCascadeUpdate(tableName: ProposalTargetTable, projectId: string, record: Record<string, unknown>, changes: Record<string, unknown>) {
  const table = novelDb.table(tableName) as Table<Record<string, unknown>, string>;
  const next = { ...record, ...changes, revision: Number(record.revision ?? 0) + 1, updatedAt: Date.now(), updatedBy: "local-user" };
  await table.put(next);
  await appendOperation(projectId, tableName, String(record.id), "update", { value: { before: record, after: next } });
}

async function applyDeleteCandidate(params: {
  proposalId: string;
  projectId: string;
  item: ProposalItem;
  collaborativeDeletes: Array<{ projectId: string; documentId: string }>;
}) {
  const { item, projectId } = params;
  if (!item.targetId || item.targetTable === "projects" || item.targetTable === "architectures") throw new Error(`“${item.label}”不是可删除的结构化条目`);
  const targetId = item.targetId;
  const table = novelDb.table(item.targetTable) as Table<Record<string, unknown>, string>;
  const before = await table.get(targetId);
  if (!before) return;

  if (item.targetTable === "outlineNodes") {
    const removed = new Set([targetId]);
    const documents = await novelDb.documents.where("projectId").equals(projectId).filter((document) => document.plotSegmentId === targetId).toArray();
    for (const document of documents) await putCascadeUpdate("documents", projectId, document as unknown as Record<string, unknown>, { plotSegmentId: undefined });
    await novelDb.outlineNodes.delete(targetId);
    await novelDb.outlineRealizations.where("projectId").equals(projectId).filter((realization) => realization.outlineNodeId === targetId).delete();
    await novelDb.embeddings.where("targetId").equals(targetId).delete();
    const threads = await novelDb.plotThreads.where("projectId").equals(projectId).toArray();
    for (const thread of threads) {
      const changes: Record<string, unknown> = {};
      if (thread.startNodeId && removed.has(thread.startNodeId)) changes.startNodeId = undefined;
      if (thread.targetNodeId && removed.has(thread.targetNodeId)) changes.targetNodeId = undefined;
      if (Object.keys(changes).length) await putCascadeUpdate("plotThreads", projectId, thread as unknown as Record<string, unknown>, changes);
    }
    const clues = await novelDb.foreshadowing.where("projectId").equals(projectId).toArray();
    for (const clue of clues) {
      const changes: Record<string, unknown> = {};
      if (clue.seededNodeId && removed.has(clue.seededNodeId)) changes.seededNodeId = undefined;
      if (clue.targetNodeId && removed.has(clue.targetNodeId)) changes.targetNodeId = undefined;
      if (Object.keys(changes).length) await putCascadeUpdate("foreshadowing", projectId, clue as unknown as Record<string, unknown>, changes);
    }
  } else if (item.targetTable === "documents") {
    const document = before;
    const runs = await novelDb.workflowRuns.where("targetDocumentId").equals(targetId).toArray();
    const runIds = runs.map((run) => run.id);
    const proposalIds = (await novelDb.proposals.where("targetId").equals(targetId).primaryKeys() as string[]).filter((id) => id !== params.proposalId);
    const sceneIds = await novelDb.scenes.where("chapterId").equals(targetId).primaryKeys() as string[];
    const revisionIds = await novelDb.revisions.where("documentId").equals(targetId).primaryKeys() as string[];
    const workflowAgentIds = runIds.length ? await novelDb.agentRuns.where("projectId").equals(projectId).filter((run) => Boolean(run.workflowRunId && runIds.includes(run.workflowRunId))).primaryKeys() as string[] : [];
    const contextIds = runs.map((run) => run.contextPacketId).filter((id): id is string => Boolean(id));
    await retireChapterDependencies(projectId, targetId, revisionIds);
    await novelDb.documents.delete(targetId);
    await novelDb.scenes.where("chapterId").equals(targetId).delete();
    await novelDb.revisions.where("documentId").equals(targetId).delete();
    await novelDb.manuscriptChanges.where("documentId").equals(targetId).delete();
    if (runIds.length) {
      await novelDb.workflowArtifacts.where("workflowRunId").anyOf(runIds).delete();
      await novelDb.qualityReports.where("workflowRunId").anyOf(runIds).delete();
      await novelDb.factCandidates.where("workflowRunId").anyOf(runIds).delete();
      await novelDb.workflowRuns.bulkDelete(runIds);
    }
    if (proposalIds.length) await novelDb.proposals.bulkDelete(proposalIds);
    if (workflowAgentIds.length) await novelDb.agentRuns.bulkDelete(workflowAgentIds);
    if (contextIds.length) await novelDb.contextPackets.bulkDelete(contextIds);
    await novelDb.embeddings.where("targetId").anyOf([targetId, ...sceneIds]).delete();
    if (typeof document.yjsDocumentId === "string") params.collaborativeDeletes.push({ projectId, documentId: document.yjsDocumentId });
  } else if (item.targetTable === "entities") {
    const relations = await novelDb.relations.where("projectId").equals(projectId).filter((relation) => relation.fromEntityId === targetId || relation.toEntityId === targetId).toArray();
    for (const relation of relations) {
      await novelDb.relations.delete(relation.id);
      await appendOperation(projectId, "relations", relation.id, "delete", { value: { before: relation, after: null } });
    }
    const scenes = await novelDb.scenes.where("projectId").equals(projectId).filter((scene) => scene.characterIds.includes(targetId) || scene.povCharacterId === targetId || scene.locationId === targetId).toArray();
    for (const scene of scenes) await putCascadeUpdate("scenes", projectId, scene as unknown as Record<string, unknown>, { characterIds: withoutId(scene.characterIds, targetId), ...(scene.povCharacterId === targetId ? { povCharacterId: undefined } : {}), ...(scene.locationId === targetId ? { locationId: undefined } : {}) });
    const documents = await novelDb.documents.where("projectId").equals(projectId).filter((document) => document.blueprint.characterIds.includes(targetId) || document.blueprint.locationIds.includes(targetId) || document.blueprint.povCharacterId === targetId).toArray();
    for (const document of documents) await putCascadeUpdate("documents", projectId, document as unknown as Record<string, unknown>, { blueprint: { ...document.blueprint, characterIds: withoutId(document.blueprint.characterIds, targetId), locationIds: withoutId(document.blueprint.locationIds, targetId), ...(document.blueprint.povCharacterId === targetId ? { povCharacterId: undefined } : {}) } });
    const threads = await novelDb.plotThreads.where("projectId").equals(projectId).filter((thread) => thread.participantIds.includes(targetId)).toArray();
    for (const thread of threads) await putCascadeUpdate("plotThreads", projectId, thread as unknown as Record<string, unknown>, { participantIds: withoutId(thread.participantIds, targetId) });
    const events = await novelDb.timelineEvents.where("projectId").equals(projectId).filter((event) => event.participantIds.includes(targetId) || event.locationId === targetId).toArray();
    for (const event of events) await putCascadeUpdate("timelineEvents", projectId, event as unknown as Record<string, unknown>, { participantIds: withoutId(event.participantIds, targetId), ...(event.locationId === targetId ? { locationId: undefined } : {}) });
  } else if (item.targetTable === "plotThreads") {
    const documents = await novelDb.documents.where("projectId").equals(projectId).filter((document) => document.blueprint.plotThreadIds.includes(targetId)).toArray();
    for (const document of documents) await putCascadeUpdate("documents", projectId, document as unknown as Record<string, unknown>, { blueprint: { ...document.blueprint, plotThreadIds: withoutId(document.blueprint.plotThreadIds, targetId) } });
    const scenes = await novelDb.scenes.where("projectId").equals(projectId).filter((scene) => scene.plotThreadIds?.includes(targetId) ?? false).toArray();
    for (const scene of scenes) await putCascadeUpdate("scenes", projectId, scene as unknown as Record<string, unknown>, { plotThreadIds: withoutId(scene.plotThreadIds, targetId) });
  } else if (item.targetTable === "foreshadowing") {
    const documents = await novelDb.documents.where("projectId").equals(projectId).filter((document) => document.blueprint.foreshadowingIds.includes(targetId)).toArray();
    for (const document of documents) await putCascadeUpdate("documents", projectId, document as unknown as Record<string, unknown>, { blueprint: { ...document.blueprint, foreshadowingIds: withoutId(document.blueprint.foreshadowingIds, targetId) } });
    const scenes = await novelDb.scenes.where("projectId").equals(projectId).filter((scene) => scene.foreshadowingIds?.includes(targetId) ?? false).toArray();
    for (const scene of scenes) await putCascadeUpdate("scenes", projectId, scene as unknown as Record<string, unknown>, { foreshadowingIds: withoutId(scene.foreshadowingIds, targetId) });
  } else if (item.targetTable === "timelineEvents") {
    const events = await novelDb.timelineEvents.where("projectId").equals(projectId).filter((event) => event.causeIds.includes(targetId) || event.consequenceIds.includes(targetId)).toArray();
    for (const event of events) await putCascadeUpdate("timelineEvents", projectId, event as unknown as Record<string, unknown>, { causeIds: withoutId(event.causeIds, targetId), consequenceIds: withoutId(event.consequenceIds, targetId) });
  }

  await table.delete(targetId);
  await novelDb.embeddings.where("targetId").equals(targetId).delete();
  await appendOperation(projectId, item.targetTable, targetId, "delete", { value: { before, after: null } });
}

export async function applyProposalItems(proposalId: string, selectedItemIds: string[], options?: { sourceFingerprint?: string; selectedFields?: Record<string, string[]> }) {
  const initialProposal = await novelDb.proposals.get(proposalId);
  if (!initialProposal || initialProposal.status !== "pending") throw new Error("提案不存在或已经处理");
  if (initialProposal.sourceFingerprint && options?.sourceFingerprint && initialProposal.sourceFingerprint !== options.sourceFingerprint) throw new Error("原数据已在微调后发生变化，请退回候选并重新微调");
  const initialSelected = initialProposal.items.filter((item) => selectedItemIds.includes(item.id) && (item.operation !== "update" || options?.selectedFields?.[item.id] === undefined || options.selectedFields[item.id].length > 0));
  if (!initialSelected.length) throw new Error("请至少选择一个候选项");
  const appendPlotSegment = initialProposal.taskKey === "plot-design" && initialProposal.outlineGenerationMode === "plot-segment-append";
  if (appendPlotSegment) {
    if (initialSelected.length !== initialProposal.items.length) throw new Error("剧情设计必须整体采纳");
    if (!initialProposal.targetId) throw new Error("剧情设计缺少目标幕");
    const segment = initialSelected.find((item) => item.targetTable === "outlineNodes");
    const chapters = initialSelected.filter((item) => item.targetTable === "documents").sort((left, right) => Number(left.payload.order) - Number(right.payload.order));
    validatePlotDesignItems(initialSelected, initialProposal.targetId, Number(segment?.payload.order), Number(chapters[0]?.payload.order));
  }
  const acceptedRefs = await acceptedProjectReferences(initialProposal.projectId);
  const entityNameToIdMap = await projectEntityNameToIdMap(initialProposal.projectId);
  const tables = initialSelected.some((item) => item.operation === "delete")
    ? novelDb.tables
    : [...new Set([
      ...initialSelected.map((item) => novelDb.table(item.targetTable)),
      novelDb.architectures, novelDb.documents, novelDb.outlineNodes, novelDb.entities, novelDb.plotThreads, novelDb.foreshadowing, novelDb.timelineEvents, novelDb.operations, novelDb.proposals, novelDb.embeddings,
    ])];
  const embeddings: Array<{ table: ProposalTargetTable; id: string; record: Record<string, unknown> }> = [];
  const collaborativeDeletes: Array<{ projectId: string; documentId: string }> = [];
  let appliedCount = 0;
  let conflictCount = 0;
  await novelDb.transaction("rw", tables, async () => {
    const proposal = await novelDb.proposals.get(proposalId);
    if (!proposal || proposal.status !== "pending") throw new Error("提案已由其他操作处理");
    const selected = proposal.items.filter((item) => selectedItemIds.includes(item.id) && (item.operation !== "update" || options?.selectedFields?.[item.id] === undefined || options.selectedFields[item.id].length > 0));
    if (proposal.taskKey === "plot-design" && proposal.outlineGenerationMode === "plot-segment-append") {
      if (!proposal.targetId || selected.length !== proposal.items.length) throw new Error("剧情设计必须整体采纳");
      const [architecture, allNodes, documents] = await Promise.all([
        novelDb.architectures.where("projectId").equals(proposal.projectId).first(),
        novelDb.outlineNodes.where("projectId").equals(proposal.projectId).toArray(),
        novelDb.documents.where("projectId").equals(proposal.projectId).toArray(),
      ]);
      if (!architecture?.phases.some((phase) => phase.id === proposal.targetId)) throw new Error("目标幕已发生变化，请退回后重新生成剧情设计");
      const nextSegmentOrder = allNodes.filter((node) => node.phaseId === proposal.targetId).reduce((max, node) => Math.max(max, node.order), -1) + 1;
      const nextChapterOrder = documents.reduce((max, document) => Math.max(max, document.order), -1) + 1;
      validatePlotDesignItems(selected, proposal.targetId, nextSegmentOrder, nextChapterOrder);
    }
    const selectedTempIds = new Set(selected.map((item) => item.tempId).filter((id): id is string => Boolean(id)));
    const generatedTempIds = new Set(proposal.items.map((item) => item.tempId).filter((id): id is string => Boolean(id)));
    const missingDependencies = selected.flatMap((item) => item.dependencies.filter((dependency) => generatedTempIds.has(dependency) && !selectedTempIds.has(dependency)));
    if (missingDependencies.length) throw new Error(`请同时选择依赖项：${[...new Set(missingDependencies)].join("、")}`);
    const refs = new Map(acceptedRefs);
    for (const item of selected) if (item.tempId) refs.set(item.tempId, item.targetId || crypto.randomUUID());
    const conflicts: string[] = [];
    for (const item of selected) {
      if ((item.operation !== "update" && item.operation !== "delete") || !item.targetId) continue;
      const current = await novelDb.table(item.targetTable).get(item.targetId) as { revision?: number } | undefined;
      if (!current || current.revision !== item.expectedRevision) conflicts.push(item.id);
    }
    const applicable = selected.filter((item) => !conflicts.includes(item.id));
    // 安全网：修复历史提案中可能残留的 ref:tempId_* 引用（问题 #13）
    repairUnresolvableTempRefs(applicable, refs, entityNameToIdMap);
    const catalog = catalogWithResolvedProposalItems(await projectReferenceCatalog(proposal.projectId), applicable, refs);
    const preparedPayloads = new Map<string, Record<string, unknown>>();
    for (const item of applicable) {
      if (item.operation === "delete") continue;
      const rawResolved = sanitizePayload(resolveReferences(item.after ?? item.payload, refs) as Record<string, unknown>);
      const resolved = item.targetTable === "outlineNodes" ? sanitizeModelPayload("outlineNodes", rawResolved) : rawResolved;
      const acceptedFields = item.operation === "update" ? options?.selectedFields?.[item.id] : undefined;
      const filtered = acceptedFields ? Object.fromEntries(Object.entries(resolved).filter(([key]) => acceptedFields.includes(key))) : resolved;
      const validate = item.operation === "create" ? CREATE_PAYLOAD_VALIDATORS[item.targetTable] : PAYLOAD_VALIDATORS[item.targetTable];
      if (!validate(filtered)) throw new Error(`“${item.label}”字段无效：${validate.errors?.map((error) => `${error.instancePath || "root"} ${error.message}`).join("；")}`);
      const payload = item.targetTable === "documents" ? normalizeDocumentPayload(filtered) : item.targetTable === "architectures" ? normalizeArchitecturePayload(filtered) : filtered;
      if (item.targetTable === "outlineNodes" && typeof payload.phaseId === "string") {
        const architecture = await novelDb.architectures.where("projectId").equals(proposal.projectId).first();
        if (!architecture?.phases.some((phase) => phase.id === payload.phaseId)) throw new Error(`“${item.label}”引用了不存在的幕`);
      }
      if (item.targetTable === "documents" && typeof payload.plotSegmentId === "string") {
        const existingSegment = await novelDb.outlineNodes.get(payload.plotSegmentId);
        const selectedSegment = applicable.some((candidate) => candidate.targetTable === "outlineNodes" && candidate.operation === "create" && candidate.tempId && refs.get(candidate.tempId) === payload.plotSegmentId);
        if (!existingSegment && !selectedSegment) throw new Error(`“${item.label}”引用了不存在的剧情段`);
      }
      assertResolvedPayloadReferences(item, payload, catalog);
      preparedPayloads.set(item.id, payload);
    }
    for (const item of applicable) {
      if (item.operation === "delete") {
        await applyDeleteCandidate({ proposalId, projectId: proposal.projectId, item, collaborativeDeletes });
        continue;
      }
      const table = novelDb.table(item.targetTable) as Table<Record<string, unknown>, string>;
      const payload = preparedPayloads.get(item.id)!;
      if (item.operation === "create") {
        const id = item.targetId || (item.tempId ? refs.get(item.tempId) : undefined) || crypto.randomUUID();
        if (await table.get(id)) throw new Error(`“${item.label}”目标 ID 已存在`);
        const record = normalizedCreate(item.targetTable, proposal.projectId, id, payload) as Record<string, unknown>;
        await table.put(record);
        await appendOperation(proposal.projectId, item.targetTable, id, "create", { value: { before: null, after: record } });
        await novelDb.embeddings.where("targetId").equals(id).delete();
        embeddings.push({ table: item.targetTable, id, record });
      } else if (item.targetId) {
        const before = await table.get(item.targetId);
        const mergedPayload = item.targetTable === "documents" && payload.blueprint && (before as Record<string, unknown>)?.blueprint ? { ...payload, blueprint: { ...((before as Record<string, unknown>).blueprint as Record<string, unknown>), ...(payload.blueprint as Record<string, unknown>) } } : payload;
        const record = { ...before, ...mergedPayload, revision: Number((before as { revision?: number })?.revision ?? 0) + 1, updatedAt: Date.now(), updatedBy: "local-user" } as Record<string, unknown>;
        await table.put(record);
        await appendOperation(proposal.projectId, item.targetTable, item.targetId, "update", { value: { before, after: record } });
        await novelDb.embeddings.where("targetId").equals(item.targetId).delete();
        embeddings.push({ table: item.targetTable, id: item.targetId, record });
      }
    }
    const selectedIds = new Set(selected.map((item) => item.id));
    const nextItems = proposal.items.map((item) => conflicts.includes(item.id)
      ? { ...item, status: "conflict" as const }
      : selectedIds.has(item.id)
        ? { ...item, targetId: item.targetId ?? (item.tempId ? refs.get(item.tempId) : undefined), status: "accepted" as const, acceptedFields: item.operation === "update" ? options?.selectedFields?.[item.id] : undefined }
        : item.status === "pending" ? { ...item, status: "rejected" as const } : item);
    const accepted = nextItems.filter((item) => item.status === "accepted").length;
    const status = conflicts.length ? "pending" : accepted === nextItems.length ? "accepted" : accepted > 0 ? "partially_accepted" : "rejected";
    await novelDb.proposals.put({ ...proposal, items: nextItems, status, revision: proposal.revision + 1, updatedAt: Date.now() });
    appliedCount = applicable.length;
    conflictCount = conflicts.length;
  });
  if (appendPlotSegment) await normalizeChapterOrderByPlanning(initialProposal.projectId);
  if (collaborativeDeletes.length) {
    const { deleteCollaborativeDocument } = await import("./collaboration");
    const cleanup = await Promise.allSettled(collaborativeDeletes.map((item) => deleteCollaborativeDocument(item.projectId, item.documentId)));
    const failed = cleanup.filter((result) => result.status === "rejected").length;
    if (failed) throw new Error(`结构化数据已写入，但有 ${failed} 个协作文档缓存清理失败`);
  }
  const { upsertEmbedding } = await import("./retrieval");
  const embeddingResults = await Promise.allSettled(embeddings.map(({ table, id, record }) => {
    const content = embeddingText(table, record);
    return content ? upsertEmbedding({ projectId: initialProposal.projectId, targetTable: table as "entities", targetId: id, content }) : Promise.resolve();
  }));
  return { applied: appliedCount, conflicts: conflictCount, embeddingFailures: embeddingResults.filter((result) => result.status === "rejected").length };
}
