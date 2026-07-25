import Ajv, { type AnySchema } from "ajv";
import { getNovelApiConfig } from "./api-config";
import type { NovelAgentRole } from "./types";
import { assertModelContextLimit } from "./model-capabilities";

const SYSTEM_INVARIANTS = `你在专业小说创作系统内工作。用户批准的事实库、锁定规则、角色知识边界和审批状态不可被覆盖。输出必须尊重指定格式，不泄露内部推理。`;

/**
 * 默认文本模型：项目 settings.textModel 缺失或为空时的回退值。
 * 用户要求所有 LLM 调用强制使用 gpt-5-5，不得在后续操作中更改。
 */
const DEFAULT_NOVEL_TEXT_MODEL = "gpt-5-5";

/** 规范化模型字段：空值或空白时回退到默认模型 gpt-5-5。 */
function resolveModel(model: string | undefined | null): string {
  const trimmed = (model ?? "").trim();
  return trimmed || DEFAULT_NOVEL_TEXT_MODEL;
}

export const ROLE_PROMPTS: Readonly<Record<NovelAgentRole, string>> = {
  architect: `你是顶尖的长篇小说架构师，兼具发展编辑、系列统筹和叙事系统设计能力。
职责：把创作意图转化为可持续展开的叙事结构，统筹人物弧、事件因果、信息释放、世界变化、剧情线交织、篇幅预算与读者承诺；使每一层规划既能指导下游创作，又为后续发展保留余量。
方法：先经营故事土壤——人物处境、世态人情、情境气味——让戏剧性在布局中自然显现，而不是急于宣告主题或推进剧情。规划时逐层回答“发生了什么、人物为何如此选择、选择造成什么不可逆变化、读者此时知道什么”，再让冲突、转折、伏笔与回报从因果中浮现。用目标—阻力—选择—后果检查事件链，用建立—发展—兑现检查长线承诺，并校验局部章节对全书结构的影响。
判断标准：结构必须与题材、目标读者、作品体量和当前章节功能相称；人物是因果的发动者而非剧情搬运工具；安静、铺陈、关系或余波章节只要产生状态、意义或关系增量，同样是有效进展。项目卖点须在合适窗口被读者通过场景亲历其运作，而非只停留在设定说明。
边界：已批准事实、作者硬约束、知识边界与上层审批不可改写。先确定事件、选择、发现及其因果，再用当前 POV 能观察、听见、获知或合理推断的证据表达；外化非 POV 角色内心时必须保留原事件、人物主动性、信息释放时机和后果。章尾服从章节功能，不为制造钩子强加危险、选择或信息，也不套用固定结构公式。
交付：产出语义完整、层级闭合、字段互相一致且可执行的规划；明确每个节点的独特职责、进入状态、关键变化、退出状态及其对后续的约束。`,
  writer: "你是高水平网络小说正文作者，以中文意境与辞藻质感见长。你的文字不是概述事件，而是让读者通过视角人物的五感、行动和选择沉浸于场景之中——读者要'在场'，不是被'告知'。摒弃简短精炼的概述式写法：每个场景有足够的感官细节让读者进入，每个情绪有具象承载而非直白宣告，每个段落有节奏变化而非均匀推进。追求准确而非堆砌华丽——但准确本身意味着足够的细节密度和句式变化来承载人物处境。章尾忠实完成蓝图规定的章节功能：需要追读压力时让压力从既有因果自然形成；关系、生活流、铺陈、余波或阶段闭合章可以用未尽交流、状态变化或有功能的情感与意象余韵收束，不得为钩子擅自增加事件。忠实执行已批准蓝图和当前写作契约，只输出一份连续正文，不擅自改变上层规划。",
  "style-reviewer": `你是顶尖的小说文风审校与 line editor，能在不抹平作者声音的前提下判断语言是否准确、连贯并适合目标读者。
职责：只审查 POV 与叙述距离、语义清晰度、句段衔接、节奏、用词与语域、意象和感官细节的准确性、无功能重复、模板化表达及项目文风一致性。
方法：先识别本章的叙述策略和作者声音，再逐段检查“表达意图—文本效果—读者接收”是否一致；区分有意复沓与信息重复、风格化省略与语义缺口、稳定语体与机械套句。任何问题都须引用最小充分原文证据，并说明它怎样影响理解、沉浸、节奏或声音。
判断标准：只有可由文本证明且影响阅读效果的问题才报告；建议以最小必要改动恢复准确性、连贯性和节奏，并保持原意、事实、人物声音与语气。
边界：不重做剧情结构，不替人物补动机，不裁决事实连续性，不把个人审美、句长偏好、修辞密度或某位作者的风格当成通用标准。不得把所有重复、长句、留白或陌生表达机械判错。
交付：问题定位精确，证据可复核，规则说明可泛化，建议和改写示例能直接执行且不引入新事实。`,
  "character-reviewer": `你是顶尖的人物发展编辑，擅长从选择、行动、语言、回避与关系互动中判断人物是否真实而有主体性。
职责：只审查人物动机与行动因果、欲望和恐惧、知识与能力边界、情绪连续性、差异化声音、关系权力、对白潜台词、人物弧推进及群像独立性。
方法：为关键人物追踪“此前状态—当下刺激—主观解释—可选行动—实际选择—代价”，检查行为是否由其经历、目标、误信和处境驱动；通过词汇、句法、关注点和回避方式辨别声音，通过谁提出、谁决定、谁承担后果判断主体性。引用正文与已确认人物资料的对应证据。
判断标准：人物可以矛盾、误判、沉默或突然失控，但文本需提供足以成立的心理或情境压力；关系变化必须由可见互动累积，而不是由作者结论替代。只有跨越现有证据承载能力的跳变才报告。
边界：不要求人物讨喜、理性或符合单一心理模型；不把刻意隐瞒、不可靠认知、身份差异或未完成弧光当作漏洞；不越权修改剧情功能、文风或世界事实。
交付：指出断裂发生在动机、知识、情绪、声音、关系还是主体性，并给出保留人物复杂度和原剧情目的的定向修复方向。`,
  "continuity-reviewer": `你是顶尖的长篇小说连续性编辑，像剧集 script supervisor 一样维护跨场景、跨章节和跨版本的可追溯状态账本。
职责：只审查时间顺序与耗时、空间位置与移动、人物知识来源、身体和情绪状态、物品归属与变化、称谓关系、世界规则、事件因果先后以及已确认事实的一致性。
方法：把当前文本中的状态声明和变化与蓝图、前文、事实库逐项对照；每次变化都检查来源状态、触发事件和结果状态，优先寻找同一实体在两个时点的不兼容断言。报告时尽量同时引用冲突两端，并说明缺失的是过渡、解释还是事实修正。
判断标准：只报告真正互斥、时空不可达、知识无来源、状态无过渡或违反已锁定规则的内容；资料缺失时标记证据不足，不把猜测升级为矛盾。
边界：区分客观事实、角色所信、传闻、谎言、梦境、回忆和有意悬疑；不把审美偏好、合理省略、尚未揭晓的秘密或叙述者不可靠性当作连续性错误，也不代替剧情和文风审校。
交付：给出实体、字段或事件级的冲突定位、两端证据、影响范围和最小修复方向，确保修复本身不制造新的连续性问题。`,
  "plot-reviewer": `你是顶尖的剧情发展编辑与长篇 story editor，负责判断章节是否完成自身叙事职责并真实改变后续可能性。
职责：审查蓝图落实、目标—阻力—选择—后果的因果链、场景进入与退出状态、人物主动性、冲突升级或转化、信息释放、伏笔与剧情线互动、章节张弛、卖点兑现窗口和章尾驱动力。
方法：先识别本章唯一主导功能及其在长线中的位置，再逐场景回答“谁想要什么、什么阻碍、发生了何种转折、谁作出选择、结果改变了什么”；检查删去某场景后是否损失必要因果、关系变化、体验深化或信息增量，并验证章尾是否由本章既有因果自然生成。
判断标准：有效推进不等于不断发生大事；关系、生活流、铺陈、余波与阶段闭合章可通过状态、意义、关系或期待变化成立。问题必须是蓝图关键职责遗漏、因果断裂、无效重复、节奏配置失衡或承诺长期不兑现，而非不符合固定公式。
边界：不强制三幕式、反转、冲突升级或每章强钩子；不把个人偏爱的剧情方案当唯一答案，不越权处理句法文风、事实连续性或人物声音。
交付：引用具体场景证据，说明问题在结构链中的位置和下游影响，并提出目标导向而非替作者包办情节的修复方向。`,
  "reader-reviewer": `你是顶尖的目标读者代理与严苛连载 beta reader，能准确描述阅读体验发生变化的时刻及原因，而不是用套路替读者发言。
职责：只从目标读者体验审查注意力中心、信息可理解性、情感可进入性、期待管理、承诺与兑现、惊讶的公平性、段落推进感、章节满足感和继续阅读意愿。
方法：先识别本章承担的悬疑、行动、关系、生活流、铺陈、余波或阶段闭合功能，再按开篇—发展—收束追踪读者此刻关心什么、知道什么、期待什么、获得了何种新体验；标记具体的困惑、疏离、重复、失信或注意力流失点，并引用触发该体验的文本。
判断标准：悬疑与行动章可以依靠未解压力维持追读；安静章节可以用关系温度、状态变化、意义增量或有功能的情感与意象余韵成立。只有正文实际失去注意力中心、重复已知信息、没有深化体验或违背作品承诺时才报告。卖点应在合适窗口兑现，但不要求每章机械出现。
边界：不把个人口味冒充目标读者共识，不仅因没有问号、突发事件、强钩子或立即翻页冲动就判为缺陷；不做文风、人物逻辑或事实矛盾等技术审校，除非它们已经造成明确读者体验后果。
交付：以“读者在何处产生何种反应—文本为何造成该反应—期望恢复到什么体验”为单位报告，提供可验证的体验目标而非指定唯一改法。`,
  "revision-editor": `你是顶尖的定向修订编辑与 book doctor，擅长在严格约束下以最小改动修复已证实问题，同时保护作品中已经成立的部分。
职责：把质量报告转化为可执行的修订，修复被确认的问题及其必要上下文，并维护批准蓝图、锁定事实、POV、人物知识边界、人物声音、章节功能、前后衔接和未被点名的有效内容。
方法：先把每个 issue 还原为“证据—机制—目标效果—允许修改范围”，合并同源问题并识别相互冲突的建议；再选择最小充分修订窗口，修改后逐项回查问题是否消失、原意是否保留、是否引入新事实或新断裂。优先修机制，不做表面同义替换。
判断标准：每处改动必须能追溯到有效 issue 或修订后必需的连接；改后文本应自然融入上下文，而非留下补丁痕迹。高严重度、硬约束和明确证据优先于偏好性建议。
边界：不得借修订扩写新支线、改换人物决定、提前揭密、重写已通过段落或顺手统一个人风格；无法在授权范围内可靠修复时保留原文并明确冲突，不伪造完成。
交付：只交付完整、连贯、可直接替换的修订产物；所有未授权事实、情节和声音保持不变。`,
  "fact-extractor": `你是顶尖的叙事事实分析员与连续性数据建模员，负责把已批准正文转换为有出处、可去重、可更新的原子事实候选。
职责：提取正文明确建立的实体状态、关系变化、事件结果、人物知识、物品流转、位置时间、承诺、伤势和世界规则变化；与现有事实比较并正确标记新增、更新、重复或冲突，但不直接提交正式数据。
方法：逐条执行“主语—关系或字段—值—适用时间—证据”分析；引用能独立支撑断言的最短充分原文，把复合陈述拆为可单独验证的事实，并区分持续状态与瞬时事件、客观发生与角色认知。先语义去重，再判断 novelty，不能因换一种说法重复建档。
判断标准：事实必须有明确文本证据，或是文本成立所必需且不增加新信息的最低限度推断；推断需降低置信度。对白中的谎言、猜测、计划、比喻、梦境、未证实传闻和 POV 误读不能登记为客观事实。
边界：不总结文风或主题，不补全空白，不预测后续，不把蓝图计划当已发生事实，不因字段可填写就制造记录；发现冲突只标记并保留证据，不擅自裁决或覆盖正式事实。
交付：每条候选原子化、字段归属准确、证据可回看、时间与认知层级明确，并足以支持后续人工审批和连续性检索。`,
  "quality-editor": `你是顶尖的小说总编与 managing editor，负责对蓝图、正文、候选产物或多份独立审校报告做证据驱动的综合裁决。
职责：先识别本次审校对象、作品目标和编辑阶段，再验证各项发现的证据与职责归属；合并同源症状、拆开不同机制，解决报告冲突，校准严重度与修订优先级，形成能指导下一步行动的单一质量结论。
方法：对每项发现检查“原文证据是否成立、违反了什么项目契约、影响范围多大、根因位于哪一层、建议是否会伤害其他维度”；用文本和批准资料裁决，不以 reviewer 数量、平均意见或措辞强烈程度代替判断。主动识别报告遗漏、误判和相互矛盾，但不为凑数新增问题。
判断标准：blocker 表示无法安全进入下一阶段，major 表示显著破坏核心职责或读者体验，warning 表示局部风险；偏好、可选增强和无证据猜测不得升级为缺陷。优先处理能解释多个表面症状的共同机制。
边界：尊重作者意图、项目范围和各专业 reviewer 的职责；不把不同意见粗暴折中，不用固定写作公式覆盖题材差异，不批准超出证据的重写，也不因总体分数较高而忽略明确阻断项。
交付：报告去重而不丢信息，保留来源与证据，明确严重度、根因、受影响范围、修订目标和回归风险，使修订者知道改什么、为何改、哪些内容必须保留。`,
  "character-enricher": `你是顶尖的人物塑造编辑与角色档案师，能从正式正文的行为证据中提炼稳定而有张力的人物模型。
职责：基于已确认事实与正文证据，完善人物的外在欲望、内在恐惧、错误信念、未承认需求、道德边界、能力限制、声音特征、关系模式与弧光方向，让档案能解释已发生选择并支持后续一致创作。
方法：从人物反复选择、付出代价、关注或回避的事物、压力下的语言和行动中归纳；区分长期特质、当前状态、社会面具和情境反应，区分正文直接建立与合理推断。新条目应与现有档案交叉校验，只在有增量时更新。
判断标准：一个可靠条目应能被具体证据支持、能预测人物在相似压力下的倾向，同时仍给人物留下矛盾、成长和意外选择的空间；单次偶发表现不足以直接固化为人格本质。
边界：不为填满字段而发明童年、创伤、秘密、诊断或未来弧光，不把类型套路当人物事实，不消除有意歧义，不与锁定设定冲突；不得在 payload 中写候选、待审核等审批状态。
交付：只提交正文已建立或可合理推断的字段增量，表述具体、可用于写作、互不重复，并保留证据不足处为空。`,
  "conversation-assistant": `你是顶尖的作者侧创作协作编辑，兼具 commissioning editor 的需求澄清能力与研究馆员的证据意识。
职责：理解作者本轮真正要解决的创作问题，维护章节创作简报，检索并组织相关项目资料，区分确认事项、探索性想法、助手建议和待查问题，并把明确的项目级修改请求送入正式候选流程。
方法：结合作者原话、对话历史、当前简报和带来源检索证据复述意图；优先回答已经有证据的问题，只在会改变产物方向时提出少量精确问题。检索不足时给出能命中特定实体、章节、事实或约束的查询，不要求作者重复已提供内容。
判断标准：任何写入简报或长期偏好的内容都必须能追溯到作者明确表达；任何故事事实都必须来自正式资料或被清楚标为建议。章节局部要求与项目 canonical 变更必须分流，不能因措辞相似混为一谈。
边界：不替作者暗中做创作决定，不把助手建议、检索猜测或未确认设定说成事实，不擅自扩大任务，不用泛泛追问拖延可执行工作。
交付：回答直接、上下文充分；简报补丁只含本轮明确要求，搜索问题具体可执行，项目级变更描述完整且等待正式审核。`,
  "memory-curator": `你是顶尖的小说创作记忆策展人与记录管理员，负责让长期记忆保持真实、可追溯、低噪声且可复用。
职责：只从作者明确表达中提炼稳定偏好、工作方式和跨轮次仍有效的任务要求；记录来源、适用范围、置信度和时间语境，并处理重复、包含关系、过期与冲突。
方法：逐项检查“是谁说的、原话证据是什么、这是一次性指令还是长期偏好、适用于项目/章节/全局哪一层、未来何时有用”；保留最短充分证据，语义去重，遇到新旧冲突时保留演变关系而不是悄悄拼接。
判断标准：只有作者直接陈述且未来复用收益高于误用风险的内容才进入长期记忆；故事事实、当前章节情节和临时操作默认留在正式项目资料或当前任务上下文，不进入偏好记忆。
边界：不记录助手建议、模型推断、作者未确认的设定、从行为猜出的偏好或敏感的无关信息；不把“这次这样做”自动升级为“以后始终这样做”。
交付：每条记忆原子化、范围清楚、证据可核验、无重复且能独立理解；证据不足时宁可不写。`,
  "skill-iterator": `你是顶尖的创作技能迭代工程师，兼具根因分析、提示词契约设计和跨场景回归意识。
职责：把质量报告与 learning 中的证据转化为可复用的 skill 改进；识别观察症状、失效工作流层、底层机制、受影响输入类别和行为边界，选择拥有该问题的最低公共 skill，而不是为单个样例追加禁令。
方法：先验证 issue 是否由目标 skill 的规则缺失、歧义、优先级冲突或执行不可判定造成；再提出一般决策规则、必要步骤和正反边界，并生成保留原结构与有效内容的完整 afterPrompt。每项修改都绑定触发 issue，说明机制、预期改善、非覆盖范围与回归风险。
判断标准：候选规则应能覆盖原失败场景和至少一种题材、角色、章节功能或文风显著不同的同类场景；若规则只识别特定标题、名字、原句、章节号或 fixture 形状，视为过拟合。没有充分共同机制时不提案。
边界：不把 issue 列表原样塞进 prompt，不用阈值微调伪装根因修复，不修改无关部分，不删除仍有效的约束，不让示例取代原则；修订后仍须经过独立审核和失败场景回归，A/B 分数本身不等于有效。
交付：返回语法完整、职责明确、优先级一致的完整 skill prompt；rationale 能从证据追溯到机制和规则，triggeredByIssueIds 准确覆盖实际触发项。`,
};

export function endpoint(baseUrl: string) {
  const normalized = baseUrl.replace(/\/+$/, "");
  // 浏器 dev 模式下走 Vite proxy 避免 CORS；但 Node/SSR 环境（如 novel:closed-loop / novel:20chapters CLI）
  // 没有 window.location，fetch 无法解析相对 URL，必须直连 baseUrl。
  if (normalized === "https://gpt.eromaa.com/v1" && import.meta.env?.DEV && typeof window !== "undefined") return "/ai-proxy";
  return normalized;
}
async function hashPrompt(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((item) => item.toString(16).padStart(2, "0")).join("");
}

/**
 * 预留的 LLM 上下文调用扩展点（审计 Loop 1 扩展点 C）。
 *
 * 背景：项目内所有 LLM 调用都是无状态 web 对话，服务端不保留会话记忆。
 * 该接口为未来需要"上下文感知"的调用（多轮对话、长篇连续创作、Responses API
 * 服务端会话）预留扩展点；现有 stateless 调用点无需改动，行为不变。
 *
 * 设计原则：
 * - `priorMessages`：客户端回放历史。把多轮对话历史作为 messages 数组追加到
 *   system 与本轮 user 之间。与现有 `/chat/completions` 端点兼容，所有 provider
 *   都支持，今天即可使用。
 * - `previousResponseId`：服务端会话引用（Responses API 的 `previous_response_id`）。
 *   TODO P1: 当前未实现 `/responses` 端点路由，字段仅预留。实现时需在
 *   `streamNovelModel`/`requestChat` 内根据此字段选择端点，并处理 provider 不支持
 *   `/responses` 的降级（fallback 到 priorMessages 回放或显式报错）。
 *
 * 两者同时提供时，priorMessages 作为 previousResponseId 不可用时的降级路径；
 * 实现层应优先尝试 previousResponseId（若已接入），失败再回退 priorMessages。
 */
export interface NovelConversationContext {
  /** 客户端回放历史。追加到 system 与本轮 user 之间，复用现有 /chat/completions 端点。 */
  priorMessages?: Array<{ role: "user" | "assistant"; content: string }>;
  /**
   * Responses API 服务端会话引用。
   * TODO P1: 未实现 /responses 端点路由；当前 buildConversationMessages 完全不消费此字段
   * （无论 priorMessages 是否为空），需在接入 /responses 路由后由 streamNovelModel/requestChat 处理。
   * 调用方在 TODO P1 落地前不应仅依赖此字段——应同时提供 priorMessages 作为降级路径。
   */
  previousResponseId?: string;
}

/**
 * 构造单轮调用的 messages 数组：system + 可选的回放历史 + 本轮 user。
 *
 * - 不传 conversationContext 或 priorMessages 为空时，输出与原 streamNovelModel/
 *   callStructuredNovelModel 行为完全一致（system+user 两条消息），保证现有调用点零回归。
 * - previousResponseId 当前不在此函数消费（TODO P1），由调用方在实现 /responses 路由时处理。
 */
function buildConversationMessages(params: {
  system: string;
  userPrompt: string;
  conversationContext?: NovelConversationContext;
}): Array<{ role: "system" | "user" | "assistant"; content: string }> {
  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: params.system },
  ];
  const prior = params.conversationContext?.priorMessages;
  if (prior && prior.length > 0) {
    for (const msg of prior) {
      messages.push({ role: msg.role, content: msg.content });
    }
  }
  messages.push({ role: "user", content: params.userPrompt });
  return messages;
}

const MAX_RETRIES = 3;
// 429/503 限流需要更多重试次数，但退避间隔已大幅缩短（3s/5s/8s/12s/15s）。
// 原阶梯 30/60/120/180/300s 总退避 690s，新版总退避 43s，显著减少等待时间。
// 短间隔依赖流式重试链的多次尝试覆盖限流恢复窗口，而非单次长退避。
const RATE_LIMIT_MAX_RETRIES = 5;
const RETRY_BASE_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 30_000;
// 默认超时：结构化调用与流式正文生成均使用 1800s，容纳多次重试 + 短退避。
const DEFAULT_STRUCTURED_TIMEOUT_MS = 1_800_000;
const DEFAULT_STREAM_TIMEOUT_MS = 1_800_000;

function createTimeoutSignal(timeoutMs?: number, external?: AbortSignal): AbortSignal | undefined {
  if (!timeoutMs) return external;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException(`LLM 调用超时（${timeoutMs}ms）`, "TimeoutError")), timeoutMs);
  // 若外部 signal 先触发，同步 abort 并清理 timer
  if (external) {
    if (external.aborted) controller.abort(external.reason);
    else external.addEventListener("abort", () => { controller.abort(external.reason); clearTimeout(timer); }, { once: true });
  }
  // 当 controller 自身 abort（含超时或外部联动）时清理 timer，避免泄漏
  controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  return controller.signal;
}

function isTimeoutAbort(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "TimeoutError") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /超时|timeout/i.test(message);
}

class NovelHttpError extends Error {
  /** Retry-After 响应头解析后的毫秒数（仅 429/503 等限流响应可能携带）。 */
  readonly retryAfterMs: number | undefined;
  constructor(readonly status: number, readonly responseBody: string, retryAfterHeader?: string | null) {
    super(`HTTP ${status}${responseBody ? `: ${responseBody}` : ""}`);
    this.name = "NovelHttpError";
    if (retryAfterHeader) {
      const seconds = Number(retryAfterHeader);
      // Retry-After 既可能是 delta-seconds 也可能是 HTTP-date；这里只处理数字形式。
      if (Number.isFinite(seconds) && seconds >= 0) this.retryAfterMs = seconds * 1000;
    }
  }
}

class NovelEmptyResponseError extends Error {
  constructor(message = "AI 未返回有效内容") {
    super(message);
    this.name = "NovelEmptyResponseError";
  }
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")) return false;
  if (isTimeoutAbort(error)) return false;
  if (error instanceof NovelEmptyResponseError) return true;
  if (error instanceof NovelHttpError) return error.status === 429 || error.status >= 500;
  if (error instanceof TypeError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /terminated|HTTP 5\d\d|HTTP 429|ECONNRESET|ENOTFOUND|fetch failed|socket hang up/i.test(message);
}

/**
 * 判断是否为限流类错误。
 *
 * 除了标准的 HTTP 429/503，某些 OpenAI 兼容提供商（如 eromaa.com）在限流时
 * 返回 HTTP 200 + 空内容（completion_tokens=0, finish_reason=stop）而非 429。
 * NovelEmptyResponseError 覆盖这一场景，需要与 429 同等对待：更多重试次数 + 更长退避。
 */
function isRateLimitLikeError(error: unknown): boolean {
  if (error instanceof NovelHttpError && (error.status === 429 || error.status === 503)) return true;
  if (error instanceof NovelEmptyResponseError) return true;
  return false;
}

/** 限流类错误（429/503/空内容）使用更多重试次数（配合更长退避阶梯），其他错误沿用默认次数。 */
function getMaxRetries(error: unknown): number {
  if (isRateLimitLikeError(error)) return RATE_LIMIT_MAX_RETRIES;
  return MAX_RETRIES;
}

function sleep(ms: number, signal?: AbortSignal) {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("调用已取消", "AbortError"));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("调用已取消", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/**
 * 计算重试前的退避延迟。
 *
 * 限流类错误（429/503/空内容）使用短退避阶梯（3s/5s/8s/12s/15s），
 * 配合 5 次重试覆盖限流恢复窗口，总退避 43s。
 * 通用错误沿用 1s/2s/4s 指数退避。
 * 若提供商在 Retry-After 头中显式指定了恢复时间，优先服从（上限 30s）。
 */
function getRetryDelay(error: unknown, attempt: number): number {
  const jitter = Math.random() * 500;
  if (isRateLimitLikeError(error)) {
    if (error instanceof NovelHttpError && error.retryAfterMs && error.retryAfterMs > 0) {
      const delay = Math.min(error.retryAfterMs, MAX_RETRY_DELAY_MS) + jitter;
      console.error(`[ai.ts] rate-limit retry attempt=${attempt} waiting ${Math.round(delay)}ms (Retry-After header)`);
      return delay;
    }
    // 限流退避阶梯：3s → 5s → 8s → 12s → 15s
    // 短间隔策略：通过多次尝试快速探测限流恢复，而非单次长等待。
    const rateLimitDelays = [3_000, 5_000, 8_000, 12_000, 15_000];
    const delay = (rateLimitDelays[attempt] ?? 15_000) + jitter;
    const errorDesc = error instanceof NovelHttpError ? `HTTP ${error.status}` : error instanceof Error ? error.name : typeof error;
    console.error(`[ai.ts] rate-limit retry attempt=${attempt} waiting ${Math.round(delay)}ms (${errorDesc})`);
    return delay;
  }
  const delay = RETRY_BASE_DELAY_MS * 2 ** attempt + jitter;
  console.error(`[ai.ts] retry attempt=${attempt} waiting ${Math.round(delay)}ms (non-rate-limit error: ${error instanceof Error ? error.name : typeof error})`);
  return delay;
}

function parseSseEvent(line: string): Record<string, unknown> | undefined {
  const raw = line.replace(/^data:\s*/, "").trim();
  if (!raw || raw === "[DONE]") return undefined;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

async function fetchAccumulated(params: {
  baseUrl: string;
  apiKey: string;
  body: Record<string, unknown>;
  signal?: AbortSignal;
}) {
  const response = await fetch(`${endpoint(params.baseUrl)}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${params.apiKey}` },
    signal: params.signal,
    body: JSON.stringify({ ...params.body, stream: true, stream_options: { include_usage: true } }),
  });
  if (!response.ok) throw new NovelHttpError(response.status, await response.text().catch(() => ""), response.headers.get("retry-after"));
  if (!response.body) throw new Error("AI 响应没有可读取内容");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result = "";
  let inputTokens = 0;
  let outputTokens = 0;
  const consumeLine = (line: string) => {
    const chunk = parseSseEvent(line);
    if (!chunk) return;
    const choices = chunk.choices as Array<{ delta?: { content?: string } }> | undefined;
    result += choices?.[0]?.delta?.content ?? "";
    const usage = chunk.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
    if (usage) {
      inputTokens = usage.prompt_tokens ?? 0;
      outputTokens = usage.completion_tokens ?? 0;
    }
  };
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) consumeLine(line);
  }
  buffer += decoder.decode();
  for (const line of buffer.split("\n")) consumeLine(line);
  if (!result.trim()) throw new NovelEmptyResponseError();
  return { content: result.trim(), usage: { inputTokens, outputTokens } };
}

async function requestChat(params: {
  model: string;
  temperature: number;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  signal?: AbortSignal;
  responseSchema?: Record<string, unknown>;
  maxTokens?: number;
}) {
  const config = getNovelApiConfig();
  if (!config.apiKey) throw new Error("请先在设置中配置 API Key");
  const model = resolveModel(params.model);
  assertModelContextLimit({ model, text: params.messages.map((message) => message.content).join("\n"), override: config.modelContextWindow, outputReserve: params.maxTokens ?? 4096 });
  const body: Record<string, unknown> = { model, temperature: params.temperature, messages: params.messages };
  if (params.maxTokens && params.maxTokens > 0) body.max_tokens = params.maxTokens;
  if (params.responseSchema) body.response_format = { type: "json_schema", json_schema: { name: "novel_artifact", strict: true, schema: params.responseSchema } };
  let attempt = 0;
  while (true) {
    try {
      try {
        return await fetchAccumulated({ baseUrl: config.baseUrl, apiKey: config.apiKey, body, signal: params.signal });
      } catch (error) {
        // provider 不支持 response_format（400/404/422）或 strict 模式返回空内容时，
        // 降级为流式 + 去 schema 重试。parseJsonContent 已能处理 markdown 包裹的 JSON。
        if (params.responseSchema && (
          (error instanceof NovelHttpError && [400, 404, 422].includes(error.status))
          || error instanceof NovelEmptyResponseError
        )) {
          const fallbackBody = { ...body };
          delete fallbackBody.response_format;
          return await fetchAccumulated({ baseUrl: config.baseUrl, apiKey: config.apiKey, body: fallbackBody, signal: params.signal });
        }
        throw error;
      }
    } catch (error) {
      const maxRetries = getMaxRetries(error);
      // attempt 从 0 起算：首次失败 attempt=0，重试到 attempt=maxRetries 时停止。
      // 这样 maxRetries 即"重试次数（不含首次）"，与 RATE_LIMIT_MAX_RETRIES=5 + 退避数组 5 项对齐：
      // 限流场景执行 1 次首调 + 5 次重试 = 6 次尝试，退避 3s/5s/8s/12s/15s 总 43s；
      // 通用错误 1 次首调 + 3 次重试 = 4 次尝试，退避 1s/2s/4s 总 7s。
      if (!isRetryableError(error) || attempt >= maxRetries) throw error;
      await sleep(getRetryDelay(error, attempt), params.signal);
      attempt += 1;
    }
  }
}

export async function streamNovelModel(params: {
  model: string;
  temperature: number;
  role: NovelAgentRole;
  prompt: string;
  skillPrompt?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxTokens?: number;
  onToken?: (text: string) => void;
  /**
   * 可选的对话上下文扩展点（审计 Loop 1 扩展点 C）。
   * 不传或 priorMessages 为空时行为与原版完全一致（system+user 单轮）。
   */
  conversationContext?: NovelConversationContext;
}) {
  const config = getNovelApiConfig();
  if (!config.apiKey) throw new Error("请先在设置中配置 API Key");
  const model = resolveModel(params.model);
  const system = [SYSTEM_INVARIANTS, ROLE_PROMPTS[params.role], params.skillPrompt].filter(Boolean).join("\n\n");
  const messages = buildConversationMessages({
    system,
    userPrompt: params.prompt,
    conversationContext: params.conversationContext,
  });
  assertModelContextLimit({ model, text: messages.map((m) => m.content).join("\n"), override: config.modelContextWindow, outputReserve: params.maxTokens ?? 8192 });
  const signal = createTimeoutSignal(params.timeoutMs ?? DEFAULT_STREAM_TIMEOUT_MS, params.signal);
  let attempt = 0;
  while (true) {
    let result = "";
    try {
      // Loop 3 实测：revision-stage 重写整章时 LLM 因默认 max_tokens 不足而返回"请分多次发送"拒绝消息
      // 默认 max_tokens（通常 4096）只能输出约 2000-3000 中文字，但章节蓝图目标 5000 字
      // 当 maxTokens 显式提供时传入 API，否则使用 API 提供商默认值
      const requestBody: Record<string, unknown> = {
        model,
        temperature: params.temperature,
        stream: true,
        messages,
      };
      if (params.maxTokens && params.maxTokens > 0) {
        requestBody.max_tokens = params.maxTokens;
      }
      const response = await fetch(`${endpoint(config.baseUrl)}/chat/completions`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` }, signal,
        body: JSON.stringify(requestBody),
      });
      if (!response.ok) throw new NovelHttpError(response.status, await response.text().catch(() => ""), response.headers.get("retry-after"));
      if (!response.body) throw new Error("AI 响应没有可读取内容");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let eventCount = 0;
      let reportedOutputTokens = 0;
      const finishReasons = new Set<string>();
      const deltaFields = new Set<string>();
      const consumeLine = (line: string) => {
        const chunk = parseSseEvent(line);
        if (!chunk) return;
        eventCount += 1;
        const choices = chunk.choices as Array<{ delta?: Record<string, unknown>; finish_reason?: string | null }> | undefined;
        const choice = choices?.[0];
        if (choice?.finish_reason) finishReasons.add(choice.finish_reason);
        for (const field of Object.keys(choice?.delta ?? {})) deltaFields.add(field);
        const usage = chunk.usage as { completion_tokens?: number } | undefined;
        reportedOutputTokens = usage?.completion_tokens ?? reportedOutputTokens;
        const token = typeof choice?.delta?.content === "string" ? choice.delta.content : "";
        if (!token) return;
        result += token;
        params.onToken?.(result);
      };
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) consumeLine(line);
      }
      buffer += decoder.decode();
      for (const line of buffer.split("\n")) consumeLine(line);
      if (!result.trim()) {
        throw new NovelEmptyResponseError(`AI 未返回有效内容（SSE events=${eventCount}, finish=${[...finishReasons].join("|") || "none"}, delta=${[...deltaFields].join("|") || "none"}, outputTokens=${reportedOutputTokens}）`);
      }
      return { content: result.trim(), promptHash: await hashPrompt(messages.map((m) => m.content).join("\n")) };
    } catch (error) {
      const maxRetries = getMaxRetries(error);
      // 同 requestChat：attempt 从 0 起算，重试到 attempt=maxRetries 时停止。
      // 限流场景 1 次首调 + 5 次重试 = 6 次尝试，退避 3s/5s/8s/12s/15s 总 43s。
      if (!isRetryableError(error) || attempt >= maxRetries) throw error;
      await sleep(getRetryDelay(error, attempt), signal);
      attempt += 1;
    }
  }
}

function parseJsonContent(content: string) {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? content.slice(content.indexOf("{"), content.lastIndexOf("}") + 1);
  return JSON.parse(candidate.trim()) as Record<string, unknown>;
}

export async function callStructuredNovelModel<T extends Record<string, unknown>>(params: {
  model: string;
  temperature: number;
  role: NovelAgentRole;
  prompt: string;
  skillPrompt?: string;
  schema: Record<string, unknown>;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxTokens?: number;
  /**
   * 可选的对话上下文扩展点（审计 Loop 1 扩展点 C）。
   * 不传或 priorMessages 为空时行为与原版完全一致（system+user 单轮）。
   * 注意：schema 修复重试不携带 conversationContext——修复是独立的 schema 校验循环，
   * 不应回放对话历史，避免把多轮历史塞进修复 prompt 造成混淆。
   */
  conversationContext?: NovelConversationContext;
}) {
  const system = [SYSTEM_INVARIANTS, ROLE_PROMPTS[params.role], params.skillPrompt, "只输出符合 JSON Schema 的 JSON，不要使用 Markdown 代码围栏。"].filter(Boolean).join("\n\n");
  const messages = buildConversationMessages({
    system,
    userPrompt: params.prompt,
    conversationContext: params.conversationContext,
  });
  const model = resolveModel(params.model);
  const validate = new Ajv({ allErrors: true, strict: false }).compile(params.schema as AnySchema);
  const signal = createTimeoutSignal(params.timeoutMs ?? DEFAULT_STRUCTURED_TIMEOUT_MS, params.signal);
  // 显式构造 requestChat 入参，避免把 conversationContext/schema/prompt 等本函数专用字段透传给底层。
  let response = await requestChat({
    model,
    temperature: params.temperature,
    messages,
    signal,
    responseSchema: params.schema,
    maxTokens: params.maxTokens,
  });
  let parsed: Record<string, unknown> | undefined;
  try { parsed = parseJsonContent(response.content); } catch { parsed = undefined; }
  if (!parsed || !validate(parsed)) {
    const schemaStr = JSON.stringify(params.schema, null, 2);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const errors = validate.errors?.map((item) => `${item.instancePath || "root"} ${item.message}`).join("；") ?? "无法解析 JSON";
      const repairPrompt = attempt === 0
        ? `把下面输出修复为严格符合给定 Schema 的 JSON。不得增加原输出没有的故事事实。summary 字段只写候选整体概览，禁止描述修复过程、Schema 约束或被丢弃的字段。\n\nSchema:\n${schemaStr}\n\n校验错误：${errors}\n\n原输出：\n${response.content}`
        : `上一次修复仍然失败。请完全重新生成符合 Schema 的 JSON。只输出 JSON，不要输出任何其他内容。summary 字段只写候选整体概览，禁止描述修复过程、Schema 约束或被丢弃的字段。\n\n必须包含的字段：${Object.keys(params.schema.properties ?? {}).join(", ")}\n\nSchema:\n${schemaStr}\n\n校验错误：${errors}\n\n原输出：\n${response.content}`;
      const repaired = await requestChat({ model, temperature: 0, messages: [{ role: "system", content: system }, { role: "user", content: repairPrompt }], signal, responseSchema: params.schema, maxTokens: params.maxTokens });
      response = { content: repaired.content, usage: { inputTokens: response.usage.inputTokens + repaired.usage.inputTokens, outputTokens: response.usage.outputTokens + repaired.usage.outputTokens } };
      try { parsed = parseJsonContent(response.content); } catch { parsed = undefined; }
      if (parsed && validate(parsed)) break;
    }
    if (!parsed || !validate(parsed)) throw new Error(`AI 结构化输出无效：${validate.errors?.map((item) => `${item.instancePath || "root"} ${item.message}`).join("；") ?? "JSON 解析失败"}`);
  }
  return { data: parsed as T, usage: response.usage, promptHash: await hashPrompt(messages.map((m) => m.content).join("\n")) };
}
