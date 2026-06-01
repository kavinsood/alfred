// Cloudflare-binding-backed tools — public face of the cf_* family.
//
// Tools defined in the sibling files (`./browser.ts`, `./ai.ts`,
// `./vpc.ts`, `./email.ts`) are stitched together here into a single
// `CF_TOOL_DEFS` registry. Both backends (Isolate DO + MicroVM
// Sandbox DO) build their runtime BetaRunnableTools from this same
// list, and the schemas module in `../schemas.ts` reads it to build
// the Anthropic agent payload.
//
// Custom tool name conventions: every tool here is prefixed `cf_` so
// the model can recognise them as a single family ("Cloudflare-backed
// tools") and pick them in preference to generic equivalents like the
// built-in `web_fetch`. The system prompts in `src/isolate/system-prompt.ts`
// and `src/microvm/prompt.ts` document the preference.
//
// Lifecycle: factories are invoked once per `start()` call. They read
// the dependencies they need from the Env at construction; if a
// binding is missing the corresponding tool is simply not registered
// (the control plane has the gating logic).

import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import { z } from "zod";
import { CUSTOM_TOOLS } from "../custom-tools";
import {
  customToolToBetaRunnable,
  enabledCustomToolNames,
  isCustomToolEnabled,
} from "../custom-tools-runtime";
import { bytesToBase64, formatErr } from "../../helpers";
import { VPC_BINDINGS } from "../../vpc.generated";
import {
  cfImageGenerateCoreSchema,
  generateCfImageBytes,
  resolveCfImageModel,
  type CfImageGenerateCoreInput,
} from "./ai";
import {
  captureCfScreenshotBytes,
  cfBrowseDescription,
  cfBrowseSchema,
  cfFetchMarkdownDescription,
  cfFetchMarkdownSchema,
  cfScreenshotCoreSchema,
  cfWebFetchDescription,
  cfWebFetchSchema,
  runCfBrowse,
  runCfFetchMarkdown,
  runCfWebFetch,
  type CfScreenshotCoreInput,
} from "./browser";
import {
  cfEmailInboxCoreSchema,
  cfEmailReadCoreSchema,
  cfEmailSendCoreSchema,
  runCfEmailInbox,
  runCfEmailRead,
  runCfEmailSend,
} from "./email";
import {
  browserRenderingDeps,
  detectImageMime,
  ensureAbsolute,
  type CfToolDeps,
} from "./shared";
import { buildCfCallServiceSchema, runCfCallService } from "./vpc";

// Re-export the shared types and helpers callers outside the cf/
// directory still need. Keeps the public surface flat — consumers
// import from `src/tools/cf` rather than reaching into the sub-files.
export { detectImageMime, type CfToolDeps } from "./shared";

// ---------------------------------------------------------------------------
// Gating tag. Each tool declares one of these; `evaluateCfRequires`
// below resolves it against the current Env. The tags are coarse on
// purpose — "email" covers any of SEND_EMAIL / DB, even though the
// individual run functions only succeed when their specific binding is
// present. The per-tool `buildBetaRunnable` still null-checks the
// specific binding so we never register a tool that would only return
// "not configured" at call time.
export type CfRequires = "browser-rendering" | "workers-ai" | "vpc" | "email";

// Resolve a gating tag against the current Env. Used by both backends
// and by the schemas layer (via `isolateCapabilitiesFromEnv`).
export function evaluateCfRequires(req: CfRequires, env: Env): boolean {
  switch (req) {
    case "browser-rendering":
      return !!browserRenderingDeps(env);
    case "workers-ai":
      return !!env.AI;
    case "vpc": {
      // Dynamic binding lookup — operator picks the name in wrangler.jsonc.
      const envRecord = env as unknown as Record<string, unknown>;
      const services = VPC_BINDINGS.filter(
        (b) => b.type === "service" && typeof envRecord[b.binding] === "object",
      );
      return services.length > 0;
    }
    case "email":
      return !!env.SEND_EMAIL || !!env.DB;
  }
}

export interface CfToolEntry {
  name: string;
  requires: CfRequires;

  // Anthropic agent payload — Isolate-flavoured catalog description and
  // input schema. Used by `src/tools/schemas.ts` to build the `tools`
  // array sent to /v1/agents. Description is plain text; input schema is
  // a Zod object, JSON-Schema-converted at agent-build time.
  agentDescription: string;
  agentInputSchema: z.ZodTypeAny;

  // Per-backend agent payload override. When set, MicroVM agents see
  // this description / schema in their tool catalog instead of the
  // workspace-aware variants above. Used by `screenshot` and
  // `image_generate` — those write to the workspace on Isolate but
  // return inline image content blocks on Sandbox, so the model's
  // input shape differs (no `path` field on MicroVM).
  agentDescriptionMicrovm?: string;
  agentInputSchemaMicrovm?: z.ZodTypeAny;

  // Build a BetaRunnableTool that runs in the Worker DO (IsolateRunner
  // or Sandbox). `deps.workspace` is set for Isolate sessions and
  // omitted for Sandbox; factories that produce binary output branch
  // on its presence. Returns null when the tool's specific binding is
  // missing (the coarse `requires` tag may say "available" because a
  // sibling tool's binding is set; let the per-tool factory have the
  // final say).
  buildBetaRunnable: (deps: CfToolDeps) => BetaRunnableTool | null;
}

// Schemas the registry uses for the workspace-aware Isolate variants of
// the two image-producing tools. The agent payload uses these too so
// the model sees the `path` field in its catalog.
const cfScreenshotIsolateSchema = cfScreenshotCoreSchema.extend({
  path: z
    .string()
    .optional()
    .describe("Workspace path to save the PNG. Defaults to /screenshot.png."),
});
const cfImageGenerateIsolateSchema = cfImageGenerateCoreSchema.extend({
  path: z
    .string()
    .optional()
    .describe("Workspace path to save the PNG. Defaults to /image.png."),
});

// ---------------------------------------------------------------------------
// CF_TOOL_DEFS — single source of truth for every cf_* tool.
// ---------------------------------------------------------------------------
//
// One entry per tool. Both backends read from this array:
//
//   - The IsolateRunner DO (`buildCfTools` with a Workspace) builds a
//     BetaRunnableTool per entry and registers it with the SDK's
//     custom-tool dispatcher running inside the DO.
//   - The Sandbox DO (also `buildCfTools`, but with `workspace:
//     undefined`) builds the same BetaRunnableTools and registers them
//     with its own custom-tool dispatcher — also running inside the
//     DO, parallel to `ant beta:worker run` in the container. The
//     dispatcher polls Anthropic for `agent.custom_tool_use` events
//     and answers them directly with `env` access; the container
//     never participates in custom-tool dispatch.
//   - The Anthropic agent payload builder (`src/tools/schemas.ts`)
//     reads each entry's `agentDescription` / `agentInputSchema` (or
//     the `agentDescriptionMicrovm` / `agentInputSchemaMicrovm`
//     overrides for tools whose wire shape differs between backends,
//     like `screenshot` and `image_generate` which only carry a
//     workspace `path` on Isolate). The catalog sent to /v1/agents
//     therefore can't drift from what the dispatcher actually
//     registers.
//
// Adding a new cf_* tool: write the schemas and run functions in the
// matching group file (browser / ai / vpc / email) and add an entry
// here. Nothing else in this Worker needs to change.

// Order is preserved in the agent payload so the model sees the cf_*
// family in a consistent sequence on both backends.
export const CF_TOOL_DEFS: readonly CfToolEntry[] = [
  // -------- Browser Rendering --------
  {
    name: "cf_web_fetch",
    requires: "browser-rendering",
    agentDescription: cfWebFetchDescription,
    agentInputSchema: cfWebFetchSchema,
    buildBetaRunnable: (deps) =>
      browserRenderingDeps(deps.env)
        ? betaZodTool({
            name: "cf_web_fetch",
            description: cfWebFetchDescription,
            inputSchema: cfWebFetchSchema,
            run: (input) => runCfWebFetch(input, deps.env),
          })
        : null,
  },
  {
    name: "fetch_to_markdown",
    requires: "browser-rendering",
    agentDescription: cfFetchMarkdownDescription,
    agentInputSchema: cfFetchMarkdownSchema,
    buildBetaRunnable: (deps) =>
      browserRenderingDeps(deps.env)
        ? betaZodTool({
            name: "fetch_to_markdown",
            description: cfFetchMarkdownDescription,
            inputSchema: cfFetchMarkdownSchema,
            run: (input) => runCfFetchMarkdown(input, deps.env),
          })
        : null,
  },
  {
    name: "browse",
    requires: "browser-rendering",
    agentDescription: cfBrowseDescription,
    agentInputSchema: cfBrowseSchema,
    buildBetaRunnable: (deps) =>
      browserRenderingDeps(deps.env)
        ? betaZodTool({
            name: "browse",
            description: cfBrowseDescription,
            inputSchema: cfBrowseSchema,
            run: (input) => runCfBrowse(input, deps.env),
          })
        : null,
  },
  {
    name: "screenshot",
    requires: "browser-rendering",
    // Isolate-flavoured catalog description — references the workspace path.
    agentDescription:
      "Take a PNG screenshot of a URL using Cloudflare Browser Rendering. The image is saved to the workspace at the path you supply (default `/screenshot.png`); returns the saved path and byte count. Use this when the user asks you to grab a screenshot of a website.",
    agentInputSchema: cfScreenshotIsolateSchema,
    // Sandbox-flavoured catalog description — no workspace path, image
    // returns inline as a content block. Save with the container's
    // `write` tool if you want to persist it under /workspace.
    agentDescriptionMicrovm:
      "Take a PNG screenshot of a URL using Cloudflare Browser Rendering. Returns the image as a content block — save it to disk with your `write` tool if you want to persist it under /workspace.",
    agentInputSchemaMicrovm: cfScreenshotCoreSchema,
    buildBetaRunnable: (deps) => {
      if (!browserRenderingDeps(deps.env)) return null;
      const hasWorkspace = Boolean(deps.workspace);
      return betaZodTool({
        name: "screenshot",
        description: hasWorkspace
          ? "Take a PNG screenshot of a URL using Cloudflare Browser Rendering. The image is saved to the workspace at the path you supply (default `/screenshot.png`); returns the saved path and byte count. Use this when the user asks you to grab a screenshot of a website."
          : "Take a PNG screenshot of a URL using Cloudflare Browser Rendering. Returns the image as a content block — save it to disk with your `write` tool if you want to persist it under /workspace.",
        inputSchema: hasWorkspace
          ? cfScreenshotIsolateSchema
          : cfScreenshotCoreSchema,
        run: async (rawInput) => {
          try {
            // Isolate variant carries a `path`; Sandbox variant does not.
            // Cast to the wider Isolate shape and read `path` defensively.
            const { path, ...input } = rawInput as CfScreenshotCoreInput & {
              path?: string;
            };
            const result = await captureCfScreenshotBytes(input, deps.env);
            if (typeof result === "string") return result;
            const mime = detectImageMime(result);
            if (deps.workspace) {
              const dest = ensureAbsolute(path ?? "/screenshot.png");
              // Workspace expects UTF-8 strings. Encode binary as base64 + a
              // `data:` URL sentinel so downstream tools (or the model) can
              // decode it and so `cf_read` round-trips bytes unchanged.
              const dataUrl = `data:${mime};base64,${bytesToBase64(result)}`;
              await deps.workspace.writeFile(dest, dataUrl);
              return `saved ${result.byteLength} bytes to ${dest} (${mime}; data URL — read with cf_read or pass into another tool)`;
            }
            // Sandbox: return inline content blocks. The custom-dispatch
            // result encoder passes `image`/`document` blocks through
            // unchanged, so the model receives the PNG bytes directly.
            return [
              {
                type: "text",
                text: `captured ${result.byteLength} bytes (${mime})`,
              },
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: mime,
                  data: bytesToBase64(result),
                },
              },
            ] as unknown as string;
          } catch (error) {
            return formatErr(error);
          }
        },
      });
    },
  },

  // -------- Workers AI --------
  {
    name: "image_generate",
    requires: "workers-ai",
    agentDescription:
      "Generate an image from a text prompt using Cloudflare Workers AI (FLUX.2 [dev] by default). The image is saved to the workspace at the path you provide (default `/image.png`); returns the saved path and byte count.",
    agentInputSchema: cfImageGenerateIsolateSchema,
    agentDescriptionMicrovm:
      "Generate an image from a text prompt using Cloudflare Workers AI (FLUX.2 [dev] by default). Returns the image as a content block — save it to disk with your `write` tool if you want to persist it under /workspace.",
    agentInputSchemaMicrovm: cfImageGenerateCoreSchema,
    buildBetaRunnable: (deps) => {
      const resolved = resolveCfImageModel(deps.env);
      if (!resolved) return null;
      const { model } = resolved;
      const hasWorkspace = Boolean(deps.workspace);
      return betaZodTool({
        name: "image_generate",
        description: hasWorkspace
          ? `Generate an image from a text prompt using Cloudflare Workers AI (${model}). The PNG is saved to the workspace at the path you provide (default \`/image.png\`); returns the saved path and byte count.`
          : `Generate an image from a text prompt using Cloudflare Workers AI (${model}). Returns the image as a content block — save it to disk with your \`write\` tool if you want to persist it under /workspace.`,
        inputSchema: hasWorkspace
          ? cfImageGenerateIsolateSchema
          : cfImageGenerateCoreSchema,
        run: async (rawInput) => {
          try {
            const { path, ...input } = rawInput as CfImageGenerateCoreInput & {
              path?: string;
            };
            const result = await generateCfImageBytes(input, deps.env);
            if (typeof result === "string") return result;
            const mime = detectImageMime(result.bytes);
            if (deps.workspace) {
              // FLUX.2 returns PNG; FLUX 1 Schnell returns JPEG. Pick the
              // path extension off the detected mime so files end up with
              // sensible names even when the user didn't specify one.
              const defaultName =
                mime === "image/jpeg" ? "/image.jpg" : "/image.png";
              const dest = ensureAbsolute(path ?? defaultName);
              const dataUrl = `data:${mime};base64,${bytesToBase64(result.bytes)}`;
              await deps.workspace.writeFile(dest, dataUrl);
              return `generated ${result.bytes.byteLength} bytes (${mime}, model=${result.model}) and saved to ${dest}`;
            }
            // Sandbox: return inline content blocks.
            return [
              {
                type: "text",
                text: `generated ${result.bytes.byteLength} bytes (${mime}, model=${result.model})`,
              },
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: mime,
                  data: bytesToBase64(result.bytes),
                },
              },
            ] as unknown as string;
          } catch (error) {
            return formatErr(error);
          }
        },
      });
    },
  },

  // -------- VPC service call --------
  {
    name: "call_service",
    requires: "vpc",
    agentDescription:
      "Call a private VPC service exposed to this Worker via a binding. Use when the user asks you to talk to an internal API that isn't on the public internet. Returns { status, headers, body } as JSON.",
    // Agent payload uses a generic `binding: z.string()` because the enum
    // would only narrow correctly per-env, and the agent payload is built
    // before the model picks a binding. Runtime validates against the
    // live set via the per-call factory below.
    agentInputSchema: z.object({
      binding: z.string(),
      path: z.string(),
      method: z
        .enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"])
        .default("GET"),
      headers: z.record(z.string(), z.string()).optional(),
      body: z.string().optional(),
    }),
    buildBetaRunnable: (deps) => {
      const built = buildCfCallServiceSchema(deps.env);
      if (!built) return null;
      return betaZodTool({
        name: "call_service",
        description: built.description,
        inputSchema: built.schema,
        run: (input) => runCfCallService(input, deps.env),
      });
    },
  },

  // -------- Email --------
  //
  // Email tools read `sessionId` from the runtime (the DO knows which
  // session it's bound to) — the model never sees a session_id input.
  // Same on both backends now that we route everything through a
  // BetaRunnableTool.
  {
    name: "email_send",
    requires: "email",
    agentDescription:
      "Send an email through Cloudflare Email Routing. The destination must be a verified address on your zone. Replies route back into this same session via the Message-ID we stamp on the outbound — read them with email_inbox / email_read.",
    agentInputSchema: cfEmailSendCoreSchema,
    buildBetaRunnable: (deps) => {
      if (!deps.env.SEND_EMAIL) return null;
      return betaZodTool({
        name: "email_send",
        description:
          "Send an email through Cloudflare Email Routing. The destination must be a verified address on your zone (configure verified destinations in the Cloudflare dashboard → Email Routing → Destination addresses). The From: address defaults to this agent's public inbox; replies land back in this session automatically and are readable via email_inbox.",
        inputSchema: cfEmailSendCoreSchema,
        run: (input) =>
          runCfEmailSend({ ...input, sessionId: deps.sessionId }, deps.env),
      });
    },
  },
  {
    name: "email_inbox",
    requires: "email",
    agentDescription:
      "List recent emails delivered to this session's inbox. Returns up to 25 messages, newest first, with id / from / subject / received timestamp.",
    agentInputSchema: cfEmailInboxCoreSchema,
    buildBetaRunnable: (deps) => {
      if (!deps.env.DB) return null;
      return betaZodTool({
        name: "email_inbox",
        description:
          "List recent emails delivered to this session's inbox. Returns up to 25 messages, newest first, with id / from / subject / received timestamp. Use email_read to fetch a message body. The response includes this agent's public inbox address when EMAIL_DOMAIN is configured.",
        inputSchema: cfEmailInboxCoreSchema,
        run: (input) =>
          runCfEmailInbox({ ...input, sessionId: deps.sessionId }, deps.env),
      });
    },
  },
  {
    name: "email_read",
    requires: "email",
    agentDescription:
      "Read the full body of a single email by id (use email_inbox to list ids).",
    agentInputSchema: cfEmailReadCoreSchema,
    buildBetaRunnable: (deps) => {
      if (!deps.env.DB) return null;
      return betaZodTool({
        name: "email_read",
        description:
          "Read the full body of a single email by id (use email_inbox to list ids). Returns plain-text body when present, HTML body otherwise; both are truncated at 200 KB.",
        inputSchema: cfEmailReadCoreSchema,
        run: (input) =>
          runCfEmailRead({ ...input, sessionId: deps.sessionId }, deps.env),
      });
    },
  },
];

// ---------------------------------------------------------------------------
// Public facades — used by runner.ts and the Sandbox DO custom-tool
// dispatcher.
// ---------------------------------------------------------------------------

export interface CfToolGroup {
  // Whether to even attempt registration — false when the relevant
  // binding/secret is missing. Used by the control plane to skip work cheaply.
  enabled: boolean;
  // Names of the tools this group exposes (always returned, even when
  // disabled, so the schema layer can advertise them consistently).
  names: string[];
}

// Group tool names by `requires` tag and report which groups are
// available on this env. Used by the control plane's drift detection so a
// mid-session binding change forces a dispatcher restart. Derived from
// CF_TOOL_DEFS — adding a new entry above is enough to surface it here.
export function cfToolGroups(env: Env): {
  browser: CfToolGroup;
  ai: CfToolGroup;
  vpc: CfToolGroup;
  email: CfToolGroup;
  custom: CfToolGroup;
} {
  const byTag = new Map<CfRequires, string[]>();
  for (const def of CF_TOOL_DEFS) {
    const list = byTag.get(def.requires) ?? [];
    list.push(def.name);
    byTag.set(def.requires, list);
  }
  const group = (tag: CfRequires): CfToolGroup => ({
    enabled: evaluateCfRequires(tag, env),
    names: byTag.get(tag) ?? [],
  });
  const customNames = enabledCustomToolNames(CUSTOM_TOOLS, env);
  return {
    browser: group("browser-rendering"),
    ai: group("workers-ai"),
    vpc: group("vpc"),
    email: group("email"),
    custom: {
      enabled: customNames.length > 0,
      names: customNames,
    },
  };
}

// Build every available cf_* tool plus enabled user-defined custom
// tools, in registry order. Each entry's `buildBetaRunnable` decides
// whether the specific binding is present — registry-level gating is
// coarse and may still register a no-op for sibling tools (e.g.
// email_read when only SEND_EMAIL is set), so we let the per-tool
// factory have the final say.
export function buildCfTools(deps: CfToolDeps): BetaRunnableTool[] {
  const tools: BetaRunnableTool[] = [];
  for (const def of CF_TOOL_DEFS) {
    if (!evaluateCfRequires(def.requires, deps.env)) continue;
    const tool = def.buildBetaRunnable(deps);
    if (tool) tools.push(tool);
  }
  for (const custom of CUSTOM_TOOLS) {
    if (isCustomToolEnabled(custom, deps.env)) {
      tools.push(customToolToBetaRunnable(custom, deps.env));
    }
  }
  return tools;
}
