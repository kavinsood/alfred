// Agent payload rewriters used by the /api/agents create + update
// routes. Lives here (next to the tool registries) so the wire-format
// shaping stays close to the definitions that determine it; the API
// handlers in `src/api/index.ts` just call these.
//
// Both backends ride the same Anthropic `agent.tools[]` array on the
// wire. The shapes differ in what's inside:
//
//   - Isolate: every tool is a `type: "custom"` entry registered by
//     the DO dispatcher. The form sends an `agent_toolset_20260401`
//     wrapper alongside server-side tool toggles; we strip the
//     wrapper and replace it with the actual catalog entries
//     `buildIsolateAgentTools()` derives from the registry.
//
//   - MicroVM: the SDK's in-container dispatcher owns the stock
//     toolset (bash / read / write / edit / glob / grep / web_fetch /
//     web_search) via the `agent_toolset_20260401` wrapper. The cf_*
//     family and user-defined customs come through a parallel DO
//     dispatcher as `type: "custom"` entries. We keep the wrapper for
//     stock names and append customs the user picked.

import {
  buildIsolateAgentTools,
  buildMicrovmCustomTools,
  ISOLATE_TOOL_NAMES,
  MICROVM_CUSTOM_TOOL_NAMES,
} from "../tools/schemas";
import { VPC_BINDINGS } from "../vpc.generated";
import type { AgentBackend } from "../storage";

// Tools in `agent_toolset_20260401` that execute on Anthropic's
// infrastructure rather than inside the user's sandbox. Their HTTP
// requests originate from Anthropic's network and never traverse the
// container's outbound handler, so egress policies can't see them.
//
// The agent form's "Server-side tools" section defaults these off and
// surfaces a warning callout; we mirror that policy on the wire so a
// stale client can't silently punch a hole through the egress proxy.
const SERVER_SIDE_TOOLS = ["web_fetch", "web_search"] as const;

// Pull the list of Isolate tool names the frontend marked as enabled
// out of an agent payload.
//
// The form sends an `agent_toolset_20260401` wrapper alongside the
// Isolate-specific tools. The wrapper itself only ever describes
// Anthropic's stock toolset (bash / read / write / glob / grep /
// web_fetch / web_search) — it has NOTHING to say about the `cf_*`
// custom-tool catalog. So we deliberately ignore the wrapper's
// `default_config.enabled` here: it would otherwise mis-fire for
// Isolate agents whose form sends `default_config.enabled: false`
// (the form's signal for "don't turn on the wrapper's filesystem
// tools, they'd shadow the dispatcher's customs"), zeroing out the
// enabled set and shipping an agent with no tools at all.
//
// Treat every Isolate catalog entry as enabled by default, then
// honour any explicit per-tool config the form has emitted —
// `enabled: false` removes a name, `enabled: true` keeps/restores
// one. Names outside ISOLATE_TOOL_NAMES are ignored regardless.
function readEnabledIsolateTools(body: unknown): string[] {
  const enabled = new Set(ISOLATE_TOOL_NAMES);
  if (!body || typeof body !== "object") return [...enabled];
  const tools = (body as Record<string, unknown>).tools;
  if (!Array.isArray(tools)) return [...enabled];
  for (const t of tools) {
    if (!t || typeof t !== "object") continue;
    const tool = t as Record<string, unknown>;
    // Only inspect the toolset wrapper. Custom-typed entries are passed
    // through verbatim if the caller already built them, but we don't yet.
    if (tool.type !== "agent_toolset_20260401") continue;
    const configs = Array.isArray(tool.configs) ? tool.configs : [];
    for (const c of configs) {
      if (!c || typeof c !== "object") continue;
      const cfg = c as Record<string, unknown>;
      const name = typeof cfg.name === "string" ? cfg.name : null;
      if (!name || !ISOLATE_TOOL_NAMES.has(name)) continue;
      if (cfg.enabled === false) enabled.delete(name);
      else if (cfg.enabled === true) enabled.add(name);
    }
  }
  return [...enabled];
}

// Partition a MicroVM agent's `tools` array into:
//  - the stock toolset wrapper (kept as-is so the in-container SDK
//    dispatcher handles bash / read / etc.)
//  - `type: "custom"` entries for the cf_* + user-defined tools the
//    user picked (handled by the Sandbox DO dispatcher)
//
// The frontend lists every checked custom name in the wrapper's
// `configs` array; we sift those out, then call
// `buildMicrovmCustomTools` to look up descriptions / input schemas
// and apply binding gating.
function rewriteMicrovmTools(
  body: Record<string, unknown>,
  env: Env | undefined,
): void {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const enabled = new Set<string>();
  const newTools: unknown[] = [];

  for (const t of tools) {
    if (!t || typeof t !== "object") {
      newTools.push(t);
      continue;
    }
    const tool = t as Record<string, unknown>;

    // Toolset wrapper — sift custom names out of `configs` and rewrite
    // it to mention only stock tool names. The wrapper itself stays in
    // the payload; the SDK dispatcher in the container handles its
    // entries.
    if (tool.type === "agent_toolset_20260401") {
      const configs = Array.isArray(tool.configs) ? tool.configs : [];
      const remaining: unknown[] = [];
      for (const c of configs) {
        if (!c || typeof c !== "object") {
          remaining.push(c);
          continue;
        }
        const cfg = c as Record<string, unknown>;
        const name = typeof cfg.name === "string" ? cfg.name : null;
        if (name && MICROVM_CUSTOM_TOOL_NAMES.has(name)) {
          if (cfg.enabled !== false) enabled.add(name);
          continue;
        }
        // Stock or unknown — leave it in the toolset configs untouched.
        // (Anthropic ignores unknown names with a warning; keeping them
        // lets a stale UI degrade gracefully.)
        remaining.push(c);
      }
      tool.configs = remaining;
      newTools.push(tool);
      continue;
    }

    // Existing `type: "custom"` entries — treat the name as enabled.
    // The worker rebuilds them below so per-deploy schema/description
    // updates always take effect on save.
    if (tool.type === "custom" && typeof tool.name === "string") {
      if (MICROVM_CUSTOM_TOOL_NAMES.has(tool.name)) {
        enabled.add(tool.name);
        continue;
      }
      // Unknown custom name — preserve verbatim. Could be a hand-built
      // tool the operator wired up outside our registry.
      newTools.push(tool);
      continue;
    }

    // Anything else (e.g. an unrelated toolset) — leave untouched.
    newTools.push(tool);
  }

  // Build the type:"custom" entries for the enabled custom tools.
  // Binding-gated tools are filtered against `env` so a disabled
  // binding doesn't surface a tool the dispatcher can't actually run.
  const vpcAvailable = VPC_BINDINGS.length > 0;
  const customDefs = buildMicrovmCustomTools(
    [...enabled],
    env,
    vpcAvailable,
  );

  body.tools = [...newTools, ...customDefs];
}

// Rewrite an agent payload's `tools` array based on backend.
//
// Both backends use `type: "custom"` entries for the cf_* family and
// any user-defined tools from `src/tools/custom-tools.ts`. The shapes differ
// in what else rides on the payload — see the module header above.
export function transformAgentToolsForBackend(
  body: unknown,
  backend: AgentBackend | null,
  env: Env | undefined,
): unknown {
  if (!body || typeof body !== "object") return body;

  if (backend === "isolate") {
    const enabled = readEnabledIsolateTools(body);
    // Gate cf_* + power tools on what's actually wired up at runtime so
    // the model doesn't see tools that would only return "tool not
    // implemented". VPC availability is signalled separately because
    // it's not a single binding — any non-empty VPC_BINDINGS counts.
    const vpcAvailable = VPC_BINDINGS.length > 0;
    const customTools = buildIsolateAgentTools(enabled, env, vpcAvailable);
    // Preserve any non-toolset tools the caller may have included
    // alongside; only strip the Sandbox toolset wrapper.
    const existing = (body as Record<string, unknown>).tools;
    const passthrough = Array.isArray(existing)
      ? existing.filter(
          (t) =>
            t &&
            typeof t === "object" &&
            (t as Record<string, unknown>).type !== "agent_toolset_20260401",
        )
      : [];
    (body as Record<string, unknown>).tools = [...passthrough, ...customTools];
    return body;
  }

  if (backend === "microvm") {
    rewriteMicrovmTools(body as Record<string, unknown>, env);
    return body;
  }

  return body;
}

// Pass-through guard for the create / update agent paths. Older
// clients that don't yet know about server-side tools (web_fetch,
// web_search) would never send a `configs` entry for them; in that
// case the agent_toolset's `default_config.enabled = true` would
// silently turn them on. We append explicit `enabled: false` entries
// when neither side has spoken about a server-side tool so a stale
// client can't quietly punch a hole through the egress policy.
//
// When the form sends an explicit entry (enabled true or false), we
// leave it alone — the user chose. The first-class opt-in path is
// the agent form's "Server-side tools" section, which surfaces the
// egress-bypass warning before the user checks the box.
export function defaultDisableUnspecifiedServerTools(body: unknown): unknown {
  if (!body || typeof body !== "object") return body;
  const tools = (body as Record<string, unknown>).tools;
  if (!Array.isArray(tools)) return body;
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    const t = tool as Record<string, unknown>;
    if (t.type !== "agent_toolset_20260401") continue;
    const existing = Array.isArray(t.configs)
      ? (t.configs as Array<Record<string, unknown>>).filter(
          (c) => c && typeof c === "object",
        )
      : [];
    const seen = new Set<string>();
    for (const c of existing) {
      if (typeof c.name === "string") seen.add(c.name);
    }
    for (const name of SERVER_SIDE_TOOLS) {
      // Already mentioned (either way) → respect the caller's intent.
      if (seen.has(name)) continue;
      // Not mentioned → safe-default off.
      existing.push({ name, enabled: false });
    }
    t.configs = existing;
  }
  return body;
}
