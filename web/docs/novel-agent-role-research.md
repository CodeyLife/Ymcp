# 小说工作流 Agent 身份职责研究

## 问题与修复层级

现有工作流已经在各阶段 prompt 中提供输入、任务和输出 schema，但多数非 `writer` 身份只有一句职责标签。模型因此知道“要检查什么”，却不知道专业人员如何取证、如何判断、何时不应越权，以及怎样交付可被下一阶段消费的结果。

本次改进落在所有模型调用共享的 `ROLE_PROMPTS` 身份层。阶段 prompt 继续负责本次任务，skill prompt 继续负责版本化创作规则，role prompt 只负责稳定的职业能力合同。每份非 `writer` 合同统一包含：

1. `职责`：该身份对什么结果负责。
2. `方法`：顶尖从业者如何分析输入，而非只列检查项。
3. `判断标准`：什么证据足以支持结论。
4. `边界`：哪些相邻问题必须留给其他角色，避免多人重复审校或越权改写。
5. `交付`：结果如何做到可追溯、可执行并适配下游 schema。

这是一项共享层修复，覆盖不同题材、角色、章节功能和工作流阶段；它不替代具体 stage skill，也不规定单一小说公式。

## 资料原则

### 专业编辑的共同合同

[Editors Canada Professional Editorial Standards 2024](https://editors.ca/publications/professional-editorial-standards/) 将编辑定义为面向受众、媒介和目的审查、纠正和改进内容，并强调多轮独立编辑。其[编辑基础标准](https://editors.ca/publications/professional-editorial-standards/fundamentals-editing/)要求编辑尊重项目范围、保持作者原意和声音、明确不同编辑阶段的职责，并检查前序编辑是否落实且没有引入新问题。

采用结果：所有审校和修订身份都必须先理解项目目的，在职责范围内工作，以最小必要改动保护原意，并对新引入风险负责。

### 发展编辑、文风编辑与事实核验的分工

[Editors Canada 的编辑技能定义](https://editors.ca/hire-an-editor/skills/)将 structural editing 定义为改善内容与组织并澄清情节、人物和主题；stylistic editing 负责语义、连贯、流动、语气和作者声音；copy editing 负责准确、一致、完整及人物名、关系、时代错置等连续性；fact checking 必须回到原始或权威来源；manuscript evaluation 则综合人物、对白、场景、情节、结构、可信度、声音和受众适配。

采用结果：

- `style-reviewer` 只处理 POV、叙述距离、语言准确性、句段节奏和项目文风。
- `character-reviewer` 聚焦动机、选择、声音、关系和人物弧。
- `continuity-reviewer` 把时空、知识、物品和事实当作跨版本状态账本。
- `plot-reviewer` 聚焦章节功能、场景转折和因果链。
- `quality-editor` 负责跨报告校验、去重、冲突裁决和干预等级，而不是再次混做所有局部角色。
- `revision-editor` 只修改已证实问题，并验证没有改变原意或引入新错误。

### 长篇故事编辑与连续性

[ScreenSkills 的 Script Editor 职业说明](https://www.screenskills.com/job-profiles/browse/film-and-tv-drama/development-film-and-tv-drama-job-profiles/script-editor-film-and-tv-drama/)强调理解并保护作者声音、发展故事与人物、汇总多方意见，以及维护场景和剧集之间的连续性。该资料还把 script reader 的交付描述为包含故事拆解、类型和语气分析、优缺点与结论的 coverage report。

采用结果：`plot-reviewer`、`character-reviewer` 和 `continuity-reviewer` 不只做静态勾选，而要追踪跨场景状态、人物选择和长线故事影响；`quality-editor` 汇总意见时保留作者意图，不用多数票替代证据。

### 给作者反馈而非替作者写作

[Writers' Guild of Great Britain 的工作指南](https://writersguild.org.uk/wp-content/uploads/2024/07/working-with-tv-writers-a-good-practice-guide-for-programme-makers.pdf)要求反馈诚实、具体、建设性，说明为什么尚未成立；相比直接指定情节点，更应清楚表达期望达到的目标，并避免因个人口味强加修改。

采用结果：所有 reviewer 的交付采用“证据、影响、目标”结构，指出修复方向但不把个人方案当唯一答案；`reader-reviewer` 明确区分目标读者体验与个人喜好。

### 人物真实性与复杂度

[Editors Canada 的人物呈现指南](https://editors.ca/publications/editing-with-respect/)要求编辑检查人物身份呈现、刻板印象、不一致与资料依据，以形成真实、细腻而非工具化的人物。[其世界构建编辑资料](https://webinars.editors.ca/webinar_recording/worldbuilding-in-fiction-editing-theory-and-practice/)强调世界、人物和情节应可信、一致、沉浸，并从社会关系的实际运作而非清单式设定出发。

采用结果：`character-reviewer` 不以讨喜或单一心理模型裁决人物；`character-enricher` 区分长期特质、当前状态、社会面具和单次反应，不因字段为空就发明创伤、秘密或诊断。

### 事实、记忆与来源可追溯

[W3C PROV Overview](https://www.w3.org/TR/prov-overview/)将 provenance 定义为有关数据产出所涉及实体、活动和责任主体的信息，用于判断质量、可靠性和可信度。[PROV Primer](https://www.w3.org/TR/prov-primer/)进一步区分实体、活动、代理人、角色、使用、生成和版本派生。[ISO 15489-1](https://www.iso.org/standard/62542.html)覆盖记录、元数据、责任、控制以及记录的创建、捕获和长期管理。

采用结果：

- `fact-extractor` 以“主语、字段、值、时间、证据”生成原子事实，区分客观发生、人物认知、传闻和计划。
- `memory-curator` 记录作者原话来源、适用范围和时间语境，区分一次性指令与长期偏好。
- `conversation-assistant` 把作者确认、正式资料、检索推测和助手建议分层，不把来源不明内容升级为 canonical 事实。

### 改进必须处理机制而非样例

[ISO 的过程方法指南](https://www.iso.org/files/live/sites/isoorg/files/archive/pdf/en/iso9001-2015-process-appr.pdf)要求先定义问题、收集分析数据、选择方案、验证有效性并纳入日常流程，同时指出纠正措施应识别和消除根因。[ASQ Root Cause Analysis](https://asq.org/quality-resources/root-cause-analysis)把根因分析定位为持续改进的一部分，目标是找到引发整条因果链的可消除原因。

采用结果：`skill-iterator` 必须从 issue 还原失效层、底层机制、受影响输入类别和边界；规则要覆盖原案例及不同反例，禁止识别标题、名字、原句、章节号或 fixture 形状的样例过拟合。改进候选仍需独立审核和回归验证。

## 身份边界总览

| 身份 | 对结果负责 | 明确不负责 |
| --- | --- | --- |
| `architect` | 长篇结构、人物与事件因果、信息释放、长线承诺 | 正文措辞、擅改批准事实、固定结构套模 |
| `style-reviewer` | POV、叙述距离、语义、节奏、声音、具体性 | 情节重构、人物动机、事实裁决 |
| `character-reviewer` | 动机、选择、知识边界、声音、关系、主体性 | 要求人物讨喜、替代剧情或连续性审校 |
| `continuity-reviewer` | 时空、知识、状态、物品、规则、已确认事实 | 审美偏好、故意悬疑、未揭晓秘密 |
| `plot-reviewer` | 章节功能、场景转折、因果、信息和长线影响 | 强制公式、句法文风、事实账本 |
| `reader-reviewer` | 目标读者的注意、理解、情感、期待和满足 | 个人口味、技术审校、机械强钩子 |
| `revision-editor` | 在授权范围内修复有效 issue 并保护已通过内容 | 借机扩写、改剧情、统一个人风格 |
| `fact-extractor` | 有证据的原子状态变化及 novelty | 推测成真、把计划当发生、直接提交 |
| `quality-editor` | 证据校验、去重、冲突裁决、严重度和优先级 | 多数票裁决、凑问题、公式化总评 |
| `character-enricher` | 从正式证据提炼可复用人物模型 | 为填字段发明设定、固化单次反应 |
| `conversation-assistant` | 意图澄清、检索、简报和正式变更分流 | 暗中替作者决策、重复追问、猜测成真 |
| `memory-curator` | 有原话证据的长期偏好和跨轮次要求 | 故事事实、临时指令、助手建议 |
| `skill-iterator` | 根因驱动、跨场景可复用的 skill 完整修订 | 样例特判、阈值调参、只看 A/B 分数 |

