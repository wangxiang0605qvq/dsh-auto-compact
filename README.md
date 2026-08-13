# dsh-auto-compact — DeepSeek Harness 自动压缩插件 | Auto Compaction Plugin

让模型可以主动调度 DeepSeek Harness 会话上下文的自动压缩。注册模型工具 `compact_now`：模型在回合中请求压缩当前会话历史，插件在**回合结束后（agent 空闲时）**自动执行压缩，并写入会话日志。

Allows the model to schedule automatic compaction of its session context. Registers the `compact_now` tool: when called, the plugin runs compaction **after the current turn ends (once the agent is idle)** and records the result in the session log.

## 为什么需要它 | Why

- DSH 内置了按压力触发的自动压缩（`compaction-basic`）和人类手动的 `/compact` 命令。
- 但**模型自己无法触发压缩**：`compaction.compactNow` 要求 agent 空闲，而工具在回合内执行时 agent 必然处于运行中（会抛 `busy`）。
- 本插件的 `compact_now` 用 `agent.whenIdle()` 把压缩推迟到回合结束后的空闲时刻执行，绕开 busy 限制。

## 安装 | Install

将本仓库复制到 DSH profile 的 node_modules 下：

```powershell
Copy-Item -Recurse . "$env:USERPROFILE\.dsh\profiles\node_modules\@deepseek-ai\dsh-auto-compact"
```

在 profile 补丁（如 `~/.dsh/profiles/web/cordis.patch.yml`）中插入：

```yaml
- insert:
    - id: auto-compact
      name: "@deepseek-ai/dsh-auto-compact"
      inject: ["tools", "agents", "timer"]
      config: {}
```

重启 DSH 生效。

## 使用 | Usage

模型直接调用 `compact_now` 工具即可：

- 返回 `{ ok: true, status: "scheduled" }`：压缩已排队，回合结束后自动执行；
- 返回 `{ ok: false, reason }`：压缩服务不可用（如 minimal 预设未挂 `compaction-basic`）；
- 压缩结果（`compaction/start` 标记、摘要等）记录在会话日志中，模型可从后续上下文中看到。

## 依赖 | Dependencies

- `@deepseek-ai/dsh-compaction`：压缩服务契约（agent 预设需挂载 `compaction-basic` 实现）。
- `@deepseek-ai/dsh-tools`、`@deepseek-ai/cordis`：工具注册与运行时。

## License

MIT
