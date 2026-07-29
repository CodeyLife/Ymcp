-- ============================================================
-- 017_migrate_v1_skills.sql
-- 把 v1 的 28 个内置 skill 迁移到 v2 skill_definitions 表
-- ============================================================
--
-- 脚本目的：
--   将 v1 BUILTIN_NOVEL_SKILLS (src/features/novel/skills.ts L81-L110) 中的 28 个内置 skill
--   迁移到 v2 skill_definitions 表 (deploy/postgres/001_novel_v2.sql L64-L75 +
--   deploy/postgres/008_skill_genres.sql 追加 applicable_genres 列)。
--   不覆盖 013_default_skills.sql 已有的 3 个 v2 原生 skill：
--   longform-continuity / independent-quality-gate / memory-consolidation。
--
-- 字段映射规则（v1 NovelSkillManifest → v2 skill_definitions 行）：
--   skillId            → skill_id              直接映射
--   version            → version               直接映射（默认 1.0.0）
--   enabled            → enabled               直接映射（默认 TRUE）
--   stages             → applicable_tasks      v1 NovelSkillStage 映射到 v2 PreflightPlan.taskClass
--                                                (src/novel-v2/protocol.ts L39)：
--                                                  foundation         → foundation
--                                                  planning           → planning
--                                                  drafting           → drafting
--                                                  review             → review
--                                                  revision           → revision
--                                                  fact-extraction    → memory-maintenance
--                                                  character-enrichment → revision
--                                                    (TODO P2: v2 taskClass 枚举无 character-enrichment，
--                                                     按"修订式丰富"语义映射到 revision)
--   (无)               → capabilities          根据 stages 推断：
--                                                  drafting           → draft
--                                                  revision           → revision
--                                                  review             → review
--                                                  fact-extraction    → memory
--                                                  planning           → planning
--                                                  foundation         → planning
--                                                    (TODO P2: v2 capabilities 词表无 foundation，
--                                                     按"前期规划"语义映射到 planning)
--                                                  character-enrichment → revision
--                                                    (TODO P2: 同上，映射到 revision)
--                                                去重后写入。
--   (无)               → required_memory_kinds 全部置为 '{}'。
--                                                TODO P2: 任务描述假设 v1 requires 是 memory kind 数组，但
--                                                实际 v1 requires 是 skillId 依赖数组（见 skills.ts L221
--                                                addRequirements 递归），语义上对应"skill 依赖"而非 v2
--                                                MemoryKind (canonical/episodic/hierarchical，见
--                                                013_default_skills.sql)。v2 schema 无 skill_dependencies
--                                                列，故 required_memory_kinds 留空；v1 requires 信息
--                                                (chapter-blueprint/continuity-audit/fact-delta-extraction/
--                                                 romance-arc-design 的 skillId 依赖) 在迁移中丢失。
--   conflicts          → conflicts             直接映射。本次 28 个内置 skill 均未声明 conflicts，
--                                                统一用 ARRAY[]::text[]。
--   qualityChecks      → quality_gates         字符串数组直接映射。若该 skill 在
--                                                PORTABLE_SKILL_PROMPT_OVERRIDES (skills.ts L114-L133)
--                                                中被覆盖，使用覆盖后的 qualityChecks——
--                                                符合 AGENTS.md「reusable contracts over case-specific rules」，
--                                                可迁移契约版本去除了样例依赖。
--   prompt             → prompt_sections       JSONB 对象。key 为 v2 NovelStage
--                                                (protocol.ts L10: foundation/planning/drafting/review/
--                                                 revision/fact-extraction)，value 为 v1 prompt 字符串。
--                                                v1 stages 中每个 stage 映射到一个 NovelStage key；
--                                                character-enrichment 映射到 revision key (TODO P2)。
--                                                若多个 stage 映射到同一 key（如 revision +
--                                                character-enrichment），key 只出现一次。prompt 使用
--                                                "可迁移契约"版本：若 skill 在
--                                                PORTABLE_SKILL_PROMPT_OVERRIDES 中有覆盖，用覆盖后的
--                                                prompt（去除样例依赖）。
--   (无)               → applicable_genres     全部置为 '{}'（题材无关）。v1 category 是创作流派
--                                                (ideation/character-world/long-plan/chapter/drafting/
--                                                 serial/review/memory)，不是 v2 题材标签（玄幻/都市），
--                                                不直接迁移。题材特化走 craft rule 沉淀
--                                                (见 008_skill_genres.sql 设计依据)。
--
-- 已丢弃的 v1 字段（v2 schema 无对应列）：
--   name, description, locale, category, priority, inputSchema, outputSchema,
--   source, sourceUrl, license, readonly, triggers, requires (skillId 依赖，见上 TODO P2)
--
-- ON CONFLICT 策略：
--   ON CONFLICT(skill_id) DO NOTHING —— 不覆盖 013_default_skills.sql 已插入的 3 个 v2 原生 skill。
--   v1 的 28 个 skill_id 与 v2 已有 skill_id 不冲突（v1 用 long-form-master-craft 等，
--   v2 用 longform-continuity 等）。
--
-- 转义策略：
--   prompt_sections 用 jsonb_build_object(stage_key, $tag$prompt_text$tag$) 构造。
--   prompt 文本用 dollar-quoting（$tag$...$tag$）避免单引号/反斜杠转义问题：
--     - dollar-quoted 字符串内可原样包含单引号、双引号、反斜杠
--     - 换行用 SQL 源码中的真实换行（dollar-quoted 字符串可跨多行）
--     - jsonb_build_object 自动处理 JSON 转义（" → \"，换行 → \n，\ → \\）
--   每个 skill 使用独立的 CTE (pNN) 承载 prompt，避免在 jsonb_build_object 中重复长文本。
--
-- 数据来源（只读）：
--   - v1 skills: src/features/novel/skills.ts (BUILTIN_NOVEL_SKILLS L81-L110,
--                PORTABLE_SKILL_PROMPT_OVERRIDES L114-L133)
--   - v1 类型:   src/features/novel/types.ts (NovelSkillManifest L743-L764,
--                NovelSkillStage L740)
--   - long-form-master-craft 的 prompt 引用自 src/features/novel/craft-standards.ts
--     的 LONG_FORM_WEB_NOVEL_STANDARD
--   - v2 schema: deploy/postgres/001_novel_v2.sql L64-L75
--   - v2 类型:   src/novel-v2/protocol.ts (SkillDescriptor L151-L171,
--                NovelStage L10, PreflightPlan.taskClass L39)
--   - v2 用法:   src/novel-v2/cognition.ts resolveSkillBundle L207-L225
--
-- ============================================================


-- Skill 01: long-form-master-craft (百万字长篇总纲)
-- 来源 prompt: craft-standards.ts LONG_FORM_WEB_NOVEL_STANDARD
WITH p01 AS (SELECT $p_01$面向百万字级长篇连载，所有规划、写作与审核共同遵守以下通用标准。标准用于判断作品是否具备长期生命力，不要求每章机械覆盖全部维度。

一、长期叙事承诺
- 核心设定必须持续制造选择、阻力和代价，而不是只支撑开篇噱头。
- 全书、分幕、剧情段和章节形成不同尺度的期待与兑现；短期回报不能透支中长期秘密、关系跃迁和价值冲突。
- 升级来自人物解决旧问题后进入更难处境，不靠单纯扩大敌人、数字或灾难规模。
- 安静章、余波章和生活章可以不改变局势，但必须深化人物、关系、世界秩序、情绪积累或读者理解。

二、因果与结构
- 重要事件由人物目标、既有规则和前置行动共同触发，并留下可追踪的直接后果和延迟后果。
- 支线拥有自身人物与矛盾，可以改变主线人物的选择、认知、关系或资源，也可以独立承担世界观铺陈、群像塑造或主题回声；不必机械反哺主线，但必须有自身完整的人物处境与因果链。
- 转折应同时改变外部处境和人物内部判断，形成不可逆的新阶段；禁止用偶然、误会拖延或临时规则代替因果。
- 伏笔以日常细节自然存在，提醒方式有变化，回收既解释过去又改变当下。

三、人物生命力
- 主要人物拥有独立欲望、恐惧、价值排序、行为底线、关系债务和愿意支付的代价。
- 人物通过选择推动剧情；同一人物在压力升级时既保持核心一致，又因经历产生可解释的变化。
- 配角在主角视野之外也有行动链，群像通过利益、感情、秘密和承诺构成动态关系网络。
- 对白由身份、教育、权力位置、当下目的和回避方式共同决定；去掉姓名仍应尽量可辨。
- 情感关系通过共同经历、误读、照顾、冲突、亏欠和选择逐步变化，禁止用设定说明代替相处过程。

四、场景与阅读体验
- 场景具有明确的视角、当下欲望、具体阻力、环境反馈和局部结果；信息通过行动与感知进入，而非作者集中讲解。
- 节奏是铺垫、施压、行动、兑现和余波的呼吸，不把每章都写成高潮，也不让低强度章节原地重复。
- 相邻章节必须从已经改变的事实、关系、认知或行动位置继续，不反复用同一时间标记、天气、地点巡看、整理物件或背景说明把人物重置到相似起点。
- 章尾保留真实未解压力、关系变化、认知缺口或行动方向，不使用与正文无关的强制悬崖。
- 连载回报应来自前文积累，既满足题材承诺，又带来新的代价、问题或人物变化。

五、文笔、意境与叙述控制
- 抽象情绪落到身体反应、动作、器物、空间、声音、气味、温度和人物选择；关键处允许直写，但避免连续解释。
- 意象来自题材、人物经验和场景物质条件，随剧情改变含义；禁止为显得文学而堆砌同类景物和金句。
- 跨章复现的意象、句式和场景框架必须获得新的信息、关系或情绪功能；有语义演进的母题可以保留，只有换词而功能不变的模板复用需要改写。
- 句式长短、叙述密度和语体随场景功能变化。行动清楚，情绪有停留，对话有潜台词，背景说明有触发点。
- 叙述者尊重读者推断，不替人物和主题做过量总结；文学性来自准确、节制、独特视角与反复积累。
- 不模仿单一作品的表面词汇、句式或桥段，应提炼可迁移的叙事机制，并服从当前项目的题材与声音。

六、连续性与规模控制
- 事实、时间、人物知识、能力代价、资源流向和关系状态必须可追溯；新增例外要成为显式事实并承担后果。
- 每一阶段保留后续扩展空间，定期回收旧承诺、更新人物状态、淘汰失效支线，防止百万字后设定漂移。
- 审核区分事实错误、结构问题、人物问题、文体问题和审美偏好；只有有证据且可执行的问题进入修订。

七、规则演进原则
- 单章问题只是证据，不直接成为全局规则。先识别失效机制和适用输入类别，再决定修改 Skill、系统 Prompt、工作流还是局部内容。
- 任何全局规则修改必须说明适用边界、非目标与回归风险，并在原问题及不同人物、章节功能和叙事强度上验证。
- 新规则不得把一种优秀写法固化成唯一写法；应保护题材差异、作者声音、慢节奏章节和非常规结构的合理空间。

八、穿插节奏与体量稀释
- 主线推进应通过穿插式小故事稀释，相邻主线推进剧情段之间应穿插非主线推进剧情段（世界观穿插/群像塑造/支线编织/呼吸节奏），让整体推进速度放缓。
- 单一 phase 内，主线推进剧情段不建议连续超过 2 个而不穿插。
- 非主线推进剧情段也必须有自身完整的人物处境、矛盾和因果链，不能只是主线休息站或填充章。
- 世界观穿插型剧情段深化读者对世界秩序、势力、文化或规则的理解；群像塑造型剧情段深化读者对次要角色或配角生态的理解；呼吸节奏型剧情段深化人物关系或情感积累。这些剧情段不推进主线，但让小说内容更丰富、世界观更宏大、人物塑造和感情塑造更丰满。$p_01$ AS prompt_text)
INSERT INTO skill_definitions(skill_id, version, capabilities, applicable_tasks, required_memory_kinds, conflicts, quality_gates, prompt_sections, enabled)
SELECT 'long-form-master-craft', '1.0.0',
  ARRAY['planning','draft','review','revision'],
  ARRAY['foundation','planning','drafting','review','revision'],
  ARRAY[]::text[],
  ARRAY[]::text[],
  ARRAY['局部推进是否保留长期叙事空间','人物是否通过有代价的选择推动剧情','支线和伏笔是否改变后续而非只作装饰','文体与意境是否准确服务当前视角和场景','规则是否来自可迁移机制而非单一样例'],
  jsonb_build_object('foundation', prompt_text, 'planning', prompt_text, 'drafting', prompt_text, 'review', prompt_text, 'revision', prompt_text),
  TRUE
FROM p01
ON CONFLICT(skill_id) DO NOTHING;


-- Skill 02: story-facts-invariant (故事事实优先)
WITH p02 AS (SELECT $p_02$已确认的故事事实、锁定规则和人物知识边界优先于任何写作技巧。不得把建议写成既定事实；发生冲突时必须指出冲突并停止提交相关变更。$p_02$ AS prompt_text)
INSERT INTO skill_definitions(skill_id, version, capabilities, applicable_tasks, required_memory_kinds, conflicts, quality_gates, prompt_sections, enabled)
SELECT 'story-facts-invariant', '1.0.0',
  ARRAY['planning','draft','review','revision','memory'],
  ARRAY['foundation','planning','drafting','review','revision','memory-maintenance'],
  ARRAY[]::text[],
  ARRAY[]::text[],
  ARRAY['不得违反锁定事实','角色只能使用已知或合理推断的信息'],
  jsonb_build_object('foundation', prompt_text, 'planning', prompt_text, 'drafting', prompt_text, 'review', prompt_text, 'revision', prompt_text, 'fact-extraction', prompt_text),
  TRUE
FROM p02
ON CONFLICT(skill_id) DO NOTHING;


-- Skill 03: premise-pressure-test (核心创意压力测试)
-- prompt 取自 PORTABLE_SKILL_PROMPT_OVERRIDES（可迁移契约版本）
WITH p03 AS (SELECT $p_03$检验核心创意能否持续产生人物主动目标、现实阻力、选择代价、关系变化和题材承诺。扩展空间应来自机制可组合、人物会变化且后果能累积，而不是预设固定升级次数。短篇、单元剧、群像和实验结构按自身承诺判断。$p_03$ AS prompt_text)
INSERT INTO skill_definitions(skill_id, version, capabilities, applicable_tasks, required_memory_kinds, conflicts, quality_gates, prompt_sections, enabled)
SELECT 'premise-pressure-test', '1.0.0',
  ARRAY['planning'],
  ARRAY['foundation'],
  ARRAY[]::text[],
  ARRAY[]::text[],
  ARRAY['核心创意是否能持续生成有差异的处境','扩展是否来自人物与机制而非重复升级'],
  jsonb_build_object('foundation', prompt_text),
  TRUE
FROM p03
ON CONFLICT(skill_id) DO NOTHING;


-- Skill 04: character-desire-engine (人物欲望引擎)
-- prompt 取自 PORTABLE_SKILL_PROMPT_OVERRIDES
WITH p04 AS (SELECT $p_04$根据人物处境建立外在欲望、内在需求、恐惧、错误信念、边界、资源与代价之间的动态关系。字段只在有项目证据或创作必要时采用，不把人物压进固定原型。对立角色也应具有自洽目标、可理解边界和独立行动能力。初始状态必须具体到可进入场景，但允许不确定性明确留空并在后续补证。$p_04$ AS prompt_text)
INSERT INTO skill_definitions(skill_id, version, capabilities, applicable_tasks, required_memory_kinds, conflicts, quality_gates, prompt_sections, enabled)
SELECT 'character-desire-engine', '1.0.0',
  ARRAY['planning','review','revision'],
  ARRAY['foundation','planning','review','revision'],
  ARRAY[]::text[],
  ARRAY[]::text[],
  ARRAY['人物选择是否由自身处境与欲望推动','代价是否改变后续选择空间','对立角色是否具有独立行动逻辑'],
  jsonb_build_object('foundation', prompt_text, 'planning', prompt_text, 'review', prompt_text, 'revision', prompt_text),
  TRUE
FROM p04
ON CONFLICT(skill_id) DO NOTHING;


-- Skill 05: character-voice-matrix (角色声音矩阵)
WITH p05 AS (SELECT $p_05$让角色仅凭对白也可辨认。依据教育、阶层、关系权力、当前目标和回避习惯控制词汇、直接程度、潜台词与沉默。配角不得充当作者点题的传声筒。特殊身份人物除思考特质外，也必须呈现符合处境的身体感受、情绪压力和身份困境。

【群像场景的次要角色发声】蓝图在同一场安排多个有动作呈现的角色时，不能只让主要说话者开口。有具体动作（递物、拦阻、指引、反应、整理、呼唤其一）的次要角色应各有符合年龄、职业与处境的差异化表达，用于建立规则、提示世界观、呈现关系质地或锚定当下处境。仅作背景的群演可不发声，但有动作呈现的角色若全程沉默，等同于把声音全部收敛到主角与单一 NPC，丢失群像声部。判定标准：去掉说话人名字后，若一场戏中两个以上有动作的次要角色对白交换或缺失，则声音同质化或缺失，违规。$p_05$ AS prompt_text)
INSERT INTO skill_definitions(skill_id, version, capabilities, applicable_tasks, required_memory_kinds, conflicts, quality_gates, prompt_sections, enabled)
SELECT 'character-voice-matrix', '1.0.0',
  ARRAY['draft','review','revision'],
  ARRAY['drafting','review','revision'],
  ARRAY[]::text[],
  ARRAY[]::text[],
  ARRAY[]::text[],
  jsonb_build_object('drafting', prompt_text, 'review', prompt_text, 'revision', prompt_text),
  TRUE
FROM p05
ON CONFLICT(skill_id) DO NOTHING;


-- Skill 06: world-rule-contract (世界规则契约)
WITH p06 AS (SELECT $p_06$世界规则必须写清适用条件、能力上限、代价、例外和社会后果。解决冲突不得临时创造无铺垫规则；新增例外必须形成待审事实。$p_06$ AS prompt_text)
INSERT INTO skill_definitions(skill_id, version, capabilities, applicable_tasks, required_memory_kinds, conflicts, quality_gates, prompt_sections, enabled)
SELECT 'world-rule-contract', '1.0.0',
  ARRAY['planning','review'],
  ARRAY['foundation','planning','review'],
  ARRAY[]::text[],
  ARRAY[]::text[],
  ARRAY[]::text[],
  jsonb_build_object('foundation', prompt_text, 'planning', prompt_text, 'review', prompt_text),
  TRUE
FROM p06
ON CONFLICT(skill_id) DO NOTHING;


-- Skill 07: hierarchical-outline (分层剧情控制)
-- prompt 取自 PORTABLE_SKILL_PROMPT_OVERRIDES
WITH p07 AS (SELECT $p_07$按全书阶段、剧情段与章节逐层分配材料。每一层说明它改变的处境、人物关系、读者认知与后续可能性；下层不重复上层摘要，也不把未来节点提前压进当前层。层级数量、段落长度和转折形态由作品规模、题材与叙事结构决定。

【phase.turningPoint 文学化判定】架构中每个 phase 的 turningPoint 必须用文学化叙事书写，写处境的不可逆变化与人物心境的回不去，不得用"X 发现 Y""X 获得 Z 机会""X 建立 Y"等编剧指令腔。turningPoint 不是"接下来会发生什么"的事件预告，而是"此阶段结束时人物与世界已无可挽回地改变了什么"的文学定格。判定标准：删除该句后，读者仍能从字里行间感受到该阶段的不可逆变化；若不能，则 turningPoint 没写到位。事件公告式描述（"真相被揭开""证据链闭合""秘密公开兑现"）等同于编剧指令腔，违规。$p_07$ AS prompt_text)
INSERT INTO skill_definitions(skill_id, version, capabilities, applicable_tasks, required_memory_kinds, conflicts, quality_gates, prompt_sections, enabled)
SELECT 'hierarchical-outline', '1.0.0',
  ARRAY['planning'],
  ARRAY['foundation','planning'],
  ARRAY[]::text[],
  ARRAY[]::text[],
  ARRAY['上下层是否具有清晰职责','当前层是否保留后续展开空间','阶段变化是否产生可追踪后果','phase.turningPoint 是否为文学化不可逆定格而非事件公告/编剧指令腔','删除 turningPoint 句后读者是否仍能感受到回不去了'],
  jsonb_build_object('foundation', prompt_text, 'planning', prompt_text),
  TRUE
FROM p07
ON CONFLICT(skill_id) DO NOTHING;


-- Skill 08: causal-thread-weaving (因果与剧情线编织)
-- prompt 取自 PORTABLE_SKILL_PROMPT_OVERRIDES
WITH p08 AS (SELECT $p_08$重要推进应能追溯触发条件、人物行动、阻碍、直接结果与延迟后果。主线和支线通过人物、资源、秘密、关系或价值选择相互改变；支线可以提供对照、世界厚度或情感回声，不必机械服务主线，但必须在作品整体中产生可辨识影响。

【支线反哺三问】支线不得只通过"同时发生"与主线关联（如"主角在做 A 时，配角在做 B"），必须通过因果链关联（如"配角在 B 中获得的信息改变了主角在 A 中的选择"）。每条支线必须回答以下三问中的至少一问：(1) 它如何改变了主线人物的选择？(2) 它如何改变了主线人物的认知或信念？(3) 它如何为主线提供了关键资源、秘密或盟友？若一条支线对这三个问题都回答"否"，则该支线只是主线休息站，应考虑删除或重构。在 review 阶段应检查每条支线是否回答了反哺三问中的至少一问。$p_08$ AS prompt_text)
INSERT INTO skill_definitions(skill_id, version, capabilities, applicable_tasks, required_memory_kinds, conflicts, quality_gates, prompt_sections, enabled)
SELECT 'causal-thread-weaving', '1.0.0',
  ARRAY['planning','review'],
  ARRAY['planning','review'],
  ARRAY[]::text[],
  ARRAY[]::text[],
  ARRAY['推进是否有可追溯因果','支线是否产生独立且可辨识的影响','后果是否进入后续状态','每条支线是否回答了反哺三问中的至少一问','支线是否通过因果链而非同时发生与主线关联'],
  jsonb_build_object('planning', prompt_text, 'review', prompt_text),
  TRUE
FROM p08
ON CONFLICT(skill_id) DO NOTHING;


-- Skill 09: foreshadowing-ledger (伏笔账本)
-- prompt 取自 PORTABLE_SKILL_PROMPT_OVERRIDES
WITH p09 AS (SELECT $p_09$伏笔记录读者可见线索、角色可知范围、可能误读、提醒条件、揭示条件和回收影响。埋设、提醒和回收的距离与显著度由题材、公平性和阅读节奏决定；伏笔不是每个单元的必填项，也不得以作者预告代替现场证据。

【延迟回收范式】伏笔的威力来自延迟回收，而非即时揭晓。落实以下反直觉约束：(1) 伏笔埋设时必须以日常细节形态存在，不得自我标榜（禁止"他不知道这个决定将改变一切""这个细节后来证明至关重要"等作者预告）。(2) 伏笔的"读者可见线索"应当看似无关紧要的日常描写，读者初读仅觉景物描写，回收时方知环环相扣。(3) 伏笔的"提醒"应当以不经意的方式呈现（人物偶然瞥见、他人随口提及），不得让人物主动追查伏笔（除非该人物有明确动机）。(4) 伏笔的"回收"应当让读者产生"原来如此"的恍然，而非"终于揭晓"的被动接受——回收瞬间应触发情感爆发，而非信息确认。判定标准：若读者重读埋设段落时能立刻认出这是伏笔，则埋设过于刻意；理想状态是读者重读时才惊觉"原来这里早就埋了线索"。

【长线伏笔多义真相硬约束】长篇（百万字以上）需至少包含 1 条跨百章以上的长线伏笔。长线伏笔的 truth 字段不得在埋设阶段锁死单一解释——truth 字段写最终真相，但 notes 字段必须显式列出至少 1 个中期误导解释（读者在百章以内可能推断出的错误结论），最终揭晓的真相只是候选解释之一。具体要求：(1) notes 字段除标注提醒/回收方式外，必须包含"中期误导解释"小节，列出至少 1 个读者中期可能误推的错误结论；(2) 长线伏笔的最终真相应至少部分颠覆读者中期的推断，而非只是补充或确认；(3) 长线伏笔不得全部服务同一条主线（如全部指向同一案件真相），至少 1 条应独立关联权力格局、人物关系或世界规则，能在回收时改变角色关系或权力平衡；(4) 短线伏笔（回收跨度 < 30 章）的 truth 允许单一解释，但不得与长线伏笔回收至同一结论。判定标准：若所有长线伏笔的 truth 都收敛至同一解释，或 notes 字段未列出任何中期误导解释，则违规。短篇或单元剧不强制此要求。$p_09$ AS prompt_text)
INSERT INTO skill_definitions(skill_id, version, capabilities, applicable_tasks, required_memory_kinds, conflicts, quality_gates, prompt_sections, enabled)
SELECT 'foreshadowing-ledger', '1.0.0',
  ARRAY['planning','review','memory'],
  ARRAY['planning','review','memory-maintenance'],
  ARRAY[]::text[],
  ARRAY[]::text[],
  ARRAY['线索与角色知识边界是否清楚','回收是否有前文证据','伏笔是否适合当前题材与篇幅','伏笔埋设是否以日常细节形态存在而非自我标榜','伏笔提醒是否不经意而非人物主动追查','伏笔回收是否触发情感爆发而非信息确认','重读埋设段落时伏笔是否足够隐蔽','长线伏笔 notes 是否列出至少 1 个中期误导解释','长线伏笔是否至少有 1 条独立关联权力/关系/世界规则而非全部服务同一主线','所有长线伏笔 truth 是否避免收敛至同一解释'],
  jsonb_build_object('planning', prompt_text, 'review', prompt_text, 'fact-extraction', prompt_text),
  TRUE
FROM p09
ON CONFLICT(skill_id) DO NOTHING;


-- Skill 10: chapter-blueprint (章节蓝图)
-- prompt 取自 PORTABLE_SKILL_PROMPT_OVERRIDES
WITH p10 AS (SELECT $p_10$先判断本章不可替代的主导功能、精确起点、允许兑现的材料和需要保护的后续空间，再设计足以完成该功能的节拍。节拍数量、冲突强度、信息释放和章尾形态由具体章节决定；背景、生活、内心、关系、行动、余波和意象都可承担有效节拍。单视角内容不得越过角色可观察、可推断或可被告知的知识边界。

【卖点兑现调度】项目声明的卖点（sellingPoints：独特世界观机制、题材亮点、核心创意钩子）是读者留存的核心发动机——读者冲着卖点来，若全程读不到卖点在正文运作会弃书。规划时须识别处于本章兑现窗口的卖点，为其安排至少一个"读者通过视角人物当下行动、观察或对白在场亲历其运作"的具体节拍：卖点要被读者看到/听到/感受到它如何起效、如何改变人物处境或判断，而非仅通过设定说明、人物转述、旁白交代或 mustHappen 抽象提及。安静章/余波章不强制每章兑现卖点，但长线须有兑现调度，不得让卖点全程停留在设定层；若某卖点尚未进入兑现窗口，应在 forbidden 中保护其材料而非提前消费。判定标准：若全章对某个处于兑现窗口的卖点只在设定陈述、对白转述或抽象条目中出现，读者无法在场景中亲历其运作，则该卖点未兑现，须为其安排可体验节拍或明确推迟到后续兑现窗口并说明理由。

【POV 模式互斥硬约束】单 POV 章节与多视角切片章节互斥，不得混用：(1) 若 povCharacterId 填入具体角色 ID（非空、非"multi"），则必须使用单 POV 模式——所有 mustHappen 项不得包含非 POV 角色的内心动作（"X 意识到 / X 发现 / X 察觉 / X 心想"等），只能包含 POV 角色可观察、可推断、可被告知的外部事项，或 POV 角色自身的决定/记忆/误读/回避。(2) 若本章需要呈现 ≥2 个角色的内心活动（如"三线切片""群像章节"），则必须使用多视角切片模式——povCharacterId 必须为空或填入"multi"占位，不得填具体角色 ID；characterIds 必须列出全部视角人物；beats 中每个节拍必须显式标注其 POV（如"[POV:A] ...""[POV:B] ..."）。(3) 违规判定：povCharacterId 填具体角色 ID 但 mustHappen 含非 POV 角色内心动作 = 违规；povCharacterId 为空但 beats 未标注 POV = 违规；声称"多视角切片"但 povCharacterId 仍填单一角色 = 违规。$p_10$ AS prompt_text)
INSERT INTO skill_definitions(skill_id, version, capabilities, applicable_tasks, required_memory_kinds, conflicts, quality_gates, prompt_sections, enabled)
SELECT 'chapter-blueprint', '1.0.0',
  ARRAY['planning'],
  ARRAY['planning'],
  ARRAY[]::text[],
  ARRAY[]::text[],
  ARRAY['本章是否有不可替代的功能','节拍是否必要且连续','是否遵守兑现与知识边界','处于兑现窗口的卖点是否安排了可被正文在场亲历其运作的节拍而非仅设定陈述或对白转述','单 POV 章节 mustHappen 是否避免非 POV 角色内心动作','多视角切片章节 povCharacterId 是否为空或 multi 且 beats 是否标注 POV','POV 模式是否避免混用（单 POV + 多视角切片不得同时出现）'],
  jsonb_build_object('planning', prompt_text),
  TRUE
FROM p10
ON CONFLICT(skill_id) DO NOTHING;


-- Skill 11: scene-action-reaction (行动与反应场景)
WITH p11 AS (SELECT $p_11$行动场景围绕当下欲望与具体阻力展开；重大结果后给人物足够空间感受、误解、回避、回忆、权衡或暂不决定。呼吸段可以建立故事背景、日常秩序、人物内心、关系质地、情感余波或文学意象，不必立即改变局势；它只需深化读者对人物和世界的体验，并避免重复已经明确的信息。$p_11$ AS prompt_text)
INSERT INTO skill_definitions(skill_id, version, capabilities, applicable_tasks, required_memory_kinds, conflicts, quality_gates, prompt_sections, enabled)
SELECT 'scene-action-reaction', '1.0.0',
  ARRAY['planning','draft','review'],
  ARRAY['planning','drafting','review'],
  ARRAY[]::text[],
  ARRAY[]::text[],
  ARRAY[]::text[],
  jsonb_build_object('planning', prompt_text, 'drafting', prompt_text, 'review', prompt_text),
  TRUE
FROM p11
ON CONFLICT(skill_id) DO NOTHING;


-- Skill 12: embodied-prose (具象场景正文)
-- prompt 取自 PORTABLE_SKILL_PROMPT_OVERRIDES
WITH p12 AS (SELECT $p_12$在行动、感官、环境、对白、自由间接引语与必要的内心叙述之间选择最适合当前视角的表达。抽象判断应有场景证据，但不强制把所有心理改写成动作。关键瞬间（人物登场、命运降临、决断时刻、重大转折）建议用'动作+停顿+环境反应+时间流逝+心境外化'五元素组合放大呈现——通过环境与身体的连锁反应让读者感受人物内心，而非直接描写心理。五元素应自然融入叙事节奏，不可逐项罗列；非关键瞬间仍用常规叙事。心境外化必须是可被镜头捕捉的动作或身体反应，不可回退到'他心中…'式心理描写。细节必须具体、有效并符合人物注意力。$p_12$ AS prompt_text)
INSERT INTO skill_definitions(skill_id, version, capabilities, applicable_tasks, required_memory_kinds, conflicts, quality_gates, prompt_sections, enabled)
SELECT 'embodied-prose', '1.0.0',
  ARRAY['draft','revision'],
  ARRAY['drafting','revision'],
  ARRAY[]::text[],
  ARRAY[]::text[],
  ARRAY['叙述手段是否适合当前视角与场景','认知变化是否有可见或可推断依据','细节是否具体且具有功能','关键瞬间是否用五元素组合放大而非一笔带过','心境外化是否为可被镜头捕捉的动作而非心理描写'],
  jsonb_build_object('drafting', prompt_text, 'revision', prompt_text),
  TRUE
FROM p12
ON CONFLICT(skill_id) DO NOTHING;


-- Skill 13: serial-rhythm (通用连载节奏)
-- prompt 取自 PORTABLE_SKILL_PROMPT_OVERRIDES
WITH p13 AS (SELECT $p_13$在连续章节中分配建立、停留、蓄势、行动、回报和余波，使阅读期待来自未完成的因果、人物关系和意义变化。钩子数量、位置、强度和结尾开放度没有固定公式；安静或阶段闭合的章节同样可以成立，只要完成自身功能并让长线仍有真实动力。$p_13$ AS prompt_text)
INSERT INTO skill_definitions(skill_id, version, capabilities, applicable_tasks, required_memory_kinds, conflicts, quality_gates, prompt_sections, enabled)
SELECT 'serial-rhythm', '1.0.0',
  ARRAY['planning','draft','review'],
  ARRAY['planning','drafting','review'],
  ARRAY[]::text[],
  ARRAY[]::text[],
  ARRAY['连续章节是否有功能与强度变化','回报是否来自铺垫和人物行动','章尾是否适合本章而非重复模板'],
  jsonb_build_object('planning', prompt_text, 'drafting', prompt_text, 'review', prompt_text),
  TRUE
FROM p13
ON CONFLICT(skill_id) DO NOTHING;


-- Skill 14: continuity-audit (连续性审校)
WITH p14 AS (SELECT $p_14$逐段核对人物位置与移动、故事时间、环境、角色知识、重要物品归属、世界规则和前因后果。只报告有上下文证据的矛盾，并引用冲突来源。$p_14$ AS prompt_text)
INSERT INTO skill_definitions(skill_id, version, capabilities, applicable_tasks, required_memory_kinds, conflicts, quality_gates, prompt_sections, enabled)
SELECT 'continuity-audit', '1.0.0',
  ARRAY['review'],
  ARRAY['review'],
  ARRAY[]::text[],
  ARRAY[]::text[],
  ARRAY[]::text[],
  jsonb_build_object('review', prompt_text),
  TRUE
FROM p14
ON CONFLICT(skill_id) DO NOTHING;


-- Skill 15: style-specificity-audit (文风与具体性审校)
WITH p15 AS (SELECT $p_15$检查叙述距离、视角稳定、抽象情绪、重复意象和模板化动作。高频词统计只形成警告；必须结合人物声音和项目风格判断，不能机械判错。

【强调词贬值】统计"第一次""突然""忽然""终于""竟然"等强调词的频次。单章同一强调词出现超过 2 次即判定为贬值，须替换或删除。特别注意"第一次+动词"结构（第一次意识到/发现/明白/感到）的堆叠。

【金句收尾密度】检测以格言式、总结式、哲理式句子结尾的段落。单章超过 3 处即判定为"金句过密"，须将部分金句改为行动或沉默。

【人物语言越界】检查配角对白是否超出其身份认知。底层人物（兵卒、农人、流民）不可说出哲学总结或抽象道理。若发现配角台词像"作者传声筒"，须改为符合其身份的朴素表达，或用行动代替说教。$p_15$ AS prompt_text)
INSERT INTO skill_definitions(skill_id, version, capabilities, applicable_tasks, required_memory_kinds, conflicts, quality_gates, prompt_sections, enabled)
SELECT 'style-specificity-audit', '1.0.0',
  ARRAY['review'],
  ARRAY['review'],
  ARRAY[]::text[],
  ARRAY[]::text[],
  ARRAY[]::text[],
  jsonb_build_object('review', prompt_text),
  TRUE
FROM p15
ON CONFLICT(skill_id) DO NOTHING;


-- Skill 16: plot-pacing-audit (剧情与节奏审校)
WITH p16 AS (SELECT $p_16$比较蓝图与正文，检查必须节拍、人物选择、因果推进、场景功能、信息释放、张弛变化和章尾驱动力。区分结构阻断与审美建议。$p_16$ AS prompt_text)
INSERT INTO skill_definitions(skill_id, version, capabilities, applicable_tasks, required_memory_kinds, conflicts, quality_gates, prompt_sections, enabled)
SELECT 'plot-pacing-audit', '1.0.0',
  ARRAY['review'],
  ARRAY['review'],
  ARRAY[]::text[],
  ARRAY[]::text[],
  ARRAY[]::text[],
  jsonb_build_object('review', prompt_text),
  TRUE
FROM p16
ON CONFLICT(skill_id) DO NOTHING;


-- Skill 17: fact-delta-extraction (事实差异提取)
WITH p17 AS (SELECT $p_17$只提取正文明确陈述或强烈蕴含的新事实、角色状态、知识、关系、物品、时间线、剧情线和伏笔变化。每项必须引用原文证据、给出置信度并标记新增、更新、重复或冲突；不得直接提交。

【关系(relations)提取规则】
- 新建立的关系：novelty='new'，field='record'，after 提供完整对象 {fromEntityId, toEntityId, relationType, bond, publicLabel, privateTruth}。fromEntityId/toEntityId 必须是上下文中真实存在的角色 ID。bond 用中文描述两人关系状态（如"关系亲密，已建立信任，近期因误会产生隔阂"）。
- 现有关系的状态变化（如关系从亲密转为疏远）：novelty='update'，targetId 填关系 ID，field='bond'，before 填旧描述，after 填新的中文描述。
- 关系类型的变化（如从'同伴'变为'对手'）：novelty='update'，field='relationType'。
- 不得为已存在的角色对重复提取 new 关系；若正文未明确体现关系变化，不要强行提取。

【新人物(entities/character)提取规则】
- 当正文首次出现有姓名且对剧情有推动作用的重要人物（非路人甲、非一次性过场角色），且上下文事实库中尚不存在同名 character 实体时，提取为 novelty='new'，targetTable='entities'，field='record'，subject.kind='entity'，subject.id 省略（由系统生成）。
- after 必须提供完整对象：{kind:'character', name:'人物姓名', aliases:['别名/字号/称谓'], summary:'一句话身份定位与剧情作用', description:'基于正文可观察的登场印象、标志性动作或对白特征', character:{role:'主角/重要配角/反派/导师等剧情定位', appearance:'基于正文可观察的外貌细节（无则留空字符串）', personality:'基于正文行动推断的性格特质', desire:'基于正文可观察的外在欲望', motivation:'基于正文可推断的动机', weakness:'', secret:'', abilities:[], voice:'基于正文对白归纳的说话方式', arc:'', state:{location:'登场场景地点', physical:'', emotional:'', objective:'登场时的即时目标', inventory:[], relationshipNotes:[]}}}。
- 只填写正文已建立或可合理推断的字段；正文未体现的字段留空字符串或空数组，留给后续 character-enrichment 阶段补完。
- 不得为上下文中已存在的同名或同别名 character 提取 new 实体；此时应改为 novelty='update'，targetId 填已有实体 ID，field 填具体变化字段（如 character.state.location）。
- 路人甲、一次性NPC、未命名群演不得提取；只有具备剧情推动力或有再次出场可能的人物才提取。$p_17$ AS prompt_text)
INSERT INTO skill_definitions(skill_id, version, capabilities, applicable_tasks, required_memory_kinds, conflicts, quality_gates, prompt_sections, enabled)
SELECT 'fact-delta-extraction', '1.0.0',
  ARRAY['memory'],
  ARRAY['memory-maintenance'],
  ARRAY[]::text[],
  ARRAY[]::text[],
  ARRAY[]::text[],
  jsonb_build_object('fact-extraction', prompt_text),
  TRUE
FROM p17
ON CONFLICT(skill_id) DO NOTHING;


-- Skill 18: classic-character-ensemble (经典人物群像法)
-- prompt 取自 PORTABLE_SKILL_PROMPT_OVERRIDES
WITH p18 AS (SELECT $p_18$构建能够脱离主角独立运转的群像：重要人物拥有自己的欲望、边界、资源、关系和代价，并能主动改变局势。人物辨识度来自其注意力、决策、动作、语言与回避方式的稳定差异；登场方式服从场景，不套固定动作或对白公式。人物弧光必须由连续选择和后果积累，并允许矛盾、沉默和内心叙述共同呈现复杂性。$p_18$ AS prompt_text)
INSERT INTO skill_definitions(skill_id, version, capabilities, applicable_tasks, required_memory_kinds, conflicts, quality_gates, prompt_sections, enabled)
SELECT 'classic-character-ensemble', '1.0.0',
  ARRAY['planning','draft','review','revision'],
  ARRAY['foundation','planning','drafting','review','revision'],
  ARRAY[]::text[],
  ARRAY[]::text[],
  ARRAY['重要人物是否具有独立行动逻辑','人物声音与决策是否可区分','关系变化是否由连续事件和选择推动'],
  jsonb_build_object('foundation', prompt_text, 'planning', prompt_text, 'drafting', prompt_text, 'review', prompt_text, 'revision', prompt_text),
  TRUE
FROM p18
ON CONFLICT(skill_id) DO NOTHING;


-- Skill 19: classic-narrative-tension (经典叙事张力法)
-- prompt 取自 PORTABLE_SKILL_PROMPT_OVERRIDES
WITH p19 AS (SELECT $p_19$根据作品体量和类型管理短期、中期与长线期待。悬念、伏笔、回报和阶段变化只有在服务人物选择与因果推进时才采用，其数量、距离和显著度不设固定配额。回报应改变人物处境或读者理解，阶段转折应产生可追踪的后果；支线可通过人物、资源、秘密、关系或主题对照影响作品整体。

【支线反哺硬约束】支线不得只通过"同时发生"与主线关联，必须通过因果链关联——通过人物、资源、秘密、关系或主题对照改变主线人物的选择、认知或资源。每条支线必须回答以下三问中的至少一问：(1) 它如何改变了主线人物的选择？(2) 它如何改变了主线人物的认知或信念？(3) 它如何为主线提供了关键资源、秘密或盟友？若一条支线对这三个问题都回答"否"，则该支线只是主线休息站，应考虑删除或重构。

【阶段不可逆变化】长篇布局需有"阶段不可逆变化"：每个阶段转折让人物"回不去了"，而非"又升了一级"。阶段转折必须改变人物处境、关系或认知的某一不可逆维度——人物退不到阶段开始前的状态。"又升了一级"式转折（人物变强/获取资源/地位上升但处境本质未变）不构成阶段转折，只是事件推进。判定标准：删除该阶段转折后，人物能否回到阶段开始前的状态？若能，则该转折不是阶段转折，应重构。$p_19$ AS prompt_text)
INSERT INTO skill_definitions(skill_id, version, capabilities, applicable_tasks, required_memory_kinds, conflicts, quality_gates, prompt_sections, enabled)
SELECT 'classic-narrative-tension', '1.0.0',
  ARRAY['planning','review'],
  ARRAY['planning','review'],
  ARRAY[]::text[],
  ARRAY[]::text[],
  ARRAY['期待是否来自真实未完成因果','回报是否改变处境或理解','阶段与支线影响是否进入后续状态','每条支线是否回答了反哺三问中的至少一问','支线是否通过因果链而非同时发生与主线关联','阶段转折是否产生不可逆变化而非"又升了一级"'],
  jsonb_build_object('planning', prompt_text, 'review', prompt_text),
  TRUE
FROM p19
ON CONFLICT(skill_id) DO NOTHING;


-- Skill 20: classic-prose-texture (经典文笔质感法)
-- prompt 取自 PORTABLE_SKILL_PROMPT_OVERRIDES
WITH p20 AS (SELECT $p_20$语言风格由题材、视角人物、时代语境和场景功能共同决定。追求辞藻质感但拒绝空洞堆砌——每个修辞和句式选择必须服务视角与场景目标。重要场景、情绪高点和意境段落可适度使用凝练句式和半文半白质感；日常场景用鲜活白话和俚俗表达。语体随场景功能切换：正式场合用凝练含蓄的语感，日常场合用鲜活直率的语感——切换如呼吸，不可混用导致语感断裂。不设固定配额、句式切换或情绪外化公式，但句式长短和叙述密度应有变化而非全篇均匀。对白应体现人物当下意图与语言习惯；去掉说话人名字后读者仍应能辨认说话人，不套固定动作或对白公式。意象每次出现应提供新的状态或意义；重要情绪允许直陈、间接呈现或两者结合，但必须准确、克制且有上下文依据。叙述者隐身：主题藏在人物的选择与代价里，内心通过行动和感官外化。最重的情绪用最简的白描承载——越是重要时刻，越要克制形容词。$p_20$ AS prompt_text)
INSERT INTO skill_definitions(skill_id, version, capabilities, applicable_tasks, required_memory_kinds, conflicts, quality_gates, prompt_sections, enabled)
SELECT 'classic-prose-texture', '1.0.0',
  ARRAY['draft','revision'],
  ARRAY['drafting','revision'],
  ARRAY[]::text[],
  ARRAY[]::text[],
  ARRAY['语言是否符合视角、人物与场景','细节和意象是否产生新信息或意义','情绪表达是否准确而非模板化','语体是否随场景功能切换而非全篇均匀','叙述者是否隐身未直接宣告主题或内心','关键情绪是否用白描而非形容词堆砌'],
  jsonb_build_object('drafting', prompt_text, 'revision', prompt_text),
  TRUE
FROM p20
ON CONFLICT(skill_id) DO NOTHING;


-- Skill 21: romance-arc-design (言情感情线弧光设计)
-- prompt 取自 PORTABLE_SKILL_PROMPT_OVERRIDES
WITH p21 AS (SELECT $p_21$感情线由人物需求、边界、信任、误读、共同经历与现实代价推动。关系阶段和推进速度由人物与题材决定，不套固定相遇、暧昧、决裂或复合模板。亲密变化必须有双方可追溯的选择和后果，并保留各自独立生活与目标。$p_21$ AS prompt_text)
INSERT INTO skill_definitions(skill_id, version, capabilities, applicable_tasks, required_memory_kinds, conflicts, quality_gates, prompt_sections, enabled)
SELECT 'romance-arc-design', '1.0.0',
  ARRAY['planning','draft','review','revision'],
  ARRAY['foundation','planning','drafting','review','revision'],
  ARRAY[]::text[],
  ARRAY[]::text[],
  ARRAY['关系变化是否来自双方选择','亲密与冲突是否有具体积累','人物是否保有独立目标'],
  jsonb_build_object('foundation', prompt_text, 'planning', prompt_text, 'drafting', prompt_text, 'review', prompt_text, 'revision', prompt_text),
  TRUE
FROM p21
ON CONFLICT(skill_id) DO NOTHING;


-- Skill 22: imagery-aesthetics (意象美学)
-- prompt 取自 PORTABLE_SKILL_PROMPT_OVERRIDES
WITH p22 AS (SELECT $p_22$依据题材、视角和场景功能选择环境细节、意象、留白、修辞与句式节奏。意象应参与人物注意、选择或意义变化，而不是装饰；重复意象需要呈现新状态或新关系。每个场景须有一个环境意象与视角人物此刻心境形成呼应或反差——反差比直说更有力。关键情绪不可说透，须用留白手法承载：反常动作、被反复触碰的物件、没说完的话、环境意象的突变、沉默其一；留白后禁止补解释句。每个场景至少调动两种感官（视觉/听觉/嗅觉/触觉/温度），感官须融入行动与情绪而非罗列。虚实相生：实写人物的行动、对话、感官，虚写人物的心境、命运、主题；关键情绪场景七分实写三分虚写，禁止全实写变流水账或全虚写变散文诗。不得强制感官数量、意象配额、固定声部或特定作者风格，审美强度应与情节重量和项目风格匹配。$p_22$ AS prompt_text)
INSERT INTO skill_definitions(skill_id, version, capabilities, applicable_tasks, required_memory_kinds, conflicts, quality_gates, prompt_sections, enabled)
SELECT 'imagery-aesthetics', '1.0.0',
  ARRAY['draft','revision'],
  ARRAY['drafting','revision'],
  ARRAY[]::text[],
  ARRAY[]::text[],
  ARRAY['意象是否服务人物、场景或主题','重复意象是否发生意义变化','语言审美是否符合项目风格','每个场景是否有意象与人物心境呼应或反差','关键情绪是否用留白手法而非直说','感官是否融入行动与情绪而非罗列','关键情绪场景是否虚实相生而非全实写或全虚写'],
  jsonb_build_object('drafting', prompt_text, 'revision', prompt_text),
  TRUE
FROM p22
ON CONFLICT(skill_id) DO NOTHING;


-- Skill 23: prose-discipline (文笔纪律)
WITH p23 AS (SELECT $p_23$检查强调词、格言式收尾、作者解释、人物语言越界和结构重复。生成时优先使用具体叙事；审校时依据正文证据报告问题，不把审校术语写进正文。$p_23$ AS prompt_text)
INSERT INTO skill_definitions(skill_id, version, capabilities, applicable_tasks, required_memory_kinds, conflicts, quality_gates, prompt_sections, enabled)
SELECT 'prose-discipline', '1.0.0',
  ARRAY['draft','review'],
  ARRAY['drafting','review'],
  ARRAY[]::text[],
  ARRAY[]::text[],
  ARRAY['强调词是否控制在每章 2 次以内','金句式收尾是否控制在每章 2 处以内','叙述者是否隐身，未直接宣告主题或内心','配角对白是否未越界，无作者传声筒','全章是否只回答一个问题，无主题重复推进'],
  jsonb_build_object('drafting', prompt_text, 'review', prompt_text),
  TRUE
FROM p23
ON CONFLICT(skill_id) DO NOTHING;


-- Skill 24: plot-segment-design (剧情段与章节编排)
-- prompt 取自 PORTABLE_SKILL_PROMPT_OVERRIDES
WITH p24 AS (SELECT $p_24$剧情段是承担一个中程变化的组织单元。章节数量与功能组合由因果跨度、视角转换、体验展开、篇幅预算和回报位置决定。每章应有独立职责，段内状态能够累积并产生后果；不强制覆盖预设功能、伏笔数量、信息密度或张力曲线。$p_24$ AS prompt_text)
INSERT INTO skill_definitions(skill_id, version, capabilities, applicable_tasks, required_memory_kinds, conflicts, quality_gates, prompt_sections, enabled)
SELECT 'plot-segment-design', '1.0.0',
  ARRAY['planning'],
  ARRAY['planning'],
  ARRAY[]::text[],
  ARRAY[]::text[],
  ARRAY['章节数量是否由材料需要决定','各章是否有独立职责','段内状态是否连续并产生后果'],
  jsonb_build_object('planning', prompt_text),
  TRUE
FROM p24
ON CONFLICT(skill_id) DO NOTHING;


-- Skill 25: plot-segment-audit (剧情段设计审核)
-- prompt 取自 PORTABLE_SKILL_PROMPT_OVERRIDES
WITH p25 AS (SELECT $p_25$依据剧情段目标和实际章节审核因果连续、人物主体性、功能分配、体验空间、节奏变化、长篇余量与后续影响。不得以固定章节数、功能组合、伏笔数量或张力曲线作为合格条件；只报告有具体字段证据且会损害作品承诺的问题。$p_25$ AS prompt_text)
INSERT INTO skill_definitions(skill_id, version, capabilities, applicable_tasks, required_memory_kinds, conflicts, quality_gates, prompt_sections, enabled)
SELECT 'plot-segment-audit', '1.0.0',
  ARRAY['review'],
  ARRAY['review'],
  ARRAY[]::text[],
  ARRAY[]::text[],
  ARRAY['因果与状态是否连续','章节功能是否与材料匹配','是否保留长篇余量'],
  jsonb_build_object('review', prompt_text),
  TRUE
FROM p25
ON CONFLICT(skill_id) DO NOTHING;


-- Skill 26: blueprint-audit (章节蓝图审核)
-- prompt 取自 PORTABLE_SKILL_PROMPT_OVERRIDES
WITH p26 AS (SELECT $p_26$依据本章实际功能、项目风格、人物状态、前后因果、知识边界和长篇余量审核蓝图。节拍数量、信息密度、冲突强度与章尾形态没有固定公式。问题必须引用具体字段，说明它如何造成因果断裂、人物失真、体验不足、提前透支或后续动力缺失。

【卖点兑现审核】若本章处于项目某卖点（sellingPoints）的兑现窗口，审核蓝图是否为其安排了可被正文在场亲历其运作的具体节拍，而非仅在 mustHappen 抽象提及、设定说明或对白转述中带过——读者冲着卖点来却读不到卖点运作会弃书。安静章/余波章不强制每章兑现，但若长线多个章节均无任何卖点兑现调度，应报告为 major（dimension: hookPayoff），说明卖点停留在设定层的留存风险；同时须确认蓝图未为凑兑现而提前消费尚未到兑现窗口的卖点材料。$p_26$ AS prompt_text)
INSERT INTO skill_definitions(skill_id, version, capabilities, applicable_tasks, required_memory_kinds, conflicts, quality_gates, prompt_sections, enabled)
SELECT 'blueprint-audit', '1.0.0',
  ARRAY['review'],
  ARRAY['review'],
  ARRAY[]::text[],
  ARRAY[]::text[],
  ARRAY['主导功能是否成立','节拍是否必要且连续','是否遵守视角与兑现边界','处于兑现窗口的卖点是否安排可被正文亲历其运作的节拍','长线是否避免卖点全程停留在设定层','结构选择是否适合当前章节'],
  jsonb_build_object('review', prompt_text),
  TRUE
FROM p26
ON CONFLICT(skill_id) DO NOTHING;


-- Skill 27: prose-audit (正文元审核)
-- prompt 取自 PORTABLE_SKILL_PROMPT_OVERRIDES
WITH p27 AS (SELECT $p_27$直接核对正文与各局部审核报告（含读者留存维度），检查遗漏、误判和互相冲突的建议。整体权衡剧情因果、人物主体性与声音、现场体验、语言准确性、意象功能、章节功能、读者留存与长篇余量。不得套用特定作者、题材、句式、感官数量或章尾公式；每个问题必须引用正文证据，并说明修订对其他维度的风险。$p_27$ AS prompt_text)
INSERT INTO skill_definitions(skill_id, version, capabilities, applicable_tasks, required_memory_kinds, conflicts, quality_gates, prompt_sections, enabled)
SELECT 'prose-audit', '1.0.0',
  ARRAY['review'],
  ARRAY['review'],
  ARRAY[]::text[],
  ARRAY[]::text[],
  ARRAY['审核结论是否有正文证据','是否识别局部报告的误判与冲突','修订建议是否兼顾整体质量'],
  jsonb_build_object('review', prompt_text),
  TRUE
FROM p27
ON CONFLICT(skill_id) DO NOTHING;


-- Skill 28: reader-audit (读者留存审校)
-- prompt 取自 PORTABLE_SKILL_PROMPT_OVERRIDES
WITH p28 AS (SELECT $p_28$以严苛追更读者视角审核章节留存力，只回答：读完这章后是否想立刻翻下一章。检查开篇吸引力（前 200 字是否抛出未解压力或反常细节）、中段悬念密度（每千字是否有可辨识的小钩子）、信息释放节奏（重要信息是否在读者需要时抵达）、阅读疲劳点（是否存在连续无对白无动作变化的长段铺陈）、章尾驱动力（是否停在揪心瞬间或未解压力）、读者代入度（视角人物是否有权衡瞬间）、设定承诺兑现（项目设定承诺的卖点或题材亮点是否在正文兑现，而非只停留在设定层——读者冲着亮点来却读不到会弃书）。不替代其他 reviewer 的技术分析；安静章节只要携带未解压力或关系张力就合规。每个问题引用段落证据，dimension 用 readerRetention，修订建议指向如何让读者想继续读。$p_28$ AS prompt_text)
INSERT INTO skill_definitions(skill_id, version, capabilities, applicable_tasks, required_memory_kinds, conflicts, quality_gates, prompt_sections, enabled)
SELECT 'reader-audit', '1.0.0',
  ARRAY['review'],
  ARRAY['review'],
  ARRAY[]::text[],
  ARRAY[]::text[],
  ARRAY['开篇是否抛出未解压力或反常细节','中段是否有可辨识的小钩子','重要信息是否在读者需要时抵达','是否存在阅读疲劳点','章尾是否停在揪心瞬间且携带未解信息','视角人物是否有权衡瞬间维持代入度','项目设定承诺的卖点或题材亮点是否在正文兑现'],
  jsonb_build_object('review', prompt_text),
  TRUE
FROM p28
ON CONFLICT(skill_id) DO NOTHING;

-- ============================================================
-- 迁移完成：28 个 v1 内置 skill 已写入 skill_definitions 表。
-- 验证查询（不在本脚本执行，仅参考）：
--   SELECT skill_id, version, enabled FROM skill_definitions ORDER BY skill_id;
--   预期共 28 + 3 (来自 013_default_skills.sql) = 31 行。
-- ============================================================
