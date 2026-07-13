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
  builtin({ skillId: "premise-pressure-test", name: "核心创意压力测试", description: "检查故事承诺、持续冲突和长篇扩展空间。", category: "ideation", stages: ["foundation"], prompt: "从主角主动目标、持续阻力、失败代价、题材承诺、差异化机制和至少三次升级空间检查核心创意。不要用空泛主题代替可发生的戏剧行动。" }),
  builtin({ skillId: "character-desire-engine", name: "人物欲望引擎", description: "用欲望、恐惧、错误信念、真实需求和代价构造人物。", category: "character-world", stages: ["foundation", "planning", "review"], prompt: "为主要人物明确外在欲望、内在恐惧、错误信念、未承认的需求、道德边界和愿意支付的代价。人物选择必须由这些力量推动，而不是服务作者方便。" }),
  builtin({ skillId: "character-voice-matrix", name: "角色声音矩阵", description: "区分角色词汇、句长、回避方式、潜台词与情绪泄露。", category: "character-world", stages: ["drafting", "review", "revision"], prompt: "让角色仅凭对白也可辨认。依据教育、关系权力、当前目标和回避习惯控制词汇、句长、直接程度、语气词、潜台词与沉默；禁止所有角色共享同一书面腔。" }),
  builtin({ skillId: "world-rule-contract", name: "世界规则契约", description: "把能力、社会和物理规则写成带代价的可验证约束。", category: "character-world", stages: ["foundation", "planning", "review"], prompt: "世界规则必须写清适用条件、能力上限、代价、例外和社会后果。解决冲突不得临时创造无铺垫规则；新增例外必须形成待审事实。" }),
  builtin({ skillId: "hierarchical-outline", name: "分层剧情控制", description: "从全书阶段到幕、序列和故事事件逐级分解。", category: "long-plan", stages: ["planning"], prompt: "先确定上层叙事承诺和阶段不可逆变化，再分解到幕、序列与具体故事事件。大纲只表达故事因果，不绑定章节；每个下层节点必须服务至少一个上层目标。" }),
  builtin({ skillId: "causal-thread-weaving", name: "因果与剧情线编织", description: "避免事件清单和支线失踪。", category: "long-plan", stages: ["planning", "review"], prompt: "每个重要事件标注原因、触发条件、阻碍、直接结果和延迟后果。主线与支线通过共同人物、资源、秘密或选择相互改变，不能仅轮流出现。" }),
  builtin({ skillId: "foreshadowing-ledger", name: "伏笔账本", description: "规划埋设、提醒、误导、揭示和回收。", category: "long-plan", stages: ["planning", "review", "fact-extraction"], prompt: "伏笔必须记录读者可见线索、角色可知范围、预期误读、提醒频率、揭示条件和回收影响。揭示前不得让角色无来源地知道真相。" }),
  builtin({ skillId: "chapter-blueprint", name: "章节蓝图", description: "先产出可审批、可执行的章节节拍。", category: "chapter", stages: ["planning"], requires: ["story-facts-invariant"], outputSchema: chapterBlueprintSchema, priority: 200, prompt: "章节蓝图必须包含具体目标、精确起点、4至10个行动节拍、每个节拍的情绪反应与结果、信息释放、转折、章尾钩子、必须发生与禁止事项。节拍要足够具体但不代写正文。" }),
  builtin({ skillId: "scene-action-reaction", name: "行动与反应场景", description: "用目标、冲突、结果和反应、两难、决定形成推进。", category: "chapter", stages: ["planning", "drafting", "review"], prompt: "行动场景围绕目标、阻碍和不可逆结果展开；重大结果后安排必要的情绪反应、选择权衡和新决定。呼吸段必须改变理解或决定，不能停滞。" }),
  builtin({ skillId: "embodied-prose", name: "具象场景正文", description: "用行动、感官和选择承载情绪与信息。", category: "drafting", stages: ["drafting", "revision"], prompt: "正文优先呈现人物正在做什么、注意到什么、误读什么和选择什么。抽象总结要落回可观察行动、具体感官、环境阻力或有代价的对白。感官细节必须服务视角与场景目标。" }),
  builtin({ skillId: "serial-rhythm", name: "通用连载节奏", description: "控制章节承诺、推进、阶段回报和下一章驱动力。", category: "serial", stages: ["planning", "drafting", "review"], prompt: "每章开头尽快建立当章问题，中段至少发生一次局势变化，结尾产生新的决定、代价、危险或认知缺口。回报必须来自此前阻力和人物行动，不按固定字数机械插入爽点。" }),
  builtin({ skillId: "continuity-audit", name: "连续性审校", description: "检查时间、空间、知识、物品、规则和因果。", category: "review", stages: ["review"], requires: ["story-facts-invariant"], priority: 180, prompt: "逐段核对人物位置与移动、故事时间、环境、角色知识、重要物品归属、世界规则和前因后果。只报告有上下文证据的矛盾，并引用冲突来源。" }),
  builtin({ skillId: "style-specificity-audit", name: "文风与具体性审校", description: "检查视角、语言具体性、重复和模板化表达。", category: "review", stages: ["review"], prompt: "检查叙述距离、视角稳定、句段节奏、抽象情绪、重复意象和模板化动作。高频词统计只形成警告；必须结合人物声音和项目风格判断，不能机械判错。" }),
  builtin({ skillId: "plot-pacing-audit", name: "剧情与节奏审校", description: "验证节拍落实、局势变化、钩子和回报。", category: "review", stages: ["review"], prompt: "比较蓝图与正文，检查必须节拍、人物选择、因果推进、场景功能、信息释放、张弛变化和章尾驱动力。区分结构阻断与审美建议。" }),
  builtin({ skillId: "fact-delta-extraction", name: "事实差异提取", description: "从已批准正文提取带证据的结构化变化。", category: "memory", stages: ["fact-extraction"], requires: ["story-facts-invariant"], priority: 220, prompt: "只提取正文明确陈述或强烈蕴含的新事实、角色状态、知识、关系、物品、时间线、剧情线和伏笔变化。每项必须引用原文证据、给出置信度并标记新增、更新、重复或冲突；不得直接提交。" }),
  builtin({ skillId: "classic-character-ensemble", name: "经典人物群像法", description: "从《雪中悍刀行》《剑来》《庆余年》提炼群像塑造、出场即性格、对话即性格的写法。", category: "character-world", stages: ["foundation", "planning", "drafting", "review"], priority: 60, prompt: "借鉴《雪中悍刀行》《剑来》《庆余年》等网文经典的人物塑造法，落实以下规则：\n\n【群像生态】每个重要配角必须拥有独立欲望、资源与代价，不能只服务主角剧情。配角之间要形成关系网（恩怨、利益、秘密），让世界因他们而运转。雪中温华、剑来宁姚、庆余年陈萍萍之所以立得住，在于他们有不在主角面前时也成立的人生。\n\n【出场即性格】人物首次登场需用一个“标志性动作+一句辨识度对白+一个反差细节”立住形象。拒绝先大段外貌描写再补性格的流水账。李淳罡出场即“羊裘裘老头拎羊脂玉”，陈平安出场即“穷且规矩”。\n\n【对话即性格】对白要承载人物的教育、出身、当下意图与回避。江湖人说江湖话，庙堂人说庙堂话，市井人说市井话。禁止所有角色共享同一书面腔。烽火的人物对白常带“言在此而意在彼”的潜台词，猫腻的对白常带从容的幽默与机锋。\n\n【弧光与代价】主角成长必须伴随真实代价（失去、误解、道德妥协），不能只升不降。陈平安的成长伴随着“道理越讲越沉”的代价，范闲的快意伴随着“身在庙堂不由己”的代价。每个阶段的选择都要回扣人物的核心恐惧与未承认需求。\n\n【留白与暗示】不把人物内心全部写透。用动作、沉默、物件、环境暗示人物状态。雪中常用“某人没说话，只是做了某事”来承载情绪。让读者通过拼图理解人物，而非作者直接宣告。", qualityChecks: ["配角是否有独立于主角的欲望与场景", "首次登场是否用动作/对白立住性格", "对白是否区分了人物身份与意图", "成长是否伴随真实代价", "是否避免了作者直接宣告人物内心"] }),
  builtin({ skillId: "classic-narrative-tension", name: "经典叙事张力法", description: "从《雪中悍刀行》《剑来》《庆余年》提炼悬念、伏笔、节奏与长线布局的叙事法。", category: "long-plan", stages: ["planning", "review"], priority: 60, prompt: "借鉴《雪中悍刀行》《剑来》《庆余年》等网文经典的叙事张力构建法，落实以下规则：\n\n【悬念分层】每章至少埋一个“章尾钩子”（短期悬念），每幕至少推进一个“中期谜题”（数十章到百章级），全书贯穿一到两个“核心悬念”（雪中“徐凤年为何而活”、剑来“陈平安的道理”）。三层悬念并行，读者在任何尺度都有期待。\n\n【伏笔的延迟回收】伏笔要“埋得自然、提得克制、收得有力”。雪中“温华断臂”前铺垫极长，回收时爆发出巨大情感。禁止埋伏笔时大张旗鼓（如“他不知道这个决定将改变一切”），让伏笔以日常细节形态存在。回收时要让读者恍然“原来早有线索”，而非作者强行解释。\n\n【张弛与节奏】网文的节奏不是“每章爽点”，而是“阻力—推进—回报”的呼吸。雪中常见“三章蓄势、一章爆发”的节奏。爆发章要兑现此前积累的期待，蓄势章要制造新的认知缺口或情感压力。禁止用固定字数机械插入爽点，回报必须来自此前阻力与人物行动。\n\n【长线布局】长篇要有“阶段不可逆变化”。雪中徐凤年从“纨绔世子”到“北凉王”再到“江湖人”，每个阶段都有不可逆的身份与认知转变。规划时先定阶段转折点，再回填事件。转折点要让人物“回不去了”，而非“又升了一级”。\n\n【支线反哺主线】支线不能只是主线休息站。剑来的支线（如山崖书院、剑气长城）最终都反哺陈平安的核心命题。支线要通过共享人物、资源、秘密或主题与主线相互改变，而非轮流出现。每条支线都要回答“它如何改变了主线人物的选择”。\n\n【留白叙事】有些最重要的信息用“不写”来写。雪中李淳罡的过去、剑来某些大人物的图谋，常通过他人反应、环境变化、片段暗示来呈现。规划时明确“哪些信息延迟揭示”“哪些信息永不揭示”“哪些信息用侧面呈现”。", qualityChecks: ["是否埋设了章尾/幕级/全书三层悬念", "伏笔是否以日常形态埋设而非大张旗鼓", "回报是否来自此前阻力而非机械插入", "阶段转折是否造成不可逆变化", "支线是否反哺主线人物选择"] }),
  builtin({ skillId: "classic-prose-texture", name: "经典文笔质感法", description: "从《雪中悍刀行》《剑来》《庆余年》提炼句式节奏、意境营造、白描留白的文笔法。", category: "drafting", stages: ["drafting", "revision"], priority: 70, prompt: "借鉴《雪中悍刀行》《剑来》《庆余年》等网文经典的文笔质感，落实以下规则：\n\n【文白交织】重要场景、情绪高点、意境段落可适度使用半文半白的句式，日常推进用洗练白话。雪中“天不生我李淳罡，剑道万古如长夜”是文白交织的典范。禁止全篇文言或全篇口水白话，要让文白根据场景情绪自然切换。\n\n【句式节奏】长短句交错，短句承载冲击与决断，长句承载铺陈与心理。爆发段落用短句甚至单字段：“剑出。人头落。”抒情段落用绵长句。禁止通篇中等长度句的“匀速感”。每段要有节奏起伏，像呼吸。\n\n【意境营造】用环境意象承载人物情绪与主题。雪中常以“雪”“剑”“酒”为核心意象，剑来常以“山水”“道理”为核心意象。意象要反复出现并随人物成长变化含义。禁止空洞堆砌华丽辞藻，意象必须服务视角与场景目标。\n\n【白描与留白】用最少的字写最重的情。雪中温华出场、剑来陈平安父亲之死，都用极简白描承载巨大情感。关键情绪不要直说“他很悲伤/愤怒”，而用一个动作、一个物件、一句没说完的话来承载。留白处让读者用自己的情感填补。\n\n【对白的机锋】高质量对白要“话里有话”。猫腻的对白常带从容的幽默与机锋，烽火的对白常带“言在此而意在彼”的江湖气。对白不是信息传递工具，而是人物博弈、情感试探、立场宣示的场域。每句重要对白都要有“表面意思”与“真实意图”两层。\n\n【感官与画面感】每个场景至少调动两种以上感官（视觉、听觉、嗅觉、触觉、温度）。雪中的“大雪压剑”、剑来的“山水清音”都是有强感官的画面。画面感不等于华丽，而在于让读者“看见”“听见”“感受到”。\n\n【避免网文腔】警惕“恐怖如斯”“倒吸一口凉气”“嘴角上扬”等模板化表达。文笔的质感来自具体而非套话。每个情绪都找属于这个人物、这个场景的独特表达方式。", qualityChecks: ["文白切换是否服务场景情绪", "句式是否有长短节奏起伏", "意象是否反复出现并随人物变化", "关键情绪是否用白描而非直说", "对白是否有表面与真实两层意图", "是否避免了模板化网文腔"] }),
];

const PROFILE_SKILLS: Record<string, string[]> = {
  "general-serial": ["story-facts-invariant", "premise-pressure-test", "character-desire-engine", "character-voice-matrix", "world-rule-contract", "hierarchical-outline", "causal-thread-weaving", "foreshadowing-ledger", "chapter-blueprint", "scene-action-reaction", "embodied-prose", "serial-rhythm", "continuity-audit", "style-specificity-audit", "plot-pacing-audit", "fact-delta-extraction", "classic-character-ensemble", "classic-narrative-tension", "classic-prose-texture"],
  progression: ["story-facts-invariant", "premise-pressure-test", "character-desire-engine", "world-rule-contract", "hierarchical-outline", "causal-thread-weaving", "chapter-blueprint", "scene-action-reaction", "embodied-prose", "serial-rhythm", "continuity-audit", "plot-pacing-audit", "fact-delta-extraction", "classic-character-ensemble", "classic-narrative-tension", "classic-prose-texture"],
  emotional: ["story-facts-invariant", "premise-pressure-test", "character-desire-engine", "character-voice-matrix", "hierarchical-outline", "foreshadowing-ledger", "chapter-blueprint", "scene-action-reaction", "embodied-prose", "serial-rhythm", "continuity-audit", "style-specificity-audit", "fact-delta-extraction", "classic-character-ensemble", "classic-narrative-tension", "classic-prose-texture"],
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
