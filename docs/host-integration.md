# 宿主集成

Ymcp 默认使用 stdio 传输，并优先优化 Trae 的 MCP 工具调用体验。

推荐的本地服务器配置：

```json
{
  "mcpServers": {
    "ymcp": {
      "command": "ymcp",
      "args": ["serve"],
      "env": {}
    }
  }
}
```

使用 `ymcp print-config --host trae` 可以打印当前配置片段；使用 `ymcp inspect-tools --json` 可以在本地检查标准工具列表和契约信息。
