# 规划剧情线

已将原输出中的 plotThreads 数组转换为符合 Schema 的 items 结构，并修正不符合枚举、类型和必填要求的字段。未新增原输出之外的故事事实。

## 1. 名字消失事件调查线

原数据描述为主线事件调查，转换为 plotThreads 创建记录。status 和 priority 根据 Schema 要求转换为合法类型。

- 操作：新增
- 类型：plotThreads

## 2. 沈默川记忆代价危机线

原数据中的 sub 类型不符合 Schema，转换为 subplot。未保留无法映射的文本类型字段。

- 操作：新增
- 类型：plotThreads

## 3. 林见夏调查者成长线

原数据描述为角色成长方向，因此映射为 growth 类型。保留原有姓名确认限制说明。

- 操作：新增
- 类型：plotThreads

## 4. 顾临川秩序维护者对抗线

原数据描述为对抗关系线，转换为 antagonist 类型。未将待确认角色信息当作已确定事实。

- 操作：新增
- 类型：plotThreads