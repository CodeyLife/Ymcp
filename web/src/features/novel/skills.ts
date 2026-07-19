import Ajv from "ajv";
import { parse as parseYaml } from "yaml";
import { novelDb, recordBase, type NovelDatabase } from "./db";
import type {
  NovelSkillManifest,
  NovelSkillSource,
  NovelSkillStage,
  ProjectSkillBinding,
} from "./types";

type SkillDraft = Omit<NovelSkillManifest, keyof ReturnType<typeof recordBase> | "projectId" | "source" | "readonly" | "enabled">;

const skillImportSchema = {
  type: "object",
  additionalProperties: false,
  required: ["skillId", "version", "name", "description", "locale", "category", "stages", "prompt"],
  properties: {
    skillId: { type: "string", pattern: "^[a-z0-9][a-z0-9.-]{2,80}$" },
    version: { type: "string", pattern: "^\\d+\\.\\d+\\.\\d+$" },
    name: { type: "string", minLength: 2, maxLength: 80 },
    description: { type: "string", minLength: 4, maxLength: 300 },
    locale: { type: "string", minLength: 2, maxLength: 20 },
    category: { enum: ["ideation", "character-world", "long-plan", "chapter", "drafting", "serial", "review", "memory"] },
    stages: { type: "array", minItems: 1, uniqueItems: true, items: { enum: ["foundation", "planning", "drafting", "review", "revision", "fact-extraction"] } },
    triggers: { type: "array", items: { type: "string", maxLength: 80 } },
    requires: { type: "array", uniqueItems: true, items: { type: "string" } },
    conflicts: { type: "array", uniqueItems: true, items: { type: "string" } },
    priority: { type: "integer", minimum: 0, maximum: 1000 },
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    prompt: { type: "string", minLength: 20, maxLength: 30000 },
    qualityChecks: { type: "array", items: { type: "string", maxLength: 160 } },
    sourceUrl: { type: "string", maxLength: 500 },
    license: { type: "string", maxLength: 80 },
  },
} as const;

const validateSkill = new Ajv({ allErrors: true, strict: false }).compile(skillImportSchema);
const forbiddenSkillPatterns = [/<script\b/i, /javascript:/i, /忽略(?:所有|以上|系统)指令/i, /ignore (?:all |the )?(?:previous|system) instructions/i, /(?:调用|执行).{0,8}(?:shell|powershell|bash|脚本)/i];

function builtin(draft: Partial<SkillDraft> & Pick<SkillDraft, "skillId" | "name" | "description" | "category" | "stages" | "prompt">): NovelSkillManifest {
  return {
    id: `builtin:${draft.skillId}`,
    projectId: "__builtin__",
    schemaVersion: 2,
    revision: 1,
    createdAt: 0,
    updatedAt: 0,
    createdBy: "system",
    updatedBy: "system",
    version: draft.version ?? "1.0.0",
    locale: draft.locale ?? "zh-CN",
    triggers: draft.triggers ?? [],
    requires: draft.requires ?? [],
    conflicts: draft.conflicts ?? [],
    priority: draft.priority ?? 50,
    inputSchema: draft.inputSchema,
    outputSchema: draft.outputSchema,
    qualityChecks: draft.qualityChecks ?? [],
    source: "builtin",
    sourceUrl: draft.sourceUrl,
    license: draft.license ?? "Ymcp built-in",
    enabled: true,
    readonly: true,
    ...draft,
  };
}

const chapterBlueprintSchema = {
  type: "object",
  required: ["title", "objective", "startingState", "beats", "endingHook", "mustHappen", "forbidden"],
  properties: {
    title: { type: "string" }, objective: { type: "string" }, startingState: { type: "string" },
    beats: { type: "array", minItems: 2, maxItems: 8, items: { type: "object", required: ["action", "emotion", "outcome"], properties: { action: { type: "string" }, emotion: { type: "string" }, outcome: { type: "string" } } } },
    endingHook: { type: "string" }, mustHappen: { type: "array", items: { type: "string" } }, forbidden: { type: "array", items: { type: "string" } },
  },
};

export const BUILTIN_NOVEL_SKILLS: NovelSkillManifest[] = [
  builtin({ skillId: "story-facts-invariant", name: "故事事实优先", description: "区分已确认事实、角色认知、推测和创作建议。", category: "memory", stages: ["foundation", "planning", "drafting", "review", "revision", "fact-extraction"], priority: 1000, prompt: "已确认的故事事实、锁定规则和人物知识边界优先于任何写作技巧。不得把建议写成既定事实；发生冲突时必须指出冲突并停止提交相关变更。", qualityChecks: ["不得违反锁定事实", "角色只能使用已知或合理推断的信息"] }),
  builtin({ skillId: "premise-pressure-test", name: "核心创意压力测试", description: "检查故事承诺、持续冲突和长篇扩展空间。", category: "ideation", stages: ["foundation"], prompt: "从主角主动目标、持续阻力、失败代价、题材承诺、差异化机制和至少三次升级空间检查核心创意。不要用空泛主题代替可发生的戏剧行动；但'可发生的戏剧行动'指的是能在场景里铺陈的具体处境、选择与情感波澜，不是指一上来就要把核心冲突与转折点写到梗概和大纲首句。主题应在故事中自然浮现，而非被宣告。" }),
  builtin({ skillId: "character-desire-engine", name: "人物欲望引擎", description: "用欲望、恐惧、错误信念、真实需求、代价、行为底线与信念闭环构造人物。", category: "character-world", stages: ["foundation", "planning", "review", "character-enrichment"], prompt: "为主要人物明确外在欲望、内在恐惧、错误信念、未承认的需求、道德边界和愿意支付的代价。人物选择必须由这些力量推动，而不是服务作者方便。\n\n【反派与对立角色三零件】长篇反派与对立角色除上述欲望轴外，必须额外具备：(1) 具体且分层的核心欲望（生存层/情感层/信念层）；(2) 一条死都不碰的行为底线——这是读者共情的关键，可以为了目标算计所有人，但绝不伤害某类对象或违背某种承诺；(3) 围绕核心信念展开、前后不矛盾的信念闭环。三类经典模板：理念型（与主角的矛盾是理念之争）、悲剧型（本为好人，因命运/背叛滑向黑暗）、亦正亦邪型（看心情看利益，制造张力）。反派每次出场前自检三问：他想要什么？他不做什么？他死都要守住什么？\n\n【初始 state 必填】创建角色时必须给出完整的初始 state，作为后续章节规划与正文场景的锚点：\n- state.location：角色首次出场的具体地点，应当引用世界观中已有的 location 实体名（如\"东宫文华殿\"\"刑部仵作房\"），不可写\"未指定\"或留空。\n- state.physical：角色此刻的身体状态（疲劳 / 健康 / 受伤 / 重病 / 怀孕 / 残疾等），不可写\"未指定\"；若未明确受伤或异常，应明确写\"健康\"或\"精力充沛\"等具体状态。\n- state.emotional：角色此刻的情绪基调，用具体描述而非抽象词（如\"压抑的悲痛\"\"强压的愤怒\"\"强装的平静\"\"隐忍的警惕\"），不可写\"未指定\"或\"平静\"。\n- state.objective：角色在此状态下的即时目标（短期、可被场景兑现的目标，不是全书欲望）。\n- state.inventory：角色随身或可立即调用的关键物品（可为空数组，但不可缺失字段）。\n- state.relationshipNotes：角色此刻对其他在场角色的态度摘要（可为空数组）。\n\"未指定\"不得作为任何 state 字段的值；缺失字段会让后续章节规划无法判断人物此刻在哪里、处于什么情绪、持有何种资源。" }),
  builtin({ skillId: "character-voice-matrix", name: "角色声音矩阵", description: "区分角色词汇、回避方式、潜台词与情绪泄露。", category: "character-world", stages: ["drafting", "review", "revision"], prompt: "让角色仅凭对白也可辨认。依据教育、阶层、关系权力、当前目标和回避习惯控制词汇、直接程度、潜台词与沉默。配角不得充当作者点题的传声筒。特殊身份人物除思考特质外，也必须呈现符合处境的身体感受、情绪压力和身份困境。\n\n【群像场景的次要角色发声】蓝图在同一场安排多个有动作呈现的角色时，不能只让主要说话者开口。有具体动作（递物、拦阻、指引、反应、整理、呼唤其一）的次要角色应各有符合年龄、职业与处境的差异化表达，用于建立规则、提示世界观、呈现关系质地或锚定当下处境。仅作背景的群演可不发声，但有动作呈现的角色若全程沉默，等同于把声音全部收敛到主角与单一 NPC，丢失群像声部。判定标准：去掉说话人名字后，若一场戏中两个以上有动作的次要角色对白交换或缺失，则声音同质化或缺失，违规。" }),
  builtin({ skillId: "world-rule-contract", name: "世界规则契约", description: "把能力、社会和物理规则写成带代价的可验证约束。", category: "character-world", stages: ["foundation", "planning", "review"], prompt: "世界规则必须写清适用条件、能力上限、代价、例外和社会后果。解决冲突不得临时创造无铺垫规则；新增例外必须形成待审事实。" }),
  builtin({ skillId: "hierarchical-outline", name: "分层剧情控制", description: "按幕、剧情段和章节逐级组织长篇规划。", category: "long-plan", stages: ["planning"], prompt: "长篇是循序渐进的铺陈，不是主题宣告。全书架构中的宏观阶段就是幕，不得重复创建另一份幕数据。每幕拆成若干剧情段，每个剧情段直接组织正式章节；章节标题、摘要和蓝图必须足以进入后续写作流程，不再设置独立事件层。每个下层内容必须服务至少一个上层目标，转折、伏笔和悬念应作为布局埋设，不作为口号宣告。\n\n【phase.turningPoint 文学化叙事】架构中每个 phase 的 turningPoint 字段必须用文学化叙事书写，写处境的不可逆变化与人物心境的回不去，不得用\"X 发现 Y\"\"X 获得 Z 机会\"\"X 建立 Y\"等编剧指令腔。\n- 错误示范：\"太子死因被发现存在疑点，三人获得接触尸身与调查线索的机会\"——这是事件式描述，把人物当作被事件推动的工具。\n- 正确示范：\"初雪之夜，太子的灯火熄灭后再未亮起；萧彻第一次意识到自己看见的不是一具尸身，而是一封无人敢拆的信。\"——写出处境的不可逆与人物心境的拐弯。\n判断标准：删除该句后，phase 还能否被读者感受到\"回不去了\"？若不能，则 turningPoint 没写到位。turningPoint 不是\"接下来会发生什么\"的事件预告，而是\"此阶段结束时人物与世界已无可挽回地改变了什么\"的文学定格。" }),
  builtin({ skillId: "causal-thread-weaving", name: "因果与剧情线编织", description: "避免事件清单和支线失踪。", category: "long-plan", stages: ["planning", "review"], prompt: "每个重要事件标注原因、触发条件、阻碍、直接结果和延迟后果。主线与支线通过共同人物、资源、秘密或选择相互改变，不能仅轮流出现。\n\n【支线反哺三问】支线不能只是主线休息站。剑来的支线（山崖书院、剑气长城）最终都反哺陈平安的核心命题——每条支线都要回答“它如何改变了主线人物的选择”。每条支线必须回答以下三个问题中的至少一问：(1) 它如何改变了主线人物的选择？(2) 它如何改变了主线人物的认知或信念？(3) 它如何为主线提供了关键资源、秘密或盟友？若一条支线对这三个问题都回答“否”，则该支线只是主线休息站，应考虑删除或重构。支线不得只通过“同时发生”与主线关联（如“主角在做A时，配角在做B”），必须通过因果链关联（如“配角在B中获得的信息改变了主角在A中的选择”）。在 review 阶段，plot-reviewer 应检查每条支线是否回答了反哺三问中的至少一问。", qualityChecks: ["每个重要事件是否标注了原因/触发/阻碍/结果/延迟后果", "主线与支线是否通过共享人物/资源/秘密/选择相互改变", "每条支线是否回答了反哺三问中的至少一问", "支线是否通过因果链而非同时发生与主线关联"] }),
  builtin({ skillId: "foreshadowing-ledger", name: "伏笔账本", description: "规划埋设、提醒、误导、揭示和回收。", category: "long-plan", stages: ["planning", "review", "fact-extraction"], prompt: "伏笔必须记录读者可见线索、角色可知范围、预期误读、提醒频率、揭示条件和回收影响。揭示前不得让角色无来源地知道真相。\n\n【延迟回收范式】伏笔的威力来自延迟回收，而非即时揭晓。雪中“温华断臂”前铺垫极长，回收时爆发出巨大情感——关键在于伏笔埋设时以日常细节形态存在，不自我标榜。落实以下反直觉约束：(1) 伏笔埋设时必须以日常细节形态存在，不得自我标榜（禁止“他不知道这个决定将改变一切”“这个细节后来证明至关重要”等作者预告）。(2) 伏笔的“读者可见线索”应当看似无关紧要的日常描写（如剑来槐叶飘落、雪中温华的木剑），读者初读仅觉景物描写，回收时方知环环相扣。(3) 伏笔的“提醒”应当以不经意的方式呈现（如人物偶然瞥见、他人随口提及），不得让人物主动追查伏笔（除非该人物有明确动机）。(4) 伏笔的“回收”应当让读者产生“原来如此”的恍然，而非“终于揭晓”的被动接受——回收瞬间应触发情感爆发，而非信息确认。判断标准：若读者重读埋设段落时能立刻认出这是伏笔，则埋设过于刻意；理想状态是读者重读时才惊觉“原来这里早就埋了线索”。", qualityChecks: ["伏笔是否记录了六要素（线索/可知范围/误读/提醒/揭示/回收）", "伏笔埋设是否以日常细节形态存在而非自我标榜", "伏笔提醒是否不经意而非人物主动追查", "伏笔回收是否触发情感爆发而非信息确认", "重读埋设段落时伏笔是否足够隐蔽"] }),
  builtin({ skillId: "chapter-blueprint", name: "章节蓝图", description: "先产出可审批、可执行且保留长篇余量的章节节拍。", category: "chapter", stages: ["planning"], requires: ["story-facts-invariant"], outputSchema: chapterBlueprintSchema, priority: 200, prompt: "先确定本章唯一的主导叙事功能：建立世界与常态、深化人物与关系、积累情绪与压力、埋设或提醒线索、承担行动转折、呈现后果与余波，或阶段兑现。章节蓝图包含精确起点、2至8个必要节拍、每个节拍的行动或观察、人物反应与局部结果，以及必须发生与禁止事项。目标描述本章探索和积累的方向，不等于必须解决的问题；informationRelease 可以为空，endingHook 可以是未说出口的情感、关系张力、意象余韵或尚未行动的决定，不必制造突发危险。只有属于本章兑现窗口的变化才能写入 mustHappen；后续大纲节点、秘密真相、关系跃迁和伏笔回收应进入 forbidden，防止提前消费。节拍保持相邻因果，但允许背景铺陈、生活过程、内心游移、关系相处和情感余波占据篇幅。禁止把大纲节点压缩成当章任务清单，也禁止为凑节拍强造转折。\n\n【POV 与 mustHappen 一致性】若本章 povCharacterId 是单一角色（第三人称限知 POV），则 mustHappen 中的所有动作必须满足以下两种之一：\n(1) 该 POV 角色亲自可观察、可推断或可被告知的事项——如 POV 角色亲眼看到的他人行动、亲耳听到的对白、收到他人转述的事件；\n(2) 该 POV 角色自身的内心动作——如 POV 角色的决定、记忆、误读、回避。\n不得在单 POV 章节的 mustHappen 中包含非 POV 角色的内心动作（\"X 意识到 / X 发现 / X 察觉 / X 心想\"等），因为正文写作时 POV 角色无法直接呈现这些内心。\n如确需呈现多个角色的内心活动：\n- 方案 A：保持单 POV，把其他角色的内心外化为该 POV 角色可观察的行动（把\"沈知微察觉异常\"改写为\"沈知微的手停在半空，指尖轻颤了一下\"——POV 角色萧彻可见的行动暗示其内心）；\n- 方案 B：显式标注本章为\"多视角切片\"，将 povCharacterId 留空（或填入\"multi\"占位），并在 characterIds 中列出全部视角人物，在 beats 中标注每个节拍的 POV。\n错误示范：povCharacterId=萧彻，mustHappen=[\"沈知微发现与太子生前记录有关的矛盾细节\",\"顾长安受命接触太子尸身并察觉不寻常之处\"]——萧彻不可能直接观察沈知微与顾长安的内心活动。\n正确示范：povCharacterId=萧彻，mustHappen=[\"萧彻在东宫外廊听到内侍低语太子未起\",\"沈知微呈上的一卷旧档被魏承恩拦下\",\"顾长安领命入刑部仵作房\"]——全部为萧彻可见、可知或可被告知的外部动作。" }),
  builtin({ skillId: "scene-action-reaction", name: "行动与反应场景", description: "在行动、反应和叙事停留之间形成呼吸。", category: "chapter", stages: ["planning", "drafting", "review"], prompt: "行动场景围绕当下欲望与具体阻力展开；重大结果后给人物足够空间感受、误解、回避、回忆、权衡或暂不决定。呼吸段可以建立故事背景、日常秩序、人物内心、关系质地、情感余波或文学意象，不必立即改变局势；它只需深化读者对人物和世界的体验，并避免重复已经明确的信息。" }),
  builtin({ skillId: "embodied-prose", name: "具象场景正文", description: "用行动、感官和选择承载情绪与信息。", category: "drafting", stages: ["drafting", "revision"], prompt: "正文优先呈现人物正在做什么、注意到什么、误读什么和选择什么。抽象总结要落回可观察行动、具体感官、环境阻力或有代价的对白。认知变化必须由前文可见信息触发；观察不足时，人物判断应保持试探性并允许出错。\n\n【画面感公式】关键瞬间（人物登场、命运降临、决断时刻、重大转折）建议用“动作+停顿+环境反应+时间流逝+心境外化”五元素组合呈现，而非一笔带过。这是烽火戏诸侯自述的“不写之写”画面感公式——网文突破天花板的钥匙之一。范式示例（参考烽火老僧掠荒漠一段）：动作（老僧抬手）→ 停顿（空气中似有剑意）→ 环境反应（远处风沙骤停）→ 时间流逝（一炷香后他才落下）→ 心境外化（他没有回头，但衣袖已被汗水浸透）。五元素组合通过环境与身体的连锁反应让读者感受到人物内心，而非直接描写心理。注意事项：(1) 五元素应自然融入叙事节奏，不可当作清单逐项罗列；(2) 非关键瞬间不必套用此公式，日常推进仍用常规叙事；(3) 心境外化必须是可被镜头捕捉的动作或身体反应，不可回退到“他心中…”式心理描写。", qualityChecks: ["正文是否优先呈现人物行动与观察而非抽象总结", "认知变化是否由前文可见信息触发", "关键瞬间是否用画面感公式五元素放大而非一笔带过", "心境外化是否为可被镜头捕捉的动作而非心理描写"] }),
  builtin({ skillId: "serial-rhythm", name: "通用连载节奏", description: "控制长篇中的蓄势、停留、推进、余波和阶段回报。", category: "serial", stages: ["planning", "drafting", "review"], prompt: "章节不必都完成局势转折。根据长线位置，让不同章节分别承担建立常态、人物相处、背景展开、压力累积、行动推进、后果消化或阶段回报；连续章节在功能和强度上形成呼吸。安静章节仍应有视角人物的注意力、欲望或情感暗流，但不得为了显得有用而强造危险、秘密揭晓、关系跃迁或章尾反转。回报必须来自足够铺垫，重大大纲节点只在批准的兑现窗口发生。全章只保留一个开场和一个结尾，不用第二组事件重复推进。\n\n【一章三钩位置密度】单章节奏不是“每章一个爽点”，而是“章首钩—章中钩—章尾钩”的三段式张力分布，可作为默认节奏参考而非硬性要求。(1) 章首钩：建议开篇 200 字内衔接上一章的未解压力或抛出新认知缺口，让读者从“悬着”直接跌入“紧张”——如“冰冷的刀锋擦着脖颈划过，身后的脚步声越来越近”。不宜用大段环境描写或心理回顾开篇。(2) 章中钩：建议每千字埋一个小钩子，不必是大悬念，只需让读者心里咯噔一下——修仙文主角炼丹到一半丹炉发出异常红光；职场文主角刚拿到方案电脑突然黑屏。小钩子可以是物件反常、人物欲言又止、线索出现细微矛盾、第三方意外介入其一。(3) 章尾钩：宜停在最揪心、最期待、最未知的瞬间，不建议把事情讲完或让情绪完全落地。三种基础形态（任选其一，不必俱全）：动作方向（指向尚未到达的地点或尚未发生的事）、代价压力（让读者担心下一次如何偿付）、关系裂痕（露出尚未摊牌的张力）。安静章节可以用未说出口的话或日常细节反常承载章尾钩，建议携带未解信息或新压力；纯情感余韵的封闭画面也可作为变体，但不宜连续多章使用同一收束形态。\n\n【压抑-释放-反压循环】爆发章（行动推进、阶段回报）的节奏不是“压→爽”二段式，而是“压→反压→爽”三段式，可作为爆发章的推荐结构。(1) 压抑：场景设计让人物陷入困境，让读者共情难受（被嘲讽、被围攻、被误解）。(2) 反压：建议让主角第一次反抗失败或被更深的困境压回——这是网文与流水账爽文的核心分水岭。反压让读者积蓄更深的期待，也让人物的最终胜利不是廉价的外挂，而是用代价换来的。(3) 释放：找到关键转机（宜来自前文铺垫的伏笔或人物主动选择，不宜突降外挂），爆发爽点。反压缺失的爆发章容易显得廉价——读者感受不到“回不去了”的重量。规划爆发章时建议明确三段：压抑场景是什么、反压失败在哪里、释放的转机由哪条伏笔或人物选择提供。蓄势章（建立常态、人物相处、背景展开）不必套用此循环，可参考章首—章中—章尾三钩维持张力下限。", qualityChecks: ["单章是否有章首钩（200 字内抛出未解压力）", "章中是否每千字埋一个小钩子", "章尾是否停在揪心瞬间且携带未解信息", "爆发章是否包含压抑—反压失败—释放三段", "释放的转机是否来自前文铺垫而非突降外挂"] }),
  builtin({ skillId: "continuity-audit", name: "连续性审校", description: "检查时间、空间、知识、物品、规则和因果。", category: "review", stages: ["review"], requires: ["story-facts-invariant"], priority: 180, prompt: "逐段核对人物位置与移动、故事时间、环境、角色知识、重要物品归属、世界规则和前因后果。只报告有上下文证据的矛盾，并引用冲突来源。" }),
  builtin({ skillId: "style-specificity-audit", name: "文风与具体性审校", description: "检查视角、语言具体性、重复和模板化表达。", category: "review", stages: ["review"], prompt: "检查叙述距离、视角稳定、抽象情绪、重复意象和模板化动作。高频词统计只形成警告；必须结合人物声音和项目风格判断，不能机械判错。\n\n【强调词贬值】统计“第一次”“突然”“忽然”“终于”“竟然”等强调词的频次。单章同一强调词出现超过 2 次即判定为贬值，须替换或删除。特别注意“第一次+动词”结构（第一次意识到/发现/明白/感到）的堆叠。\n\n【金句收尾密度】检测以格言式、总结式、哲理式句子结尾的段落。单章超过 3 处即判定为“金句过密”，须将部分金句改为行动或沉默。\n\n【人物语言越界】检查配角对白是否超出其身份认知。底层人物（兵卒、农人、流民）不可说出哲学总结或抽象道理。若发现配角台词像“作者传声筒”，须改为符合其身份的朴素表达，或用行动代替说教。" }),
  builtin({ skillId: "plot-pacing-audit", name: "剧情与节奏审校", description: "验证节拍落实、局势变化、钩子和回报。", category: "review", stages: ["review"], prompt: "比较蓝图与正文，检查必须节拍、人物选择、因果推进、场景功能、信息释放、张弛变化和章尾驱动力。区分结构阻断与审美建议。" }),
  builtin({ skillId: "fact-delta-extraction", name: "事实差异提取", description: "从已批准正文提取带证据的结构化变化。", category: "memory", stages: ["fact-extraction"], requires: ["story-facts-invariant"], priority: 220, prompt: "只提取正文明确陈述或强烈蕴含的新事实、角色状态、知识、关系、物品、时间线、剧情线和伏笔变化。每项必须引用原文证据、给出置信度并标记新增、更新、重复或冲突；不得直接提交。\n\n【关系(relations)提取规则】\n- 新建立的关系：novelty='new'，field='record'，after 提供完整对象 {fromEntityId, toEntityId, relationType, bond, publicLabel, privateTruth}。fromEntityId/toEntityId 必须是上下文中真实存在的角色 ID。bond 用中文描述两人关系状态（如“关系亲密，已建立信任，近期因误会产生隔阂”）。\n- 现有关系的状态变化（如关系从亲密转为疏远）：novelty='update'，targetId 填关系 ID，field='bond'，before 填旧描述，after 填新的中文描述。\n- 关系类型的变化（如从'同伴'变为'对手'）：novelty='update'，field='relationType'。\n- 不得为已存在的角色对重复提取 new 关系；若正文未明确体现关系变化，不要强行提取。\n\n【新人物(entities/character)提取规则】\n- 当正文首次出现有姓名且对剧情有推动作用的重要人物（非路人甲、非一次性过场角色），且上下文事实库中尚不存在同名 character 实体时，提取为 novelty='new'，targetTable='entities'，field='record'，subject.kind='entity'，subject.id 省略（由系统生成）。\n- after 必须提供完整对象：{kind:'character', name:'人物姓名', aliases:['别名/字号/称谓'], summary:'一句话身份定位与剧情作用', description:'基于正文可观察的登场印象、标志性动作或对白特征', character:{role:'主角/重要配角/反派/导师等剧情定位', appearance:'基于正文可观察的外貌细节（无则留空字符串）', personality:'基于正文行动推断的性格特质', desire:'基于正文可观察的外在欲望', motivation:'基于正文可推断的动机', weakness:'', secret:'', abilities:[], voice:'基于正文对白归纳的说话方式', arc:'', state:{location:'登场场景地点', physical:'', emotional:'', objective:'登场时的即时目标', inventory:[], relationshipNotes:[]}}}。\n- 只填写正文已建立或可合理推断的字段；正文未体现的字段留空字符串或空数组，留给后续 character-enrichment 阶段补完。\n- 不得为上下文中已存在的同名或同别名 character 提取 new 实体；此时应改为 novelty='update'，targetId 填已有实体 ID，field 填具体变化字段（如 character.state.location）。\n- 路人甲、一次性NPC、未命名群演不得提取；只有具备剧情推动力或有再次出场可能的人物才提取。" }),
  builtin({ skillId: "classic-character-ensemble", name: "经典人物群像法", description: "从《雪中悍刀行》《剑来》《庆余年》提炼群像塑造、出场即性格、对话即性格的写法。", category: "character-world", stages: ["foundation", "planning", "drafting", "review", "character-enrichment"], priority: 60, prompt: "借鉴《雪中悍刀行》《剑来》《庆余年》等网文经典的人物塑造法，落实以下规则：\n\n【群像生态】每个重要配角必须拥有独立欲望、资源与代价，不能只服务主角剧情。配角之间要形成关系网（恩怨、利益、秘密），让世界因他们而运转。雪中温华、剑来宁姚、庆余年陈萍萍之所以立得住，在于他们有不在主角面前时也成立的人生。\n\n【出场即性格】人物首次登场需用一个“标志性动作+一句辨识度对白+一个反差细节”立住形象。拒绝先大段外貌描写再补性格的流水账。李淳罡出场即“羊裘裘老头拎羊脂玉”，陈平安出场即“穷且规矩”。\n\n【对话即性格】对白要承载人物的教育、出身、当下意图与回避。江湖人说江湖话，庙堂人说庙堂话，市井人说市井话。禁止所有角色共享同一书面腔。烽火的人物对白常带“言在此而意在彼”的潜台词，猫腻的对白常带从容的幽默与机锋。\n\n【弧光与代价】主角成长必须伴随真实代价（失去、误解、道德妥协），不能只升不降。陈平安的成长伴随着“道理越讲越沉”的代价，范闲的快意伴随着“身在庙堂不由己”的代价。每个阶段的选择都要回扣人物的核心恐惧与未承认需求。\n\n【留白与暗示】不把人物内心全部写透。用动作、沉默、物件、环境暗示人物状态。雪中常用“某人没说话，只是做了某事”来承载情绪。让读者通过拼图理解人物，而非作者直接宣告。", qualityChecks: ["配角是否有独立于主角的欲望与场景", "首次登场是否用动作/对白立住性格", "对白是否区分了人物身份与意图", "成长是否伴随真实代价", "是否避免了作者直接宣告人物内心"] }),
  builtin({ skillId: "classic-narrative-tension", name: "经典叙事张力法", description: "从《雪中悍刀行》《剑来》《庆余年》提炼悬念、伏笔、节奏与长线布局的叙事法。", category: "long-plan", stages: ["planning", "review"], priority: 60, prompt: "借鉴《雪中悍刀行》《剑来》《庆余年》等网文经典的叙事张力构建法。这些经典的共同特点不是急于宣告主题，而是用绵长的铺陈让戏剧性在事件流中自然生长——雪中徐凤年的成长用上百章温养，剑来陈平安的道理用一砖一瓦垒起。规划时不要把悬念、伏笔、转折当作必须尽快展示的清单，而要当作埋在土壤里的种子，让它们在合适的章节自然发芽。以下规则在此前提下落实：\n\n【悬念分层】每章至少埋一个“章尾钩子”（短期悬念），每幕至少推进一个“中期谜题”（数十章到百章级），全书贯穿一到两个“核心悬念”（雪中“徐凤年为何而活”、剑来“陈平安的道理”）。三层悬念并行，读者在任何尺度都有期待。\n\n【伏笔的延迟回收】伏笔要“埋得自然、提得克制、收得有力”。雪中“温华断臂”前铺垫极长，回收时爆发出巨大情感。禁止埋伏笔时大张旗鼓（如“他不知道这个决定将改变一切”），让伏笔以日常细节形态存在。回收时要让读者恍然“原来早有线索”，而非作者强行解释。\n\n【张弛与节奏】网文的节奏不是“每章爽点”，而是“阻力—推进—回报”的呼吸。雪中常见“三章蓄势、一章爆发”的节奏。爆发章要兑现此前积累的期待，蓄势章要制造新的认知缺口或情感压力。禁止用固定字数机械插入爽点，回报必须来自此前阻力与人物行动。\n\n【长线布局】长篇要有“阶段不可逆变化”。雪中徐凤年从“纨绔世子”到“北凉王”再到“江湖人”，每个阶段都有不可逆的身份与认知转变。规划时先定阶段转折点，再回填事件。转折点要让人物“回不去了”，而非“又升了一级”。\n\n【支线反哺主线】支线不能只是主线休息站。剑来的支线（如山崖书院、剑气长城）最终都反哺陈平安的核心命题。支线要通过共享人物、资源、秘密或主题与主线相互改变，而非轮流出现。每条支线都要回答“它如何改变了主线人物的选择”。\n\n【留白叙事】有些最重要的信息用“不写”来写。雪中李淳罡的过去、剑来某些大人物的图谋，常通过他人反应、环境变化、片段暗示来呈现。规划时明确“哪些信息延迟揭示”“哪些信息永不揭示”“哪些信息用侧面呈现”。", qualityChecks: ["是否埋设了章尾/幕级/全书三层悬念", "伏笔是否以日常形态埋设而非大张旗鼓", "回报是否来自此前阻力而非机械插入", "阶段转折是否造成不可逆变化", "支线是否反哺主线人物选择"] }),
  builtin({ skillId: "classic-prose-texture", name: "经典文笔质感法", description: "从《雪中悍刀行》《剑来》《庆余年》提炼句式节奏、意境营造、白描留白的文笔法。", category: "drafting", stages: ["drafting", "revision"], priority: 70, prompt: "借鉴《雪中悍刀行》《剑来》《庆余年》等网文经典的文笔质感，落实以下规则：\n\n【文白交织】重要场景、情绪高点、意境段落可适度使用半文半白的句式，日常推进用洗练白话。雪中“天不生我李淳罡，剑道万古如长夜”是文白交织的典范。禁止全篇文言或全篇口水白话，要让文白根据场景情绪自然切换。\n\n【意境营造】用环境意象承载人物情绪与主题。雪中常以“雪”“剑”“酒”为核心意象，剑来常以“山水”“道理”为核心意象。意象要反复出现并随人物成长变化含义。禁止空洞堆砌华丽辞藻，意象必须服务视角与场景目标。\n\n【白描与留白】用最少的字写最重的情。雪中温华出场、剑来陈平安父亲之死，都用极简白描承载巨大情感。关键情绪不要直说“他很悲伤/愤怒”，而用一个动作、一个物件、一句没说完的话来承载。留白处让读者用自己的情感填补。\n\n【对白的机锋】高质量对白要“话里有话”。猫腻的对白常带从容的幽默与机锋，烽火的对白常带“言在此而意在彼”的江湖气。对白不是信息传递工具，而是人物博弈、情感试探、立场宣示的场域。每句重要对白都要有“表面意思”与“真实意图”两层。\n\n【感官与画面感】每个场景至少调动两种以上感官（视觉、听觉、嗅觉、触觉、温度）。雪中的“大雪压剑”、剑来的“山水清音”都是有强感官的画面。画面感不等于华丽，而在于让读者“看见”“听见”“感受到”。\n\n【避免网文腔】警惕“恐怖如斯”“倒吸一口凉气”“嘴角上扬”等模板化表达。文笔的质感来自具体而非套话。每个情绪都找属于这个人物、这个场景的独特表达方式。\n\n【情绪不可直说】禁止用“他很悲伤/愤怒/高兴/害怕/孤独”等情绪词直接宣告人物感受。情绪必须通过以下方式之一承载：一个反常动作（如攥紧又松开）、一个环境意象的变化（如灯火晃了一下）、一句没说完的话、一个物件被反复触碰。\n\n【去情绪化书写清单（具体替换范式）】心理描写越重，越要换算成一个可被镜头捕捉的动作或物件状态。猫腻《庆余年》的范式：愤怒不写“他很怒”，写“范闲捏碎瓷枕，瓷片划破掌心也没擦”；情绪波动不写“他心乱”，写“五竹黑布微扬，止步片刻才继续前行”；心理失衡不写“她动摇”，写“海棠指尖捻碎花瓣，落了一地”。替换公式：(1) 把“他感到X”换成“他对Y做了一件反常动作”；(2) 把“她意识到X”换成“她重复触碰某物件，物件状态变化暗示认知”；(3) 把“他心想X”换成“他对环境做出反应（停步/侧首/合上书/把杯子推远）”。不宜用“他知道，……”句式替读者解释人物动机，不宜用“这意味着……”替读者归纳含义。每处心理描写落笔前自检：能否被镜头拍到？若不能，建议改写为动作或物件。\n\n【双声部语体切换】语体不是全篇统一，而是按场景功能切换两个声部。(1) 典雅声部：朝堂奏对、诗会唱和、宗门论道、仪式祭告——使用半文半白、句式凝练、用典含蓄（“此子当诛”“尔等宵小”“浮曹娥江上，铁面横波”）。(2) 市井声部：酒馆闲谈、师徒相处、市集买卖、家人絮语——使用鲜活白话和俚俗比喻（“路还长着呢”“你这破刀还能砍人不”）。两声部切换如呼吸，不可混用导致语感断裂：朝堂人物下了朝说市井话是亲民，市井人物上了朝说文言是僭越或滑稽。穿越/异世界主角内心独白可保留现代语感，但对外说话建议翻译为当世声部。判定标准：去掉说话人名字，仅凭语体能判断这是朝堂场景还是市井场景。\n\n【身份声部样例库（生成时锚点）】以下为不同身份角色的声部样例，生成对白时以此为锚点对照——不是抄录，而是内化“该身份的人在此情境下会怎么说”。每个样例回答“为什么这个人这么说而不是那么说”。\n◆ 掌事宦官/内廷执事（推制度+回避+规矩辞令）：\n  - “东宫封存，自有名册可查。殿下若要问，奴才不敢隐瞒，只是不敢先替规矩开口。”——把个人意愿藏在制度后面，用“名册可查”回避立场表态。\n  - “奴才只管记时辰，旁的不敢多嘴。”——用职责边界回避信息披露。\n  - “按旧例走，东西先验，牌子留下。”——用流程指令代替判断，不解释原因。\n◆ 皇子/权力上位者（追问+不表态+点到即止）：\n  - “今夜进过这间殿的人，魏公公想必都记着。”——用陈述句代替问句，把试探藏在肯定里，不解释自己为何要问。\n  - “若真有不该留下的东西，等到该看的时候，未必还在。”——用假设句施压，不直接要求行动，留余地给自己。\n  - “我只是来看看三弟。”——用日常意图包装政治目的，点到即止不展开。\n◆ 文献官/史官（考据腔调+指向物证+只陈述观察）：\n  - “起居注载，太子殿下戌正取温水与药炉，此前两个时辰未有召见记录。”——用档案语言陈述事实，不解释意义，让读者自行判断。\n  - “这册卷宗的封角与上月所见不同。”——只报告物证差异，不下结论。\n  - “旧录在此，是否入档，凭掌事定夺。”——把判断权交出，但通过“旧录在此”暗示信息存在。\n◆ 市井仵作/技术身份者（术语精准+市井俚俗+直指物证）：\n  - “尸斑未褪，至少死了三个时辰。这趟没白来。”——前半句术语精准，后半句市井口语，身份反差立住。\n  - “掌事若只要一张凭证，我带来了。若要真相，就别让我站在门外。”——市井直率+讨价还价，不绕弯子。\n  - “这儿。地砖缝里的水痕——外头雪还没化透，这里却干了一半。”——用专业观察+市井语气陈述异常，不解释含义。\n判定标准：两个不同身份角色的对白交换名字后若读起来一样，则声音同质化，违规——必须重写其中至少一人。\n\n【意象密度】每个情绪场景至少绑定一个环境意象，用意象的状态变化暗示人物内心。意象不可是装饰，必须与视角人物此刻的心境形成呼应或反差。全书应建立 3-5 个核心意象（如雪、剑、灯、路、井），让它们随人物成长改变含义。\n\n【金句控制】禁止每段都以格言式句子收尾。全章格言式收尾不超过 2 处，且必须由人物对白或行动自然引出，不可由叙述者宣告。判断标准：若删除该句，段落意思不变，则它是多余的宣告。\n\n【作者隐身】禁止叙述者直接宣告主题、人物内心或世界规则。主题必须藏在人物的选择与代价里；人物内心必须通过行动和感官外化；世界规则必须通过人物遭遇体现。“他想：这个世界没有算法”是宣告，“他盯着城门看了很久，没有划下第二道线”是外化。\n\n【现代词汇边界】穿越/异世界设定下，现代概念词（模型、变量、算法、系统、模块、字段、量化、输入、输出）只允许出现在主角内心独白中。主角对外说话时必须将现代概念“翻译”为当世能懂的话（“模型”→“算法/章法/门道”，“变量”→“变数”）。旁人对这些词应有合理的陌生反应，不可无感。\n\n【参考作品 prose 范本库】以下片段按维度组织，标注技巧点。生成正文时以此作为质感锚点对照——不是模仿其情节，而是内化其“如何承载”。每条都回答“这一刻作者为什么不直说、而这样写”。\n\n◆ 去情绪化书写（最关键维度）\n- 庆余年·范闲闻父死讯：作者不写“他很悲伤”，写他坐了很久，把碗里剩的半口酒喝完才站起来。技巧：巨恸用日常动作承载，身体先于心知反应。\n- 雪中·李淳罡忆往事：老剑神只是喝了口酒，酒水顺着白须淌下来他也没擦。技巧：未擦的酒水承载情绪，作者全程隐身，不点破“他想起当年”。\n- 剑来·陈平安父亲之死：极简白描，用一件具体遗物承载，不出现“悲”字。技巧：最重的情用最少的字，留白让读者自填。\n判定标准：若把人物动作换成“他感到X”，句子立刻变成作者宣告——则原句合规；若本身就含“他感到/他知道/他意识到”，则违规。\n\n◆ 器物隐喻系统\n- 庆余年·五竹铁钎：未经修饰的原始力量，状态从不变化暗示其超越常人的稳定——器物状态即人物质地。\n- 庆余年·范闲菜刀：厨房切菜与战场杀人同一把刀，暴力工具双重性——器物参与抉择瞬间，折射人物身份张力。\n- 雪中·徐凤年佩剑：从春雷到凉刀，剑的更替折射身份转变——器物状态变化暗示人物处境不可逆。\n判定标准：器物必须至少参与一次抉择瞬间（摩挲/攥紧/放下/折断），状态变化必须暗示人物处境；只作装饰则违规。\n\n◆ 留白叙事\n- 雪中·温华断臂：前文以日常细节形态铺垫极长（木剑、师门、江湖梦），回收时读者“原来如此”爆发情感——伏笔埋设时不自我标榜。\n- 剑来·大人物图谋：通过他人反应、环境变化、片段暗示呈现，不直接揭示——关键信息用“不写”来写。\n- 雪中·徐骁屠城：从不正面描写，通过他人畏惧反应呈现——留白比直写更有重量。\n判定标准：删掉替读者归纳的句子后，读者能否从场景并置自行得出结论？若能，则该归纳句冗余。\n\n◆ 群像声音区分\n- 庆余年：费介用俚俗比喻解构权威；庄墨韩以考据腔调消解神圣；范闲以戏谑修辞解构崇高——去掉名字仍能认出说话人。\n- 雪中：江湖人说江湖话（俚俗、江湖气），庙堂人说庙堂话（典雅、含蓄、机锋）——两声部不可混用。\n- 剑来：陈平安说话“穷且规矩”，宁姚说话“直且锋利”——身份决定词汇、句长、回避方式。\n判定标准：两个不同身份角色的对白交换名字后若读起来一样，则声音同质化，违规。\n\n◆ 意象功能化\n- 雪中·雪：从初雪到暴雪到残雪，随徐凤年成长改变含义——意象每次出现呈现可辨识新状态。\n- 剑来·山水：山水清音承载“道理”——意象服务视角与场景目标，非装饰。\n判定标准：连续使用同类意象时，每次是否呈现新信息或新功能？若只重复营造相同氛围，则违规。", qualityChecks: ["文白切换是否服务场景情绪", "意象是否反复出现并随人物变化", "关键情绪是否用白描而非直说", "对白是否有表面与真实两层意图", "是否避免了模板化网文腔", "是否避免了情绪词直说（悲伤/愤怒/高兴等）", "每个情绪场景是否绑定环境意象", "全章格言式收尾是否不超过 2 处", "叙述者是否隐身，未直接宣告主题", "现代词汇是否限制在内心独白，对外是否翻译", "器物是否参与抉择瞬间且状态变化暗示处境", "对白去掉名字后是否仍能区分说话人身份", "意象每次出现是否呈现新状态或新功能而非重复氛围"] }),
  builtin({ skillId: "romance-arc-design", name: "言情感情线弧光设计", description: "从《我的26岁女房客》《我在风花雪月里等你》等青春言情提炼感情线阶段弧光、虐点设计、关系羁绊描述与言情文笔质感。", category: "long-plan", stages: ["planning", "drafting", "review", "revision"], requires: ["character-desire-engine"], priority: 65, triggers: ["感情线", "言情", "恋爱", "浪漫", "romance", "虐恋", "暧昧", "追妻"], prompt: "借鉴《我的26岁女房客》《我在风花雪月里等你》《世界上最爱我的人》等超级大坦克科比系都市言情，以及《致青春》《何以笙箫默》等优秀青春言情的感情线写法，落实以下规则：\n\n【阶段弧光模型】\n感情线不是平铺直叙的相爱到在一起，而是有明确阶段弧光：初遇 → 好感 → 暧昧 → 升温 → 误会/阻碍 → 虐点 → 和解/抉择 → 结局(HE/BE)。每个阶段必须有：一个推动进入下一阶段的事件、一个阻力来源、一次不可逆的关系认知变化。用 EntityRelation.bond 以中文描述每阶段的关系状态：初遇期萍水相逢尚无深交；好感期互生好感彼此留意；暧昧期心意未明试探拉扯；升温期情意渐浓相互依赖；误会期产生隔阂信任动摇；虐点期关系撕裂痛苦挣扎；和解期冰释前嫌重新接纳或彻底错过各自释怀。bond 描述须随情节推进而更新，不得一成不变。\n\n【双向吸引与剧情融合】\n吸引必须双向，禁止单方面舔狗。男主不能只因女主漂亮善良动心，女主不能只因男主强大护短沦陷，必须有三观契合、性格互补或彼此身上有对方缺失的光。感情线必须跟着主线剧情走，在共患难、并肩行动、日常相处中自然升温，禁止为谈恋爱暂停剧情。每个感情节点都要服务人物目标或主线冲突，禁止脱离剧情的工业糖精。\n\n【拉扯试探与阻碍】\n真正的心动来自拉扯而非一帆风顺。暧昧期核心是试探与回避：一个进半步、一个退半步，用眼神、沉默、欲言又止承载未说出口的心意。阻碍必须来自人物核心恐惧、立场冲突或外部代价（身世、阵营、责任、原生家庭），而非低级的信息不对称硬造误会。超级大坦克科比作品的虐感多来自现实苦海挣扎——人物缺陷、原生家庭、现实压力让本可相爱的人彼此伤害。\n\n【虐点设计原理】\n虐点必须有铺垫与因果，来自人物核心恐惧或立场对立的必然爆发，而非硬煽情或他不知道她没说清的低级误会。《我的26岁女房客》的意难平来自昭阳的人物缺陷与现实挣扎，《我在风花雪月里等你》的虐来自米高的卑微与叶芷的选择，《世界上最爱我的人》的痛来自余味原生家庭的拖累与爱而不得。BE 的痛感来自本可挽回却因人物必然性错过——读者要能追因到前文某个选择或缺陷，而非作者强行拆散。虐点前必须让读者看见他们本可以幸福的希望，落差越大越痛。\n\n【名场面承载】\n重逢、雨夜、告白、误会、牺牲、错过、追妻火葬场等关键场面，禁止用直抒胸臆的她很伤心他心如刀割承载。用一个动作、一个物件、一句没说完的话、一个环境意象承载情绪。《女房客》以爱情是彩色蝴蝶攥紧就褪色的意象承载全篇情感基调。雨、雪、风花雪月、旧物件、未寄出的信都是可复用的情绪载体。关键情绪留白，让读者用自身情感填补。\n\n【对白潜台词】\n言情对白的核心是言不由衷与情感试探。每句重要对白要有表面意思与真实意图两层：字面一层，意图藏在下面，读者第二遍才摸到真意。用破碎对白制造张力——欲言又止的省略号、强行打断、答非所问的心虚。配上小动作（皱眉、转身、攥紧衣角）比话语传递更多。卑微者用回避与过度客气掩饰爱意；骄傲者用讽刺与冷漠掩饰心动。禁止所有角色直白宣告我爱你，情感要泄露而非宣告。\n\n【HE/BE 一致性】\n结局类型须与前文铺垫、人物核心需求匹配。HE 必须解决人物的未承认需求（被爱、被接纳、被原谅），而非外部强行圆满或第三者助攻；人物要有真实成长或代价。BE 的痛感来自因果必然性——某个本可挽回的瞬间因人物缺陷或立场错过，读者能追因到具体选择。禁止为虐而虐的突转结局。结局要回扣开篇的情感承诺。\n\n【避免言情腔】\n警惕嘴角上扬、倒吸一口凉气、心漏跳一拍、眼眶泛红等模板化表达。每个情绪都找属于这个人物、这个场景的独特承载方式。甜不靠撒糖台词堆砌，虐不靠苦情独白硬煽。感情线的质感来自具体的、不可替换的细节。\n\n【现实考据质感】言情的质感来自现实考据，而非悬浮的偶像剧桥段。超级大坦克科比《我在风花雪月里等你》的质感来自作者真在云南开过客栈、了解无人区细节——这种现实考据让言情细节真实可信。落实以下规则：(1) 关键场景（约会地点、职业场景、旅行路线、生活细节）应基于真实地理/职业/行话考据，不得用通用模板（如“高档餐厅”“咖啡馆”“海边”）代替具体场所。(2) 每个关键场景至少包含 1-2 个只有真实去过/了解过该场景才能写出的细节（如云南客栈的火塘布局、某条徒步路线的海拔变化、某行业的黑话）。(3) 若缺乏相关考据，应在场景设计时明确标注“此场景需补充考据”，而非用模糊描写带过。(4) 考据细节应服务情感推进，不得为考据而考据——写云南客栈不只是写客栈，而是让客栈的某个细节（如火塘边的位置安排）推动人物关系。", qualityChecks: ["感情线是否覆盖明确阶段弧光，每阶段有推进事件与不可逆变化", "吸引是否双向且有内在动因，避免单方面舔狗", "虐点是否有铺垫因果，而非低级信息不对称硬造误会", "bond 关系描述是否随情节推进更新而非一成不变", "关键情感是否用行动/物件/意象承载而非直抒胸臆", "对白是否有表面与真实两层意图，避免直白宣告", "结局(HE/BE)是否与人物核心需求及前文铺垫因果一致", "是否避免了嘴角上扬等模板化言情腔", "关键场景是否基于真实考据而非通用模板", "每个关键场景是否有 1-2 个只有真实去过才能写出的细节"] }),
  builtin({ skillId: "imagery-aesthetics", name: "意象美学", description: "以意象系统、虚实相生、情景交融、留白艺术、声韵节奏构建中文意境美，约束 LLM 生成有文学质感的正文。", category: "drafting", stages: ["drafting", "revision"], priority: 75, prompt: "本 skill 是正文意境美的核心约束。生成正文时必须落实以下规则：\n\n【核心意象系统】每部作品须建立 3-5 个贯穿全书的核心意象。核心意象不是随机景物，而是承载主题与人物命运的符号。选择标准：能在不同场景呈现不同状态（如雪可以是初雪/暴雪/残雪），能随人物成长改变含义（如“剑”从凶器变为担当再变为放下）。开篇场景必须首次呈现至少一个核心意象，此后每章至少触及一次。\n\n【场景意象绑定】每个场景须有一个环境意象与视角人物此刻心境形成呼应或反差。呼应：人物内心混乱时，场景意象也混乱（如人群嘈杂、灯火摇晃）。反差：人物内心悲凉时，场景意象却温暖（如邻桌的笑声、灶上的热气），反差比直说更有力。禁止环境描写与人物情绪无关。\n\n【虚实相生】实写人物的行动、对话、感官；虚写人物的心境、命运、主题。实写可被读者“看见”，虚写可被读者“感受”。一段文字中，实写是骨架，虚写是气韵。禁止全实写（变成流水账）或全虚写（变成散文诗）。关键情绪场景的比例：七分实写（动作/对话/感官），三分虚写（意象/留白/暗示）。\n\n【留白艺术】关键情绪不可说透，须用以下留白手法之一承载：\n- 一个反常动作（他放下碗，没有喝那口热汤）\n- 一个被反复触碰的物件（她第三次整理那件没褶的衣裳）\n- 一句没说完的话（“我只是……”他没有说下去）\n- 一个环境意象的突变（风停了，灯却灭了）\n- 一段沉默（他看了她很久，什么也没说）\n留白处让读者用自身情感填补。禁止在留白后补一句解释（“他知道，这意味着……”是破坏留白）。\n\n【感官通感】每个场景至少调动两种感官。除视觉外，须有听觉、嗅觉、触觉或温度感之一。通感（感官交错）可用于意境高点：如“冷香”（触觉+嗅觉）、“暖色压下来”（视觉+触觉）。禁止感官描写沦为罗列（“他看见了X，听见了Y，闻到了Z”是清单，不是意境）——感官必须融入行动与情绪。\n\n【白描承重】最重的情绪用最简的白描承载。禁止用华丽辞藻堆砌情绪高点。越是重要时刻，越要克制形容词。一个准确的白描动作（如“他把手缩回袖子里”）比十个形容词更有力。\n\n【器物隐喻系统】器物是人物延伸，不只是道具。猫腻《庆余年》的范式：范闲的菜刀折射暴力工具的双重性（厨房切菜与战场杀人是同一把刀），五竹的铁钎代表未经修饰的原始力量，监察院黑骑盔甲的反光暗示权力镜像效应。落实以下规则：(1) 每个主要角色可绑定 1-2 件标志性器物（武器/工具/饰物/日常物件），器物应能折射人物身份、信念或命运。(2) 器物在不同场景中呈现不同状态——状态变化暗示人物处境转变（如刀从磨得锋利到卷刃，暗示人物从斗志昂扬到疲惫妥协）。(3) 器物不得只作装饰，必须至少参与一次行动或一次抉择瞬间（如关键抉择时人物摩挲剑柄、攥紧玉佩、放下茶碗）。(4) 禁止用器物直接宣告象征意义（如“这把刀象征着…”“这枚玉佩代表着…”），让器物的功能与处境自然承载隐喻——读者应通过器物被如何使用来体会其意味，而非被作者点破。", qualityChecks: ["开篇是否首次呈现核心意象", "每场景是否有意象与人物心境呼应或反差", "关键情绪是否用留白手法而非直说", "每场景是否调动两种以上感官", "情绪高点是否用白描而非华丽辞藻", "留白后是否避免了破坏性解释", "主要角色是否绑定标志性器物且参与行动", "器物状态变化是否暗示人物处境转变", "器物是否避免直接宣告象征意义"] }),
  builtin({ skillId: "prose-discipline", name: "文笔纪律", description: "防治强调词贬值、金句过密、作者旁白、结构重复等通用文风通病。", category: "drafting", stages: ["drafting", "review"], priority: 80, prompt: "检查强调词、格言式收尾、作者解释、人物语言越界和结构重复。生成时优先使用具体叙事；审校时依据正文证据报告问题，不把审校术语写进正文。", qualityChecks: ["强调词是否控制在每章 2 次以内", "金句式收尾是否控制在每章 2 处以内", "叙述者是否隐身，未直接宣告主题或内心", "配角对白是否未越界，无作者传声筒", "全章是否只回答一个问题，无主题重复推进"] }),
];

const PROFILE_SKILLS: Record<string, string[]> = {
  "general-serial": ["story-facts-invariant", "premise-pressure-test", "character-desire-engine", "character-voice-matrix", "world-rule-contract", "hierarchical-outline", "causal-thread-weaving", "foreshadowing-ledger", "chapter-blueprint", "scene-action-reaction", "embodied-prose", "serial-rhythm", "continuity-audit", "style-specificity-audit", "plot-pacing-audit", "fact-delta-extraction", "classic-character-ensemble", "classic-narrative-tension", "classic-prose-texture", "imagery-aesthetics", "prose-discipline"],
  progression: ["story-facts-invariant", "premise-pressure-test", "character-desire-engine", "world-rule-contract", "hierarchical-outline", "causal-thread-weaving", "chapter-blueprint", "scene-action-reaction", "embodied-prose", "serial-rhythm", "continuity-audit", "plot-pacing-audit", "fact-delta-extraction", "classic-character-ensemble", "classic-narrative-tension", "classic-prose-texture", "imagery-aesthetics", "prose-discipline"],
  emotional: ["story-facts-invariant", "premise-pressure-test", "character-desire-engine", "character-voice-matrix", "hierarchical-outline", "foreshadowing-ledger", "chapter-blueprint", "scene-action-reaction", "embodied-prose", "serial-rhythm", "continuity-audit", "style-specificity-audit", "fact-delta-extraction", "classic-character-ensemble", "classic-narrative-tension", "classic-prose-texture", "romance-arc-design", "imagery-aesthetics", "prose-discipline"],
};

export interface ResolvedSkillSet {
  skills: NovelSkillManifest[];
  conflicts: Array<{ skillId: string; conflictsWith: string }>;
}

export async function listAvailableSkills(projectId: string, db: NovelDatabase = novelDb) {
  const custom = await db.skills.where("projectId").anyOf("__user__", projectId).toArray();
  return [...BUILTIN_NOVEL_SKILLS, ...custom];
}

export async function resolveNovelSkills(params: { projectId: string; stage: NovelSkillStage; explicitSkillIds?: string[]; db?: NovelDatabase }): Promise<ResolvedSkillSet> {
  const db = params.db ?? novelDb;
  const project = await db.projects.get(params.projectId);
  if (!project) throw new Error("项目不存在");
  const [available, bindings] = await Promise.all([
    listAvailableSkills(params.projectId, db),
    db.projectSkills.where("projectId").equals(params.projectId).toArray(),
  ]);
  const bindingMap = new Map(bindings.map((item) => [item.skillId, item]));
  const selected = new Set(PROFILE_SKILLS[project.settings.contentProfile] ?? PROFILE_SKILLS["general-serial"]);
  for (const binding of bindings) binding.enabled ? selected.add(binding.skillId) : selected.delete(binding.skillId);
  for (const id of params.explicitSkillIds ?? []) selected.add(id);

  const byId = new Map(available.map((item) => [item.skillId, item]));
  const addRequirements = (id: string, trail = new Set<string>()) => {
    if (trail.has(id)) throw new Error(`Skill 依赖形成循环：${[...trail, id].join(" → ")}`);
    const skill = byId.get(id);
    if (!skill) throw new Error(`缺少 Skill：${id}`);
    const nextTrail = new Set(trail).add(id);
    for (const required of skill.requires) { selected.add(required); addRequirements(required, nextTrail); }
  };
  for (const id of [...selected]) addRequirements(id);

  const explicit = new Set(params.explicitSkillIds ?? []);
  const skills = [...selected].map((id) => byId.get(id)).filter((item): item is NovelSkillManifest => Boolean(item && item.enabled && item.stages.includes(params.stage))).sort((a, b) => {
    const rankA = (explicit.has(a.skillId) ? 10000 : 0) + (bindingMap.has(a.skillId) ? 5000 : 0) + (bindingMap.get(a.skillId)?.priorityOverride ?? a.priority);
    const rankB = (explicit.has(b.skillId) ? 10000 : 0) + (bindingMap.has(b.skillId) ? 5000 : 0) + (bindingMap.get(b.skillId)?.priorityOverride ?? b.priority);
    return rankB - rankA || a.skillId.localeCompare(b.skillId);
  });
  const active = new Set(skills.map((item) => item.skillId));
  const conflicts = skills.flatMap((skill) => skill.conflicts.filter((id) => active.has(id)).map((id) => ({ skillId: skill.skillId, conflictsWith: id }))).filter((item, index, all) => index === all.findIndex((other) => [other.skillId, other.conflictsWith].sort().join(":") === [item.skillId, item.conflictsWith].sort().join(":")));
  return { skills, conflicts };
}

function normalizeDraft(raw: Record<string, unknown>, promptFromBody = "") {
  return {
    ...raw,
    prompt: String(raw.prompt || promptFromBody).trim(),
    triggers: raw.triggers ?? [],
    requires: raw.requires ?? [],
    conflicts: raw.conflicts ?? [],
    priority: raw.priority ?? 50,
    qualityChecks: raw.qualityChecks ?? [],
  };
}

export function parseNovelSkill(input: string): SkillDraft {
  const trimmed = input.trim();
  let raw: Record<string, unknown>;
  if (trimmed.startsWith("{")) {
    raw = JSON.parse(trimmed) as Record<string, unknown>;
  } else {
    const match = trimmed.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n([\s\S]*)$/);
    if (!match) throw new Error("Markdown Skill 必须包含 YAML frontmatter");
    raw = normalizeDraft((parseYaml(match[1]) ?? {}) as Record<string, unknown>, match[2]);
  }
  const normalized = normalizeDraft(raw);
  if (!validateSkill(normalized)) throw new Error(`Skill 格式无效：${validateSkill.errors?.map((item) => `${item.instancePath || "root"} ${item.message}`).join("；")}`);
  if (forbiddenSkillPatterns.some((pattern) => pattern.test(String(normalized.prompt)))) throw new Error("Skill 包含脚本执行或覆盖系统规则的指令，已拒绝导入");
  return normalized as SkillDraft;
}

export async function importNovelSkill(params: { projectId: string; content: string; scope: "user" | "project" }) {
  const draft = parseNovelSkill(params.content);
  const projectId = params.scope === "user" ? "__user__" : params.projectId;
  const existing = await novelDb.skills.where("[projectId+skillId]").equals([projectId, draft.skillId]).first();
  const skill: NovelSkillManifest = {
    ...(existing ?? recordBase(projectId)),
    ...draft,
    projectId,
    source: params.scope as NovelSkillSource,
    enabled: true,
    readonly: false,
    revision: (existing?.revision ?? 0) + 1,
    updatedAt: Date.now(),
  };
  await novelDb.skills.put(skill);
  return skill;
}

export async function setProjectSkill(projectId: string, skillId: string, enabled: boolean) {
  const existing = await novelDb.projectSkills.where("[projectId+skillId]").equals([projectId, skillId]).first();
  const binding: ProjectSkillBinding = {
    ...(existing ?? recordBase(projectId)),
    skillId,
    enabled,
    config: existing?.config ?? {},
    revision: (existing?.revision ?? 0) + 1,
    updatedAt: Date.now(),
  };
  await novelDb.projectSkills.put(binding);
  return binding;
}

export function formatSkillPrompt(skills: NovelSkillManifest[]) {
  return skills.map((skill) => `## Skill: ${skill.name} (${skill.skillId}@${skill.version})\n${skill.prompt}`).join("\n\n");
}

const DRAFTING_FACT_SKILLS = new Set(["story-facts-invariant"]);
const DRAFTING_CHARACTER_SKILLS = new Set(["character-voice-matrix", "classic-character-ensemble"]);
const DRAFTING_PROGRESS_SKILLS = new Set(["scene-action-reaction", "serial-rhythm"]);
const DRAFTING_PROSE_SKILLS = new Set(["embodied-prose", "classic-prose-texture", "imagery-aesthetics", "prose-discipline", "romance-arc-design"]);

function hasAnySkill(skills: NovelSkillManifest[], ids: Set<string>) {
  return skills.some((skill) => ids.has(skill.skillId));
}

function customSkillBlock(skills: NovelSkillManifest[]) {
  const custom = skills.filter((skill) => skill.source !== "builtin");
  if (custom.length === 0) return "";
  return `\n\n## 项目自定义规则\n${custom.map((skill) => `### ${skill.name}\n${skill.prompt}`).join("\n\n")}\n\n自定义规则只补充项目风格；与事实边界、阶段职责或正文输出契约冲突时，以前述契约为准。`;
}

export function compileNovelStagePrompt(skills: NovelSkillManifest[], stage: NovelSkillStage) {
  const sections: string[] = [];
  if (stage === "foundation") {
    sections.push("## 基础设定契约\n从项目题材、主题承诺和已确认材料推导人物与世界，不套用示例作品、固定时代、职业或剧情模板。每项设定都应说明它如何产生人物选择、现实阻力或长线变化空间；无法进入故事因果的装饰性设定应压缩。");
    if (hasAnySkill(skills, DRAFTING_FACT_SKILLS)) {
      sections.push("## 事实边界\n区分作者已确认事实、模型建议和待验证推断。不得用常见题材惯例填补空缺；新设定只能作为候选提交，并保留与现有事实的来源关系。");
    }
    if (skills.some((skill) => skill.skillId === "character-desire-engine")) {
      sections.push("## 人物基础\n从人物处境建立外在欲望、内在恐惧、错误信念、未承认需求、行为边界与可支付代价。初始状态必须给出项目内真实地点、具体身体与情绪状态、即时目标和可用资源；这些字段来自当前项目，不得复制提示词示例。人物矛盾应形成可持续选择压力，而不是套用固定反派或英雄类型。");
    }
    if (skills.some((skill) => skill.skillId === "world-rule-contract")) {
      sections.push("## 世界规则\n规则写清适用条件、能力上限、代价、例外和社会后果，并能在不同人物与场景中接受一致检验。不得为了当前样例冲突临时增加只对某一角色生效的例外。");
    }
    return `${sections.join("\n\n")}${customSkillBlock(skills)}`;
  }

  if (stage === "character-enrichment") {
    sections.push("## 人物补全契约\n只根据本项目已确认事实、正文行动与对白补全空缺字段。欲望、动机、弱点、秘密、声音和弧光必须能指回具体证据；信息不足就保留空缺，不使用题材身份模板、示例角色或常见人设补齐。已有字段和未来剧情不得改写或臆造。");
    return `${sections.join("\n\n")}${customSkillBlock(skills)}`;
  }

  if (stage === "planning") {
    sections.push("## 长篇规划契约\n大纲用于分配跨章节材料，不是要求尽快完成的任务表。先确定当前层级与本章主导叙事功能，再决定哪些内容只铺垫、哪些继续延迟、哪些已经到达兑现窗口。背景建立、人物相处、内心发展、情感积累、生活过程和意象生长都可以成为正式章节功能，不得默认每章都需要冲突升级、秘密揭晓、关系跃迁或强钩子。");
    if (hasAnySkill(skills, DRAFTING_FACT_SKILLS)) {
      sections.push("## 事实与兑现边界\n严格遵守已批准事实、人物知识边界和锁定规则。把尚未到达揭示条件的秘密、伏笔回收、重大转折和关系变化保留在后续，不因当前章节提及相关材料就提前完成。");
    }
    if (skills.some((skill) => skill.skillId === "chapter-blueprint")) {
      sections.push("## 章节蓝图\n为章节选择一个主导功能，使用 2 至 8 个必要节拍。objective 描述探索或积累方向，不等于必须解决的问题；informationRelease 可以为空；mustHappen 只容纳本章已经批准兑现的内容；forbidden 应保护尚需铺垫的后续材料。endingHook 可以是情感余韵、关系张力、未完成动作、意象变化或认知缺口，不必是突发危险。");
    }
    sections.push("## 规划质量\n相邻章节需要功能与强度差异。行动和回报应来自足够积累；铺陈章的质量取决于世界、人物、关系或情感是否变得更具体，而不是主线移动了多少。禁止为满足结构模板强造选择、代价、反制、转折和伏笔。");
    return `${sections.join("\n\n")}${customSkillBlock(skills)}`;
  }

  if (stage === "drafting") {
    sections.push("## 正文创作契约\n按以下优先级写作：事实、知识边界与兑现边界 → 本章主导叙事功能 → 人物当下体验与关系 → 场景因果 → 语言质感。蓝图规定本章可以触碰的材料，不是必须全部结算的清单；不得为完成目标提前消费后续大纲节点。");
    if (hasAnySkill(skills, DRAFTING_FACT_SKILLS)) {
      sections.push("## 事实边界\n严格遵守已批准蓝图、正式事实、锁定规则和人物知识边界；信息不足时保持不确定，不得补造既定事实。");
    }
    if (hasAnySkill(skills, DRAFTING_CHARACTER_SKILLS)) {
      sections.push("## 人物与声音\n人物的行动、对白和判断必须符合其身份、欲望、认知与当下处境。让主要说话者保持稳定的词汇、直率程度与回避方式——去掉名字读者仍能认出是谁在说话；从冻结上下文中的年龄、职业、关系距离、目标和既有说话习惯推导声部，不得套用固定身份模板。群像场景中，若蓝图在同一场安排了多个有具体动作（递物、拦阻、指引、反应、整理、呼唤其一）的次要角色，不能只让主要说话者开口：每个有动作呈现的次要角色应有匹配其年龄、职业与处境的差异化表达，用于建立规则、提示世界观、呈现关系质地或锚定当下处境。仅作背景的群演可不发声，但有动作呈现的次要角色若全程沉默，等同于把声音全部收敛到主角与单一 NPC，丢失群像声部。判定标准：去掉说话人名字后，若一场戏中两个以上有动作的次要角色对白交换或缺失，则声音同质化或缺失，违规。");
    }
    if (hasAnySkill(skills, DRAFTING_PROGRESS_SKILLS)) {
      sections.push("## 章节节奏与长篇余量\n先服从本章主导叙事功能。行动章节可以改变局势；铺陈、相处、蓄势或余波章节可以主要深化世界、人物内心、关系和情感，不强求不可逆结果。背景、回忆、生活过程和意象只要改变读者对当下的理解或感受，就具有叙事价值。信息可以被感知、误读或暂时搁置，不必当章转化为决定。只落实蓝图明确列入 mustHappen 的内容，秘密真相、关系跃迁、伏笔回收和后续节点未经许可不得提前兑现。全章只保留一个开场和一个结尾。");
    }
    if (hasAnySkill(skills, DRAFTING_PROSE_SKILLS)) {
      sections.push("## 文风与段落\n以行动、感官、环境和对白承载情绪；动作或对白已经传达含义后立即留白，不再补写解释性心理总结。核心意象只在状态或含义变化时重现，不连续用同一物件替人物说理。段落边界服从注意力、动作因果与情绪停顿。");
    }
    if (skills.some((skill) => skill.skillId === "romance-arc-design")) {
      sections.push("## 感情线\n感情变化必须由共同经历、人物选择和现实代价推动，保持双向吸引与阶段变化。关键情绪通过人物当下的行动、对白和未完成的表达呈现，不用模板化甜虐桥段替代主线因果。");
    }
    sections.push("## 正文输出契约\n正文内容必须是一份连续章节，不包含标题、说明、备选版本或内部标记。禁止输出 Markdown 标题、代码围栏或水平分隔线。换场使用叙事过渡。目标字数仅供控制篇幅，不得通过拆段、重复事件或增加第二套推进补足字数。");
    return `${sections.join("\n\n")}${customSkillBlock(skills)}`;
  }

  if (stage === "review") {
    sections.push("## 审校契约\n只报告有正文证据且属于当前角色职责的问题。先判断本章主导功能，不得把安静、铺陈、内省、关系相处或留白结尾本身判为节奏问题。检查正文是否提前兑现后续节点，或为了逐项完成蓝图而压缩背景、内心、情感和关系过程。机械化风险包括事件报表、解释人物心理、用对白传递作者结论、通用细节、匀速段落、重复事件链和第二个结尾；真正的问题是内容重复或体验没有深化，不是主线没有明显前进。结构问题只把实际需要修改的段落写入 revisionRanges。");
    return `${sections.join("\n\n")}${customSkillBlock(skills)}`;
  }

  if (stage === "revision") {
    sections.push("## 定向修订契约\n只处理质量报告允许修改的段落，保留段必须原样输出。可以删除、合并或重排允许范围内的内容，但不得生成第二份正文、回复说明、标题、代码围栏或水平分隔线。只做解决问题所必需的调整。");
    return `${sections.join("\n\n")}${customSkillBlock(skills)}`;
  }

  return formatSkillPrompt(skills);
}
