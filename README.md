# dsh-auto-compact — DeepSeek Harness 自动压缩插件 | Auto Compaction Plugin

当会话上下文使用量超过 **75%** 时，自动向会话注入警告，并在**当前回合结束后（agent 空闲时）**自动压缩上下文。如果检测到当前有任务正在进行，会先弹出警告提示，等待任务完成后请求用户确认后再进行压缩。同时保留模型工具 `compact_now`：模型也可以主动请求压缩。

Automatically warns when a session's context usage exceeds **50%** and schedules compaction **after the current turn ends (once the agent is idle)**. It also keeps the `compact_now` model tool so the agent can request compaction explicitly.

## 为什么需要它 | Why

- DSH 内置了按压力触发的自动压缩（`compaction-basic`）和人类手动的 `/compact` 命令。
- 但**模型自己无法触发压缩**：`compaction.compactNow` 要求 agent 空闲，而工具在回合内执行时 agent 必然处于运行中（会抛 `busy`）。
- 本插件的 `compact_now` 用 `agent.whenIdle()` 把压缩推迟到回合结束后的空闲时刻执行，绕开 busy 限制。
- 新增智能任务检测：当检测到有任务进行时，不会中断当前任务，而是在任务完成后请求用户确认，确保压缩操作不会干扰重要工作。

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

## 自动阈值 | Automatic threshold

- 插件在每个 agent 的 `pre-step` 检查 `tokenMeter.measure(session).totalTokens` 与模型 `contextWindow` 的比例。
- 当比例 **超过 `thresholdRatio`（默认 `0.75`，即 75%）**：
  1. 检测当前是否有任务正在进行；
  2. 如果有任务，显示警告并在任务完成后请求用户确认；
  3. 如果没有任务，直接显示警告并调度压缩；
  4. 调度 `compactNow`，在**当前回合结束后空闲时**自动压缩。
- 配置项（`cordis.patch.yml` 的 `config`）：
  ```yaml
  config:
    thresholdRatio: 0.75      # 超过 75% 触发警告+压缩
    warn: true               # 是否注入可见警告
    warnCooldownMs: 300000   # 两次警告的最小间隔（毫秒），默认 5 分钟
  ```

## 任务检测与用户确认 | Task Detection & User Confirmation

- **任务检测**：插件会自动检测 agent 是否有正在进行的任务（通过检查 agent.status、pendingWork、busy 等属性）
- **智能处理**：
  - 有任务进行：显示警告，任务完成后请求用户确认
  - 无任务进行：直接显示警告并开始压缩流程
- **用户确认**：当任务完成后，会弹出确认对话框，显示压缩信息并等待用户确认
  - 包含压缩前后的预估节省空间
  - 用户可以选择确认或取消压缩操作

## 使用 | Usage

模型直接调用 `compact_now` 工具即可：

- 返回 `{ ok: true, status: "scheduled" }`：压缩已排队，回合结束后自动执行；
- 返回 `{ ok: false, reason }`：压缩服务不可用（如 minimal 预设未挂 `compaction-basic`）；
- 压缩结果（`compaction/start` 标记、摘要等）记录在会话日志中，模型可从后续上下文中看到。

## 依赖 | Dependencies

- `@deepseek-ai/dsh-compaction`：压缩服务契约（agent 预设需挂载 `compaction-basic` 实现）。
- `@deepseek-ai/dsh-llm`：读取模型 `contextWindow` 并构造警告消息。
- `@deepseek-ai/dsh-tools`、`@deepseek-ai/cordis`：工具注册与运行时。

## License

MIT
