/**
 * V2 架构生成（foundation）提示词构建。
 *
 * 设计依据：AGENTS.md「reusable contracts over case-specific examples」+ 架构阶段原则。
 *
 * 核心原则：
 * - prompt 只描述通用维度与决策规则，不内置任何题材/类型/角色名 fixture
 * - 题材特异性来自调用方传入的 premise/genre/objective（用户输入），而非 prompt 硬编码
 * - 各 taskKey 的 guidance 描述「应覆盖哪些维度」「决策规则是什么」，不识别特定作品
 * - 与 chapter-draft prompt 的区别：foundation 是 project 级架构产出，chapter 是单章正文
 *
 * 与 writer-rules.ts 的关系：
 * - writer-rules 是文风层面的通用规则（适用于所有生成任务）
 * - foundation 是架构维度的任务指导（仅适用于 bootstrap work items）
 * - 两者互补：foundation 决定"生成什么"，writer-rules 决定"如何表达"
 */

/**
 * 各 taskKey 的架构维度指导。
 *
 * dimension：该 taskKey 在全书架构中的职责（一句话）
 * focus：LLM 应覆盖的具体维度（决策清单）
 * structuredDataHint：structuredData 字段建议的键（机读数据格式提示）
 *
 * AGENTS.md 合规：guidance 描述通用维度，不识别特定题材/作品/角色。
 */
const TASK_KEY_GUIDANCE: Record<string, { dimension: string; focus: string[]; structuredDataHint: string }> = {
  "project-positioning": {
    dimension: "确立全书的题材定位、目标读者与核心卖点，为后续所有架构决策提供基线。",
    focus: [
      "核心卖点：本书区别于同类作品的最显著特征（不超过 3 条）",
      "目标读者画像：年龄段、阅读偏好、容忍度（如慢热/快节奏）",
      "基调与情绪曲线：整体情绪走向（如先抑后扬、悲壮、诙谐）",
      "差异化策略：与同类作品相比，本作品在哪些维度上做了不同选择",
      "核心冲突预设：贯穿全书的核心矛盾（不展开具体事件）",
    ],
    structuredDataHint: "positioning: { sellingPoints: string[], targetReader: {...}, tone: string, differentiation: string[], coreConflict: string }",
  },
  architecture: {
    dimension: "设计全书的叙事结构与章节布局，确定故事的骨架。",
    focus: [
      "叙事结构：单线推进 / 多线交织 / 网状叙事 / 倒叙插叙等，并说明选择理由",
      "卷划分：全书分几卷，每卷的主题与功能（起承转合）",
      "章节布局：预计总章节数、每卷章节数、章节字数区间",
      "视角策略：第几人称、是否切换视角、视角切换规则",
      "时间跨度：故事覆盖的时间长度（如三年、十年、一生）",
    ],
    structuredDataHint: "architecture: { structure: string, volumes: [{name, theme, function, chapterCount}], povStrategy: string, timeSpan: string }",
  },
  characters: {
    dimension: "设计主要人物档案，每个人物需有清晰的动机、秘密与成长弧。",
    focus: [
      "主角：身份、外貌、性格、核心动机、隐藏秘密、成长弧起点与终点",
      "重要配角（3-7人）：与主角的关系、各自动机、在故事中的功能",
      "反派/对立面：动机层次（不写成纯粹的恶）、与主角的冲突维度",
      "人物声部锚点：每个主要人物的说话方式差异（句长、用词、直接度）",
      "人物网络：谁与谁有羁绊、谁与谁有冲突（为 relations task 预留）",
    ],
    structuredDataHint: "characters: [{id, name, alias, role, faction, motivation, secret, voiceAnchor: {...}, arc: {start, end}}]",
  },
  relations: {
    dimension: "构建人物关系图谱，明确每对关系的性质、强度与演变方向。",
    focus: [
      "关系类型矩阵：敌对/同盟/师徒/血缘/利益/情感，每对关系标注类型",
      "关系强度：1-5 级，反映关系对剧情的推动力",
      "关系演变：哪些关系会转化（敌→友、爱→恨），转折点预设",
      "关系三角/多角：识别关键的关系结构（如三角恋、权力三角）",
      "关系网络中心：哪些人物是关系网络的枢纽",
    ],
    structuredDataHint: "relations: [{from, to, type, strength, evolution: {from, to, trigger}}]",
  },
  worldview: {
    dimension: "构建世界观与设定规则，为故事提供可信的背景框架。",
    focus: [
      "地理：主要地域、地名、地形特征（服务于剧情而非百科）",
      "政治：权力结构、朝堂/江湖/势力的组织形态",
      "势力：主要势力（3-7个）、各自利益、相互关系",
      "规则与禁忌：世界观内的法则（武功体系/科技水平/魔法规则等）与禁忌",
      "外忧内患：外部威胁与内部矛盾的具体形态",
    ],
    structuredDataHint: "worldview: { geography: {...}, politics: {...}, factions: [{name, interest, relation}], rules: [...], threats: {external: [...], internal: [...]} }",
  },
  "plot-threads": {
    dimension: "设计主线与支线剧情，确保多线交织但不混乱。",
    focus: [
      "主线：贯穿全书的核心剧情（一句话概括 + 三段式起承转合）",
      "支线（3-5条）：每条支线的主题、与主线的交汇点、独立价值",
      "情感线：主要人物的情感发展轨迹（多女主感情线需明确每个女主的线）",
      "权力线：势力博弈的剧情线（朝堂/江湖/外忧）",
      "线交织规则：支线如何切入主线、何时回收，避免支线失控",
    ],
    structuredDataHint: "plotThreads: { main: {summary, threeAct: {...}}, subplots: [{id, theme, intersection, value}], emotionalLines: [...], powerLines: [...] }",
  },
  foreshadowing: {
    dimension: "埋设伏笔与回收节点，保证长篇叙事的因果连贯性。",
    focus: [
      "长线伏笔（3-5个）：贯穿全书、在后期兑现的伏笔，标注预期兑现窗口",
      "中线伏笔（5-8个）：在数卷内兑现的伏笔",
      "短线伏笔（若干）：近期章节即兑现的伏笔",
      "伏笔触发机制：每个伏笔的触发关键词/场景",
      "回收节点：每个伏笔预期在哪个卷/章兑现",
    ],
    structuredDataHint: "foreshadowings: [{id, description, triggerKeywords: [...], expectedPayoffWindow, lineType: 'long'|'mid'|'short'}]",
  },
  timeline: {
    dimension: "构建时间线与事件顺序，确保叙事时序清晰。",
    focus: [
      "历史背景：故事开始前的关键历史事件（影响当前局势）",
      "故事时间线：主线事件的时间顺序（按故事内时间）",
      "叙事时间线：事件在文本中的呈现顺序（可能与故事时间不同）",
      "关键节点：转折点、高潮、低谷的时间位置",
      "时间跨度与节奏：不同阶段的时间密度（如开篇慢、中段快）",
    ],
    structuredDataHint: "timeline: { history: [...], storyEvents: [{time, event, significance}], narrativeOrder: [...], keyNodes: [...] }",
  },
  "story-control": {
    dimension: "梳理叙事节奏与控制点，保证阅读体验的张弛有度。",
    focus: [
      "节奏曲线：全书的情绪/紧张度曲线（标注高潮与低谷位置）",
      "悬念设置：每章/每卷的悬念钩子",
      "爽点分布：爽感时刻的分布密度与类型（成就/认可/反转/情感/悬疑）",
      "留白与铺垫：哪些地方留白、哪些地方铺垫",
      "控制点：作者显性介入的节点（如卷首引言、章末点题）",
    ],
    structuredDataHint: "storyControl: { paceCurve: [...], suspenseHooks: [...], payoffDistribution: [...], controlPoints: [...] }",
  },
  "plot-design": {
    dimension: "完成 plot 设计与章节规划，将架构落实到具体章节。",
    focus: [
      "开篇设计：第一章的功能（抓人、立人设、立世界观）",
      "发展段：中段章节的功能分配（推进主线、深化人物、埋伏笔）",
      "转折点：关键转折的章节位置与触发条件",
      "高潮设计：全书高潮的章节位置与构成",
      "结局设计：结局类型（开放/封闭/半开放）、收束方式",
    ],
    structuredDataHint: "plotDesign: { opening: {...}, development: [...], turningPoints: [...], climax: {...}, ending: {...} }",
  },
  "chapter-plan": {
    dimension: "生成前十章的章节计划（标题与摘要），作为章节生成的蓝图。",
    focus: [
      "每章标题：体现该章核心事件或意象（不剧透关键反转）",
      "每章摘要：100-200字概括该章的主要事件、人物、功能",
      "章节功能：该章在全书中的功能（立人设/推进剧情/埋伏笔/兑现/高潮）",
      "章节钩子：该章结尾的悬念或期待点",
      "视角与场景：该章的视角人物与主要场景",
    ],
    structuredDataHint: "chapters: [{index, title, summary, function, hook, pov, scenes: [...]}]",
  },
};

/**
 * 构建 foundation 生成提示词。
 *
 * 输入：
 * - taskKey：当前 work item 的 taskKey（决定生成维度）
 * - instruction：work item 的 instruction（来自 bootstrap_run）
 * - projectTitle/premise/genre/objective：项目上下文
 * - priorArtifacts：前序 work item 的产出摘要（依赖链上下文）
 * - skills：可选,激活的 skill bundle(注入 promptSections.foundation/planning)
 *
 * 输出：完整的 prompt 字符串，传给 modelGateway.generateStructured
 *
 * 设计原则（AGENTS.md「reusable contracts」）：
 * - prompt 不识别特定题材/作品/角色，所有题材信息来自 premise（用户输入）
 * - guidance 描述通用维度，不嵌入 fixture
 * - 前序 artifact 摘要提供依赖链上下文，避免重复决策
 *
 * Skill 注入(对齐 chapter-draft.ts L363-365 的注入方式):
 * - foundation task 的 taskClass 是 foundation/planning,从 skill.promptSections.foundation
 *   或 skill.promptSections.planning 取文本(优先 foundation,回退 planning)
 * - 让 v1 迁移的 long-form-master-craft/hierarchical-outline/chapter-blueprint/
 *   plot-segment-design/premise-pressure-test 等 5 个 foundation/planning skill
 *   的 prompt 真正进入 LLM,而非死载荷
 */
export function buildFoundationPrompt(input: {
  taskKey: string;
  instruction: string;
  projectTitle: string;
  premise?: string;
  genre?: string;
  objective?: string;
  priorArtifacts: Array<{ taskKey: string; title: string; summary: string }>;
  skills?: Array<{ skillId: string; promptSections: Partial<Record<string, string>> }>;
}): string {
  const guidance = TASK_KEY_GUIDANCE[input.taskKey];
  const taskKeyLabel = guidance ? input.taskKey : "通用架构产出";

  const lines: string[] = [];

  lines.push("# 架构生成任务");
  lines.push("");
  lines.push(`## 当前任务维度：${taskKeyLabel}`);
  lines.push("");
  if (guidance) {
    lines.push(`**职责**：${guidance.dimension}`);
    lines.push("");
    lines.push("**应覆盖的维度**（决策清单）：");
    for (const focus of guidance.focus) {
      lines.push(`- ${focus}`);
    }
    lines.push("");
    if (guidance.structuredDataHint) {
      lines.push("**structuredData 建议格式**（机读数据，可按实际产出调整）：");
      lines.push("```");
      lines.push(guidance.structuredDataHint);
      lines.push("```");
      lines.push("");
    }
  }

  // Skill 注入(对齐 chapter-draft.ts 的 skillSections 写法)
  // 设计依据:让 v1 迁移的 foundation/planning 类 skill(如 long-form-master-craft/
  // hierarchical-outline/chapter-blueprint/plot-segment-design/premise-pressure-test)
  // 的 promptSections 真正进入 LLM,而非死载荷。
  // 取 key 优先级:foundation > planning(因为部分 v1 skill 同时声明两个 stage)
  if (input.skills?.length) {
    lines.push("## 激活技能（架构指导）");
    for (const skill of input.skills) {
      const sectionText = skill.promptSections.foundation ?? skill.promptSections.planning ?? "";
      if (!sectionText) continue;
      lines.push(`### ${skill.skillId}`);
      lines.push(sectionText);
      lines.push("");
    }
  }

  lines.push("## 项目上下文");
  lines.push(`- 标题：${input.projectTitle}`);
  if (input.genre) lines.push(`- 题材：${input.genre}`);
  if (input.premise) lines.push(`- 设定前提：${input.premise}`);
  if (input.objective) lines.push(`- 创作目标：${input.objective}`);
  lines.push(`- 当前指令：${input.instruction}`);
  lines.push("");

  if (input.priorArtifacts.length > 0) {
    lines.push("## 前序架构产出（依赖链上下文）");
    lines.push("以下决策已在前序 work item 中确定，本任务需与之保持一致并在此基础上深化：");
    lines.push("");
    for (const prior of input.priorArtifacts) {
      lines.push(`### ${prior.taskKey}：${prior.title}`);
      lines.push(prior.summary);
      lines.push("");
    }
  }

  lines.push("## 输出要求");
  lines.push("- 严格遵循 foundationSchema 的 JSON 结构");
  lines.push("- title：本次产出的标题（如「主要人物档案」「世界观设定」）");
  lines.push("- summary：200-800字摘要，概括核心决策与设计意图");
  lines.push("- sections：人类可读的分节内容，每节含 heading + content + 可选 items");
  lines.push("- structuredData：可机读的结构化数据，便于后续 task 引用");
  lines.push("- 所有决策需有内在逻辑一致性，与前序产出不冲突");
  lines.push("- 不输出任何解释性前言，直接输出 JSON");
  lines.push("");

  return lines.join("\n");
}

/**
 * foundation 生成的 system prompt。
 *
 * 设计原则：与 chapter-draft 的 system prompt 风格一致——
 * 简洁、指令式、强调"只输出 JSON"。
 */
export const FOUNDATION_SYSTEM_PROMPT =
  "你是长篇小说架构师。根据当前 taskKey 的维度指导，生成全书架构产出的对应部分。" +
  "只输出严格符合 foundationSchema 的 JSON，不使用 Markdown 代码块，不输出解释性文字。" +
  "所有决策需有内在逻辑一致性，与前序架构产出保持连贯。";
