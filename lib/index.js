// dsh-auto-compact (host half): registers the model-facing `compact_now` tool
// so the agent itself can request compaction of its session history.
//
// `compaction.compactNow` requires an idle agent (it throws ManualCompactionError
// "busy" otherwise), while a model tool executes mid-turn. The tool therefore
// schedules the compaction to run after the current turn ends: it waits on
// `agent.whenIdle()` and then calls compactNow, retrying briefly on busy.

import { defineTool } from "@deepseek-ai/dsh-tools";
import { ManualCompactionError } from "@deepseek-ai/dsh-compaction";

const name = "auto-compact";
// tools: register the model tool; agents: resolve the initiating agent;
// timer: back-off delays between busy retries.
const inject = ["tools", "agents", "timer"];

const RETRY_LIMIT = 3;
const RETRY_DELAY_MS = 2000;

function apply(ctx, config) {
  const pending = new Set();

  ctx.tools.register(defineTool({
    name: "compact_now",
    description: "Schedule compaction of this session's older context history. The session must be idle for compaction to run, so it is executed automatically after the current turn ends. Returns immediately; the compaction result is recorded in the session log.",
    parameters: {},
    timeoutMs: 15000,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const agents = ctx.get("agents");
      const agent = agents === undefined ? undefined : agents.requireInitiator();
      if (agent === void 0) return { ok: false, reason: "no active agent" };
      const compaction = agent.ctx.get("compaction");
      if (compaction === void 0) return { ok: false, reason: "compaction service is unavailable for this agent" };
      if (pending.has(agent.id)) return { ok: true, status: "already-scheduled" };

      pending.add(agent.id);
      const signal = exec.signal ?? new AbortController().signal;
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
      return { ok: true, status: "scheduled", note: "compaction runs after this turn ends" };
    },
    presentCall: () => ({ card: "generic", title: "调度上下文压缩", kind: "compact", rawInput: "" }),
  }));

  ctx.effect(() => () => {
    pending.clear();
  }, "auto-compact pending cleanup");
}

export default { name, inject, apply };
export { apply, inject, name };
