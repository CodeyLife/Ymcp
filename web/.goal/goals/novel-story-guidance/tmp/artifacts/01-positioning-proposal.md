# 完善项目定位

修复为符合 Schema 的项目更新结构，仅保留原输出中属于 projects 表且 Schema 允许的字段；未纳入 architectures 内容。

## 1. 遗忘之名项目更新

原输出中的 projects 对象包含目标项目字段，转换为 Schema 要求的 projects 更新操作；未保留 Schema 不支持的 architectures 数据和额外字段。

- 操作：更新
- 类型：projects