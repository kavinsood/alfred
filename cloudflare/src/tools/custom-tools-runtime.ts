// Internal infrastructure that wires custom tools (defined in
// `src/tools/custom-tools.ts`) into the rest of the Worker. Most operators
// never touch this file — it exists so the user-facing tool list stays
// tidy.
//
// Two integration surfaces (both backends share the same path now):
//   1. The DO's custom-tool dispatcher — `customToolToBetaRunnable`
//      returns a `BetaRunnableTool` the dispatcher registers. The
//      IsolateRunner DO does this directly; the Sandbox DO does it via
//      `buildCfTools` in `src/tools/cf/index.ts` (which appends
//      every enabled custom tool to its output).
//   2. Anthropic agent payload — `customToolAgentDef` converts a custom
//      tool to the JSON-Schema-shaped def that goes into `/v1/agents`,
//      so the model sees the tool in its catalog from the first turn.
//
// Both reuse the same `CustomTool` definition object, so the user only
// writes the tool once. Zod handles validation; we lean on
// `z.toJSONSchema()` (zod v4) to derive the JSON schema for Anthropic.
//
// This file intentionally does NOT import `CUSTOM_TOOLS` from
// `custom-tools.ts`. The wiring code imports the array directly and
// passes individual tools into the adapters here — that breaks what
// would otherwise be a circular dependency between the user-facing
// definitions and the runtime.

import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import { z } from "zod";

// Context handed to every custom tool's `run` function. We deliberately
// keep this minimal — `env` is the only thing a tool reliably needs
// across backends. If you need per-session scoping, declare a
// `session_id` field on your input schema and read it from the input.
export interface CustomToolContext {
  /** All Worker bindings (R2, KV, D1, AI, VPC services, etc). */
  env: Env;
}

// A custom tool definition. Constructed via `defineTool(...)` so users
// get type inference on the input schema → run argument.
export interface CustomTool<TSchema extends z.ZodType = z.ZodType> {
  /** Unique tool name. Convention: prefix with `cf_` for binding-backed tools. */
  name: string;
  /** One- or two-sentence description the model sees in its tool catalog. */
  description: string;
  /**
   * Zod schema describing the tool's input. Must resolve to a JSON object
   * (i.e. a `z.object(...)`) because Anthropic requires tool inputs to be
   * objects.
   */
  inputSchema: TSchema;
  /**
   * Optional gate. Return false to skip registration — typically used to
   * hide the tool when a required Worker binding isn't configured. The
   * frontend reads this through `/api/custom-tools` to grey out the
   * toggle on deployments where the binding is missing.
   */
  requires?: (env: Env) => boolean;
  /**
   * The tool implementation. Receives the validated input and a context
   * containing `env`. Return a string; throw or return an `error: ...`
   * string to signal failure to the model.
   */
  run: (
    input: z.infer<TSchema>,
    ctx: CustomToolContext,
  ) => Promise<string> | string;
}

/**
 * Type-safe builder for a custom tool. Use this in `src/tools/custom-tools.ts`:
 *
 * ```ts
 * defineTool({
 *   name: "cf_lookup_user",
 *   description: "Look up a user profile by id.",
 *   inputSchema: z.object({ userId: z.string() }),
 *   run: async ({ userId }, { env }) => {
 *     // ...
 *   },
 * })
 * ```
 *
 * The return value is the def itself — the wrapper is just here so
 * TypeScript can infer the input schema → `run` argument link.
 */
export function defineTool<TSchema extends z.ZodType>(
  def: CustomTool<TSchema>,
): CustomTool<TSchema> {
  return def;
}

// Whether the tool should register on this env. Predicate-less tools
// always register; predicate-bearing tools register only when the
// predicate returns true. Errors in the predicate are treated as
// "tool not available" so a broken predicate can't crash dispatch.
export function isCustomToolEnabled(tool: CustomTool, env: Env): boolean {
  if (!tool.requires) return true;
  try {
    return tool.requires(env);
  } catch (error) {
    console.warn(
      `[custom-tools] requires() for "${tool.name}" threw, treating as unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}

// Build a BetaRunnableTool the Isolate dispatcher can register. Errors
// thrown from `run` are caught and stringified so a single misbehaving
// tool doesn't take the whole dispatcher down.
export function customToolToBetaRunnable(
  tool: CustomTool,
  env: Env,
): BetaRunnableTool {
  return betaZodTool({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    run: async (input) => {
      try {
        return await tool.run(input, { env });
      } catch (error) {
        return `error: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  });
}

// Anthropic agent-payload-shaped tool def. The agent's tools array
// includes one of these per custom tool that's currently enabled.
// Mirrors the IsolateToolDef.inputSchema shape used by the rest of the
// catalog so `buildIsolateAgentTools` can treat them uniformly.
export interface CustomToolAgentDef {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

// Anthropic's `/v1/agents` validator parses each `pattern` with an
// RE2-style engine — no lookahead `(?=`/`(?!`, no lookbehind `(?<=`/`(?<!`,
// no backreferences `\1`. Zod v4's `.email()` emits a regex with two
// negative lookaheads, which makes the API reject the tool with
// `pattern must be a valid regex`. We don't enforce patterns server-side
// anyway (the catalog is just shown to the model), and `format: "email"`
// still conveys the same intent — so we drop RE2-incompatible patterns
// recursively and keep everything else (including user-defined
// `z.string().regex(...)` patterns that don't use lookaround).
const RE2_INCOMPATIBLE_PATTERN_FEATURES = /\(\?<?[=!]|\\\d/;

export function sanitizeJsonSchemaForAnthropic(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(sanitizeJsonSchemaForAnthropic);
  }
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (
      key === "pattern" &&
      typeof value === "string" &&
      RE2_INCOMPATIBLE_PATTERN_FEATURES.test(value)
    ) {
      continue;
    }
    out[key] = sanitizeJsonSchemaForAnthropic(value);
  }
  return out;
}

export function customToolAgentDef(tool: CustomTool): CustomToolAgentDef {
  // zod v4 emits a JSON Schema with $schema / additionalProperties etc.
  // We only need type / properties / required; the Anthropic API
  // tolerates extras but we strip them so the wire payload stays small.
  //
  // `reused: "inline"` (not "ref") because Anthropic's `/v1/agents`
  // rejects `$ref` inside a custom tool's `input_schema`. Zod v4 hoists
  // sub-schemas into `$defs` whenever a property is wrapped with
  // `.default()`/`.optional()` followed by `.describe()`, so "ref" mode
  // produced broken refs once we stripped `$defs` below.
  const raw = z.toJSONSchema(tool.inputSchema, { reused: "inline" }) as {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
  if (raw.type !== "object") {
    throw new Error(
      `Custom tool "${tool.name}" must use a z.object(...) for inputSchema (got JSON schema type ${raw.type}).`,
    );
  }
  const properties = (sanitizeJsonSchemaForAnthropic(raw.properties ?? {}) ??
    {}) as Record<string, unknown>;
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: {
      type: "object",
      properties,
      ...(raw.required && raw.required.length > 0 ? { required: raw.required } : {}),
    },
  };
}

// Convenience: the list of enabled custom tool names. Used by the
// runner's drift detection (`computeDesiredToolNames`) to spot when a
// deploy adds or removes a custom tool mid-session and restart the
// dispatcher.
export function enabledCustomToolNames(
  tools: ReadonlyArray<CustomTool>,
  env: Env,
): string[] {
  return tools.filter((t) => isCustomToolEnabled(t, env)).map((t) => t.name);
}
