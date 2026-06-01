-- Alfred D1 schema: initial tables

CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL DEFAULT '',
  vibe_anchor TEXT NOT NULL DEFAULT '',
  forbidden_tokens TEXT NOT NULL DEFAULT '[]',
  learned_preferences TEXT NOT NULL DEFAULT '[]',
  stylometric_signals TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT 'Untitled',
  document TEXT NOT NULL DEFAULT '{"paragraphs":[]}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_documents_profile ON documents(profile_id);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  document_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  cma_session_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_profile ON sessions(profile_id);
CREATE INDEX IF NOT EXISTS idx_sessions_cma ON sessions(cma_session_id);

CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  intent TEXT NOT NULL DEFAULT '',
  rationale TEXT NOT NULL DEFAULT '',
  operators TEXT NOT NULL DEFAULT '[]',
  voice_check TEXT,
  alfred_says TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_proposals_session ON proposals(session_id);

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  reject_reason TEXT,
  modified_text TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_decisions_session ON decisions(session_id);
CREATE INDEX IF NOT EXISTS idx_decisions_proposal ON decisions(proposal_id);

CREATE TABLE IF NOT EXISTS panopticon_events (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  session_id TEXT,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_panopticon_profile ON panopticon_events(profile_id);
CREATE INDEX IF NOT EXISTS idx_panopticon_session ON panopticon_events(session_id);
