# Trae 集成

Ymcp 设计为可被 Trae 作为本地 MCP stdio 服务器调用。

## 1. 安装

```powershell
pip install ymcp
pip install -U ymcp
```

开发环境安装：

```powershell
python -m pip install -e .[dev]
```

## 2. 检查本地环境

```powershell
ymcp doctor
ymcp inspect-tools --json
ymcp call-fixture plan --json
```

`ymcp doctor` 会输出 Python、依赖包和命令路径信息。Trae 无法启动服务器时，优先查看这条命令的结果。

## 3. 在 Trae 中添加 Ymcp

打开 Trae 的 MCP 设置，添加本地 MCP 服务器。配置片段可由以下命令生成：

```powershell
ymcp print-config --host trae
```

默认配置：

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

如果 Trae 找不到 `ymcp`，请把 `command` 替换为 Python Scripts 目录或虚拟环境中的 `ymcp.exe` 绝对路径。



## 4. 一键初始化 Trae

推荐直接运行：

```powershell
ymcp init-trae
```

该命令会执行两步：

1. 创建或更新当前 Windows 用户的 Trae CN 用户级 MCP 配置：`C:\Users\{用户}\AppData\Roaming\Trae CN\User\mcp.json`
2. 询问是否在当前项目 `.trae/rules/` 下创建 Ymcp 项目规则

非交互场景可使用：

```powershell
ymcp init-trae --yes-project-rules
ymcp init-trae --no-project-rules
```

项目规则范本位于：`docs/trae-project-rule-template.md`。

## 5. 预期工具

Trae 应该能发现以下四个工具：

- `plan`
- `ralplan`
- `deep_interview`
- `ralph`

## 6. Trae 调用示例

- 调用 Ymcp 的 `plan` 工具，为当前任务返回阶段计划和验收标准。
- 调用 Ymcp 的 `deep_interview` 工具，并把它建议的下一问展示给我。
- 调用 Ymcp 的 `ralplan` 工具，总结方案选项、推荐方案、ADR 和测试策略。
- 调用 Ymcp 的 `ralph` 工具，根据当前证据判断下一步是继续还是验证。

## 7. 宿主边界

Ymcp 不执行命令、不 spawn agent、不修改文件、不持久化循环，也不会直接询问用户。Trae 拥有交互循环，并决定如何使用 Ymcp 返回的结构化指导。

## 8. 故障排查

- 工具不可见：运行 `ymcp inspect-tools --json`，确认本地能看到四个标准工具名。
- 服务器无法启动：运行 `ymcp doctor --json`，检查 Python 路径和依赖版本。
- PATH 问题：在 Trae 配置中使用 `ymcp.exe` 的绝对路径。
- 协议问题：保持 `ymcp serve` 使用 stdio，不要把人类可读日志输出到 stdout。
