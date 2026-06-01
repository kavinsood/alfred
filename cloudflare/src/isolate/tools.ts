import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import type { Workspace } from "@cloudflare/shell";
import { DynamicWorkerExecutor, type Executor } from "@cloudflare/codemode";
import { aiTools, resolveProvider } from "@cloudflare/codemode/ai";
import { createBrowserTools } from "@cloudflare/think/tools/browser";
import { createExecuteTool } from "@cloudflare/think/tools/execute";
import { createWorkspaceTools } from "@cloudflare/think/tools/workspace";
import { formatErr, truncate } from "../helpers";
import { aiToolSetToBetaTools, aiToolToBetaTool } from "./adapter";
import {
  ISOLATE_TOOL_REGISTRY,
  MAX_LIST_ENTRIES,
  WORKSPACE_SCHEMAS,
} from "../tools/tool-registry";

export {
  ISOLATE_TOOL_REGISTRY,
  type IsolateToolEntry,
} from "../tools/tool-registry";

// Tools exposed to the Anthropic agent loop when a session is backed by an
// Isolate Sandbox (Cloudflare Workers isolate + SQLite-backed Workspace)
// rather than a MicroVM Sandbox container. Each tool calls directly into
// the DO-local Workspace.
//
// Shape mirrors the upstream @cloudflare/think workspace tools (which we
// re-use under the `codemode.*` namespace inside execute /
// run_file). The package keeps its `Think` brand internally; we
// surface the rebranded "Isolate" name to users and the model.
//
// Bash is intentionally absent — there is no shell here. Anthropic also
// reserves the unprefixed name `bash` for its built-in toolset, so we'd
// be unable to register a custom tool under that name even if we wanted.

const MAX_FILE_BYTES = 1_000_000;
const MAX_GREP_HITS = 200;

function patternToRegex(pattern: string): RegExp {
  // Glob → regex. Used by grep when scoping by path glob.
  const esc = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^${esc.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")}$`,
  );
}

export interface IsolateToolDeps {
  workspace: Workspace;
  // Stable label for log lines; usually the session id.
  sessionId: string;
}

// Runtime builders for each workspace tool. Schemas + descriptions
// live in `tool-registry.ts`; this map is only the runtime side. Order
// matches the registry so list order on the wire stays stable.
const WORKSPACE_RUNTIMES: Record<
  keyof typeof WORKSPACE_SCHEMAS,
  (workspace: Workspace) => BetaRunnableTool
> = {
  cf_read: (workspace) =>
    betaZodTool({
      name: "cf_read",
      description: "Read a UTF-8 file from the Isolate Sandbox workspace.",
      inputSchema: WORKSPACE_SCHEMAS.cf_read,
      run: async ({ path }) => {
        try {
          const content = await workspace.readFile(path);
          if (content === null) return `error: ${path}: no such file`;
          return truncate(content, MAX_FILE_BYTES);
        } catch (error) {
          return formatErr(error);
        }
      },
    }),
  cf_write: (workspace) =>
    betaZodTool({
      name: "cf_write",
      description:
        "Write a UTF-8 file to the Isolate Sandbox workspace. Creates parent dirs.",
      inputSchema: WORKSPACE_SCHEMAS.cf_write,
      run: async ({ path, content }) => {
        try {
          await workspace.writeFile(path, content);
          return `wrote ${content.length} bytes to ${path}`;
        } catch (error) {
          return formatErr(error);
        }
      },
    }),
  cf_edit: (workspace) =>
    betaZodTool({
      name: "cf_edit",
      description:
        "Replace the first occurrence of old_string with new_string in an existing file.",
      inputSchema: WORKSPACE_SCHEMAS.cf_edit,
      run: async ({ path, old_string, new_string }) => {
        try {
          const cur = await workspace.readFile(path);
          if (cur === null) return `error: ${path}: no such file`;
          if (!cur.includes(old_string)) {
            return `error: old_string not found in ${path}`;
          }
          await workspace.writeFile(path, cur.replace(old_string, new_string));
          return `edited ${path}`;
        } catch (error) {
          return formatErr(error);
        }
      },
    }),
  list: (workspace) =>
    betaZodTool({
      name: "list",
      description:
        "List files and directories under a path in the Isolate Sandbox workspace.",
      inputSchema: WORKSPACE_SCHEMAS.list,
      run: async ({ path, limit }) => {
        try {
          const entries = await workspace.readDir(path, {
            limit: limit ?? MAX_LIST_ENTRIES,
          });
          if (entries.length === 0) return "(empty)";
          return entries
            .map((e) => `${e.type === "directory" ? "d" : "-"} ${e.path}`)
            .join("\n");
        } catch (error) {
          return formatErr(error);
        }
      },
    }),
  find: (workspace) =>
    betaZodTool({
      name: "find",
      description: "Find workspace paths matching a glob pattern.",
      inputSchema: WORKSPACE_SCHEMAS.find,
      run: async ({ pattern }) => {
        try {
          const hits = await workspace.glob(pattern);
          if (hits.length === 0) return "(no matches)";
          return hits
            .slice(0, MAX_LIST_ENTRIES)
            .map((h) => h.path)
            .join("\n");
        } catch (error) {
          return formatErr(error);
        }
      },
    }),
  cf_grep: (workspace) =>
    // Grep walks the file tree because Workspace doesn't expose a
    // server-side search primitive. Cheap for typical agent workspaces;
    // expensive for ones dominated by large files.
    betaZodTool({
      name: "cf_grep",
      description:
        "Search workspace files for a regex; returns path:line:text.",
      inputSchema: WORKSPACE_SCHEMAS.cf_grep,
      run: async ({ pattern, path }) => {
        try {
          const re = new RegExp(pattern);
          const scope = path ? patternToRegex(path) : null;
          const all = await workspace.glob("**/*");
          const out: string[] = [];
          for (const info of all) {
            if (info.type !== "file") continue;
            if (scope && !scope.test(info.path)) continue;
            const content = await workspace.readFile(info.path);
            if (content === null) continue;
            const lines = content.split("\n");
            for (let i = 0; i < lines.length; i++) {
              if (re.test(lines[i])) {
                out.push(`${info.path}:${i + 1}:${lines[i]}`);
                if (out.length >= MAX_GREP_HITS) break;
              }
            }
            if (out.length >= MAX_GREP_HITS) break;
          }
          return out.length ? out.join("\n") : "(no matches)";
        } catch (error) {
          return formatErr(error);
        }
      },
    }),
  delete: (workspace) =>
    betaZodTool({
      name: "delete",
      description:
        "Delete a file or (recursively) a directory from the workspace.",
      inputSchema: WORKSPACE_SCHEMAS.delete,
      run: async ({ path, recursive }) => {
        try {
          await workspace.rm(path, {
            recursive: recursive ?? false,
            force: true,
          });
          return `deleted ${path}`;
        } catch (error) {
          return formatErr(error);
        }
      },
    }),
};

export function isolateTools(deps: IsolateToolDeps): BetaRunnableTool[] {
  return (
    Object.keys(WORKSPACE_RUNTIMES) as Array<keyof typeof WORKSPACE_RUNTIMES>
  ).map((name) => WORKSPACE_RUNTIMES[name](deps.workspace));
}

// ---------------------------------------------------------------------------
// Code execution / browser tools.
//
// These wrap @cloudflare/think's helper factories — which produce AI SDK
// tools — into BetaRunnableTools the Anthropic SessionToolRunner can call. See
// adapter.ts for the conversion. Both require a Worker Loader binding;
// the browser tools additionally need a Browser Rendering binding.
// ---------------------------------------------------------------------------

export interface ExecuteToolDeps {
  workspace: Workspace;
  loader: WorkerLoader;
  // Timeout for the sandboxed code's execution. The AI SDK helper defaults
  // to 30s; we mirror that and let callers override.
  timeoutMs?: number;
  // Outbound network policy for the sandboxed code:
  //   - omitted / "isolated": fetch() and connect() throw inside the
  //     sandbox.
  //   - a Fetcher: every outbound request is routed through it. The
  //     runner builds one via `ctx.exports.IsolateOutboundGateway()` —
  //     see src/isolate/gateway.ts and the egress-control docs:
  //     https://developers.cloudflare.com/dynamic-workers/usage/egress-control/
  globalOutbound?: "isolated" | Fetcher;
}

// Tool description that replaces codemode's DEFAULT_DESCRIPTION. The
// default is too lax about the calling convention — models routinely emit
// `codemode.read("foo.js")` (positional string) instead of
// `codemode.read({ path: "foo.js" })` (object), which the AI-SDK Zod
// validator rejects with "expected object, received string". Repeated
// retries with the same mistake just burn turns. Make the convention
// impossible to miss with explicit DO/DON'T pairs and concrete examples
// using the actual workspace tools.
const EXECUTE_TOOL_DESCRIPTION = `Execute JavaScript in a sandboxed Worker isolate.

Use this when you need to run code, especially to chain multiple
\`codemode.*\` calls in a single turn. The sandbox has access to the
network via global \`fetch()\` and \`connect()\` (it routes outbound
through the parent Worker), no DOM, and only the tools listed below.

Available tools:
{{types}}

CALLING CONVENTION — read carefully:
- Every tool takes a SINGLE OBJECT argument matching its declared input
  type. Positional / primitive arguments are rejected at runtime.

  CORRECT:    await codemode.read({ path: "foo.js" })
  CORRECT:    await codemode.write({ path: "out.json", content: JSON.stringify(x) })
  CORRECT:    await codemode.list({ path: "/" })
  INCORRECT:  await codemode.read("foo.js")             // string, not object
  INCORRECT:  await codemode.read({ "foo.js" })         // not valid JS
  INCORRECT:  codemode.read({ path: "foo.js" })         // missing await

WRITING THE FUNCTION:
- Write a single \`async () => { ... }\` arrow function that returns the
  result. The runtime invokes it once, no arguments.
- Plain JavaScript only — no TypeScript types, interfaces, or generics.
- Do NOT define named functions then call them. Inline the body directly.
- \`eval()\` and \`new Function()\` are BOTH blocked by the V8 isolate
  (--disallow_code_generation_from_strings is on). To execute code that
  lives in a workspace file, use the \`run_file\` tool instead — it
  loads the file as a module so it doesn't hit the dynamic-code block.

EXAMPLES:

  // Read a file and return its parsed JSON.
  async () => {
    const file = await codemode.read({ path: "config.json" });
    return JSON.parse(file.content);
  }

  // Walk every file under /src and return the ones containing a string.
  async () => {
    const hits = await codemode.find({ pattern: "src/**/*.ts" });
    const matches = [];
    for (const h of hits.entries) {
      const f = await codemode.read({ path: h });
      if (f.content.includes("TODO")) matches.push(h);
    }
    return matches;
  }

  // Compute and return a result without touching files.
  async () => {
    const a = 42, b = 8;
    return { sum: a + b, product: a * b };
  }

  // Fetch a URL and persist the response body to the workspace.
  async () => {
    const res = await fetch("https://api.example.com/data");
    const body = await res.text();
    await codemode.write({ path: "out.json", content: body });
    return { status: res.status, bytes: body.length };
  }`;

// Resolve a globalOutbound option into the shape codemode wants: a
// Fetcher (network on) or null (network off). Callers are expected to
// construct the Fetcher themselves — typically via
// `ctx.exports.IsolateOutboundGateway()` from inside the control plane DO. See
// src/isolate/gateway.ts and the egress-control docs:
// https://developers.cloudflare.com/dynamic-workers/usage/egress-control/
function resolveOutbound(
  option: ExecuteToolDeps["globalOutbound"] | RunFileToolDeps["globalOutbound"],
): Fetcher | null {
  if (option === "isolated" || option === undefined) return null;
  return option;
}

// Build an Executor that constructs a fresh DynamicWorkerExecutor for each
// `execute()` call instead of reusing a single instance for the life of the
// tool. The underlying Worker isolate is already keyed by a per-call UUID,
// but we don't want execute / run_file invocations sharing the same
// wrapper — a long-running fetch from one call shouldn't queue behind
// another, and any future per-instance state in the executor would
// otherwise leak across concurrent calls. Constructing the wrapper is
// effectively free (it just stores the options).
function perCallExecutor(opts: {
  loader: WorkerLoader;
  timeout: number;
  globalOutbound: Fetcher | null;
}): Executor {
  return {
    execute: (code, providersOrFns) =>
      new DynamicWorkerExecutor(opts).execute(code, providersOrFns),
  };
}

// Code-execution tool: lets the LLM write JavaScript that calls the
// workspace tools (and any other AI SDK tools we plumb in). The code runs
// inside a freshly-loaded Worker via the Worker Loader binding. By default
// the sandbox can call fetch() / connect() — pass `globalOutbound:
// "isolated"` to lock that down. See
// https://developers.cloudflare.com/agents/api-reference/think/#code-execution-tool
export async function isolateExecuteTool(
  deps: ExecuteToolDeps,
): Promise<BetaRunnableTool> {
  // Fresh DynamicWorkerExecutor per invocation so concurrent `execute`
  // calls don't share a wrapper — see perCallExecutor() above.
  const executor = perCallExecutor({
    loader: deps.loader,
    timeout: deps.timeoutMs ?? 30_000,
    globalOutbound: resolveOutbound(deps.globalOutbound),
  });
  const aiTool = createExecuteTool({
    // Hand the workspace tools to the sandboxed code as `codemode.*` so the
    // LLM can read/write files from inside its generated JavaScript.
    tools: createWorkspaceTools(deps.workspace),
    executor,
    description: EXECUTE_TOOL_DESCRIPTION,
  });
  // Name must match the registry entry in `tool-registry.ts`.
  return aiToolToBetaTool("execute", aiTool);
}

export interface BrowserToolDeps {
  loader: WorkerLoader;
  // Either a Browser Rendering binding (recommended) or a CDP URL. If both
  // are absent the tools throw at runtime; we still register them so the
  // model gets a clear error rather than a silent missing-tool failure.
  browser?: Fetcher;
  cdpUrl?: string;
  timeoutMs?: number;
}

// Browser tools: `browser_search` (query the CDP protocol spec) and
// `browser_execute` (run CDP commands against a live Chrome session). Each
// session is opened fresh and closed on completion. See
// https://developers.cloudflare.com/agents/api-reference/think/#browser-tools
export async function isolateBrowserTools(
  deps: BrowserToolDeps,
): Promise<BetaRunnableTool[]> {
  const set = createBrowserTools({
    loader: deps.loader,
    ...(deps.browser ? { browser: deps.browser } : {}),
    ...(deps.cdpUrl ? { cdpUrl: deps.cdpUrl } : {}),
    timeout: deps.timeoutMs ?? 30_000,
  });
  // The helper's tool names (`browser_search`, `browser_execute`) match
  // the registry entries verbatim; pass straight through.
  return aiToolSetToBetaTools(set);
}

export interface RunFileToolDeps {
  workspace: Workspace;
  loader: WorkerLoader;
  sessionId: string;
  timeoutMs?: number;
  // Same semantics as ExecuteToolDeps.globalOutbound — pass a Fetcher to
  // route outbound through it (e.g. IsolateOutboundGateway), or "isolated"
  // / omit to block fetch()/connect() inside the sandbox.
  globalOutbound?: "isolated" | Fetcher;
}

// Read a file from the workspace and execute its contents inside a
// freshly-loaded Worker isolate. Bypasses the V8
// --disallow_code_generation_from_strings restriction that blocks
// `eval()` and `new Function()` — the file's source becomes the body of
// the executor's main module, so it's compiled at module-load time
// instead of at runtime. Standard scripts with top-level statements
// work; codemode's normalizeCode wraps them in an async arrow function
// automatically.
//
// Provides the same `codemode.*` workspace bindings that `execute`
// has, so a script can read/write/edit other files mid-run. Network
// access is on by default; pass `globalOutbound: "isolated"` to lock it.
export function isolateRunFileTool(deps: RunFileToolDeps): BetaRunnableTool {
  // Fresh DynamicWorkerExecutor per invocation — see perCallExecutor() for
  // the rationale.
  const executor = perCallExecutor({
    loader: deps.loader,
    timeout: deps.timeoutMs ?? 30_000,
    globalOutbound: resolveOutbound(deps.globalOutbound),
  });
  // Wrap the workspace tools as a ToolProvider under the default
  // "codemode" namespace, then pre-resolve so we don't rebuild the
  // ResolvedProvider on every call.
  const provider = resolveProvider(
    aiTools(createWorkspaceTools(deps.workspace)),
  );

  // Reuse the same `{ path: string }` schema the agent payload exposes
  // (registered in tool-registry.ts) so the dispatcher and the catalog
  // can't drift on the input shape.
  const runFileEntry = ISOLATE_TOOL_REGISTRY.find((e) => e.name === "run_file");
  if (!runFileEntry) {
    throw new Error("run_file missing from ISOLATE_TOOL_REGISTRY");
  }
  return betaZodTool({
    name: "run_file",
    description:
      "Read a JavaScript file from the Isolate Sandbox workspace and execute it. The file's contents become the body of an async function loaded as a Worker module — so plain scripts with top-level statements, console.log, function declarations, or a single `async () => { ... }` arrow expression all work. Returns { result, logs, error? }. The workspace tools are available inside the script as `codemode.*` (object-arg convention applies). Use this instead of `execute` when the code lives in a file you already wrote — saves a round-trip and avoids re-typing.",
    inputSchema: runFileEntry.schema,
    run: async (input) => {
      // Registry's schema is `z.ZodObject<z.ZodRawShape>` so the inferred
      // input here is a loose record. `run_file` has exactly one string
      // `path`; read it through that contract.
      const path = String((input as { path: string }).path);
      try {
        const content = await deps.workspace.readFile(path);
        if (content === null) return `error: ${path}: no such file`;
        const { result, logs, error } = await executor.execute(content, [
          provider,
        ]);
        if (error) {
          // Format the error result the same shape the model sees from
          // `execute` on failure — keeps prompting consistent.
          return JSON.stringify({ error, logs });
        }
        return JSON.stringify({ result, logs });
      } catch (err) {
        return `error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });
}
