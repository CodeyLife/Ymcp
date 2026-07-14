# 生成全书架构

已将原输出修复为符合架构表 Schema 的 JSON，仅保留 architectures 相关内容，并将不符合枚举的值调整为 Schema 允许值。

## 1. arch_candidate_001

原输出包含多个数据表内容，目标 Schema 仅允许 architectures 表结构，因此保留架构核心字段并移除其他表数据。

- 操作：更新
- 类型：architectures