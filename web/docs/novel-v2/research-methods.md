# 长篇网文创作研究方法矩阵

> 目的：把公开资料中可验证的创作机制转译为项目契约，不把成品倒推成作者私有流程，也不复制任何作者的具体文风。

## 1. 证据与迁移边界

| 公开证据 | 观察到的创作机制 | 可迁移为 Runtime 契约 | 不应迁移的表面风格 |
| --- | --- | --- | --- |
| [《诡秘之主》创作谈与评论](https://wyb.chinawriter.com.cn/attachment/201912/25/d46b61fa-c89a-4856-9ab3-2fc34dd8b833.pdf) | 先做时代、社会分层、建筑、生活史等资料搜集，再把资料转成世界细节；超现实设定需要现实质感承托 | `creativeBrief.researchNeeds/worldAnchor`；worldview 必须有规则、代价、边界、社会纹理；Foundation review 检查规则是否可内化、是否承载主题 | 不复制维多利亚时代、克苏鲁元素、特定意象或叙述口吻 |
| [《庆余年》相关访谈与评论](https://www.thepaper.cn/newsDetail_forward_27645208.html) | 类型阅读承诺、宏观阶段推进、人物关系参与悬念解决；长篇成稿仍经历大规模重写 | `corePromise`、`endingEnvelope`、卷级职责、关系变化条件、修订后重新 fingerprint 审核；不把“结果先行”当成结局契约 | 不复制架空历史、双穿越、具体人物设置或金句 |
| [《雪中悍刀行》作品评论](https://wyb.chinawriter.com.cn/attachment/202206/27/04f63628-7894-42d9-877f-3a01295799a7.pdf) | 主角之外的人物也有欲望、牵挂和选择；日常与幽默可以调节沉重叙事 | `characterFocus` 的欲望/行动/代价；relations 方向性与变化条件；`humorTreatment` 允许适用性状态，不强制每章插笑点 | 不复制江湖话语、人物名、招式、豪情句式 |
| [《繁花》作品选评](https://www.chinawriter.com.cn/n1/2019/0403/c426230-31011968.html) | 连载媒介、地方语言、社会纹理和后续多轮修改可以共同形成作品质感；慢更不等于没有读者承诺 | `stylePreferences/worldAnchor` 记录语言与地方研究边界；允许安静章、余波章；提交门禁检查局部质量和长线收束，不只看更新速度 | 不把沪语、特定年代或章法直接当作所有题材模板 |
| [中国网络文学 20 年经典作品选评](https://www.chinawriter.com.cn/n1/2019/0403/c426230-31011968.html) | 官方/专业选评可作为样本池，帮助覆盖不同类型与文学追求 | 回归集按题材、章节功能、关系结构和审校问题分类；榜单只作为样本来源，不作为单一质量定义 | 不把“经典”标签转换成固定分数或固定网文公式 |
| [LOT 长文本基准](https://arxiv.org/abs/2108.12960) | 长中文文本评估需要同时看理解和生成，单段流畅度不能代表长程能力 | Foundation、Story Arc、章节正文分层评估；使用 artifact、context、transition、review evidence 和最终文本联合验收 | 不把论文 benchmark 分数直接当作本项目的文学目标 |
| [WebNovelBench](https://arxiv.org/abs/2505.14818) | 网文生成需要多维质量评估，并可与人类作品和不同生成系统比较 | 保留 D1-D5 维度，使用总分之外的 evidence path、适用性、局部退化上限和最高候选回退 | 不把 LLM-as-Judge 单分数当作创作真相 |
| [叙事社会网络研究](https://arxiv.org/abs/2008.10835) | 更复杂、动态的关系网络可增加叙事层次和文学性 | relations 使用方向、强度、变化条件和选择后果；章节要求配角独立行动，不只记录主角中心的功能标签 | 不追求关系图越复杂越好；复杂度必须服务可理解的因果与人物选择 |

## 2. 当前系统的转译链

```text
公开证据
  -> 机制假设：读者承诺、现实锚点、独立人物、关系网络、长程多维质量
  -> 创作简报：targetReader/corePromise/themeQuestion/researchNeeds/endingEnvelope
  -> Foundation：十项 task-specific structured contract + foundationReview
  -> Story Arc：worldRuleRefs/characterFocus/romanceTreatment/humorTreatment/thematicTreatment
  -> Draft/Review/Commit：D1-D5 适用性覆盖、当前 fingerprint、局部退化守卫
  -> Learning：记录 underlyingMechanism 与 affectedInputClass，回归验证后才 promote
```

## 3. 使用和更新规则

1. 研究材料只能提出可检验的机制假设，不能直接变成某部作品的禁用词或章节模板。
2. 每条机制必须落到 schema、validator、review evidence、状态转换或回归测试中的至少一层；只写 prompt 不算闭环。
3. 需要新增规则时，先写受影响输入类别和不覆盖边界，再补原始失败样本与跨题材 counterexample。
4. 研究矩阵每次更新都要同步 `workflow-map.md`、`pipeline-audit.md`、`quality-standard.md` 和 `novel-mcp.md` 的量化指标与状态。
