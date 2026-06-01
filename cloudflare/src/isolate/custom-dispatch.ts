import type Anthropic from "@anthropic-ai/sdk";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import { ANTHROPIC_BETA } from "../anthropic";

// In-DO dispatcher for `agent.tool_use` and `agent.custom_tool_use`
// session events. Used by the MicroVM Sandbox path
// (src/microvm/sandbox.ts); the Isolate path runs the SDK's
// `SessionToolRunner` directly, which already covers both kinds.
//
// On the MicroVM backend this dispatcher is one half of the
// "EnvironmentWorker substitute" — the other half is the work-item
// heartbeat loop (src/heartbeat.ts), which holds the lease while the
// dispatcher runs. The Sandbox DO composes both so the worker-side
// architecture matches what the Anthropic self-hosted-sandboxes guide
// recommends (one owner per session, claim → dispatch → stop), just
// hand-rolled because the SDK's `EnvironmentWorker.handleItem` helper
// requires Node and can't run in a Worker DO.
//
// The dispatcher accepts two parallel tool registries — `tools` for
// `agent.custom_tool_use` answered with `user.custom_tool_result`,
// and `stockTools` for `agent.tool_use` answered with
// `user.tool_result`. Keeping them separate avoids a stock name
// (`write`) accidentally answering a custom call (and vice versa) when
// the model emits the wrong event kind.
//
// What this dispatcher gives the MicroVM DO that the SDK's
// SessionToolRunner doesn't:
//  1. Reconcile across DO eviction — walks session events on every
//     stream reconnect and pre-answers tool calls that arrived while
//     we were asleep. The SDK runner reconciles per-connection but
//     doesn't survive a DO restart.
//  2. `onInFlightChange` — exposes the in-flight count so the caller
//     can renew the container's activity timer during long tool runs.
//
// Lifecycle ownership: the heartbeat loop and the dispatcher share an
// AbortController, so a `state: stopping` from the platform or a
// dispatcher-side error tears down both together.

const TOOL_TIMEOUT_MS = 120_000;
const STREAM_BACKOFF_START_MS = 500;
const STREAM_BACKOFF_CAP_MS = 10_000;
const SEND_RETRIES = 3;

// Local subset of the SDK event shapes — avoids importing from deep
// SDK paths just to reach the types.
interface ToolUseEvent {
  type: "agent.tool_use" | "agent.custom_tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}
interface ResultEvent {
  type: "user.tool_result" | "user.custom_tool_result";
  tool_use_id?: string;
  custom_tool_use_id?: string;
}
type SessionEvent = ToolUseEvent | ResultEvent | { type: string };

export interface CustomDispatchOpts {
  client: Anthropic;
  sessionId: string;
  // Custom tools (cf_*, user-defined). Answer `agent.custom_tool_use`
  // events with `user.custom_tool_result`.
  tools: BetaRunnableTool[];
  // Stock toolset (bash/read/write/edit/glob/grep). Answer
  // `agent.tool_use` events with `user.tool_result`. Pass the result
  // of `buildMicrovmStockTools()` to make the dispatcher self-
  // sufficient on self-hosted envs; omit for legacy setups where some
  // other process answers `agent.tool_use`.
  stockTools?: BetaRunnableTool[];
  signal: AbortSignal;
  // Notified after each in-flight count change (so 0 means "all
  // settled"). The MicroVM Sandbox uses this to renew the container's
  // activity timer so long-running tools don't get reaped mid-call.
  onInFlightChange?: (count: number) => void;
}

// Inspect an event and pull the (toolUseId, kind) it represents,
// either as a tool_use that needs executing or a result we should
// remember. Returning `null` means the event is unrelated to tool
// dispatch (agent.message, idle, span events, …).
function classifyEvent(ev: SessionEvent): {
  toolUse?: ToolUseEvent;
  answeredId?: string;
} | null {
  if (ev.type === "agent.tool_use" || ev.type === "agent.custom_tool_use") {
    return { toolUse: ev as ToolUseEvent };
  }
  if (ev.type === "user.tool_result") {
    return { answeredId: (ev as ResultEvent).tool_use_id };
  }
  if (ev.type === "user.custom_tool_result") {
    return { answeredId: (ev as ResultEvent).custom_tool_use_id };
  }
  return null;
}

// Run the dispatcher against a session's event stream. Returns when
// `signal` aborts. Stream errors are logged and the stream reconnects
// with exponential backoff.
export async function runCustomToolDispatcher(opts: CustomDispatchOpts): Promise<void> {
  const ctx: Ctx = {
    client: opts.client,
    sessionId: opts.sessionId,
    signal: opts.signal,
    customToolByName: new Map(opts.tools.map((t) => [t.name, t])),
    stockToolByName: new Map((opts.stockTools ?? []).map((t) => [t.name, t])),
    seen: new Set(),
    answered: new Set(),
    inFlight: 0,
    onInFlightChange: opts.onInFlightChange,
  };

  // Reconcile first so tool_use events that arrived before the DO
  // booted (or during a reconnect gap) get picked up.
  await reconcile(ctx);

  let backoff = STREAM_BACKOFF_START_MS;
  while (!ctx.signal.aborted) {
    try {
      const stream = await ctx.client.beta.sessions.events.stream(
        ctx.sessionId,
        { betas: [ANTHROPIC_BETA] },
        { signal: ctx.signal },
      );
      for await (const ev of stream as AsyncIterable<SessionEvent>) {
        if (ctx.signal.aborted) return;
        backoff = STREAM_BACKOFF_START_MS;
        await handleEvent(ctx, ev);
      }
    } catch (error) {
      if (ctx.signal.aborted) return;
      console.warn(
        `[microvm][custom-dispatch] stream disconnected session=${ctx.sessionId}, reconnecting in ${backoff}ms: ${errStr(error)}`,
      );
    }
    if (ctx.signal.aborted) return;
    await reconcile(ctx);
    await sleep(backoff, ctx.signal);
    backoff = Math.min(backoff * 2, STREAM_BACKOFF_CAP_MS);
  }
}

interface Ctx {
  client: Anthropic;
  sessionId: string;
  signal: AbortSignal;
  customToolByName: Map<string, BetaRunnableTool>;
  stockToolByName: Map<string, BetaRunnableTool>;
  seen: Set<string>;
  answered: Set<string>;
  inFlight: number;
  onInFlightChange?: (count: number) => void;
}

function bumpInFlight(ctx: Ctx, delta: 1 | -1): void {
  ctx.inFlight += delta;
  try {
    ctx.onInFlightChange?.(ctx.inFlight);
  } catch (error) {
    console.warn(
      `[microvm][custom-dispatch] onInFlightChange threw session=${ctx.sessionId}: ${errStr(error)}`,
    );
  }
}

async function reconcile(ctx: Ctx): Promise<void> {
  const pending: ToolUseEvent[] = [];
  try {
    for await (const ev of ctx.client.beta.sessions.events.list(
      ctx.sessionId,
      { limit: 1000, betas: [ANTHROPIC_BETA] },
      { signal: ctx.signal },
    ) as AsyncIterable<SessionEvent>) {
      const c = classifyEvent(ev);
      if (!c) continue;
      if (c.toolUse && !ctx.seen.has(c.toolUse.id)) {
        ctx.seen.add(c.toolUse.id);
        pending.push(c.toolUse);
      } else if (c.answeredId) {
        ctx.answered.add(c.answeredId);
      }
    }
  } catch (error) {
    if (!ctx.signal.aborted) {
      console.warn(
        `[microvm][custom-dispatch] reconcile failed session=${ctx.sessionId}: ${errStr(error)}`,
      );
    }
    return;
  }
  for (const ev of pending) {
    if (ctx.signal.aborted) return;
    if (ctx.answered.has(ev.id)) continue;
    await execute(ctx, ev);
  }
}

async function handleEvent(ctx: Ctx, ev: SessionEvent): Promise<void> {
  const c = classifyEvent(ev);
  if (!c) return;
  if (c.toolUse) {
    if (ctx.seen.has(c.toolUse.id)) return;
    ctx.seen.add(c.toolUse.id);
    await execute(ctx, c.toolUse);
  } else if (c.answeredId) {
    ctx.answered.add(c.answeredId);
  }
}

async function execute(ctx: Ctx, ev: ToolUseEvent): Promise<void> {
  const isStock = ev.type === "agent.tool_use";
  const lookup = isStock ? ctx.stockToolByName : ctx.customToolByName;
  const kind = isStock ? "stock" : "custom";
  const start = Date.now();
  const tool = lookup.get(ev.name);
  console.log(
    `[microvm][custom-dispatch] kind=${kind} tool=${ev.name} start session=${ctx.sessionId} use_id=${ev.id}`,
  );

  bumpInFlight(ctx, 1);
  let content: string | unknown[];
  let isError: boolean;
  try {
    if (!tool) {
      // Hallucinated/stale tool name. For `agent.tool_use` this most
      // often means the operator hasn't wired up `stockTools`; for
      // `agent.custom_tool_use` it's a saved agent referring to a tool
      // we no longer register. Match the SDK runner's "not found"
      // wording so both surfaces agree to the model.
      const known = [...lookup.keys()].sort().join(",") || "(none)";
      console.warn(
        `[microvm][custom-dispatch] kind=${kind} tool=${ev.name} not in registry session=${ctx.sessionId} use_id=${ev.id} registered=${known}`,
      );
      content = `Error: Tool '${ev.name}' not found. Registered ${kind} tools: ${known}`;
      isError = true;
    } else {
      ({ content, isError } = await runTool(ctx, tool, ev));
    }

    const ms = Date.now() - start;
    const sample =
      typeof content === "string"
        ? content.length > 80 ? `${content.slice(0, 80)}…` : content
        : "(blocks)";
    console.log(
      `[microvm][custom-dispatch] kind=${kind} tool=${ev.name} done  session=${ctx.sessionId} ms=${ms} error=${isError} result=${JSON.stringify(sample)}`,
    );
    await postResult(ctx, ev, content, isError);
  } finally {
    bumpInFlight(ctx, -1);
  }
}

async function runTool(
  ctx: Ctx,
  tool: BetaRunnableTool,
  ev: ToolUseEvent,
): Promise<{ content: string | unknown[]; isError: boolean }> {
  const toolCtrl = new AbortController();
  const onParentAbort = () => toolCtrl.abort();
  ctx.signal.addEventListener("abort", onParentAbort, { once: true });
  const timer = setTimeout(() => toolCtrl.abort(), TOOL_TIMEOUT_MS);
  try {
    const input = tool.parse ? tool.parse(ev.input) : ev.input;
    const content = await tool.run(input, {
      toolUse: ev,
      signal: toolCtrl.signal,
    } as unknown as Parameters<NonNullable<BetaRunnableTool["run"]>>[1]);
    return { content, isError: false };
  } catch (err) {
    return { content: `Error: ${errStr(err)}`, isError: true };
  } finally {
    clearTimeout(timer);
    ctx.signal.removeEventListener("abort", onParentAbort);
  }
}

async function postResult(
  ctx: Ctx,
  ev: ToolUseEvent,
  content: string | unknown[],
  isError: boolean,
): Promise<boolean> {
  const blocks = toContentBlocks(content);
  const resultEvent = ev.type === "agent.tool_use"
    ? { type: "user.tool_result", tool_use_id: ev.id, is_error: isError, content: blocks }
    : { type: "user.custom_tool_result", custom_tool_use_id: ev.id, is_error: isError, content: blocks };

  let lastErr: unknown;
  for (let i = 0; i < SEND_RETRIES; i++) {
    if (ctx.signal.aborted) return false;
    try {
      // `events.send` is typed for a fixed param union; cast through
      // `unknown` so we can post either result shape. Same escape
      // hatch the audit module uses — see src/isolate/audit.ts.
      await ctx.client.beta.sessions.events.send(
        ctx.sessionId,
        { betas: [ANTHROPIC_BETA], events: [resultEvent] } as unknown as Parameters<typeof ctx.client.beta.sessions.events.send>[1],
        { signal: ctx.signal },
      );
      ctx.answered.add(ev.id);
      return true;
    } catch (err) {
      lastErr = err;
      const status = (err as { status?: number })?.status;
      // 4xx except 408/429 is fatal — same policy as the SDK runner.
      if (typeof status === "number" && status >= 400 && status < 500 && status !== 408 && status !== 429) {
        break;
      }
      await sleep((i + 1) * 1000, ctx.signal);
    }
  }
  console.error(
    `[microvm][custom-dispatch] failed to send tool result session=${ctx.sessionId} use_id=${ev.id} kind=${ev.type}: ${errStr(lastErr)}`,
  );
  return false;
}

// Mirror the SDK dispatcher's toSessionContent — wrap a raw string
// into a text block, pass through structured blocks as-is, ensure we
// never post an empty array (the API rejects it).
function toContentBlocks(content: string | unknown[]): unknown[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content || "(no output)" }];
  }
  const out = content.map((b) => {
    const blk = b as { type?: string; text?: string };
    if (blk.type === "text") return { type: "text", text: blk.text || "(no output)" };
    if (blk.type === "image" || blk.type === "document") return b;
    return { type: "text", text: JSON.stringify(b) };
  });
  return out.length > 0 ? out : [{ type: "text", text: "(no output)" }];
}

function errStr(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
