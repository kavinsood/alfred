// Tool catalogs sent to Anthropic at agent-create/update time so the
// model sees its tools in its catalog. The dispatchers (Isolate
// runner DO + MicroVM Sandbox DO) register handlers under the same
// names — these two must stay in sync.
//
// User-defined tools from `src/tools/custom-tools.ts` are merged in
// dynamically — see `getIsolateToolDef` / `buildIsolateAgentTools`.
// You don't need to add anything here when defining a new custom tool.
//
// Keep this in lockstep with `src/isolate/tools.ts` (Isolate
// workspace tool dispatcher), the AI-SDK-backed factories
// (`isolateExecuteTool`, `isolateBrowserTools`), and `src/tools/cf/`
// (the Cloudflare-binding-backed tools). When you add a tool there,
// add its schema here.
//
// Two prefixes — both chosen to avoid the unprefixed tool names that
// Anthropic's Agents API reserves (`read`, `write`, `edit`, `bash`,
// `glob`, `grep`, `web_fetch`, etc., owned by agent_toolset_20260401):
//
//   cf_*       — all tools. Workspace + code-execution tools are tied
//                to the Isolate Sandbox runtime; binding-backed tools
//                (browser rendering, workers AI, email routing, VPC
//                services) call into the parent Worker. The model
//                treats them as a single family so the system prompt
//                can teach a "prefer cf_* when present" preference
//                that scales as we add more bindings.
//
// The frontend strips both prefixes for display so the UI still shows
// clean names like `web_fetch` / `read`.

import { z } from "zod";
import { CUSTOM_TOOLS } from "./custom-tools";
import {
  customToolAgentDef,
  isCustomToolEnabled,
  sanitizeJsonSchemaForAnthropic,
} from "./custom-tools-runtime";
import { CF_TOOL_DEFS } from "./cf";
import { ISOLATE_TOOL_REGISTRY, type IsolateToolEntry } from "./tool-registry";

// Prefix used by tools whose unprefixed name would collide with an
// Anthropic-reserved built-in (read/write/edit/grep from
// agent_toolset_20260401, plus the server-side web_fetch / web_search).
// The audit module uses this to flag agents whose saved tool list still
// has unprefixed clones of the reserved names — that pattern was the
// source of the legacy "tool not implemented" failures.
export const CF_TOOL_PREFIX = "cf_";

// Subset of registered tool names that ship with the `cf_` prefix. Every
// other Cloudflare-side tool lands on the wire unprefixed (read the
// frontend's display name as-is) so the system prompt, the agent
// catalog, and the dashboard's checkbox row all agree.
export const PREFIXED_TOOL_NAMES: ReadonlySet<string> = new Set([
  "cf_read",
  "cf_write",
  "cf_edit",
  "cf_grep",
  "cf_web_fetch",
  "cf_web_search",
]);

interface IsolateToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  // Optional gating — these tools only register at the dispatcher when the
  // matching binding exists. If we send them in the agent payload but the
  // binding is absent at runtime, the model will get "tool not implemented".
  // The frontend reads `requires` to disable the checkbox with an explanation
  // when the user hasn't configured the binding.
  //
  // "custom" means the tool comes from `src/tools/custom-tools.ts`;
  // gating is delegated to the tool's `requires` predicate (resolved
  // at call time by `meetsCustomToolRequirement`).
  requires?:
    | "loader"
    | "loader+browser"
    | "browser-rendering"
    | "workers-ai"
    | "vpc"
    | "email"
    | "custom";
}

// Workspace + power-tool JSON Schemas are derived from the single
// registry in `./tool-registry.ts` so the Zod schemas the dispatcher
// uses at runtime and the JSON Schemas Anthropic sees in the agent
// catalog can't drift. Adding a new workspace/power tool means
// touching one place (tool-registry.ts) — nothing here needs to change.
function entryToDef(entry: IsolateToolEntry): IsolateToolDef {
  // `reused: "inline"` because Anthropic's `/v1/agents` rejects `$ref`
  // inside a custom tool's `input_schema` — see the matching note on
  // `cfDefs` below for the gory detail.
  const json = z.toJSONSchema(entry.schema, { reused: "inline" }) as {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
  if (json.type !== "object") {
    throw new Error(
      `Isolate tool "${entry.name}" schema did not resolve to a JSON object (got ${json.type}).`,
    );
  }
  const properties = (sanitizeJsonSchemaForAnthropic(json.properties ?? {}) ??
    {}) as Record<string, unknown>;
  return {
    name: entry.name,
    description: entry.description,
    inputSchema: {
      type: "object",
      properties,
      ...(json.required && json.required.length > 0
        ? { required: json.required }
        : {}),
    },
    ...(entry.requires ? { requires: entry.requires } : {}),
  };
}

const workspaceAndPowerDefs: IsolateToolDef[] =
  ISOLATE_TOOL_REGISTRY.map(entryToDef);

// Cloudflare-binding-backed tools. Each entry is gated on a different
// binding so users can mix-and-match (e.g. enable browser tools without
// setting up email).
//
// The defs here are DERIVED from `CF_TOOL_DEFS` in `src/tools/cf/` —
// the single source of truth for cf_* tool names, descriptions,
// schemas, and run functions. We translate each entry's zod input
// schema to JSON Schema (zod v4's `z.toJSONSchema()`) so the
// Anthropic agent catalog sees the same shape the dispatcher will
// actually accept at runtime. Adding a new cf_* tool requires
// touching only `src/tools/cf/`; this array picks it up automatically.
const cfDefs: IsolateToolDef[] = CF_TOOL_DEFS.map((def) => {
  // `reused: "inline"` (not "ref") because Anthropic's `/v1/agents`
  // rejects `$ref` inside a custom tool's `input_schema`. Zod v4 hoists
  // sub-schemas into `$defs` whenever a property is wrapped with
  // `.default()`/`.optional()` followed by `.describe()` — common in
  // these cf_* schemas — so the "ref" mode produced broken refs once we
  // stripped `$defs` below and tripped the API on agent create.
  const json = z.toJSONSchema(def.agentInputSchema, { reused: "inline" }) as {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
  if (json.type !== "object") {
    // Every cf_* tool MUST use a top-level z.object. If this ever fires
    // it's a bug in `src/tools/cf/`, not in user data — surface it loudly.
    throw new Error(
      `cf_* tool "${def.name}" agentInputSchema did not resolve to a JSON object (got ${json.type}).`,
    );
  }
  // Sanitizer drops RE2-incompatible `pattern` fields (e.g. zod's
  // `.email()` emits lookahead) — see `custom-tools-runtime.ts`.
  const properties = (sanitizeJsonSchemaForAnthropic(json.properties ?? {}) ??
    {}) as Record<string, unknown>;
  return {
    name: def.name,
    description: def.agentDescription,
    inputSchema: {
      type: "object",
      properties,
      ...(json.required && json.required.length > 0
        ? { required: json.required }
        : {}),
    },
    requires: def.requires,
  };
});

// Built-in tool defs. Custom tools defined in `./custom-tools.ts`
// are merged in via `getCustomToolDefs()` at lookup time so they're
// always reflected without a code edit here.
const BUILT_IN_TOOL_DEFS: IsolateToolDef[] = [
  ...workspaceAndPowerDefs,
  ...cfDefs,
];

// Convert each entry in CUSTOM_TOOLS into an IsolateToolDef shape so
// the rest of this module can treat custom tools uniformly with the
// built-ins. JSON Schema is derived from the user's zod schema; the
// `requires: "custom"` marker tells `meetsToolRequirement` to defer
// gating to the predicate on the original CustomTool.
function getCustomToolDefs(): IsolateToolDef[] {
  const out: IsolateToolDef[] = [];
  for (const tool of CUSTOM_TOOLS) {
    try {
      const agentDef = customToolAgentDef(tool);
      out.push({
        name: agentDef.name,
        description: agentDef.description,
        inputSchema: agentDef.inputSchema,
        requires: "custom",
      });
    } catch (error) {
      // Bad zod schema or non-object input — log loudly and drop the
      // tool. Better than crashing all agent operations because one
      // user-added tool is malformed.
      console.warn(
        `[custom-tools] failed to convert "${tool.name}" to agent def: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return out;
}

export const ISOLATE_TOOL_DEFS: IsolateToolDef[] = BUILT_IN_TOOL_DEFS;

// Set of all tool names the worker recognises — built-ins plus any
// user-defined tools from `./custom-tools.ts`. The agent-payload
// rewriter uses this to filter unknown names out of the wire format,
// so custom tools have to appear here or they'll be silently dropped
// on agent save. Computed at module-load time; if the user edits
// `custom-tools.ts` they have to redeploy for the change to land
// (the control plane's drift detection handles the in-flight case).
export const ISOLATE_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...ISOLATE_TOOL_DEFS.map((t) => t.name),
  ...CUSTOM_TOOLS.map((t) => t.name),
]);

export function getIsolateToolDef(name: string): IsolateToolDef | undefined {
  const built = ISOLATE_TOOL_DEFS.find((t) => t.name === name);
  if (built) return built;
  return getCustomToolDefs().find((t) => t.name === name);
}

// Inspect an Env to decide which `requires` gates are currently satisfied.
// Used to filter the agent's tool catalog at agent-create time so the
// model doesn't see cf_* tools whose binding isn't wired up — calling
// one would return "tool not implemented" from the dispatcher and waste
// a turn. Mirrors the binding probes in `evaluateCfRequires` in
// `src/tools/cf/index.ts`.
export function isolateCapabilitiesFromEnv(env: Env): {
  loader: boolean;
  loaderBrowser: boolean;
  browserRendering: boolean;
  workersAi: boolean;
  vpc: boolean;
  email: boolean;
} {
  const loader = Boolean(env.LOADER);
  const browser = Boolean(env.BROWSER);
  const browserRendering =
    Boolean(env.BROWSER) ||
    Boolean(env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_ACCOUNT_ID);
  const workersAi = Boolean(env.AI);
  const sendEmail = Boolean(env.SEND_EMAIL);
  // VPC bindings live on a generated module to avoid pulling wrangler
  // config into runtime; import here would create a cycle, so we leave
  // VPC gating to the caller — the api layer already knows whether any
  // bindings are declared. Callers that don't care can pass `true`.
  return {
    loader,
    loaderBrowser: loader && browser,
    browserRendering,
    workersAi,
    vpc: false, // overridden by caller when VPC_BINDINGS is non-empty
    email: sendEmail,
  };
}

// Does the env satisfy `def.requires`? Workspace tools (`requires`
// unset) always pass. The optional `capsOverride` lets callers patch in
// VPC availability (the only signal that can't be read off Env directly).
function meetsToolRequirement(
  def: IsolateToolDef,
  caps: ReturnType<typeof isolateCapabilitiesFromEnv>,
  env: Env | undefined,
): boolean {
  switch (def.requires) {
    case undefined:
      return true;
    case "loader":
      return caps.loader;
    case "loader+browser":
      return caps.loaderBrowser;
    case "browser-rendering":
      return caps.browserRendering;
    case "workers-ai":
      return caps.workersAi;
    case "vpc":
      return caps.vpc;
    case "email":
      return caps.email;
    case "custom": {
      // Find the original CustomTool by name and apply its predicate.
      // Without env we can't evaluate the predicate, so we fall through
      // to "available" — the caller (typically pre-flight validation
      // without an env handle) is asking about catalog membership, not
      // runtime availability.
      if (!env) return true;
      const tool = CUSTOM_TOOLS.find((t) => t.name === def.name);
      if (!tool) return false;
      return isCustomToolEnabled(tool, env);
    }
    default:
      return true;
  }
}

// Build the `tools` array for the Anthropic agent payload from a list of
// enabled tool names. Unknown names are dropped (with a warn log) so a stale
// frontend can't poison the agent definition. When `env` is supplied, tools
// whose binding gating isn't satisfied are also dropped — keeps the model
// from being shown tools that would only return "tool not implemented" at
// runtime.
export function buildIsolateAgentTools(
  enabledNames: ReadonlyArray<string>,
  env?: Env,
  vpcAvailable?: boolean,
): Array<{
  type: "custom";
  name: string;
  description: string;
  input_schema: IsolateToolDef["inputSchema"];
}> {
  const caps = env
    ? { ...isolateCapabilitiesFromEnv(env), vpc: Boolean(vpcAvailable) }
    : null;
  const out: Array<{
    type: "custom";
    name: string;
    description: string;
    input_schema: IsolateToolDef["inputSchema"];
  }> = [];
  for (const name of enabledNames) {
    const def = getIsolateToolDef(name);
    if (!def) {
      console.warn(
        `[isolate] ignoring unknown tool name in agent payload: ${name}`,
      );
      continue;
    }
    if (caps && !meetsToolRequirement(def, caps, env)) {
      console.log(
        `[isolate] dropping ${name} from agent payload — missing binding (${def.requires})`,
      );
      continue;
    }
    out.push({
      type: "custom",
      name: def.name,
      description: def.description,
      input_schema: def.inputSchema,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// MicroVM agent payload — `type: "custom"` entries for cf_* + user-defined
// tools that run in the Sandbox DO (alongside `ant beta:worker run` in
// the container, which keeps owning the stock toolset).
// ---------------------------------------------------------------------------

// The Anthropic stock toolset names. These ride the
// `agent_toolset_20260401` wrapper and are dispatched by the SDK's
// in-container runner; the worker doesn't touch them. Everything else
// in the form's tool catalog is a custom tool and goes in `type:
// "custom"` entries that the Sandbox DO's dispatcher answers.
export const MICROVM_STOCK_TOOL_NAMES: ReadonlySet<string> = new Set([
  "bash",
  "edit",
  "read",
  "write",
  "glob",
  "grep",
  "web_fetch",
  "web_search",
]);

// Browser CDP tools — sourced from `ISOLATE_TOOL_REGISTRY` because
// the Isolate backend treats them as workspace power tools, but the
// MicroVM Sandbox DO can host them too: the underlying factory spins
// up a fresh Worker isolate via the parent Worker's LOADER binding and
// talks to BROWSER directly, neither of which the container is
// involved in. Reuse the same JSON-schema derivation as the Isolate
// catalog so the wire definitions stay in lockstep across backends.
const microvmBrowserDefs: IsolateToolDef[] = ISOLATE_TOOL_REGISTRY.filter(
  (e) => e.requires === "loader+browser",
).map(entryToDef);

// MicroVM-flavoured tool defs for the cf_* family. Same names as the
// Isolate cfDefs above, but with the workspace-free description /
// schema overrides applied where the entry provides them (screenshot,
// image_generate). Tools without overrides use the same shape on
// both backends.
const microvmCfDefs: IsolateToolDef[] = CF_TOOL_DEFS.map((def) => {
  const description = def.agentDescriptionMicrovm ?? def.agentDescription;
  const schema = def.agentInputSchemaMicrovm ?? def.agentInputSchema;
  // `reused: "inline"` — see the matching note on `cfDefs` above. Anthropic
  // rejects `$ref` in custom tool input schemas; inlining keeps the payload
  // valid for both create and update.
  const json = z.toJSONSchema(schema, { reused: "inline" }) as {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
  if (json.type !== "object") {
    throw new Error(
      `cf_* tool "${def.name}" microvm schema did not resolve to a JSON object (got ${json.type}).`,
    );
  }
  const properties = (sanitizeJsonSchemaForAnthropic(json.properties ?? {}) ??
    {}) as Record<string, unknown>;
  return {
    name: def.name,
    description,
    inputSchema: {
      type: "object",
      properties,
      ...(json.required && json.required.length > 0
        ? { required: json.required }
        : {}),
    },
    requires: def.requires,
  };
});

// Get the def for a MicroVM tool name. Returns cf_* defs with MicroVM-
// flavoured schemas, the browser CDP tools (loader+browser, hosted by
// the Sandbox DO via the parent Worker's bindings), plus user-defined
// custom tools (same shape on either backend). The workspace tools
// (cf_read/cf_write/cf_edit/cf_grep/list/find/delete) and the
// codemode-style power tools (execute / run_file) are NOT available on
// MicroVM and return undefined here — the in-container SDK runner
// handles the stock toolset (bash/read/write/etc.); the cf_* family,
// browser tools, and user customs come through the Sandbox DO's
// dispatcher.
function getMicrovmCustomToolDef(name: string): IsolateToolDef | undefined {
  const builtIn =
    microvmCfDefs.find((t) => t.name === name) ??
    microvmBrowserDefs.find((t) => t.name === name);
  if (builtIn) return builtIn;
  return getCustomToolDefs().find((t) => t.name === name);
}

// Set of every name that can appear as a custom tool on a MicroVM
// agent. Used by the api layer to partition the form's tool list
// (stock names stay in the toolset wrapper, custom names become
// type:"custom" entries).
export const MICROVM_CUSTOM_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...microvmCfDefs.map((t) => t.name),
  ...microvmBrowserDefs.map((t) => t.name),
  ...CUSTOM_TOOLS.map((t) => t.name),
]);

// Build the `type: "custom"` entries for a MicroVM agent. Same gating
// rules as `buildIsolateAgentTools` — unknown names are dropped with a
// warn log, binding-gated tools are filtered against `env`.
export function buildMicrovmCustomTools(
  enabledNames: ReadonlyArray<string>,
  env?: Env,
  vpcAvailable?: boolean,
): Array<{
  type: "custom";
  name: string;
  description: string;
  input_schema: IsolateToolDef["inputSchema"];
}> {
  const caps = env
    ? { ...isolateCapabilitiesFromEnv(env), vpc: Boolean(vpcAvailable) }
    : null;
  const out: Array<{
    type: "custom";
    name: string;
    description: string;
    input_schema: IsolateToolDef["inputSchema"];
  }> = [];
  for (const name of enabledNames) {
    const def = getMicrovmCustomToolDef(name);
    if (!def) {
      console.warn(
        `[microvm] ignoring unknown custom tool name in agent payload: ${name}`,
      );
      continue;
    }
    if (caps && !meetsToolRequirement(def, caps, env)) {
      console.log(
        `[microvm] dropping ${name} from agent payload — missing binding (${def.requires})`,
      );
      continue;
    }
    out.push({
      type: "custom",
      name: def.name,
      description: def.description,
      input_schema: def.inputSchema,
    });
  }
  return out;
}
