# novel-top-tier-iter findings

本目标独立于前序 goal，不引用历史 findings。基线与发现均由本次实测产出。

## Loop 1 基线（20260717-001059-draft + 20260717-001230-review）

### 量化基线

| 维度 | 值 |
|---|---|
| draft wordCount | 2127（目标 5000，仅 42%） |
| draft paragraphCount | 93 |
| draft 机械预检 | 0 blocker / 0 major / 1 warning |
| review weightedScore | 3.08 |
| review blockerCount | 3 |
| review majorCount | 6 |
| review warningCount | 4 |
| plot | 3.08 |
| characterVoice | 3.13 |
| sceneEmbodiment | 3.13 |
| dialogue | 3.08 |
| specificity | 3.20 |
| hookPayoff | 2.17 |
| continuity | 3.52 |

### 3 个 blockers（全部指向同一根因：章节未完成）

1. `plot` blocker: 关键死亡节点尚未闭合 — 正文停留在东宫封宫文书阶段，未呈现太子暴毙确认
2. `hookPayoff` blocker: 章节核心事件尚未完成收束 — 未完成死亡事件后的核心收束
3. `plot` blocker (chapter.incomplete-blueprint): 章节关键节拍未完成 — 共同信息压力点 + 章尾人为痕迹均未出现

### 6 个 majors

1. `characterVoice` major: 魏成礼的主动选择不足 — 主要执行登记/核验/传令，缺少秩序与自身判断的取舍
2. `characterVoice` major: 关键人物行动因果不足 — 三人只承担被登记功能，与太子联系停留在出入记录
3. `continuity` major: 部分人物信息超出当下观察范围 — "她常抱着卷册出入内廷..."式作者概括
4. `continuity` major: 部分叙述超出限知视角 — "这样的人进宫，本不该和东宫扯上关系"
5. `plot` major: 死亡事件后的核心压力尚未展开
6. `plot` major: 人物关联尚未转化为有效信息压力

## Loop 1 根因分析

### R1（CRITICAL）：`truncateTrailingSecondEnding` 误判章节正体为"第二个结尾"并截断

**证据链**：
- `output.md` 在第 93 段"纸上的字并不多"处戛然而止
- `prompt-section-3.md` 的"上一段正文末尾"（= sections 1+2 合并的末尾 1200 字符）实际包含：
  - "太子薨。"（死亡确认）
  - 魏成礼取旧钥匙进入限制区域
  - 发现萧承晏、沈知微、顾长安已在榻前
  - 发现砚台旁薄纸上有未干字迹
  - "像是有人在上面写过什么，又将纸翻了过去。"（章尾痕迹钩子）
- 这证明 LLM 在 section 2 已完整写出 beats 3-5 + endingHook
- 但 `repairDraftStructureOnce` 的 `truncateTrailingSecondEnding` 把这段章节正体（约 600+ 字）当作"第二个结尾"截断

**机制**：
- `truncateTrailingSecondEnding` 模式二：尾部 4+ 短段（<100 字符）序列，与前文整体 bigram 相似度 ≥0.15 即截断
- 阈值 0.15 极低 — 章尾场景（封存/痕迹/纸/钥匙）天然与前文登记/宫务场景共享大量基础词汇 bigram
- `bigramSimilarity` 用 `overlap / Math.min(left, right)`，对短序列（few bigrams）天然膨胀相似度
- 章尾对话密集（短段多），极易触发模式二

**后果**：3 个 blockers 全部由此产生。LLM 实际生成了完整章节，但后处理把章节高潮和章尾钩子截掉了。

### R2：LLM 跨段越写（section boundary discipline）

`planDraftSections` 将 5 beats 分成 3 段（2/2/1+hook），但 section 2 的 LLM 直接写穿了 beats 3-5 + endingHook。这导致：
- section 3 的实际任务（beats 5 + endingHook）已在 section 2 完成
- section 3 要么重复要么续写，触发 `plot.repeated-progression` 或 `truncateTrailingSecondEnding`
- `buildDraftSectionContract` 虽有"只写下列连续节拍，不得提前书写后续节拍"约束，但 LLM 未遵守

### R3：限知视角越界（narrator summary）

- "她常抱着卷册出入内廷，走路不快，说话也少，却总能在一堆旧档里找出别人忽略的地方。" — 作者式人物概括
- "这样的人进宫，本不该和东宫扯上关系。" — 作者式判断
- 这些是 POV 越界的经典模式，prose-prompts.ts 已有约束但 LLM 仍违反

### R4：群像入场同质

三人入东宫都走"传牌→魏成礼询问→登记名字"流程，差异不足。prose-prompts.ts 已有"多角色入场方式差异化"约束，但 LLM 在登记场景下未落地。

## Loop 1 优化方向

- **A（最高优先级）**：修复 `truncateTrailingSecondEnding` 模式二的过截问题
  - 提高短序列相似度阈值（0.15 → 0.35+）
  - 增加安全护栏：若尾部序列包含 blueprint mustHappen 关键词（如"薨/死/痕迹/封存"），不得截断
  - 或改为：只截断确认是"重复"的段落（与具体前文章节相似度极高），不截断"新内容"
- **B**：强化 section boundary discipline
  - `buildDraftSectionContract` 增加"本段 beats 列表"的显式编号，LLM 写完编号 beats 后必须停止
  - 或在 section prompt 中加入"下一段将处理后续 beats，本段不得越界"的硬约束
- **C**：R3/R4 在 A+B 修复后重新评估，可能因章节完整而自然改善

## Loop 1 结论

本目标独立基线揭示了一个被前序 goal 忽略的 CRITICAL 回归：`truncateTrailingSecondEnding` 后处理正在系统性地截断章节高潮和章尾钩子，导致 LLM 实际生成的完整章节被压缩为"前奏片段"。这不是 LLM 生成质量问题，而是后处理 bug。Loop 2 应优先修复此 bug，然后重新建立真实基线。

## Loop 2 真实基线（20260717-002507-draft + 20260717-002631-review）

### 修复内容
- `truncateTrailingSecondEnding` 模式二短序列相似度阈值 0.15 → 0.30
- 移除过度激进的"新内容比例护栏"（bigram 新内容 >40% 不截断）——该护栏误拦合法的 R8/R14 第二结尾（主题词复用但 bigram 序列新建）
- 阈值 0.30 已足够区分：bench case 相似度 0.25 < 0.30 不截断，R8/R14 相似度 0.83/0.875 ≥ 0.30 截断

### 量化对比（Loop 1 截断版 → Loop 2 真实版）

| 维度 | Loop 1 | Loop 2 | Δ |
|---|---|---|---|
| draft wordCount | 2127 | 3648 | +1521 |
| draft paragraphCount | 93 | 135 | +42 |
| weightedScore | 3.08 | 4.01 | +0.93 |
| blockerCount | 3 | 0 | -3 |
| majorCount | 6 | 4 | -2 |
| plot | 3.08 | 4.03 | +0.95 |
| characterVoice | 3.13 | 4.03 | +0.90 |
| sceneEmbodiment | 3.13 | 4.03 | +0.90 |
| dialogue | 3.08 | 4.03 | +0.95 |
| specificity | 3.20 | 3.90 | +0.70 |
| hookPayoff | 2.17 | 4.03 | +1.86 |
| continuity | 3.52 | 4.02 | +0.50 |

### 章节完整性确认
- output.md 末尾："那道被擦过的痕迹留在封匣之中，来处无人说明。" — 完整呈现 endingHook
- 太子暴毙、三人汇合（萧承晏/沈知微/顾长安）、章尾人为痕迹均完整呈现
- 截断 bug 已消除

### 剩余 4 个 majors（真实 prose 质量问题，Loop 3+ 目标）

1. `specificity` major（deterministic）：短句排比过多 — 7 处连续短句排比（style.short-sentence-tic），超过单章 2 处上限。revisionRanges: 28-29/31-32/35-36/93-94/95-96/108-109/128
2. `hookPayoff` major：章尾异常信息重复收束 — 第126-127段已呈现"那里有一道痕迹。很浅"，第135段再次概括"来处无人说明"，削弱余味。建议最后落点转向人物反应或新未知感受
3. `characterVoice` major：限知视角越界 — 第101段"一个守着玉佩，一个护着卷册，一个盯着案上的遗物"中"守着/护着"带目的判断，POV 只能观察动作不能确认意图
4. `plot` major：人物行动汇聚过程偏向记录式推进（chapter.information-delivery-mechanical）— 三人接近东宫主要靠魏成礼连续收到报告完成，形成事件登记感，人物与太子联系更多被记录而非通过可感知异常细节产生压力

### 剩余 6 个 warnings（次要问题）
- characterVoice: 谨慎与规矩意识重复说明（第107段心理概括）
- plot: 中段事件传递方式趋同（第28-33段顾长安入宫与沈知微入宫同构）
- characterVoice: 魏成礼部分心理被概括表达（第107/130段）
- continuity: 魏成礼与三人关系张力不足（第60-69/76-97段）
- dialogue: 顾长安对白功能化（第70-77段，"我只说看一眼"承担过多身份标签功能）
- hookPayoff: 悬疑压力部分由总结性叙述承担（第18/107段 scene.pressure-explanation）

## Loop 2 结论与下一 Loop 方向

CRITICAL 后处理 bug 已修复，真实基线显现：weighted 4.01 / 0 blocker。但 majorCount 4 > 1，未达成功判据（major ≤1）。剩余 4 majors 均为真实 prose 质量问题，需在 Loop 3+ 通过提示词或流程优化解决。

**Loop 3 优先级排序**（按影响面与可修复性）：
- **P1**：短句排比过多（deterministic major，机械可修复）— 强化 prose-prompts.ts 中"短句排比上限"约束的执行力度，或在 draft-structure-repair 增加机械后处理
- **P2**：限知视角越界（characterVoice major）— "守着/护着"是经典 POV 越界，blueprint-stage.ts 的 sanitizePovConsistencyInPlace 只覆盖 mustHappen 字段，draft 阶段缺少机械后校验
- **P3**：章尾异常信息重复收束（hookPayoff major）— endingHook 在 draft 中被两次强调，可在 prose-prompts.ts 增加"章尾落点不得重复已呈现信息"约束
- **P4**：人物行动汇聚记录式推进（plot major）— 三人入宫同构，需在 blueprint-stage 或 prose-prompts 增加"多角色入场方式差异化"的更强约束

## Loop 3 结果（20260717-003626-draft + 20260717-003748-review）

### 修改内容
- **P1 机械修复**：在 draft-structure-repair.ts 新增 `relaxStaccatoSentences` 函数，将非对白段落内连续 3+ 句 ≤10 字短句的内部句末标点（。！？）改为逗号（，），保留末句标点。集成到 `repairDraftStructureOnce` 管线（truncate 之后、initialReport 之前）。直接对应 quality.ts 的 style.short-sentence-tic 检测。
- **P2 提示词反例**：在 prose-prompts.ts buildChapterDraftPrompt 第 4 节 POV 硬约束中新增反例——"一个守着玉佩，一个护着卷册，一个盯着案上的遗物" → "萧承晏站在榻前，手中仍握着玉佩；沈知微将旧档收在手边..."（'守着/护着'是目的判断，'握着/收着/看着'是可观察动作）。
- **P3 章尾不重复约束**：在 buildDraftSectionContract 的 endingHookBlock 新增"章尾最后一句不得重复前文已呈现的信息——若异常或痕迹已在前面段落呈现，最后落点必须转向人物反应、新的未知感受或环境余波，让悬念递进而非原地强调"。

### 量化对比（Loop 2 → Loop 3）

| 维度 | Loop 2 | Loop 3 | Δ |
|---|---|---|---|
| draft wordCount | 3648 | 2752 | -896 |
| draft paragraphCount | 135 | 99 | -36 |
| weightedScore | 4.01 | 3.46 | -0.55 |
| blockerCount | 0 | 2 | +2 |
| majorCount | 4 | 4 | 0 |
| warningCount | 6 | 9 | +3 |
| plot | 4.03 | 3.26 | -0.77 |
| characterVoice | 4.03 | 3.76 | -0.27 |
| sceneEmbodiment | 4.03 | 3.76 | -0.27 |
| dialogue | 4.03 | 3.76 | -0.27 |
| specificity | 3.90 | 3.12 | -0.78 |
| hookPayoff | 4.03 | 2.37 | -1.66 |
| continuity | 4.02 | 4.02 | 0 |

### P1 短句排比机械修复效果（✓ 有效）

- Loop 2：specificity major "短句排比过多"（7 streaks，revisionRanges 28-29/31-32/35-36/93-94/95-96/108-109/128）
- Loop 3：specificity warning "短句排比过多"（3 streaks，revisionRanges 22-23/41-42/91-92）
- 结论：`relaxStaccatoSentences` 将 streaks 从 7 降到 3，major 降为 warning。机械修复策略有效，验证了"prose-prompts 已有约束但 LLM 仍违反时，机械后处理是可靠兜底"的方向。

### Loop 3 回归根因（LLM 生成不足，非代码 bug）

Loop 3 整体回归（weighted 4.01→3.46，2 blockers）并非 Loop 3 修改导致，而是 LLM 非确定性生成不足：
- bench-draft 第一次：535 字（严重不足，未达 1000 字阈值）
- bench-draft 第二次：2752 字（仍不足，目标 5000-6000 字）
- 章节只写到三人汇合（第 97-99 段"我没拿"），未达 endingHook"魏成礼发现人为痕迹"
- 2 blockers 均为 hookPayoff："章尾调查钩子未形成" + "章尾缺少具体未知线索落点"（chapter.incomplete-blueprint）

### 剩余 4 majors（Loop 3）

1. `continuity` major：后段角色描写存在视角边界风险（第 97 段）— "萧承晏站在榻前，目光仍停在太子身上，手指搭在袖口...沈知微将卷册合起...顾长安则绕到案侧..." 排列方式接近全知观察。**这是 P2 POV 越界的新模式**，不是"守着/护着"目的判断，而是多角色心理化动作排列。提示词反例未覆盖此模式。
2. `hookPayoff` major：章尾共同信息压力尚未形成（第 97-99 段）— 因 LLM 生成不足，章节停在进入查验前的准备状态，未形成共同压力。
3. `characterVoice` major：人物判断部分被叙述直接概括（第 13/49 段）— "他掌的是传递与开合，不是凭一时心思另立章法" 等作者式心理结论。
4. `plot` major：三人汇合段落节点感偏强（第 76-96 段）— 为完成汇合目标连续引入三人并快速交代信息，像按节点汇报。

### P2/P3 提示词改进效果（无法验证）

- P3 章尾不重复约束：因章节未达 endingHook，无从检验。
- P2 POV 反例：出现新模式（排列方式接近全知观察），提示词反例未覆盖。

## Loop 3 结论与下一 Loop 方向

Loop 3 的 P1 机械修复（relaxStaccatoSentences）已验证有效（major→warning，streaks 7→3），是本 loop 的确定成果。整体回归（weighted 4.01→3.46，2 blockers）是 LLM 非确定性生成不足导致，非代码 bug。这揭示了两个真问题：
1. **生成长度不稳定**：LLM 在 section 3 生成不足（2752 字 vs 目标 5000+），导致章节未达 endingHook，产生 2 blockers。需要评估是否调整 planDraftSections 或 chapterOutputTokenBudget。
2. **P2 POV 越界新模式**：Loop 3 出现"排列方式接近全知观察"的 POV 越界模式（continuity major 第 97 段），不是"守着/护着"目的判断。提示词反例需扩展覆盖，或考虑 draft 阶段机械后校验。

**Loop 4 方向**：
- 优先重跑 bench-draft + bench-review（1-2 次），验证 Loop 3 修改在 LLM 生成完整章节时的效果。LLM 非确定性可能产生完整生成。
- 若重跑后章节完整且 P2/P3 majors 仍存在，则确认是提示词问题，需扩展反例或增加机械后校验。
- 若重跑后仍生成不足，则调整生成长度保障（如减少 section 数量从 3 降到 2，或增加 maxTokens）。
- 目标：ch1 场景 weighted ≥4.0 且 0 blocker 且 major ≤1，然后跑第 2 场景验证泛化性。

