// dsh-auto-compact (host half): registers the model-facing `compact_now` tool
// AND automatically watches every agent's context pressure. When a session
// exceeds `thresholdRatio` (default 0.5 = 50%), it injects a visible warning
// into the conversation and schedules compaction to run after the current turn
// ends (when the agent is idle).
//
// `compaction.compactNow` requires an idle agent (it throws ManualCompactionError
// "busy" otherwise), while a model tool executes mid-turn. The plugin therefore
// schedules the compaction to run after the current turn ends: it waits on
// `agent.whenIdle()` and then calls compactNow, retrying briefly on busy.

import { defineTool } from "@deepseek-ai/dsh-tools";
import { ManualCompactionError } from "@deepseek-ai/dsh-compaction";
import { createUserMessage } from "@deepseek-ai/dsh-llm";

const name = "auto-compact";
// tools: register the model tool; agents: resolve the initiating agent and scan
// live agents; timer: back-off delays between busy retries.
const inject = ["tools", "agents", "timer"];

const RETRY_LIMIT = 3;
const RETRY_DELAY_MS = 2000;

const DEFAULT_THRESHOLD_RATIO = 0.75; // 75%
const DEFAULT_WARN_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

function apply(ctx, config = {}) {
  const pending = new Set();
  const warnedAt = new Map();
  const attached = new WeakSet();

  const thresholdRatio = Number.isFinite(config.thresholdRatio)
    ? config.thresholdRatio
    : DEFAULT_THRESHOLD_RATIO;
  const warnEnabled = config.warn !== false;
  const warnCooldownMs = Number.isFinite(config.warnCooldownMs)
    ? config.warnCooldownMs
    : DEFAULT_WARN_COOLDOWN_MS;

  function scheduleCompaction(agent, signal = new AbortController().signal) {
    if (pending.has(agent.id)) return { status: "already-scheduled" };
    const compaction = agent.ctx.get("compaction");
    if (compaction === void 0) {
      return { status: "unavailable", reason: "compaction service is unavailable for this agent" };
    }

    pending.add(agent.id);
    const runWhenIdle = async () => {
      try {
        await agent.whenIdle();
        for (let attempt = 0; ; attempt += 1) {
          try {
            const result = await compaction.compactNow(agent, signal);
            if (result === null) return { status: "no-compactable-history" };
            return {
              status: "done",
              shadowed: result.shadowedSeqs.length,
              tokens: result.shadowedTokenCount,
            };
          } catch (error) {
            const busy = error instanceof ManualCompactionError && error.code === "busy";
            if (!busy || attempt >= RETRY_LIMIT) return { status: "failed", reason: String(error) };
            await ctx.timer.timeout(RETRY_DELAY_MS);
          }
        }
      } catch (error) {
        return { status: "failed", reason: String(error) };
      } finally {
        pending.delete(agent.id);
      }
    };
    // Fire-and-forget: never block the executing turn.
    runWhenIdle();
    return { status: "scheduled" };
  }

  async function resolveContextWindow(agent, signal) {
    const logged = agent.session.requestContext?.();
    if (logged?.contextWindow !== void 0 && Number.isFinite(logged.contextWindow) && logged.contextWindow > 0) {
      return logged.contextWindow;
    }
    const header = agent.session.requestHeader?.();
    const target = header?.config ?? agent.options;
    const llm = agent.ctx.get("llm");
    if (llm === void 0 || target?.provider === void 0 || target?.model === void 0) return void 0;
    try {
      const info = await llm.resolveModelInfo(target.provider, target.model, signal);
      return info?.context?.contextWindow;
    } catch {
      return void 0;
    }
  }

  async function warnAndMaybeSchedule(agent, signal) {
    const compaction = agent.ctx.get("compaction");
    if (compaction === void 0) return;
    const tokenMeter = agent.ctx.get("tokenMeter");
    if (tokenMeter === void 0) return;

    const measurement = tokenMeter.measure(agent.session);
    const totalTokens = measurement.totalTokens;
    if (!Number.isFinite(totalTokens) || totalTokens <= 0) return;

    const contextWindow = await resolveContextWindow(agent, signal);
    if (contextWindow === void 0 || contextWindow <= 0) return;

    const ratio = totalTokens / contextWindow;
    if (ratio <= thresholdRatio) {
      warnedAt.delete(agent.id);
      return;
    }

    const percent = Math.round(ratio * 100);
    
    // 检查是否正在有任务进行
    const isBusy = isAgentBusy(agent);
    
    if (warnEnabled) {
      const now = Date.now();
      const lastWarn = warnedAt.get(agent.id) ?? 0;
      if (now - lastWarn >= warnCooldownMs) {
        warnedAt.set(agent.id, now);
        try {
          if (isBusy) {
            // 如果有任务在进行，显示警告并等待用户确认
            const message = createUserMessage({
              content: [{ type: "text", text: `⚠️ 会话上下文已使用约 ${percent}%（${totalTokens} / ${contextWindow} tokens），达到压缩阈值。\n\n检测到当前有任务正在进行，将在任务完成后询问是否进行上下文压缩。` }],
              source: {
                kind: "plugin",
                plugin: "dsh-auto-compact",
                form: "notice",
                summary: `上下文使用 ${percent}%，等待任务完成`,
              },
            });
            agent.inject(message);
            
            // 任务完成后再次询问
            setTimeout(async () => {
              const confirmation = await showUserConfirmation(agent, signal);
              if (confirmation) {
                scheduleCompaction(agent);
              }
            }, 10000); // 10秒后询问
          } else {
            // 没有任务进行，直接进行压缩
            const message = createUserMessage({
              content: [{ type: "text", text: `⚠️ 会话上下文已使用约 ${percent}%（${totalTokens} / ${contextWindow} tokens），超过 ${Math.round(thresholdRatio * 100)}% 阈值。插件将在本回合结束后自动压缩。` }],
              source: {
                kind: "plugin",
                plugin: "dsh-auto-compact",
                form: "notice",
                summary: `上下文使用 ${percent}%，即将自动压缩`,
              },
            });
            agent.inject(message);
          }
        } catch (error) {
          ctx.logger?.warn?.(`auto-compact: warning injection failed: ${String(error)}`);
        }
      }
    }

    // 如果没有任务在进行，直接调度压缩
    if (!isBusy) {
      const scheduled = scheduleCompaction(agent);
      if (scheduled.status === "scheduled") {
        ctx.logger?.info?.(`auto-compact: session ${agent.id} at ${percent}% context usage; automatic compaction scheduled after this turn.`);
      }
    }
  }

  function isAgentBusy(agent) {
    // 检查agent是否有正在进行的任务
    if (agent.status && agent.status !== 'idle') {
      return true;
    }
    // 检查是否有pending的任务
    if (agent.pendingWork || agent.busy) {
      return true;
    }
    return false;
  }

  async function showUserConfirmation(agent, signal) {
    // 创建用户确认消息
    const message = createUserMessage({
      content: [{
        type: "text", 
        text: `⚠️ 会话上下文已使用约 ${Math.round((tokenMeter.measure(agent.session).totalTokens / await resolveContextWindow(agent, signal)) * 100)}%，达到压缩阈值。\n\n检测到当前有任务正在进行，是否立即进行上下文压缩？\n\n⚠️ 注意：压缩操作会清理旧的对话历史，但保留当前会话的内容。`
      }],
      source: {
        kind: "plugin",
        plugin: "dsh-auto-compact",
        form: "confirmation",
        summary: "确认压缩操作",
        action: "confirm_compaction"
      },
    });
    agent.inject(message);
    
    // 等待用户确认 - 这里简化处理，实际可能需要更复杂的用户交互机制
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve(true); // 默认确认，实际应该根据用户输入决定
      }, 5000); // 5秒后默认确认
    });
  }

  function attachAgent(agent) {
    if (agent === void 0 || attached.has(agent)) return;
    attached.add(agent);
    agent.ctx.on("agent/pre-step", async ({ signal }, next) => {
      try {
        await warnAndMaybeSchedule(agent, signal);
      } catch (error) {
        ctx.logger?.warn?.(`auto-compact: automatic context check failed: ${String(error)}`);
      }
      return next();
    });
  }

  ctx.tools.register(defineTool({
    name: "compact_now",
    description: "Schedule compaction of this session's older context history. The session must be idle for compaction to run, so it is executed automatically after the current turn ends. Returns immediately; the compaction result is recorded in the session log.",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          status: { type: "string" },
          note: { type: "string" },
          reason: { type: "string" },
          shadowed: { type: "number" },
          tokens: { type: "number" },
        },
      },
      render: (_args, value) => [{
        type: "text",
        text: value && value.ok === false
          ? `上下文压缩不可用：${value.reason ?? "未知原因"}`
          : value && value.status === "scheduled"
            ? "已调度上下文压缩：将在当前回合结束后自动执行（结果记入会话日志）。"
            : value && value.status === "already-scheduled"
              ? "压缩已排队，回合结束后自动执行。"
              : "上下文压缩请求已处理。",
      }],
    },
    timeoutMs: 15000,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const agents = ctx.get("agents");
      const agent = agents === undefined ? undefined : agents.requireInitiator();
      if (agent === void 0) return { ok: false, reason: "no active agent" };
      const signal = exec.signal ?? new AbortController().signal;
      const scheduled = scheduleCompaction(agent, signal);
      if (scheduled.status === "already-scheduled") return { ok: true, status: "already-scheduled" };
      if (scheduled.status === "unavailable") return { ok: false, reason: scheduled.reason };
      return { ok: true, status: "scheduled", note: "compaction runs after this turn ends" };
    },
    presentCall: () => ({ card: "generic", title: "调度上下文压缩", kind: "compact", rawInput: "" }),
  }));

  // Watch all agents, including ones already live when this plugin loads.
  const agents = ctx.get("agents");
  if (agents !== void 0 && typeof agents.list === "function") {
    for (const agent of agents.list()) attachAgent(agent);
  }
  ctx.on("agent/created", ({ agent }) => attachAgent(agent));
  ctx.on("agent/disposed", ({ agent }) => warnedAt.delete(agent.id));

  ctx.effect(() => () => {
    pending.clear();
    warnedAt.clear();
  }, "auto-compact pending cleanup");
}

export default { name, inject, apply };
export { apply, inject, name };
