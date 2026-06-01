-- Webhook events received from Anthropic. Kept around for the dashboard,
-- then pruned daily by the cron handler.
CREATE TABLE IF NOT EXISTS webhook_events (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  ts_ms        INTEGER NOT NULL,
  body         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_ts ON webhook_events (ts_ms DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_events_session ON webhook_events (session_id, ts_ms DESC);

-- Sessions tracked by webhook ingestion. One row per Anthropic session id.
--
--   last_data_json — most recent webhook `data` payload, so egress policy
--                    matchers can resolve fields like `organization_id` /
--                    `workspace_id` at dispatch time.
--   agent_id       — cached Anthropic agent id for the session.
--   backend        — cached runtime backend ("microvm" | "isolate"). Both
--                    are stable for a session's lifetime, so caching here
--                    avoids a round-trip on every status/exec/stop call.
CREATE TABLE IF NOT EXISTS sessions (
  session_id          TEXT PRIMARY KEY,
  created_at_ms       INTEGER NOT NULL,
  last_webhook_at_ms  INTEGER NOT NULL,
  last_webhook_type   TEXT NOT NULL,
  last_data_json      TEXT,
  agent_id            TEXT,
  backend             TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_last ON sessions (last_webhook_at_ms DESC);

-- Per-agent backend choice + VPC binding list. Agents are stored on
-- Anthropic's side, but the runtime backend is our concern, so we keep
-- a small mapping table here keyed by agent id.
--
--   backend       — one of:
--                     'microvm' — Cloudflare Sandbox SDK / containers (default).
--                     'isolate' — Workers isolate + SQLite Workspace.
--   vpc_bindings  — JSON-encoded array of VPC binding names the agent
--                   can call. NULL or empty means no VPC access. At
--                   dispatch time, the Sandbox / Isolate paths augment
--                   the resolved egress policy with one vpc-service
--                   route per binding (host = `<binding>.local`).
CREATE TABLE IF NOT EXISTS agent_backends (
  agent_id      TEXT PRIMARY KEY,
  backend       TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  vpc_bindings  TEXT
);

-- Per-session email inbox. Populated by the email() Worker handler when
-- a message arrives via Cloudflare Email Routing; read by the
-- cf_email_inbox / cf_email_read tools.
--
-- Indexed on (session_id, received_at_ms DESC) because the inbox tool
-- always lists newest-first within a single session. message_id is the
-- primary key so the read tool can fetch by id without a join.
CREATE TABLE IF NOT EXISTS inbox (
    message_id     TEXT PRIMARY KEY,
    session_id     TEXT NOT NULL,
    from_addr      TEXT NOT NULL,
    to_addr        TEXT NOT NULL,
    subject        TEXT NOT NULL DEFAULT '(no subject)',
    received_at_ms INTEGER NOT NULL,
    size_bytes     INTEGER NOT NULL DEFAULT 0,
    body_text      TEXT,
    body_html      TEXT,
    raw            TEXT
);

CREATE INDEX IF NOT EXISTS idx_inbox_session_received
    ON inbox (session_id, received_at_ms DESC);

-- Agent-level email aliases. One agent has one primary alias used as
-- the default From: address; operators may add secondary aliases later.
-- The email handler looks an inbound recipient's local-part up here
-- (after stripping `+tag` subaddressing) to find the owning agent.
--
-- `alias` is normalized — lowercase, no `+tag` suffix. `is_primary` is 1
-- for the agent's default outbound address (one per agent). Aliases are
-- auto-provisioned by the webhook resolver when it first learns an
-- agent_id; operators can also seed extra rows manually.
CREATE TABLE IF NOT EXISTS agent_emails (
    alias         TEXT PRIMARY KEY,
    agent_id      TEXT NOT NULL,
    is_primary    INTEGER NOT NULL DEFAULT 0,
    created_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_emails_agent ON agent_emails (agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_emails_primary ON agent_emails (agent_id, is_primary);

-- Outbound messages sent by cf_email_send. The Message-ID we issue
-- encodes the session id, so when a counterparty replies with that
-- value in In-Reply-To / References we can route the reply back to the
-- same session — even if the agent's address is generic and the
-- counterparty is corresponding with multiple sessions in parallel.
CREATE TABLE IF NOT EXISTS sent_messages (
    message_id  TEXT PRIMARY KEY,
    session_id  TEXT NOT NULL,
    agent_id    TEXT NOT NULL,
    to_addr     TEXT NOT NULL,
    sent_at_ms  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sent_messages_session ON sent_messages (session_id);

-- Per-counterparty thread routing. When an inbound message can't be
-- linked back to a specific outbound via Message-ID, we fall back to
-- this table: the same counterparty corresponding with the same agent
-- keeps landing in the same session. First contact creates a fresh
-- session for the agent and writes the mapping. Threads survive cron
-- pruning because they're the only stable link between a long-running
-- correspondent and an active session.
--
-- `counterparty` is normalized (lowercase, `+tag` stripped from local
-- part) so `bob+work@x` and `bob@x` collapse to one thread.
CREATE TABLE IF NOT EXISTS email_threads (
    agent_id           TEXT NOT NULL,
    counterparty       TEXT NOT NULL,
    session_id         TEXT NOT NULL,
    last_message_at_ms INTEGER NOT NULL,
    PRIMARY KEY (agent_id, counterparty)
);

CREATE INDEX IF NOT EXISTS idx_email_threads_session ON email_threads (session_id);
