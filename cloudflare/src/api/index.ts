function getSessionSandbox(_env: unknown, _id: string): any { return null; }
function getContainerStatus(_id: string, _env: unknown): any { return null; }
import { Hono, type Context } from "hono";
import { anthropic, resolveAnthropicBaseURL } from "../anthropic";
import {
  isAgentId,
  isPolicyId,
  isSecretKey,
  isSessionId,
  parsePositiveInt,
} from "../helpers";
// microvm removed — Alfred is isolate-only
import { getIsolateRunner } from "../isolate/runner";
import { ISOLATE_SYSTEM_PROMPT } from "../isolate/system-prompt";
import { isolateCapabilitiesFromEnv } from "../tools/schemas";
import { CF_TOOL_DEFS, evaluateCfRequires } from "../tools/cf";
import { ISOLATE_TOOL_REGISTRY } from "../tools/tool-registry";
import {
  defaultDisableUnspecifiedServerTools,
  transformAgentToolsForBackend,
} from "../isolate/agent-payload";
const MICROVM_SYSTEM_PROMPT = "";
import { CUSTOM_TOOLS } from "../tools/custom-tools";
import { isCustomToolEnabled } from "../tools/custom-tools-runtime";
import { drainWork, resolveBackend } from "../webhooks";
import {
  deleteAllWebhookEvents,
  deleteAgentBackend,
  getAgentBackend,
  getWebhookEvent,
  hasMicrovmFootprint,
  listAgentBackends,
  listSessionBackends,
  listSessions,
  listWebhookEvents,
  recordSessionAgent,
  setAgentBackend,
  type AgentBackend,
} from "../storage";
import {
  deletePolicy as deleteEgressPolicy,
  getPolicy as getEgressPolicy,
  listKnownDataFields,
  listPolicies as listEgressPolicies,
  savePolicy as saveEgressPolicy,
} from "../egress/store";
import type { EgressPolicy, EgressRule } from "../egress/types";
// VPC bindings are read from a generated module produced by
// `scripts/sync-vpc-bindings.mjs` at build time. The script reads
// wrangler.jsonc directly so users only declare bindings in one place.
import { VPC_BINDINGS } from "../vpc.generated";
import { buildOpenApiSpec } from "./openapi";

// ID-shape validators live in `src/helpers.ts`. Aliased locally so the
// hundred-or-so call sites that read `assertSessionId(id)` stay
// untouched.
const assertSessionId = isSessionId;
const assertAgentId = isAgentId;
const assertSecretKey = isSecretKey;
const assertPolicyId = isPolicyId;

// Lightweight status read for Isolate-Sandbox sessions. We don't have a
// container lifecycle to query (sandbox.getState()), so we ask the DO
// whether its dispatcher is currently live. The DO is durable so a stub
// always returns; "stopped" just means no active poll loop.
async function getIsolateRunnerStatus(env: Env, sessionId: string): Promise<string> {
  try {
    return await getIsolateRunner(env, sessionId).getStatus();
  } catch (error) {
    console.warn(
      `[status] failed to read isolate runner state for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return "unknown";
  }
}

// Pull the backend choice out of an incoming agent payload. The frontend
// sends `backend: "microvm" | "isolate"` alongside the standard agent
// fields; we strip it before forwarding to Anthropic so it doesn't reject
// unknown keys, and persist it locally keyed by agent id once the
// upstream call returns.
function takeBackend(body: unknown): AgentBackend | null {
  if (!body || typeof body !== "object") return null;
  const raw = (body as Record<string, unknown>).backend;
  delete (body as Record<string, unknown>).backend;
  if (raw === "isolate" || raw === "microvm") return raw;
  return null;
}

// Read agent.id from a JSON body returned by the upstream API. We avoid
// throwing — if Anthropic returns an error response we won't have an id and
// the backend write is silently skipped.
function readAgentId(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const id = (body as Record<string, unknown>).id;
  return typeof id === "string" && id.startsWith("agent_") ? id : null;
}

// Persist the backend mapping for an upstream agent response. Used by
// the create path where the agent id only becomes known once Anthropic
// returns. Reads the JSON body off a clone so the original Response is
// still streamable to the caller.
//
// Returns true when the row was written, false otherwise. The create
// handler escalates a failure here into a 500 so a frontend "Isolate"
// pick can't silently land as a MicroVM-dispatched agent — that was
// exactly the trap that caused `cf_write not found` errors before this
// fix.
async function persistBackendFromResponse(
  res: Response,
  db: D1Database,
  backend: AgentBackend,
): Promise<{ persisted: boolean; agentId: string | null; error?: string }> {
  // 4xx/5xx responses don't echo an agent id; skip the parse rather
  // than failing on non-JSON error bodies.
  if (!res.ok) return { persisted: false, agentId: null };
  let payload: unknown;
  try {
    payload = await res.clone().json();
  } catch (error) {
    return {
      persisted: false,
      agentId: null,
      error: `upstream agent created but response body was not JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const agentId = readAgentId(payload);
  if (!agentId) {
    return {
      persisted: false,
      agentId: null,
      error: "upstream agent created but response had no agent id",
    };
  }
  try {
    await setAgentBackend(db, agentId, backend);
    return { persisted: true, agentId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[api] failed to persist backend=${backend} for agent=${agentId}: ${message}`,
    );
    return { persisted: false, agentId, error: message };
  }
}

// Persist the backend mapping when the agent id is already known (the
// update path). No body parsing needed — the caller knows the id from
// the URL.
async function persistBackendForAgent(
  db: D1Database,
  agentId: string,
  backend: AgentBackend,
): Promise<void> {
  try {
    await setAgentBackend(db, agentId, backend);
  } catch (error) {
    console.warn(
      `[api] failed to persist backend=${backend} for agent=${agentId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// Allowed operator strings on an ApplyTo matcher. Kept in sync with the
// type union in `src/egress/types.ts`. Centralised here so the wire
// validator and the matcher both reject the same set.
const MATCHER_OPERATORS = ["equals", "contains", "matches", "is-one-of"] as const;
type MatcherOperator = (typeof MATCHER_OPERATORS)[number];
const isMatcherOperator = (v: unknown): v is MatcherOperator =>
  typeof v === "string" && (MATCHER_OPERATORS as readonly string[]).includes(v);

function validatePolicy(input: unknown): EgressPolicy | string {
  if (!input || typeof input !== "object") return "invalid policy body";
  const p = input as Record<string, unknown>;
  if (typeof p.id !== "string" || !assertPolicyId(p.id)) return "invalid policy id";
  if (typeof p.name !== "string" || p.name.trim().length === 0) return "policy name required";
  if (!Array.isArray(p.egressRules)) return "egressRules must be array";
  if (!Array.isArray(p.applyTo)) return "applyTo must be array";
  // `sessionIds` is legacy; tolerate missing/empty arrays so the form can
  // omit it entirely.
  if (p.sessionIds !== undefined && !Array.isArray(p.sessionIds)) {
    return "sessionIds must be array";
  }
  if (p.appliesToAll !== undefined && typeof p.appliesToAll !== "boolean") {
    return "appliesToAll must be boolean";
  }
  // appliesToAll is mutually exclusive with applyTo matchers. The UI
  // enforces this; mirror it on the wire so a buggy client can't ship a
  // contradictory policy.
  if (p.appliesToAll === true && (p.applyTo as unknown[]).length > 0) {
    return "appliesToAll and applyTo cannot both be set";
  }

  // Each `applyTo` matcher must be actionable. The matcher layer drops
  // empty matchers defensively (`src/egress/match.ts` matcherIsActionable),
  // but rejecting on save keeps the policy list from filling up with
  // blank-row policies the editor seeds by default. Without this guard a
  // half-filled save shape — the editor ships
  // `{field: "", operator: "equals", value: ""}` — would persist and
  // either be silently dropped at match time or, on older builds, match
  // every session.
  for (let i = 0; i < (p.applyTo as unknown[]).length; i++) {
    const m = (p.applyTo as unknown[])[i] as Record<string, unknown>;
    if (!m || typeof m !== "object") return `applyTo[${i}] is not an object`;
    if (typeof m.field !== "string" || m.field.trim().length === 0) {
      return `applyTo[${i}].field must be a non-empty string`;
    }
    if (!isMatcherOperator(m.operator)) {
      return `applyTo[${i}].operator must be one of ${MATCHER_OPERATORS.join(", ")}`;
    }
    if (m.operator === "is-one-of") {
      if (!Array.isArray(m.values) || m.values.length === 0) {
        return `applyTo[${i}].values must be a non-empty array for is-one-of`;
      }
      if (!m.values.every((v) => typeof v === "string" && v.length > 0)) {
        return `applyTo[${i}].values entries must be non-empty strings`;
      }
    } else {
      if (typeof m.value !== "string" || m.value.length === 0) {
        return `applyTo[${i}].value must be a non-empty string for ${m.operator}`;
      }
      if (m.operator === "matches") {
        try {
          new RegExp(m.value);
        } catch (e) {
          return `applyTo[${i}].value is not a valid regex: ${
            e instanceof Error ? e.message : String(e)
          }`;
        }
      }
    }
  }

  // Shallow validation of rule shapes — full type-checking happens at runtime
  // when handlers consume them.
  for (const r of p.egressRules as EgressRule[]) {
    if (!r || typeof r !== "object" || typeof r.type !== "string") return "invalid rule";
  }
  return p as unknown as EgressPolicy;
}

export function createApiApp() {
  const app = new Hono<{ Bindings: Env }>();

  app.get("/api/secrets", async (c) => {
    const cursor = c.req.query("cursor") || undefined;
    const limit = parsePositiveInt(c.req.query("limit"), 100, 1, 1000);
    const list = await c.env.SECRETS.list<{ updatedAt?: string }>({
      prefix: "secret:",
      cursor,
      limit,
    });

    const items = list.keys.map((key) => ({
      key: key.name.slice("secret:".length),
      updatedAt: key.metadata?.updatedAt || null,
    }));

    return c.json({
      items,
      cursor: list.list_complete ? null : list.cursor,
      hasMore: !list.list_complete,
    });
  });

  app.get("/api/secrets/:key", async (c) => {
    const key = c.req.param("key");
    if (!assertSecretKey(key)) {
      return c.json({ error: "invalid secret key" }, 400);
    }

    const value = await c.env.SECRETS.get(`secret:${key}`, "text");
    if (value === null) {
      return c.json({ error: "secret not found" }, 404);
    }

    return c.json({ key, value });
  });

  app.put("/api/secrets/:key", async (c) => {
    const key = c.req.param("key");
    if (!assertSecretKey(key)) {
      return c.json({ error: "invalid secret key" }, 400);
    }

    const body = await c.req.json<{ value?: string }>();
    if (typeof body.value !== "string" || body.value.length === 0) {
      return c.json({ error: "value must be a non-empty string" }, 400);
    }

    await c.env.SECRETS.put(`secret:${key}`, body.value, {
      metadata: { updatedAt: new Date().toISOString() },
    });

    return c.json({ key, status: "saved" });
  });

  app.delete("/api/secrets/:key", async (c) => {
    const key = c.req.param("key");
    if (!assertSecretKey(key)) {
      return c.json({ error: "invalid secret key" }, 400);
    }

    await c.env.SECRETS.delete(`secret:${key}`);
    return c.json({ key, status: "deleted" });
  });

  app.get("/api/environments", async (c) => {
    const page = parsePositiveInt(c.req.query("page"), 1, 1, Number.MAX_SAFE_INTEGER);
    const limit = parsePositiveInt(c.req.query("limit"), 20, 1, 100);

    const { items, total } = await listSessions(c.env.DB, page, limit);

    const augmented = await Promise.all(
      items.map(async (session) => {
        const { backend } = await resolveBackend(c.env, session.sessionId);
        const containerStatus =
          backend === "isolate"
            ? await getIsolateRunnerStatus(c.env, session.sessionId)
            : await getContainerStatus(session.sessionId, c.env);
        return { ...session, backend, containerStatus };
      }),
    );

    return c.json({
      items: augmented,
      total,
      page,
      limit,
      pages: Math.max(1, Math.ceil(total / limit)),
    });
  });

  // Manual drain trigger — useful for catching any pending work without waiting
  // for the next webhook delivery.
  app.post("/api/environments/drain", async (c) => {
    const spawned = await drainWork(c.env);
    return c.json({ status: "ok", spawned });
  });

  app.post("/api/environments/:sessionId/stop", async (c) => {
    const sessionId = c.req.param("sessionId");
    if (!assertSessionId(sessionId)) {
      return c.json({ error: "invalid session id" }, 400);
    }

    const { backend } = await resolveBackend(c.env, sessionId);

    try {
      if (backend === "isolate") {
        await getIsolateRunner(c.env, sessionId).stop();
      } else {
        const stub = getSessionSandbox(c.env, sessionId);
        // Snapshot /workspace before destroying. Best-effort; the helper
        // logs and swallows any error so a snapshot failure can't block a
        // stop. Mirrors the auto-snapshot in onActivityExpired so manual
        // and idle stops produce the same restore behaviour next boot.
        try {
          await stub.snapshot();
        } catch (error) {
          console.warn(
            `[api] manual-stop snapshot threw for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        await stub.destroy();
      }
    } catch {
      // already gone
    }

    return c.json({ sessionId, backend, status: "stopped" });
  });

  // Run a one-off shell command inside a sandbox. Used by the dashboard's
  // terminal and as a debugging hook. Isolate-Sandbox sessions have no
  // shell, so we hard-reject with a clear message instead of silently
  // 500ing.
  app.post("/api/environments/:sessionId/exec", async (c) => {
    const sessionId = c.req.param("sessionId");
    if (!assertSessionId(sessionId)) {
      return c.json({ error: "invalid session id" }, 400);
    }
    const body = await c.req.json<{ command?: string }>();
    if (typeof body.command !== "string" || !body.command) {
      return c.json({ error: "command is required" }, 400);
    }
    const { backend } = await resolveBackend(c.env, sessionId);
    if (backend === "isolate") {
      return c.json(
        {
          error:
            "exec not available — this session uses an Isolate Sandbox (no shell). Use the workspace tools instead.",
          backend,
        },
        409,
      );
    }
    try {
      const stub = getSessionSandbox(c.env, sessionId);
      // Block /exec until the container is booted and the latest
      // /workspace snapshot has been restored. Mirrors the PTY
      // upgrade and webhook dispatch paths — any caller that "turns
      // on" the sandbox sees a hydrated workspace, never an empty one
      // that gets overwritten mid-restore.
      await stub.ensureStarted();
      const result = await stub.exec(body.command, { timeout: 15000 });
      return c.json({
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  app.get("/api/environments/:sessionId/status", async (c) => {
    const sessionId = c.req.param("sessionId");
    if (!assertSessionId(sessionId)) {
      return c.json({ error: "invalid session id" }, 400);
    }

    const { backend } = await resolveBackend(c.env, sessionId);
    const containerStatus =
      backend === "isolate"
        ? await getIsolateRunnerStatus(c.env, sessionId)
        : await getContainerStatus(sessionId, c.env);
    return c.json({ sessionId, backend, containerStatus });
  });

  // Workspace browse endpoints (Isolate Sandbox only). MicroVM sessions get a
  // 409 mirroring how /exec rejects Isolate sessions — the affordance just
  // doesn't exist on the other backend. The workspace is SQLite-backed inside
  // the IsolateRunner DO; we proxy each call straight through the RPC stub.
  function isolateOnly(c: Context<{ Bindings: Env }>, backend: AgentBackend) {
    return c.json(
      {
        error:
          "workspace not available — this session uses a MicroVM Sandbox (container, not a workspace).",
        backend,
      },
      409,
    );
  }

  app.get("/api/environments/:sessionId/workspace", async (c) => {
    const sessionId = c.req.param("sessionId");
    if (!assertSessionId(sessionId)) {
      return c.json({ error: "invalid session id" }, 400);
    }
    const { backend } = await resolveBackend(c.env, sessionId);
    if (backend !== "isolate") return isolateOnly(c, backend);
    const path = c.req.query("path") || "/";
    const limit = parsePositiveInt(c.req.query("limit"), 500, 1, 1000);
    const offset = parsePositiveInt(c.req.query("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
    try {
      const entries = await getIsolateRunner(c.env, sessionId).readDir(path, { limit, offset });
      return c.json({ path, entries });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  app.get("/api/environments/:sessionId/workspace/file", async (c) => {
    const sessionId = c.req.param("sessionId");
    if (!assertSessionId(sessionId)) {
      return c.json({ error: "invalid session id" }, 400);
    }
    const { backend } = await resolveBackend(c.env, sessionId);
    if (backend !== "isolate") return isolateOnly(c, backend);
    const path = c.req.query("path");
    if (!path) return c.json({ error: "path query parameter is required" }, 400);
    try {
      const result = await getIsolateRunner(c.env, sessionId).readFile(path);
      if (!result) return c.json({ error: "file not found" }, 404);
      return c.json(result);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  app.get("/api/environments/:sessionId/workspace/info", async (c) => {
    const sessionId = c.req.param("sessionId");
    if (!assertSessionId(sessionId)) {
      return c.json({ error: "invalid session id" }, 400);
    }
    const { backend } = await resolveBackend(c.env, sessionId);
    if (backend !== "isolate") return isolateOnly(c, backend);
    try {
      const info = await getIsolateRunner(c.env, sessionId).getWorkspaceInfo();
      return c.json(info);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  app.get("/api/webhook-events", async (c) => {
    const limit = parsePositiveInt(c.req.query("limit"), 50, 1, 200);
    const cursor = c.req.query("cursor");
    const beforeMs = cursor ? Number.parseInt(cursor, 10) : null;

    const { items, nextCursor } = await listWebhookEvents(c.env.DB, beforeMs, limit);

    return c.json({
      items,
      cursor: nextCursor,
      hasMore: nextCursor !== null,
    });
  });

  app.delete("/api/webhook-events", async (c) => {
    const deleted = await deleteAllWebhookEvents(c.env.DB);
    return c.json({ deleted });
  });

  app.get("/api/webhook-events/:eventId", async (c) => {
    const eventId = c.req.param("eventId");
    const event = await getWebhookEvent(c.env.DB, eventId);
    if (!event) {
      return c.json({ error: "event not found" }, 404);
    }
    return c.json(event);
  });

  // Egress policies — stored in the EGRESS_POLICIES KV namespace and applied
  // by the Sandbox outbound handler at dispatch time.
  app.get("/api/egress-policies", async (c) => {
    const items = await listEgressPolicies(c.env);
    return c.json({ items });
  });

  // Auto-suggestions for the policy editor's "Apply to" matcher field.
  // Seeded with the standard webhook data attributes (id, organization_id,
  // workspace_id) and grown over time as new attributes show up on
  // delivered webhooks.
  app.get("/api/egress-policies/data-fields", async (c) => {
    const items = await listKnownDataFields(c.env);
    return c.json({ items });
  });

  app.get("/api/egress-policies/:id", async (c) => {
    const id = c.req.param("id");
    if (!assertPolicyId(id)) return c.json({ error: "invalid policy id" }, 400);
    const p = await getEgressPolicy(c.env, id);
    if (!p) return c.json({ error: "not found" }, 404);
    return c.json(p);
  });

  app.put("/api/egress-policies/:id", async (c) => {
    const id = c.req.param("id");
    if (!assertPolicyId(id)) return c.json({ error: "invalid policy id" }, 400);
    const body = await c.req.json();
    if (body && typeof body === "object") (body as Record<string, unknown>).id = id;
    const policy = validatePolicy(body);
    if (typeof policy === "string") return c.json({ error: policy }, 400);
    await saveEgressPolicy(c.env, policy);
    return c.json(policy);
  });

  app.delete("/api/egress-policies/:id", async (c) => {
    const id = c.req.param("id");
    if (!assertPolicyId(id)) return c.json({ error: "invalid policy id" }, 400);
    await deleteEgressPolicy(c.env, id);
    return c.json({ id, status: "deleted" });
  });

  // VPC + Mesh: list bindings declared in wrangler.jsonc. The
  // generated `vpc.generated.ts` module is the source of truth at
  // runtime — see scripts/sync-vpc-bindings.mjs for how it's produced.
  app.get("/api/vpc", (c) => {
    const items = VPC_BINDINGS;
    return c.json({
      items,
      docsUrl: "https://developers.cloudflare.com/workers-vpc/",
    });
  });

  // OpenAPI 3.1 document covering everything the Worker exposes — used
  // by the dashboard's API Reference view (Redoc), and discoverable by
  // CLI / agent tooling at the conventional root path `/openapi.json`
  // (handled in `src/index.ts`). We pass the request origin so the
  // rendered "Try it" panel hits the same deployment the docs are
  // loaded from. CORS is open so a browser-side agent (Claude
  // tool-use, GPT actions) can fetch the document cross-origin.
  app.get("/api/openapi.json", (c) => {
    const origin = (() => {
      try {
        return new URL(c.req.url).origin;
      } catch {
        return undefined;
      }
    })();
    const spec = buildOpenApiSpec(origin);
    return new Response(JSON.stringify(spec), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "public, max-age=300",
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, HEAD, OPTIONS",
      },
    });
  });

  app.get("/api/config", async (c) => {
    const required: Record<string, string | KVNamespace | undefined> = {
      ANTHROPIC_ENVIRONMENT_KEY: c.env.ANTHROPIC_ENVIRONMENT_KEY,
      ANTHROPIC_API_KEY: c.env.ANTHROPIC_API_KEY,
      ENVIRONMENT_ID: c.env.ENVIRONMENT_ID,
      WEBHOOK_SECRET: c.env.WEBHOOK_SECRET,
    };

    const missing = Object.entries(required)
      .filter(([, value]) => !value)
      .map(([key]) => key);

    // Capability flags reflect which optional bindings / secrets are
    // wired up. The dashboard uses them to render targeted warnings
    // (e.g. "snapshots disabled") and to gate tool-checkbox UI in the
    // agent form. Keep this field small — anything bigger belongs on
    // its own endpoint.
    const env = c.env;
    const hasR2Binding = typeof env.BACKUP_BUCKET === "object" && env.BACKUP_BUCKET !== null;
    const hasR2Credentials = Boolean(
      (env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY) ||
        (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY),
    );
    // Lets the dashboard skip the "snapshots disabled" warning for
    // Isolate-only deployments where BACKUP_BUCKET is genuinely
    // optional. Considers both the agent_backends table and the
    // sessions table: a session row with backend='microvm' (or NULL,
    // which is the default read) is hard evidence that the operator
    // is running the MicroVM path. A failure here is non-fatal —
    // falling back to `true` keeps the legacy behaviour (always warn)
    // intact.
    let hasMicrovmAgents = true;
    try {
      hasMicrovmAgents = await hasMicrovmFootprint(c.env.DB);
    } catch (error) {
      console.warn(
        `[api] failed to compute microvm footprint for capabilities: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const capabilities = {
      // MicroVM snapshots require the BACKUP_BUCKET R2 binding. In
      // local dev that's enough (localBucket mode); in production the
      // SDK presigns URLs and additionally needs the four R2 secrets.
      snapshots: hasR2Binding,
      snapshotsMode: hasR2Binding
        ? hasR2Credentials
          ? ("presigned" as const)
          : ("localBucket" as const)
        : ("disabled" as const),
      browserRendering: Boolean(env.BROWSER) || Boolean(env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_ACCOUNT_ID),
      workersAi: Boolean(env.AI),
      emailSend: Boolean(env.SEND_EMAIL),
      emailInbox: Boolean(env.DB && env.EMAIL_DOMAIN),
      // True when at least one persisted agent uses the MicroVM
      // backend (or no agents exist yet — `microvm` is the default).
      // Lets the dashboard skip the snapshots banner on Isolate-only
      // deployments where R2 isn't needed.
      hasMicrovmAgents,
    };

    // Public-facing pointer to the OpenAPI document. Agents / CLIs that
    // hit /api/config first to discover the deployment can follow this
    // straight to the spec. Both URLs return the same payload — the
    // root alias exists for tooling that probes the conventional path.
    const origin = (() => {
      try {
        return new URL(c.req.url).origin;
      } catch {
        return null;
      }
    })();
    const openapi = origin
      ? {
          json: `${origin}/openapi.json`,
          legacy: `${origin}/api/openapi.json`,
          reference: `${origin}/redoc.html`,
        }
      : null;

    return c.json({
      environmentId: c.env.ENVIRONMENT_ID || null,
      anthropicBaseURL: resolveAnthropicBaseURL(c.env),
      missing,
      capabilities,
      openapi,
    });
  });

  // Isolate-specific defaults the frontend pre-fills when the user picks
  // the Isolate backend in the agent form. Single source of truth lives
  // in src/isolate/system-prompt.ts so the system prompt and the
  // codemode tool description stay aligned.
  app.get("/api/isolate/defaults", (c) => {
    return c.json({ systemPrompt: ISOLATE_SYSTEM_PROMPT });
  });

  // MicroVM-specific defaults — single source of truth in
  // src/microvm-prompt.ts. The form fetches this when the user picks
  // MicroVM and offers an "Include MicroVM defaults" checkbox that
  // mirrors the Isolate path.
  app.get("/api/microvm/defaults", (c) => {
    return c.json({ systemPrompt: MICROVM_SYSTEM_PROMPT });
  });

  // User-defined custom tools from src/tools/custom-tools.ts. The agent form
  // fetches this so user-added tools show up in the toggle list
  // automatically — no frontend code edit required to register a new
  // tool. `available` reflects the tool's `requires` predicate against
  // the live env; tools that don't pass the gate render disabled in
  // the UI with a "binding not configured" tooltip.
  //
  // Kept for backwards compatibility — `/api/tool-catalog` below
  // returns the same data plus the rest of the catalog in one round
  // trip. Older dashboards may still pull this endpoint.
  app.get("/api/custom-tools", (c) => {
    const tools = CUSTOM_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      available: isCustomToolEnabled(t, c.env),
    }));
    return c.json({ tools });
  });

  // Full agent tool catalog. The dashboard reads this once per agent
  // form render and uses the data to build the checkbox grid for both
  // backends — no hand-maintained list in the frontend, so adding a
  // new cf_* tool or user-defined custom tool surfaces in the UI
  // automatically on the next deploy.
  //
  // Each entry carries:
  //   - `name`        the wire name sent to Anthropic (the cf_-prefixed
  //                   form for our tools).
  //   - `displayName` the prefix-stripped label used for checkboxes.
  //   - `description` the same short blurb the model sees in its
  //                   catalog. Falls through to the form's tooltip.
  //   - `available`   true when the tool's binding/requires predicate
  //                   passes against the deployed env. False entries
  //                   still render in the UI (disabled with a hint).
  //
  // The catalog is grouped by where the tool runs:
  //   - `microvmStock` — `bash` / `edit` / `read` / `write` / `glob` /
  //     `grep`. Owned by the SDK's in-container dispatcher.
  //   - `serverSide` — `web_fetch` / `web_search`. Run on Anthropic
  //     infrastructure; bypass the egress policy.
  //   - `isolateWorkspace` — workspace tools from `src/tools/tool-registry.ts`.
  //   - `isolatePower` — `execute` / `run_file` / browser tools.
  //   - `cfTools` — binding-backed tools shared across both backends.
  //   - `custom` — user-defined tools from `src/tools/custom-tools.ts`.
  app.get("/api/tool-catalog", (c) => {
    const env = c.env;
    // `displayName` mirrors the wire `name` 1:1. We used to strip a
    // `cf_` prefix here for nicer UI labels, but it caused a slow trap:
    // an operator saw `read` in the catalog while the system prompt
    // (and the model) used `cf_read`. The dashboard now shows the wire
    // name verbatim so what's checked is exactly what the agent calls.
    const cfDeps = isolateCapabilitiesFromEnv(env);
    // VPC availability isn't computed by isolateCapabilitiesFromEnv
    // (it's not a single binding). Reuse the same lookup the cf-tools
    // factories use so the catalog reflects what would actually
    // register at runtime.
    const cfAvailable = (req: typeof CF_TOOL_DEFS[number]["requires"]) =>
      evaluateCfRequires(req, env);
    void cfDeps;

    return c.json({
      microvmStock: [
        { name: "bash", displayName: "bash", description: "Execute shell commands." },
        { name: "edit", displayName: "edit", description: "String replacement in files." },
        { name: "read", displayName: "read", description: "Read files, images, PDFs, notebooks." },
        { name: "write", displayName: "write", description: "Write files to the filesystem." },
        { name: "glob", displayName: "glob", description: "File pattern matching." },
        { name: "grep", displayName: "grep", description: "Search file contents." },
      ],
      // Server-side tools execute on Anthropic infra and bypass the
      // egress policy entirely — the form surfaces a callout before
      // the checkboxes, and the worker safe-defaults them off when
      // an older client omits them.
      serverSide: [
        {
          name: "web_fetch",
          displayName: "web_fetch",
          description:
            "Fetch a URL on Anthropic infra. Prefer cf_web_fetch when configured — it routes through your account and respects your egress policy.",
        },
        {
          name: "web_search",
          displayName: "web_search",
          description:
            "Search the web from Anthropic infra. No Cloudflare-side equivalent today; enable only if you need it.",
        },
      ],
      isolateWorkspace: ISOLATE_TOOL_REGISTRY.filter((e) => !e.requires).map((e) => ({
        name: e.name,
        displayName: e.name,
        description: e.description,
      })),
      isolatePower: ISOLATE_TOOL_REGISTRY.filter((e) => e.requires).map((e) => ({
        name: e.name,
        displayName: e.name,
        description: e.description,
        requires: e.requires ?? null,
        available:
          e.requires === "loader"
            ? Boolean(env.LOADER)
            : e.requires === "loader+browser"
              ? Boolean(env.LOADER && env.BROWSER)
              : true,
        // Browser CDP tools (loader+browser) run by spinning up an
        // isolate via the parent Worker's LOADER binding, so they work
        // on MicroVM agents too — the Sandbox DO registers them in
        // src/microvm/sandbox.ts. `execute` / `run_file` (loader only)
        // are workspace-bound and stay Isolate-only.
        microvmEligible: e.requires === "loader+browser",
      })),
      cfTools: CF_TOOL_DEFS.map((def) => ({
        name: def.name,
        displayName: def.name,
        description: def.agentDescription,
        requires: def.requires,
        available: cfAvailable(def.requires),
      })),
      custom: CUSTOM_TOOLS.map((t) => ({
        name: t.name,
        displayName: t.name,
        description: t.description,
        available: isCustomToolEnabled(t, env),
      })),
    });
  });

  app.get("/api/agents", async (c) => {
    const limit = c.req.query("limit") || "100";
    // Read both in parallel — backend lookup is local D1 and shouldn't
    // serialise with the upstream listing.
    const [upstream, backends] = await Promise.all([
      anthropic(c.env, "GET", `/v1/agents?limit=${limit}`),
      listAgentBackends(c.env.DB).catch(() => new Map<string, AgentBackend>()),
    ]);
    if (!upstream.ok) return upstream;
    let payload: unknown;
    try {
      payload = await upstream.json();
    } catch {
      return upstream;
    }
    if (payload && typeof payload === "object" && Array.isArray((payload as Record<string, unknown>).data)) {
      const data = (payload as { data: unknown[] }).data;
      for (const item of data) {
        if (!item || typeof item !== "object") continue;
        const id = (item as Record<string, unknown>).id;
        if (typeof id !== "string") continue;
        (item as Record<string, unknown>).backend = backends.get(id) ?? "microvm";
      }
    }
    return c.json(payload);
  });

  // Per-agent backend choice (microvm vs isolate). Stored locally because
  // Anthropic's /v1/agents has no durable user-metadata field. The
  // dispatch path reads from this table to pick which DO to spin up.
  app.get("/api/agents/:agentId/backend", async (c) => {
    const agentId = c.req.param("agentId");
    if (!assertAgentId(agentId)) {
      return c.json({ error: "invalid agent id" }, 400);
    }
    const backend = await getAgentBackend(c.env.DB, agentId);
    return c.json({ agentId, backend });
  });

  app.post("/api/agents", async (c) => {
    const body = await c.req.json();
    const backend = takeBackend(body);
    // For Isolate backends, swap the MicroVM-Sandbox toolset wrapper for
    // custom tool definitions matching the dispatcher's registered
    // handlers. For MicroVM backends, additionally emit `type: "custom"`
    // entries for the cf_* + user-defined custom tools the user picked —
    // the Sandbox DO's dispatcher answers them with the Worker's bindings.
    // Without these, the agent definition either exposes the wrong tool
    // names or silently drops the cf_* family on container-based runs.
    const transformed = transformAgentToolsForBackend(body, backend, c.env);
    const sanitized = defaultDisableUnspecifiedServerTools(transformed);
    const res = await anthropic(c.env, "POST", "/v1/agents", sanitized);
    if (!backend) return res;
    const persistResult = await persistBackendFromResponse(
      res,
      c.env.DB,
      backend,
    );
    if (!persistResult.persisted && res.ok) {
      // Upstream agent exists but our backend mapping didn't land. Surfacing
      // this as a 500 keeps the frontend from cheerfully showing a "created"
      // toast for what is in practice a broken agent — dispatch would
      // default to MicroVM for an Isolate selection (and vice-versa).
      console.error(
        `[api] /api/agents created upstream agent but failed to persist backend=${backend}: ${persistResult.error ?? "(no error reported)"}`,
      );
      return c.json(
        {
          error: "agent_persist_failed",
          message:
            "The agent was created in Anthropic but its backend mapping could not be saved. Re-issue the request, or PUT /api/agents/<id> with the desired backend to repair.",
          agentId: persistResult.agentId,
          detail: persistResult.error,
        },
        500,
      );
    }
    return res;
  });

  app.get("/api/agents/:agentId", async (c) => {
    const agentId = c.req.param("agentId");
    if (!assertAgentId(agentId)) {
      return c.json({ error: "invalid agent id" }, 400);
    }
    const [upstream, backend] = await Promise.all([
      anthropic(c.env, "GET", `/v1/agents/${agentId}`),
      getAgentBackend(c.env.DB, agentId).catch(() => "microvm" as AgentBackend),
    ]);
    if (!upstream.ok) return upstream;
    try {
      const payload = (await upstream.json()) as Record<string, unknown>;
      payload.backend = backend;
      return c.json(payload);
    } catch {
      return upstream;
    }
  });

  app.post("/api/agents/:agentId", async (c) => {
    const agentId = c.req.param("agentId");
    if (!assertAgentId(agentId)) {
      return c.json({ error: "invalid agent id" }, 400);
    }
    const body = await c.req.json();
    const incomingBackend = takeBackend(body);
    // Update flows may omit the backend field (we strip it before forward),
    // so fall back to the persisted choice — otherwise an edit that just
    // changes the system prompt would silently rewrite tools as Sandbox.
    const backend =
      incomingBackend ?? (await getAgentBackend(c.env.DB, agentId));
    const transformed = transformAgentToolsForBackend(body, backend, c.env);
    const sanitized = defaultDisableUnspecifiedServerTools(transformed);
    const res = await anthropic(c.env, "POST", `/v1/agents/${agentId}`, sanitized);
    // We have the agent id from the path param, so no need to read the
    // response body — just persist the mapping when the caller asked
    // for a backend switch and the upstream call succeeded.
    if (incomingBackend && res.ok) {
      await persistBackendForAgent(c.env.DB, agentId, incomingBackend);
    }
    return res;
  });

  app.post("/api/agents/:agentId/archive", async (c) => {
    const agentId = c.req.param("agentId");
    if (!assertAgentId(agentId)) {
      return c.json({ error: "invalid agent id" }, 400);
    }
    // Best-effort cleanup. The agent row is gone upstream so dispatch
    // behaviour for any future webhook is moot, but it keeps the table tidy.
    const res = await anthropic(c.env, "POST", `/v1/agents/${agentId}/archive`);
    if (res.ok) {
      try {
        await deleteAgentBackend(c.env.DB, agentId);
      } catch (error) {
        console.warn(
          `[api] failed to clear backend row for ${agentId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return res;
  });

  app.get("/api/sessions", async (c) => {
    const limit = c.req.query("limit") || "100";
    // Optional `backend` query param scopes the list down to one backend
    // before returning. Implemented in the worker rather than upstream
    // because Anthropic doesn't know about our per-agent backend mapping.
    const backendFilter = c.req.query("backend");
    const upstream = await anthropic(c.env, "GET", `/v1/sessions?limit=${limit}`);
    if (!upstream.ok) return upstream;
    // Clone so that if JSON parsing fails we can still fall back to the
    // raw upstream response — `Response.body` is single-use.
    const cloned = upstream.clone();
    try {
      const payload = (await upstream.json()) as {
        data?: Array<Record<string, unknown>>;
      };
      const items = Array.isArray(payload?.data) ? payload.data : [];
      const ids = items
        .map((s) => (typeof s?.id === "string" ? s.id : null))
        .filter((s): s is string => Boolean(s));
      const cached = await listSessionBackends(c.env.DB, ids);
      // Bulk read of agent_backends so we can fall back to "what backend
      // does this session's agent have?" when no session row exists yet
      // (the row only lands once the session has been webhook'd OR has
      // been created through our POST /api/sessions). Without this
      // fallback, an Isolate agent's freshly-created session always
      // rendered the MicroVM chip in the dashboard until the first
      // webhook fired — visually mismatched against the agent's
      // "Isolate" badge.
      const agentBackends = await listAgentBackends(c.env.DB).catch(
        () => new Map<string, AgentBackend>(),
      );
      const enriched = items.map((s) => {
        const sessionBackend =
          typeof s?.id === "string" ? cached.get(s.id) : undefined;
        if (sessionBackend) return { ...s, backend: sessionBackend };
        // session.agent is the snapshot Anthropic embeds on the session;
        // its `id` should equal the original agent id we wrote into
        // agent_backends at create time.
        const agentId =
          s && typeof s.agent === "object" && s.agent !== null
            ? (s.agent as Record<string, unknown>).id
            : undefined;
        const agentBackend =
          typeof agentId === "string" ? agentBackends.get(agentId) : undefined;
        return {
          ...s,
          backend: agentBackend ?? ("microvm" as AgentBackend),
        };
      });
      const filtered =
        backendFilter === "microvm" || backendFilter === "isolate"
          ? enriched.filter((s) => s.backend === backendFilter)
          : enriched;
      return c.json({ ...payload, data: filtered });
    } catch (error) {
      console.warn(
        `[api] failed to enrich sessions with backend: ${error instanceof Error ? error.message : String(error)}`,
      );
      // Losing the backend column is better than losing the whole sessions
      // list, so return the original upstream body as a fallback.
      return cloned;
    }
  });

  app.post("/api/sessions", async (c) => {
    const body = await c.req.json();
    // Inject the configured environment id when the client doesn't supply one
    // — the API requires it and the worker already knows which environment it
    // is bound to. Skipping this here would surface as an opaque
    // `environment_id is required` error to the frontend.
    if (body && typeof body === "object" && !("environment_id" in body)) {
      (body as Record<string, unknown>).environment_id = c.env.ENVIRONMENT_ID;
    }
    // Extract the agent id from the request body. Both wire shapes the
    // Anthropic SDK accepts are handled: `agent: "agent_..."` and
    // `agent: { id: "agent_..." }`. We need it so we can write the
    // (sessionId, agentId, backend) mapping to D1 immediately after the
    // upstream call returns — otherwise the first webhook for this
    // session has to round-trip back to Anthropic to learn the agent id
    // (and any failure there silently defaults backend to "microvm",
    // routing Isolate sessions into the container dispatcher and
    // surfacing as `Tool 'cf_write' not found` from the MicroVM
    // custom-tool dispatcher).
    const requestedAgentId = ((): string | null => {
      if (!body || typeof body !== "object") return null;
      const agent = (body as Record<string, unknown>).agent;
      if (typeof agent === "string") return agent;
      if (agent && typeof agent === "object") {
        const id = (agent as Record<string, unknown>).id;
        if (typeof id === "string") return id;
      }
      return null;
    })();

    const res = await anthropic(c.env, "POST", "/v1/sessions", body);
    if (!res.ok || !requestedAgentId) return res;

    // Read the session id out of the upstream response so we can cache
    // it locally. Clone first — the response body is single-use and the
    // frontend still needs to read it.
    let createdSessionId: string | null = null;
    try {
      const payload = (await res.clone().json()) as Record<string, unknown>;
      const id = payload.id;
      if (typeof id === "string") createdSessionId = id;
    } catch (error) {
      console.warn(
        `[api] /api/sessions: failed to parse upstream session body: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (createdSessionId) {
      try {
        // getAgentBackend defaults to "microvm" when the agent_backends
        // row is missing — same default the rest of the codebase uses,
        // and it gets corrected on the next resolveBackend pass if the
        // mapping shows up later.
        const backend = await getAgentBackend(c.env.DB, requestedAgentId);
        await recordSessionAgent(
          c.env.DB,
          createdSessionId,
          requestedAgentId,
          backend,
        );
      } catch (error) {
        // Caching failure here just degrades to the legacy path
        // (resolveBackend will round-trip to Anthropic on the first
        // webhook). Log and move on — the upstream session is already
        // created and returning a 5xx now would be misleading.
        console.warn(
          `[api] /api/sessions: failed to cache session=${createdSessionId} agent=${requestedAgentId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return res;
  });

  app.get("/api/sessions/:sessionId", async (c) => {
    const sessionId = c.req.param("sessionId");
    if (!assertSessionId(sessionId)) {
      return c.json({ error: "invalid session id" }, 400);
    }
    return anthropic(c.env, "GET", `/v1/sessions/${sessionId}`);
  });

  app.get("/api/sessions/:sessionId/events", async (c) => {
    const sessionId = c.req.param("sessionId");
    if (!assertSessionId(sessionId)) {
      return c.json({ error: "invalid session id" }, 400);
    }

    const search = new URL(c.req.url).search;
    return anthropic(c.env, "GET", `/v1/sessions/${sessionId}/events${search}`);
  });

  app.post("/api/sessions/:sessionId/events", async (c) => {
    const sessionId = c.req.param("sessionId");
    if (!assertSessionId(sessionId)) {
      return c.json({ error: "invalid session id" }, 400);
    }

    const body = await c.req.json();
    return anthropic(c.env, "POST", `/v1/sessions/${sessionId}/events`, body);
  });

  app.post("/api/sessions/:sessionId/archive", async (c) => {
    const sessionId = c.req.param("sessionId");
    if (!assertSessionId(sessionId)) {
      return c.json({ error: "invalid session id" }, 400);
    }

    return anthropic(c.env, "POST", `/v1/sessions/${sessionId}/archive`);
  });

  app.notFound((c) => c.json({ error: "not found" }, 404));

  return app;
}

export const apiApp = createApiApp();
