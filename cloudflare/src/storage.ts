// D1-backed storage for webhook events and session metadata. Kept thin so we
// can migrate or extend without rewriting handlers.

export interface WebhookEvent {
  type: "event";
  id: string;
  // Anthropic's payload uses `created_at`. We accept both so older payloads
  // (or the Standard Webhooks `timestamp` field) keep working.
  created_at?: string;
  timestamp?: string;
  data: {
    type: string;
    id: string;
    organization_id?: string;
    workspace_id?: string;
  };
}

export interface SessionRecord {
  sessionId: string;
  createdAt: string;
  lastWebhookAt: string;
  lastWebhookType: string;
}

interface WebhookEventRow {
  id: string;
  type: string;
  session_id: string;
  ts_ms: number;
  body: string;
}

interface SessionRow {
  session_id: string;
  created_at_ms: number;
  last_webhook_at_ms: number;
  last_webhook_type: string;
  last_data_json?: string | null;
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

function eventTimestampMs(
  event: WebhookEvent | { timestamp?: unknown; created_at?: unknown },
): number {
  const ev = event as { timestamp?: unknown; created_at?: unknown };
  for (const candidate of [ev.created_at, ev.timestamp]) {
    if (typeof candidate === "string") {
      const parsed = Date.parse(candidate);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return Date.now();
}

// Defensively pull common identifiers from a webhook payload. Anthropic
// occasionally sends test pings and event shapes that don't match the
// strict TypeScript type, so we coerce missing fields to safe defaults
// instead of throwing — D1 rejects undefined bind values.
function safeFields(event: unknown): { id: string; type: string; sessionId: string } {
  const ev = (event ?? {}) as Record<string, unknown>;
  const data = (ev.data ?? {}) as Record<string, unknown>;
  return {
    id: typeof ev.id === "string" && ev.id ? ev.id : `ev_unknown_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type: typeof data.type === "string" && data.type ? data.type : "unknown",
    sessionId: typeof data.id === "string" && data.id ? data.id : "",
  };
}

export async function recordWebhookEvent(db: D1Database, event: WebhookEvent): Promise<void> {
  const { id, type, sessionId } = safeFields(event);
  const ts = eventTimestampMs(event);
  await db
    .prepare(
      `INSERT OR REPLACE INTO webhook_events (id, type, session_id, ts_ms, body)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(id, type, sessionId, ts, JSON.stringify(event))
    .run();
}

export async function upsertSession(
  db: D1Database,
  sessionId: string,
  eventType: string,
  data?: Record<string, unknown> | null,
): Promise<void> {
  const now = Date.now();
  // Persist the latest `data` payload so policy matchers can resolve fields
  // like `organization_id` / `workspace_id` at sandbox dispatch time. We
  // only update the column when fresh data is supplied — pings and unrelated
  // events leave it untouched.
  const dataJson = data && typeof data === "object" ? JSON.stringify(data) : null;
  // INSERT ... ON CONFLICT keeps created_at_ms stable on subsequent webhooks.
  await db
    .prepare(
      `INSERT INTO sessions (session_id, created_at_ms, last_webhook_at_ms, last_webhook_type, last_data_json)
       VALUES (?1, ?2, ?2, ?3, ?4)
       ON CONFLICT(session_id) DO UPDATE SET
         last_webhook_at_ms = ?2,
         last_webhook_type = ?3,
         last_data_json = COALESCE(?4, sessions.last_data_json)`,
    )
    .bind(sessionId, now, eventType, dataJson)
    .run();
}

// Reads the most recent webhook `data` payload for a session, used by
// the sandbox dispatcher to feed egress-policy matchers.
export async function getSessionData(
  db: D1Database,
  sessionId: string,
): Promise<Record<string, unknown> | null> {
  const row = await db
    .prepare(`SELECT last_data_json FROM sessions WHERE session_id = ?`)
    .bind(sessionId)
    .first<{ last_data_json: string | null }>();
  if (!row || !row.last_data_json) return null;
  try {
    const parsed = JSON.parse(row.last_data_json);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// Cached agent + backend for a session. Populated by the webhook dispatcher
// on first resolution (one Anthropic round-trip per session) and read by
// status/exec/terminal handlers to skip a second round-trip.
export async function getSessionBackend(
  db: D1Database,
  sessionId: string,
): Promise<{ agentId: string | null; backend: AgentBackend | null }> {
  const row = await db
    .prepare(`SELECT agent_id, backend FROM sessions WHERE session_id = ?`)
    .bind(sessionId)
    .first<{ agent_id: string | null; backend: string | null }>();
  if (!row) return { agentId: null, backend: null };
  const backend: AgentBackend | null = isAgentBackend(row.backend) ? row.backend : null;
  return { agentId: row.agent_id, backend };
}

// Bulk read for the sessions index view. Returns a Map keyed by Anthropic
// session id; sessions missing from the table or with no cached backend
// are simply absent from the map. The caller decides what default to
// surface (today: "microvm"). One D1 round-trip, regardless of how many
// session ids we're enriching.
export async function listSessionBackends(
  db: D1Database,
  sessionIds: string[],
): Promise<Map<string, AgentBackend>> {
  const out = new Map<string, AgentBackend>();
  if (sessionIds.length === 0) return out;
  // D1 IN-clause: build `?,?,?` placeholders rather than splatting the
  // ids into the SQL string (avoids the obvious injection risk and lets
  // D1's prepared-statement cache reuse the query shape).
  const placeholders = sessionIds.map(() => "?").join(",");
  const rows = await db
    .prepare(
      `SELECT session_id, backend FROM sessions WHERE session_id IN (${placeholders})`,
    )
    .bind(...sessionIds)
    .all<{ session_id: string; backend: string | null }>();
  for (const row of rows.results || []) {
    if (isAgentBackend(row.backend)) {
      out.set(row.session_id, row.backend);
    }
  }
  return out;
}

export async function setSessionBackend(
  db: D1Database,
  sessionId: string,
  agentId: string | null,
  backend: AgentBackend,
): Promise<void> {
  await db
    .prepare(
      `UPDATE sessions SET agent_id = ?2, backend = ?3 WHERE session_id = ?1`,
    )
    .bind(sessionId, agentId, backend)
    .run();
}

// Pre-create (or update) the sessions row with its agent + backend at
// session-create time, BEFORE any webhook has fired. The webhook
// dispatch path (`resolveBackend`) reads from this row on its cached
// path and skips the Anthropic round-trip entirely — so an Isolate
// session's very first dispatch already knows which DO namespace to
// hit. Without this, we depended on `client.beta.sessions.retrieve()`
// returning a `session.agent.id` that matches our `agent_backends`
// row; any mismatch or transient failure there defaulted the backend
// to "microvm" and routed an Isolate agent's session into the
// MicroVM dispatcher (which doesn't register the workspace tools, so
// the model saw `Tool 'cf_write' not found` and friends).
//
// We have to satisfy the NOT NULL constraints on `last_webhook_at_ms`
// + `last_webhook_type`; "session.created" is a synthetic placeholder
// the dashboard's sessions view can render until a real webhook
// overwrites it. agent_id + backend are unconditionally overwritten
// (the caller knows them authoritatively); a later
// resolveBackend-driven write will reflect any mid-session backend
// flip on the agent_backends side.
export async function recordSessionAgent(
  db: D1Database,
  sessionId: string,
  agentId: string,
  backend: AgentBackend,
): Promise<void> {
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO sessions (session_id, created_at_ms, last_webhook_at_ms, last_webhook_type, agent_id, backend)
       VALUES (?1, ?2, ?2, 'session.created', ?3, ?4)
       ON CONFLICT(session_id) DO UPDATE SET
         agent_id = ?3,
         backend  = ?4`,
    )
    .bind(sessionId, now, agentId, backend)
    .run();
}

export async function listSessions(
  db: D1Database,
  page: number,
  limit: number,
): Promise<{ items: SessionRecord[]; total: number }> {
  const offset = (page - 1) * limit;
  const [rows, total] = await Promise.all([
    db
      .prepare(
        `SELECT session_id, created_at_ms, last_webhook_at_ms, last_webhook_type
         FROM sessions
         ORDER BY last_webhook_at_ms DESC
         LIMIT ? OFFSET ?`,
      )
      .bind(limit, offset)
      .all<SessionRow>(),
    db.prepare(`SELECT COUNT(*) AS c FROM sessions`).first<{ c: number }>(),
  ]);

  return {
    items: (rows.results || []).map((row) => ({
      sessionId: row.session_id,
      createdAt: toIso(row.created_at_ms),
      lastWebhookAt: toIso(row.last_webhook_at_ms),
      lastWebhookType: row.last_webhook_type,
    })),
    total: total?.c ?? 0,
  };
}

export async function listWebhookEvents(
  db: D1Database,
  beforeMs: number | null,
  limit: number,
): Promise<{ items: WebhookEvent[]; nextCursor: string | null }> {
  const before = beforeMs ?? Number.MAX_SAFE_INTEGER;
  const rows = await db
    .prepare(
      `SELECT id, type, session_id, ts_ms, body
       FROM webhook_events
       WHERE ts_ms < ?
       ORDER BY ts_ms DESC
       LIMIT ?`,
    )
    .bind(before, limit + 1)
    .all<WebhookEventRow>();

  const list = rows.results || [];
  const items: WebhookEvent[] = [];
  for (const r of list.slice(0, limit)) {
    try {
      items.push(JSON.parse(r.body) as WebhookEvent);
    } catch {
      // skip malformed rows
    }
  }

  const hasMore = list.length > limit;
  const nextCursor = hasMore ? String(list[limit - 1].ts_ms) : null;
  return { items, nextCursor };
}

export async function getWebhookEvent(
  db: D1Database,
  eventId: string,
): Promise<WebhookEvent | null> {
  const row = await db
    .prepare(`SELECT body FROM webhook_events WHERE id = ?`)
    .bind(eventId)
    .first<{ body: string }>();
  if (!row) return null;
  try {
    return JSON.parse(row.body) as WebhookEvent;
  } catch {
    return null;
  }
}

export async function deleteAllWebhookEvents(db: D1Database): Promise<number> {
  const before = await db.prepare(`SELECT COUNT(*) AS c FROM webhook_events`).first<{ c: number }>();
  await db.prepare(`DELETE FROM webhook_events`).run();
  return before?.c ?? 0;
}

// Per-agent backend choice. Defaults to "microvm" when no row is present
// so existing agents (created before the Isolate backend landed) keep
// their old behaviour. Writes happen from /api/agents create + update
// handlers.
export type AgentBackend = "microvm" | "isolate";

function isAgentBackend(value: string | null | undefined): value is AgentBackend {
  return value === "microvm" || value === "isolate";
}

export async function getAgentBackend(
  db: D1Database,
  agentId: string,
): Promise<AgentBackend> {
  const row = await db
    .prepare(`SELECT backend FROM agent_backends WHERE agent_id = ?`)
    .bind(agentId)
    .first<{ backend: string }>();
  return isAgentBackend(row?.backend) ? row!.backend : "microvm";
}

// Bulk read for the agents listing view. Returns a Map keyed by agent id;
// agents missing from the table fall back to "microvm" at the call site.
export async function listAgentBackends(
  db: D1Database,
): Promise<Map<string, AgentBackend>> {
  const out = new Map<string, AgentBackend>();
  const rows = await db
    .prepare(`SELECT agent_id, backend FROM agent_backends`)
    .all<{ agent_id: string; backend: string }>();
  for (const row of rows.results || []) {
    if (isAgentBackend(row.backend)) {
      out.set(row.agent_id, row.backend);
    }
  }
  return out;
}

// Has this operator deployed MicroVM agents or run MicroVM sessions?
// Used by `/api/config` to gate the "snapshots disabled" banner. We
// answer true when ANY of:
//   - a session row is recorded as microvm (or null, which defaults to
//     microvm on read), meaning we've actually dispatched one
//   - an agent_backends row is microvm
//   - the agent_backends table is empty (fresh deploy: agents created
//     here will default to microvm, so keep the warning visible)
// The previous implementation only checked the second condition and
// missed the common case of "Isolate Agent persisted, VM Agent default":
// listAgentBackends returned just ["isolate"], which has no "microvm",
// so the banner was hidden on a deployment actively running MicroVM.
export async function hasMicrovmFootprint(db: D1Database): Promise<boolean> {
  const microvmSession = await db
    .prepare(
      `SELECT 1 FROM sessions WHERE backend IS NULL OR backend = 'microvm' LIMIT 1`,
    )
    .first();
  if (microvmSession) return true;

  const microvmAgent = await db
    .prepare(`SELECT 1 FROM agent_backends WHERE backend = 'microvm' LIMIT 1`)
    .first();
  if (microvmAgent) return true;

  // Fresh deploy: no agent rows yet — new agents default to microvm,
  // so leave the warning on so the operator catches a missing R2
  // setup before their first session.
  const anyAgent = await db
    .prepare(`SELECT 1 FROM agent_backends LIMIT 1`)
    .first();
  return !anyAgent;
}

export async function setAgentBackend(
  db: D1Database,
  agentId: string,
  backend: AgentBackend,
): Promise<void> {
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO agent_backends (agent_id, backend, updated_at_ms)
       VALUES (?1, ?2, ?3)
       ON CONFLICT(agent_id) DO UPDATE SET
         backend = ?2,
         updated_at_ms = ?3`,
    )
    .bind(agentId, backend, now)
    .run();
}

export async function deleteAgentBackend(db: D1Database, agentId: string): Promise<void> {
  await db.prepare(`DELETE FROM agent_backends WHERE agent_id = ?`).bind(agentId).run();
}

// Note: per-agent VPC binding selection was prototyped here but never
// wired into the dashboard or dispatch path. The `agent_backends.vpc_bindings`
// column remains in the schema so older deploys keep parsing; routing today
// uses `vpc-service` egress rules instead (see docs/connecting-to-private-services.md).

// Removes events / sessions / inbox / sent_messages rows older than the
// given cutoff (ms epoch). Returns the row counts deleted, useful for
// cron logging. email_threads are deliberately not pruned — a stale
// thread mapping is cheap to keep and the alternative (forcing a fresh
// session for every reply more than 24h apart) breaks the "reply to
// agent" UX. Aliases (`agent_emails`) are also durable.
export async function pruneOlderThan(
  db: D1Database,
  cutoffMs: number,
): Promise<{
  events: number;
  sessions: number;
  inbox: number;
  sentMessages: number;
}> {
  const eventsRes = await db
    .prepare(`DELETE FROM webhook_events WHERE ts_ms < ?`)
    .bind(cutoffMs)
    .run();
  const sessionsRes = await db
    .prepare(`DELETE FROM sessions WHERE last_webhook_at_ms < ?`)
    .bind(cutoffMs)
    .run();
  const inboxRes = await db
    .prepare(`DELETE FROM inbox WHERE received_at_ms < ?`)
    .bind(cutoffMs)
    .run();
  const sentRes = await db
    .prepare(`DELETE FROM sent_messages WHERE sent_at_ms < ?`)
    .bind(cutoffMs)
    .run();
  return {
    events: eventsRes.meta?.changes ?? 0,
    sessions: sessionsRes.meta?.changes ?? 0,
    inbox: inboxRes.meta?.changes ?? 0,
    sentMessages: sentRes.meta?.changes ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Agent-level email aliases.
// ---------------------------------------------------------------------------
//
// Each agent has at most one primary alias (is_primary = 1) used as the
// default From: on email_send and the public address operators hand
// out to correspondents. The email handler resolves a recipient
// local-part to an agent_id via this table.
//
// The auto-provisioned alias is `agent-${shortHash(agent_id)}`. The
// short hash is 12 hex chars of SHA-256 — collision-resistant across
// any realistic agent count, and short enough that a human can type it
// from a screenshot without errors.

// Compute the deterministic primary-alias local-part for an agent. The
// function is async because crypto.subtle is async; callers usually
// await once at provisioning time and persist the result.
export async function derivePrimaryAlias(agentId: string): Promise<string> {
  const bytes = new TextEncoder().encode(agentId);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest))
    .slice(0, 6)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `agent-${hex}`;
}

// Normalise a local-part for lookup: lowercase, strip any `+tag`
// subaddressing. Matches the email-handler's recipient parsing so a
// table lookup uses the same key the inbound parser produces.
export function normalizeAlias(localPart: string): string {
  const lower = localPart.toLowerCase();
  const plus = lower.indexOf("+");
  return plus === -1 ? lower : lower.slice(0, plus);
}

// Look up the agent that owns a given alias. Returns null when the
// alias isn't registered.
export async function getAgentIdByAlias(
  db: D1Database,
  alias: string,
): Promise<string | null> {
  const row = await db
    .prepare(`SELECT agent_id FROM agent_emails WHERE alias = ?`)
    .bind(normalizeAlias(alias))
    .first<{ agent_id: string }>();
  return row?.agent_id ?? null;
}

// Return the primary alias for an agent, or null when none is set. Used
// by email_send to populate the From: header.
export async function getPrimaryAliasForAgent(
  db: D1Database,
  agentId: string,
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT alias FROM agent_emails WHERE agent_id = ? AND is_primary = 1 LIMIT 1`,
    )
    .bind(agentId)
    .first<{ alias: string }>();
  return row?.alias ?? null;
}

// Ensure an agent has a primary alias row. Idempotent: silently no-ops
// if the agent already has one. Called by the webhook resolver on first
// agent_id sighting, and by email_send before its first send.
export async function ensureAgentPrimaryEmail(
  db: D1Database,
  agentId: string,
): Promise<string> {
  const existing = await getPrimaryAliasForAgent(db, agentId);
  if (existing) return existing;
  const alias = await derivePrimaryAlias(agentId);
  const now = Date.now();
  // INSERT OR IGNORE so concurrent provisioning on two threads can't
  // race into a UNIQUE-constraint failure on the alias PK. The losing
  // call's getPrimaryAliasForAgent next-call will see the winner's row.
  await db
    .prepare(
      `INSERT OR IGNORE INTO agent_emails (alias, agent_id, is_primary, created_at_ms)
       VALUES (?1, ?2, 1, ?3)`,
    )
    .bind(alias, agentId, now)
    .run();
  return alias;
}

// ---------------------------------------------------------------------------
// Outbound message tracking — supports In-Reply-To threading.
// ---------------------------------------------------------------------------

export async function recordSentMessage(
  db: D1Database,
  messageId: string,
  sessionId: string,
  agentId: string,
  toAddr: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT OR REPLACE INTO sent_messages
         (message_id, session_id, agent_id, to_addr, sent_at_ms)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    )
    .bind(messageId, sessionId, agentId, toAddr, Date.now())
    .run();
}

// Look up which session originally sent a message with this Message-ID.
// Returns null when unknown — typical for the very first message in a
// thread, or after the row has been pruned (24h cutoff).
export async function findSessionByMessageId(
  db: D1Database,
  messageId: string,
): Promise<{ sessionId: string; agentId: string } | null> {
  const row = await db
    .prepare(
      `SELECT session_id, agent_id FROM sent_messages WHERE message_id = ?`,
    )
    .bind(messageId)
    .first<{ session_id: string; agent_id: string }>();
  if (!row) return null;
  return { sessionId: row.session_id, agentId: row.agent_id };
}

// ---------------------------------------------------------------------------
// Counterparty thread routing.
// ---------------------------------------------------------------------------

// Normalise the counterparty side of a thread key: lowercase, strip
// `+tag` from the local-part, strip surrounding whitespace and any
// `Display Name <addr>` wrapper. Failing-to-parse falls back to the
// trimmed lowercase original — better to over-match than to silently
// drop mail.
export function normalizeCounterparty(rawFrom: string): string {
  const trimmed = rawFrom.trim();
  // Pull out the bracketed address if present.
  const angle = trimmed.match(/<([^>]+)>/);
  const addr = (angle ? angle[1] : trimmed).toLowerCase().trim();
  const at = addr.lastIndexOf("@");
  if (at === -1) return addr;
  const local = addr.slice(0, at);
  const domain = addr.slice(at + 1);
  const plus = local.indexOf("+");
  const base = plus === -1 ? local : local.slice(0, plus);
  return `${base}@${domain}`;
}

export async function getThreadSession(
  db: D1Database,
  agentId: string,
  counterparty: string,
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT session_id FROM email_threads
       WHERE agent_id = ?1 AND counterparty = ?2`,
    )
    .bind(agentId, counterparty)
    .first<{ session_id: string }>();
  return row?.session_id ?? null;
}

export async function upsertThread(
  db: D1Database,
  agentId: string,
  counterparty: string,
  sessionId: string,
): Promise<void> {
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO email_threads
         (agent_id, counterparty, session_id, last_message_at_ms)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(agent_id, counterparty) DO UPDATE SET
         session_id = ?3,
         last_message_at_ms = ?4`,
    )
    .bind(agentId, counterparty, sessionId, now)
    .run();
}

// Touch only the last_message_at_ms — used when we already know the
// session matches the existing row (e.g. when In-Reply-To routing
// matched and we want to keep the thread fresh for future fallbacks).
export async function touchThread(
  db: D1Database,
  agentId: string,
  counterparty: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE email_threads SET last_message_at_ms = ?3
       WHERE agent_id = ?1 AND counterparty = ?2`,
    )
    .bind(agentId, counterparty, Date.now())
    .run();
}
