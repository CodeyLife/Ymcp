import Ajv from "ajv";
import { parse as parseYaml } from "yaml";
import { novelDb, recordBase } from "./db";
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
    beats: { type: "array", minItems: 4, items: { type: "object", required: ["action", "emotion", "outcome"], properties: { action: { type: "string" }, emotion: { type: "string" }, outcome: { type: "string" } } } },
    endingHook: { type: "string" }, mustHappen: { type: "array", items: { type: "string" } }, forbidden: { type: "array", items: { type: "string" } },
  },
};

export const BUILTIN_NOVEL_SKILLS: NovelSkillManifest[] = [
  builtin({ skillId: "story-facts-invariant", name: "故事事实优先", description: "区分已确认事实、角色认知、推测和创作建议。", category: "memory", stages: ["foundation", "planning", "drafting", "review", "revision", "fact-extraction"], priority: 1000, prompt: "已确认的故事事实、锁定规则和人物知识边界优先于任何写作技巧。不得把建议写成既定事实；发生冲突时必须指出冲突并停止提交相关变更。", qualityChecks: ["不得违反锁定事实", "角色只能使用已知或合理推断的信息"] }),
  builtin({ skillId: "premise-pressure-test", name: "核心创意压力测试", description: "检查故事承诺、持续冲突和长篇扩展空间。", category: "ideation", stages: ["foundation"], prompt: "从主角主动目标、持续阻力、失败代价、题材承诺、差异化机制和至少三次升级空间检查核心创意。不要用空泛主题代替可发生的戏剧行动；但'可发生的戏剧行动'指的是能在场景里铺陈的具体处境、选择与情感波澜，不是指一上来就要把核心冲突与转折点写到梗概和大纲首句。主题应在故事中自然浮现，而非被宣告。" }),
  builtin({ skillId: "character-desire-engine", name: "人物欲望引擎", description: "用欲望、恐惧、错误信念、真实需求和代价构造人物。", category: "character-world", stages: ["foundation", "planning", "review"], prompt: "为主要人物明确外在欲望、内在恐惧、错误信念、未承认的需求、道德边界和愿意支付的代价。人物选择必须由这些力量推动，而不是服务作者方便。" }),
  builtin({ skillId: "character-voice-matrix", name: "角色声音矩阵", description: "区分角色词汇、句长、回避方式、潜台词与情绪泄露。", category: "character-world", stages: ["drafting", "review", "revision"], prompt: "让角色仅凭对白也可辨认。依据教育、关系权力、当前目标和回避习惯控制词汇、句长、直接程度、语气词、潜台词与沉默；禁止所有角色共享同一书面腔。\n\n【身份认知边界】人物的对白必须符合其教育、阶层、职业和当下处境。戍卒说戍卒的话，不说哲学家的话；屠户说屠户的话，不说读书人的话。判断标准：若把该台词换给另一个身份的人物仍成立，则它没有区分度。配角尤其不可成为“替作者点题的传声筒”——若一句台词的主要功能是宣告主题而非推进该人物的当下目标，必须改写或删除。\n\n【穿越者人味】若主角为穿越/异世界设定，除分析特质外必须呈现其人的感受：饥饿、疲惫、寒冷、孤独、对旧世界的残存记忆、身份缺失的失重感。一个穿着死人衣服站在冬日荒地里的现代人，不可能只有“建模”没有恐惧和不适。每章至少有一处主角作为“人”而非“分析机器”的感受外化。" }),
  builtin({ skillId: "world-rule-contract", name: "世界规则契约", description: "把能力、社会和物理规则写成带代价的可验证约束。", category: "character-world", stages: ["foundation", "planning", "review"], prompt: "世界规则必须写清适用条件、能力上限、代价、例外和社会后果。解决冲突不得临时创造无铺垫规则；新增例外必须形成待审事实。" }),
  builtin({ skillId: "hierarchical-outline", name: "分层剧情控制", description: "从全书阶段到幕、序列和故事事件逐级分解。", category: "long-plan", stages: ["planning"], prompt: "长篇是循序渐进的铺陈，不是主题宣告。先经营人物处境、世态背景与情感底色，让上层叙事承诺与阶段变化在事件铺陈中自然显现，而非在梗概首句直白写出。大纲只表达故事因果，不绑定章节；每个下层节点必须服务至少一个上层目标。戏剧性要素（转折、伏笔、悬念）应作为布局埋设，不作为口号宣告。" }),
  builtin({ skillId: "causal-thread-weaving", name: "因果与剧情线编织", description: "避免事件清单和支线失踪。", category: "long-plan", stages: ["planning", "review"], prompt: "每个重要事件标注原因、触发条件、阻碍、直接结果和延迟后果。主线与支线通过共同人物、资源、秘密或选择相互改变，不能仅轮流出现。" }),
  builtin({ skillId: "foreshadowing-ledger", name: "伏笔账本", description: "规划埋设、提醒、误导、揭示和回收。", category: "long-plan", stages: ["planning", "review", "fact-extraction"], prompt: "伏笔必须记录读者可见线索、角色可知范围、预期误读、提醒频率、揭示条件和回收影响。揭示前不得让角色无来源地知道真相。" }),
  builtin({ skillId: "chapter-blueprint", name: "章节蓝图", description: "先产出可审批、可执行的章节节拍。", category: "chapter", stages: ["planning"], requires: ["story-facts-invariant"], outputSchema: chapterBlueprintSchema, priority: 200, prompt: "章节蓝图必须包含具体目标、精确起点、4至10个行动节拍、每个节拍的情绪反应与结果、信息释放、转折、章尾钩子、必须发生与禁止事项。节拍要足够具体但不代写正文。" }),
  builtin({ skillId: "scene-action-reaction", name: "行动与反应场景", description: "用目标、冲突、结果和反应、两难、决定形成推进。", category: "chapter", stages: ["planning", "drafting", "review"], prompt: "行动场景围绕目标、阻碍和不可逆结果展开；重大结果后安排必要的情绪反应、选择权衡和新决定。呼吸段必须改变理解或决定，不能停滞。" }),
  builtin({ skillId: "embodied-prose", name: "具象场景正文", description: "用行动、感官和选择承载情绪与信息。", category: "drafting", stages: ["drafting", "revision"], prompt: "正文优先呈现人物正在做什么、注意到什么、误读什么和选择什么。抽象总结要落回可观察行动、具体感官、环境阻力或有代价的对白。感官细节必须服务视角与场景目标。\n\n【禁止宣告式总结】禁止用“他第一次意识到”“他第一次发现”“他突然明白了”等结构直接宣告认知转变。认知转变必须通过一个具体事件的冲击来呈现：他看见某物、听见某话、做某事失败，然后行为发生可见改变。“他第一次把信任加入模型”是宣告，“他没有划第二道线，只是看了很久那个走进城门的老人”是展示。\n\n【判断须有依据】人物的判断和分析必须基于已观察到的具体信息，不可凭空得出。若人物得出结论，前文必须已呈现其观察过程。禁止“主角初到某地却对其运行规律做出精确判断”——若无观察积累，判断必须是试探性的、可能出错的。" }),
  builtin({ skillId: "serial-rhythm", name: "通用连载节奏", description: "控制章节承诺、推进、阶段回报和下一章驱动力。", category: "serial", stages: ["planning", "drafting", "review"], prompt: "每章开头尽快建立当章问题，中段至少发生一次局势变化，结尾产生新的决定、代价、危险或认知缺口。回报必须来自此前阻力和人物行动，不按固定字数机械插入爽点。\n\n【单章单尾】一章只有一个结尾。若前半段已形成完整的主题收束（如“活下去。不够。他要知道为什么”），后半段不可重复同一主题的二次收束。后半段必须推进到新的认知或行动层面，而非重述前半段已讲透的点。\n\n【禁重复推进】全章不可两次回答同一个问题。若前半段已展示“模型遇到人会失效”，后半段不可再用另一个例子重述同一结论。后半段要么升级（人物开始尝试新方法），要么转向（人物发现新的未知维度）。" }),
  builtin({ skillId: "continuity-audit", name: "连续性审校", description: "检查时间、空间、知识、物品、规则和因果。", category: "review", stages: ["review"], requires: ["story-facts-invariant"], priority: 180, prompt: "逐段核对人物位置与移动、故事时间、环境、角色知识、重要物品归属、世界规则和前因后果。只报告有上下文证据的矛盾，并引用冲突来源。" }),
  builtin({ skillId: "style-specificity-audit", name: "文风与具体性审校", description: "检查视角、语言具体性、重复和模板化表达。", category: "review", stages: ["review"], prompt: "检查叙述距离、视角稳定、句段节奏、抽象情绪、重复意象和模板化动作。高频词统计只形成警告；必须结合人物声音和项目风格判断，不能机械判错。\n\n【强调词贬值】统计“第一次”“突然”“忽然”“终于”“竟然”等强调词的频次。单章同一强调词出现超过 2 次即判定为贬值，须替换或删除。特别注意“第一次+动词”结构（第一次意识到/发现/明白/感到）的堆叠。\n\n【短句tic】检测连续 3 个以上独立名词或短语成段排比的句式（如“速度。力量。肌肉变化。呼吸节奏。”）。单章此类排比不超过 2 处，且每处必须服务明确的节奏目的（如极度紧张或决断瞬间），不可作为常规叙述手段。\n\n【金句收尾密度】检测以格言式、总结式、哲理式句子结尾的段落。单章超过 3 处即判定为“金句过密”，须将部分金句改为行动或沉默。\n\n【人物语言越界】检查配角对白是否超出其身份认知。底层人物（兵卒、农人、流民）不可说出哲学总结或抽象道理。若发现配角台词像“作者传声筒”，须改为符合其身份的朴素表达，或用行动代替说教。" }),
  builtin({ skillId: "plot-pacing-audit", name: "剧情与节奏审校", description: "验证节拍落实、局势变化、钩子和回报。", category: "review", stages: ["review"], prompt: "比较蓝图与正文，检查必须节拍、人物选择、因果推进、场景功能、信息释放、张弛变化和章尾驱动力。区分结构阻断与审美建议。" }),
  builtin({ skillId: "fact-delta-extraction", name: "事实差异提取", description: "从已批准正文提取带证据的结构化变化。", category: "memory", stages: ["fact-extraction"], requires: ["story-facts-invariant"], priority: 220, prompt: "只提取正文明确陈述或强烈蕴含的新事实、角色状态、知识、关系、物品、时间线、剧情线和伏笔变化。每项必须引用原文证据、给出置信度并标记新增、更新、重复或冲突；不得直接提交。\n\n【关系(relations)提取规则】\n- 新建立的关系：novelty='new'，field='record'，after 提供完整对象 {fromEntityId, toEntityId, relationType, bond, publicLabel, privateTruth}。fromEntityId/toEntityId 必须是上下文中真实存在的角色 ID。bond 用中文描述两人关系状态（如“关系亲密，已建立信任，近期因误会产生隔阂”）。\n- 现有关系的状态变化（如关系从亲密转为疏远）：novelty='update'，targetId 填关系 ID，field='bond'，before 填旧描述，after 填新的中文描述。\n- 关系类型的变化（如从'同伴'变为'对手'）：novelty='update'，field='relationType'。\n- 不得为已存在的角色对重复提取 new 关系；若正文未明确体现关系变化，不要强行提取。" }),
  builtin({ skillId: "classic-character-ensemble", name: "经典人物群像法", description: "从《雪中悍刀行》《剑来》《庆余年》提炼群像塑造、出场即性格、对话即性格的写法。", category: "character-world", stages: ["foundation", "planning", "drafting", "review"], priority: 60, prompt: "借鉴《雪中悍刀行》《剑来》《庆余年》等网文经典的人物塑造法，落实以下规则：\n\n【群像生态】每个重要配角必须拥有独立欲望、资源与代价，不能只服务主角剧情。配角之间要形成关系网（恩怨、利益、秘密），让世界因他们而运转。雪中温华、剑来宁姚、庆余年陈萍萍之所以立得住，在于他们有不在主角面前时也成立的人生。\n\n【出场即性格】人物首次登场需用一个“标志性动作+一句辨识度对白+一个反差细节”立住形象。拒绝先大段外貌描写再补性格的流水账。李淳罡出场即“羊裘裘老头拎羊脂玉”，陈平安出场即“穷且规矩”。\n\n【对话即性格】对白要承载人物的教育、出身、当下意图与回避。江湖人说江湖话，庙堂人说庙堂话，市井人说市井话。禁止所有角色共享同一书面腔。烽火的人物对白常带“言在此而意在彼”的潜台词，猫腻的对白常带从容的幽默与机锋。\n\n【弧光与代价】主角成长必须伴随真实代价（失去、误解、道德妥协），不能只升不降。陈平安的成长伴随着“道理越讲越沉”的代价，范闲的快意伴随着“身在庙堂不由己”的代价。每个阶段的选择都要回扣人物的核心恐惧与未承认需求。\n\n【留白与暗示】不把人物内心全部写透。用动作、沉默、物件、环境暗示人物状态。雪中常用“某人没说话，只是做了某事”来承载情绪。让读者通过拼图理解人物，而非作者直接宣告。", qualityChecks: ["配角是否有独立于主角的欲望与场景", "首次登场是否用动作/对白立住性格", "对白是否区分了人物身份与意图", "成长是否伴随真实代价", "是否避免了作者直接宣告人物内心"] }),
  builtin({ skillId: "classic-narrative-tension", name: "经典叙事张力法", description: "从《雪中悍刀行》《剑来》《庆余年》提炼悬念、伏笔、节奏与长线布局的叙事法。", category: "long-plan", stages: ["planning", "review"], priority: 60, prompt: "借鉴《雪中悍刀行》《剑来》《庆余年》等网文经典的叙事张力构建法。这些经典的共同特点不是急于宣告主题，而是用绵长的铺陈让戏剧性在事件流中自然生长——雪中徐凤年的成长用上百章温养，剑来陈平安的道理用一砖一瓦垒起。规划时不要把悬念、伏笔、转折当作必须尽快展示的清单，而要当作埋在土壤里的种子，让它们在合适的章节自然发芽。以下规则在此前提下落实：\n\n【悬念分层】每章至少埋一个“章尾钩子”（短期悬念），每幕至少推进一个“中期谜题”（数十章到百章级），全书贯穿一到两个“核心悬念”（雪中“徐凤年为何而活”、剑来“陈平安的道理”）。三层悬念并行，读者在任何尺度都有期待。\n\n【伏笔的延迟回收】伏笔要“埋得自然、提得克制、收得有力”。雪中“温华断臂”前铺垫极长，回收时爆发出巨大情感。禁止埋伏笔时大张旗鼓（如“他不知道这个决定将改变一切”），让伏笔以日常细节形态存在。回收时要让读者恍然“原来早有线索”，而非作者强行解释。\n\n【张弛与节奏】网文的节奏不是“每章爽点”，而是“阻力—推进—回报”的呼吸。雪中常见“三章蓄势、一章爆发”的节奏。爆发章要兑现此前积累的期待，蓄势章要制造新的认知缺口或情感压力。禁止用固定字数机械插入爽点，回报必须来自此前阻力与人物行动。\n\n【长线布局】长篇要有“阶段不可逆变化”。雪中徐凤年从“纨绔世子”到“北凉王”再到“江湖人”，每个阶段都有不可逆的身份与认知转变。规划时先定阶段转折点，再回填事件。转折点要让人物“回不去了”，而非“又升了一级”。\n\n【支线反哺主线】支线不能只是主线休息站。剑来的支线（如山崖书院、剑气长城）最终都反哺陈平安的核心命题。支线要通过共享人物、资源、秘密或主题与主线相互改变，而非轮流出现。每条支线都要回答“它如何改变了主线人物的选择”。\n\n【留白叙事】有些最重要的信息用“不写”来写。雪中李淳罡的过去、剑来某些大人物的图谋，常通过他人反应、环境变化、片段暗示来呈现。规划时明确“哪些信息延迟揭示”“哪些信息永不揭示”“哪些信息用侧面呈现”。", qualityChecks: ["是否埋设了章尾/幕级/全书三层悬念", "伏笔是否以日常形态埋设而非大张旗鼓", "回报是否来自此前阻力而非机械插入", "阶段转折是否造成不可逆变化", "支线是否反哺主线人物选择"] }),
  builtin({ skillId: "classic-prose-texture", name: "经典文笔质感法", description: "从《雪中悍刀行》《剑来》《庆余年》提炼句式节奏、意境营造、白描留白的文笔法。", category: "drafting", stages: ["drafting", "revision"], priority: 70, prompt: "借鉴《雪中悍刀行》《剑来》《庆余年》等网文经典的文笔质感，落实以下规则：\n\n【文白交织】重要场景、情绪高点、意境段落可适度使用半文半白的句式，日常推进用洗练白话。雪中“天不生我李淳罡，剑道万古如长夜”是文白交织的典范。禁止全篇文言或全篇口水白话，要让文白根据场景情绪自然切换。\n\n【句式节奏】长短句交错，短句承载冲击与决断，长句承载铺陈与心理。爆发段落用短句甚至单字段：“剑出。人头落。”抒情段落用绵长句。禁止通篇中等长度句的“匀速感”。每段要有节奏起伏，像呼吸。\n\n【意境营造】用环境意象承载人物情绪与主题。雪中常以“雪”“剑”“酒”为核心意象，剑来常以“山水”“道理”为核心意象。意象要反复出现并随人物成长变化含义。禁止空洞堆砌华丽辞藻，意象必须服务视角与场景目标。\n\n【白描与留白】用最少的字写最重的情。雪中温华出场、剑来陈平安父亲之死，都用极简白描承载巨大情感。关键情绪不要直说“他很悲伤/愤怒”，而用一个动作、一个物件、一句没说完的话来承载。留白处让读者用自己的情感填补。\n\n【对白的机锋】高质量对白要“话里有话”。猫腻的对白常带从容的幽默与机锋，烽火的对白常带“言在此而意在彼”的江湖气。对白不是信息传递工具，而是人物博弈、情感试探、立场宣示的场域。每句重要对白都要有“表面意思”与“真实意图”两层。\n\n【感官与画面感】每个场景至少调动两种以上感官（视觉、听觉、嗅觉、触觉、温度）。雪中的“大雪压剑”、剑来的“山水清音”都是有强感官的画面。画面感不等于华丽，而在于让读者“看见”“听见”“感受到”。\n\n【避免网文腔】警惕“恐怖如斯”“倒吸一口凉气”“嘴角上扬”等模板化表达。文笔的质感来自具体而非套话。每个情绪都找属于这个人物、这个场景的独特表达方式。\n\n【情绪不可直说】禁止用“他很悲伤/愤怒/高兴/害怕/孤独”等情绪词直接宣告人物感受。情绪必须通过以下方式之一承载：一个反常动作（如攥紧又松开）、一个环境意象的变化（如灯火晃了一下）、一句没说完的话、一个物件被反复触碰。唯一例外：极度情绪爆发点可用一个短句点破，每章不超过一次。\n\n【意象密度】每个情绪场景至少绑定一个环境意象，用意象的状态变化暗示人物内心。意象不可是装饰，必须与视角人物此刻的心境形成呼应或反差。全书应建立 3-5 个核心意象（如雪、剑、灯、路、井），让它们随人物成长改变含义。\n\n【金句控制】禁止每段都以格言式句子收尾。全章格言式收尾不超过 2 处，且必须由人物对白或行动自然引出，不可由叙述者宣告。判断标准：若删除该句，段落意思不变，则它是多余的宣告。\n\n【作者隐身】禁止叙述者直接宣告主题、人物内心或世界规则。主题必须藏在人物的选择与代价里；人物内心必须通过行动和感官外化；世界规则必须通过人物遭遇体现。“他想：这个世界没有算法”是宣告，“他盯着城门看了很久，没有划下第二道线”是外化。\n\n【现代词汇边界】穿越/异世界设定下，现代概念词（模型、变量、算法、系统、模块、字段、量化、输入、输出）只允许出现在主角内心独白中。主角对外说话时必须将现代概念“翻译”为当世能懂的话（“模型”→“算法/章法/门道”，“变量”→“变数”）。旁人对这些词应有合理的陌生反应，不可无感。", qualityChecks: ["文白切换是否服务场景情绪", "句式是否有长短节奏起伏", "意象是否反复出现并随人物变化", "关键情绪是否用白描而非直说", "对白是否有表面与真实两层意图", "是否避免了模板化网文腔", "是否避免了情绪词直说（悲伤/愤怒/高兴等）", "每个情绪场景是否绑定环境意象", "全章格言式收尾是否不超过 2 处", "叙述者是否隐身，未直接宣告主题", "现代词汇是否限制在内心独白，对外是否翻译"] }),
  builtin({ skillId: "romance-arc-design", name: "言情感情线弧光设计", description: "从《我的26岁女房客》《我在风花雪月里等你》等青春言情提炼感情线阶段弧光、虐点设计、关系羁绊描述与言情文笔质感。", category: "long-plan", stages: ["planning", "drafting", "review", "revision"], requires: ["character-desire-engine"], priority: 65, triggers: ["感情线", "言情", "恋爱", "浪漫", "romance", "虐恋", "暧昧", "追妻"], prompt: "借鉴《我的26岁女房客》《我在风花雪月里等你》《世界上最爱我的人》等超级大坦克科比系都市言情，以及《致青春》《何以笙箫默》等优秀青春言情的感情线写法，落实以下规则：\n\n【阶段弧光模型】\n感情线不是平铺直叙的相爱到在一起，而是有明确阶段弧光：初遇 → 好感 → 暧昧 → 升温 → 误会/阻碍 → 虐点 → 和解/抉择 → 结局(HE/BE)。每个阶段必须有：一个推动进入下一阶段的事件、一个阻力来源、一次不可逆的关系认知变化。用 EntityRelation.bond 以中文描述每阶段的关系状态：初遇期萍水相逢尚无深交；好感期互生好感彼此留意；暧昧期心意未明试探拉扯；升温期情意渐浓相互依赖；误会期产生隔阂信任动摇；虐点期关系撕裂痛苦挣扎；和解期冰释前嫌重新接纳或彻底错过各自释怀。bond 描述须随情节推进而更新，不得一成不变。\n\n【双向吸引与剧情融合】\n吸引必须双向，禁止单方面舔狗。男主不能只因女主漂亮善良动心，女主不能只因男主强大护短沦陷，必须有三观契合、性格互补或彼此身上有对方缺失的光。感情线必须跟着主线剧情走，在共患难、并肩行动、日常相处中自然升温，禁止为谈恋爱暂停剧情。每个感情节点都要服务人物目标或主线冲突，禁止脱离剧情的工业糖精。\n\n【拉扯试探与阻碍】\n真正的心动来自拉扯而非一帆风顺。暧昧期核心是试探与回避：一个进半步、一个退半步，用眼神、沉默、欲言又止承载未说出口的心意。阻碍必须来自人物核心恐惧、立场冲突或外部代价（身世、阵营、责任、原生家庭），而非低级的信息不对称硬造误会。超级大坦克科比作品的虐感多来自现实苦海挣扎——人物缺陷、原生家庭、现实压力让本可相爱的人彼此伤害。\n\n【虐点设计原理】\n虐点必须有铺垫与因果，来自人物核心恐惧或立场对立的必然爆发，而非硬煽情或他不知道她没说清的低级误会。《我的26岁女房客》的意难平来自昭阳的人物缺陷与现实挣扎，《我在风花雪月里等你》的虐来自米高的卑微与叶芷的选择，《世界上最爱我的人》的痛来自余味原生家庭的拖累与爱而不得。BE 的痛感来自本可挽回却因人物必然性错过——读者要能追因到前文某个选择或缺陷，而非作者强行拆散。虐点前必须让读者看见他们本可以幸福的希望，落差越大越痛。\n\n【名场面承载】\n重逢、雨夜、告白、误会、牺牲、错过、追妻火葬场等关键场面，禁止用直抒胸臆的她很伤心他心如刀割承载。用一个动作、一个物件、一句没说完的话、一个环境意象承载情绪。《女房客》以爱情是彩色蝴蝶攥紧就褪色的意象承载全篇情感基调。雨、雪、风花雪月、旧物件、未寄出的信都是可复用的情绪载体。关键情绪留白，让读者用自身情感填补。\n\n【对白潜台词】\n言情对白的核心是言不由衷与情感试探。每句重要对白要有表面意思与真实意图两层：字面一层，意图藏在下面，读者第二遍才摸到真意。用破碎对白制造张力——欲言又止的省略号、强行打断、答非所问的心虚。配上小动作（皱眉、转身、攥紧衣角）比话语传递更多。卑微者用回避与过度客气掩饰爱意；骄傲者用讽刺与冷漠掩饰心动。禁止所有角色直白宣告我爱你，情感要泄露而非宣告。\n\n【HE/BE 一致性】\n结局类型须与前文铺垫、人物核心需求匹配。HE 必须解决人物的未承认需求（被爱、被接纳、被原谅），而非外部强行圆满或第三者助攻；人物要有真实成长或代价。BE 的痛感来自因果必然性——某个本可挽回的瞬间因人物缺陷或立场错过，读者能追因到具体选择。禁止为虐而虐的突转结局。结局要回扣开篇的情感承诺。\n\n【避免言情腔】\n警惕嘴角上扬、倒吸一口凉气、心漏跳一拍、眼眶泛红等模板化表达。每个情绪都找属于这个人物、这个场景的独特承载方式。甜不靠撒糖台词堆砌，虐不靠苦情独白硬煽。感情线的质感来自具体的、不可替换的细节。", qualityChecks: ["感情线是否覆盖明确阶段弧光，每阶段有推进事件与不可逆变化", "吸引是否双向且有内在动因，避免单方面舔狗", "虐点是否有铺垫因果，而非低级信息不对称硬造误会", "bond 关系描述是否随情节推进更新而非一成不变", "关键情感是否用行动/物件/意象承载而非直抒胸臆", "对白是否有表面与真实两层意图，避免直白宣告", "结局(HE/BE)是否与人物核心需求及前文铺垫因果一致", "是否避免了嘴角上扬等模板化言情腔"] }),
  builtin({ skillId: "imagery-aesthetics", name: "意象美学", description: "以意象系统、虚实相生、情景交融、留白艺术、声韵节奏构建中文意境美，约束 LLM 生成有文学质感的正文。", category: "drafting", stages: ["drafting", "revision"], priority: 75, prompt: "本 skill 是正文意境美的核心约束。生成正文时必须落实以下规则：\n\n【核心意象系统】每部作品须建立 3-5 个贯穿全书的核心意象。核心意象不是随机景物，而是承载主题与人物命运的符号。选择标准：能在不同场景呈现不同状态（如雪可以是初雪/暴雪/残雪），能随人物成长改变含义（如“剑”从凶器变为担当再变为放下）。开篇场景必须首次呈现至少一个核心意象，此后每章至少触及一次。\n\n【场景意象绑定】每个场景须有一个环境意象与视角人物此刻心境形成呼应或反差。呼应：人物内心混乱时，场景意象也混乱（如人群嘈杂、灯火摇晃）。反差：人物内心悲凉时，场景意象却温暖（如邻桌的笑声、灶上的热气），反差比直说更有力。禁止环境描写与人物情绪无关。\n\n【虚实相生】实写人物的行动、对话、感官；虚写人物的心境、命运、主题。实写可被读者“看见”，虚写可被读者“感受”。一段文字中，实写是骨架，虚写是气韵。禁止全实写（变成流水账）或全虚写（变成散文诗）。关键情绪场景的比例：七分实写（动作/对话/感官），三分虚写（意象/留白/暗示）。\n\n【留白艺术】关键情绪不可说透，须用以下留白手法之一承载：\n- 一个反常动作（他放下碗，没有喝那口热汤）\n- 一个被反复触碰的物件（她第三次整理那件没褶的衣裳）\n- 一句没说完的话（“我只是……”他没有说下去）\n- 一个环境意象的突变（风停了，灯却灭了）\n- 一段沉默（他看了她很久，什么也没说）\n留白处让读者用自身情感填补。禁止在留白后补一句解释（“他知道，这意味着……”是破坏留白）。\n\n【声韵节奏】句式长短交错形成呼吸感：\n- 冲击与决断用短句甚至单字段（剑出。人头落。）\n- 铺陈与心理用长句，可适度半文半白\n- 每段须有节奏起伏，禁止通篇中等长度句的匀速感\n- 四字格可用于凝练情绪或动作（如“风雪欲来”“刀光一闪”），但每段不超过 2 处，不可堆砌\n- 段落长短也要交错：短段制造停顿与冲击，长段承载沉浸\n\n【感官通感】每个场景至少调动两种感官。除视觉外，须有听觉、嗅觉、触觉或温度感之一。通感（感官交错）可用于意境高点：如“冷香”（触觉+嗅觉）、“暖色压下来”（视觉+触觉）。禁止感官描写沦为罗列（“他看见了X，听见了Y，闻到了Z”是清单，不是意境）——感官必须融入行动与情绪。\n\n【白描承重】最重的情绪用最简的白描承载。禁止用华丽辞藻堆砌情绪高点。越是重要时刻，越要克制形容词。一个准确的白描动作（如“他把手缩回袖子里”）比十个形容词更有力。", qualityChecks: ["开篇是否首次呈现核心意象", "每场景是否有意象与人物心境呼应或反差", "关键情绪是否用留白手法而非直说", "句式是否有长短交错的呼吸感", "每场景是否调动两种以上感官", "情绪高点是否用白描而非华丽辞藻", "留白后是否避免了破坏性解释"] }),
  builtin({ skillId: "prose-discipline", name: "文笔纪律", description: "防治强调词贬值、短句tic、金句过密、作者旁白、结构重复等通用文风通病。", category: "drafting", stages: ["drafting", "review"], priority: 80, prompt: "本 skill 防治 LLM 生成正文时最常见的 6 类文风通病。这些通病不影响剧情正确性，但会显著降低文学质感。\n\n【强调词贬值】“第一次”“突然”“忽然”“终于”“竟然”“不由得”等强调词，单章同一词出现超过 2 次即贬值。特别注意“第一次+认知动词”结构（第一次意识到/发现/明白/感到/看清）的堆叠——这是开篇章最容易犯的病。每章此类结构不超过 2 次。替代方案：用具体事件呈现认知转变，而非用“第一次”宣告。\n\n【短句tic】连续 3 个以上独立名词/短语成段排比（如“速度。力量。肌肉变化。呼吸节奏。”），单章不超过 2 处。每处必须服务明确的节奏目的（极度紧张、决断瞬间、感知爆发），不可作为常规叙述手段。替代方案：将排比融入完整句式（“他注意到出拳的速度、力量和某种无法解释的变化”）。\n\n【金句过密】以格言式、总结式、哲理式句子结尾的段落，单章不超过 2 处。判断标准：若删除该句，段落叙事不变，则它是多余的宣告。金句必须由人物对白或行动自然引出，不可由叙述者宣告。替代方案：用行动或沉默收尾（“他转身走了”比“他终于明白了信任的重量”更好）。\n\n【作者旁白】禁止叙述者直接宣告：主题（“规则藏在人身上”）、人物内心（“他第一次把信任加入模型”）、世界规则（“这个世界没有算法”）。这些必须通过人物的选择、遭遇和行动让读者自己体会。叙述者只负责呈现“发生了什么”和“人物做了什么”，不负责解释“这意味着什么”。\n\n【人物语言越界】配角对白不可超出其身份认知。底层人物不说哲学家的话。判断标准：若一句配角台词的主要功能是“替作者点题”，而非推进该人物的当下目标，必须改写或删除。替代方案：让配角用行动而非道理来表达（兵卒不解释规则，只是挥手放行或拦住）。\n\n【结构重复】一章只回答一个问题。若前半段已展示某主题（如“模型遇到人会失效”），后半段不可用新例子重述同一结论。后半段必须升级（人物尝试新方法）或转向（人物发现新维度）。一章只有一个结尾——若前半段已形成主题收束，后半段必须推进到新层面。", qualityChecks: ["强调词是否控制在每章 2 次以内", "短句排比是否控制在每章 2 处以内", "金句式收尾是否控制在每章 2 处以内", "叙述者是否隐身，未直接宣告主题或内心", "配角对白是否未越界，无作者传声筒", "全章是否只回答一个问题，无主题重复推进"] }),
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

export async function listAvailableSkills(projectId: string) {
  const custom = await novelDb.skills.where("projectId").anyOf("__user__", projectId).toArray();
  return [...BUILTIN_NOVEL_SKILLS, ...custom];
}

export async function resolveNovelSkills(params: { projectId: string; stage: NovelSkillStage; explicitSkillIds?: string[] }): Promise<ResolvedSkillSet> {
  const project = await novelDb.projects.get(params.projectId);
  if (!project) throw new Error("项目不存在");
  const [available, bindings] = await Promise.all([
    listAvailableSkills(params.projectId),
    novelDb.projectSkills.where("projectId").equals(params.projectId).toArray(),
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
