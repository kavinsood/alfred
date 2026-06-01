// Single source of truth for the Isolate Sandbox workspace + power tool
// catalog. Pairs each tool's name, agent-facing description, and Zod
// input schema in one place so the runtime dispatcher (tools.ts) and the
// agent-payload builder (schemas.ts) can't drift.
//
// Naming policy: we used to prefix every tool with `cf_`. The dashboard
// already stripped that prefix for display, so an operator saw `read`
// in the catalog while the model was actually calling `cf_read` — a
// confusing UX. We now ship the unprefixed name on the wire when it's
// safe to: any tool whose unprefixed name would collide with an
// Anthropic-reserved built-in keeps the `cf_` prefix.
//
// Reserved by `agent_toolset_20260401` (kept prefixed):
//   bash, edit, read, write, glob, grep, web_fetch, web_search
// → cf_read, cf_write, cf_edit, cf_grep stay prefixed below.
// → cf_web_fetch / cf_web_search live in `./cf/` and stay prefixed
//   there for the same reason.
//
// Kept in its own file so neither caller has to transitively import the
// other — tools.ts depends on @cloudflare/codemode and @cloudflare/think,
// which transitively pull in `cloudflare:workers`. That breaks the
// vitest node environment used by the API + cf/ test suites. The
// registry only depends on zod, so importing it from schemas.ts (and
// tools.ts) stays lightweight.

import { z } from "zod";

export const MAX_LIST_ENTRIES = 500;

export interface IsolateToolEntry {
  name: string;
  description: string;
  schema: z.ZodObject<z.ZodRawShape>;
  // Runtime gate for the agent-payload builder. Workspace tools (no
  // `requires`) always register; power tools advertise the binding
  // they need so a missing LOADER or BROWSER drops them from the
  // catalog cleanly instead of producing "tool not implemented" at
  // call time.
  requires?: "loader" | "loader+browser";
}

const cfReadSchema = z.object({ path: z.string() });
const cfWriteSchema = z.object({ path: z.string(), content: z.string() });
const cfEditSchema = z.object({
  path: z.string(),
  old_string: z.string(),
  new_string: z.string(),
});
const listSchema = z.object({
  path: z.string().default("/"),
  limit: z.number().int().positive().max(MAX_LIST_ENTRIES).optional(),
});
const findSchema = z.object({ pattern: z.string() });
const cfGrepSchema = z.object({
  pattern: z.string(),
  path: z
    .string()
    .optional()
    .describe("Optional glob to scope which paths are searched."),
});
const deleteSchema = z.object({
  path: z.string(),
  recursive: z.boolean().optional(),
});
// Single-string code/path schemas reused by the power tools.
const codeSchema = z.object({ code: z.string() });
const runFileSchema = z.object({ path: z.string() });

// Re-exported for the runtime dispatcher so the BetaRunnableTool
// builders in tools.ts can use the same Zod object without redeclaring it.
// Keys match the wire name (prefixed when collision-avoidance requires).
export const WORKSPACE_SCHEMAS = {
  cf_read: cfReadSchema,
  cf_write: cfWriteSchema,
  cf_edit: cfEditSchema,
  list: listSchema,
  find: findSchema,
  cf_grep: cfGrepSchema,
  delete: deleteSchema,
} as const;

export const ISOLATE_TOOL_REGISTRY: ReadonlyArray<IsolateToolEntry> = [
  // Workspace tools — always available on Isolate sessions.
  //
  // `cf_read` / `cf_write` / `cf_edit` / `cf_grep` keep the `cf_`
  // prefix because the unprefixed names are reserved by Anthropic's
  // `agent_toolset_20260401` (the stock toolset MicroVM agents use for
  // bash / read / write / etc.). Registering a custom tool with one of
  // those names would either be rejected on agent create or shadow the
  // stock entry mid-session. `list` / `find` / `delete` have no
  // reserved-name collision so we ship them unprefixed.
  {
    name: "cf_read",
    description: "Read a UTF-8 file from the Isolate Sandbox workspace.",
    schema: cfReadSchema,
  },
  {
    name: "cf_write",
    description: "Write a UTF-8 file to the Isolate Sandbox workspace. Creates parent dirs.",
    schema: cfWriteSchema,
  },
  {
    name: "cf_edit",
    description:
      "Replace the first occurrence of old_string with new_string in an existing file.",
    schema: cfEditSchema,
  },
  {
    name: "list",
    description: "List files and directories under a path in the Isolate Sandbox workspace.",
    schema: listSchema,
  },
  {
    name: "find",
    description: "Find workspace paths matching a glob pattern.",
    schema: findSchema,
  },
  {
    name: "cf_grep",
    description: "Search workspace files for a regex; returns path:line:text.",
    schema: cfGrepSchema,
  },
  {
    name: "delete",
    description: "Delete a file or (recursively) a directory from the workspace.",
    schema: deleteSchema,
  },
  // Power tools — gated on a Worker Loader binding (and BROWSER for
  // the CDP variants). The agent-payload builder filters them out
  // when the binding is missing; the dispatcher only registers
  // handlers when the binding is present.
  {
    name: "execute",
    description:
      "Execute JavaScript in a sandboxed Worker isolate with workspace tools available as `codemode.*`. Network access goes through the parent Worker's egress gateway. Write a single async arrow function.",
    schema: codeSchema,
    requires: "loader",
  },
  {
    name: "run_file",
    description:
      "Read a JavaScript file from the workspace and run it in a sandboxed Worker isolate. Use this when you've written code with `cf_write` and want to execute it — saves a round-trip versus copying the file's contents back into `execute`. Returns { result, logs, error? }. The workspace tools are available inside the script as `codemode.*`.",
    schema: runFileSchema,
    requires: "loader",
  },
  {
    name: "browser_search",
    description:
      "Query the Chrome DevTools Protocol spec to discover commands, events, and types. Write a JS arrow function that returns the result.",
    schema: codeSchema,
    requires: "loader+browser",
  },
  {
    name: "browser_execute",
    description:
      "Run CDP commands against a live browser session. Each call opens a fresh session, exposes a `cdp` helper, and closes the session on completion.",
    schema: codeSchema,
    requires: "loader+browser",
  },
];
