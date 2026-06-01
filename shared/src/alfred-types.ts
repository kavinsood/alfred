// Canonical types for Alfred shared runtime.
// This is the single source of truth — all packages import from here.

export type ParagraphRole = "intro" | "thesis" | "section_lead" | "supporting";

export type Paragraph = {
  id: string;
  text: string;
  role?: ParagraphRole;
  parent_id?: string;
};

export type AlfredDocument = {
  paragraphs: Paragraph[];
};

// --- Operators ---

export type Position =
  | { kind: "after"; paragraph_id: string }
  | { kind: "at"; where: "start" | "end" };

export type SplitOp = {
  kind: "split";
  paragraph_id: string;
  after_sentence_index: number;
};

export type MergeOp = {
  kind: "merge";
  first_paragraph_id: string;
  second_paragraph_id: string;
  glue_text?: string;
};

export type MoveOp = {
  kind: "move";
  paragraph_id: string;
  target_position: Position;
};

export type HoistOp = {
  kind: "hoist";
  paragraph_id: string;
  target_role: "intro" | "thesis" | "section_lead";
  target_position: Position;
};

export type DemoteOp = {
  kind: "demote";
  paragraph_id: string;
  parent_paragraph_id: string;
};

export type MigrateOp = {
  kind: "migrate";
  paragraph_id: string;
  rewrite_text: string;
  change_budget_tokens: number;
};

export type GlueOp = {
  kind: "glue";
  position: Position;
  text: string;
};

export type DeleteOp = {
  kind: "delete";
  paragraph_id: string;
};

export type Operator =
  | SplitOp
  | MergeOp
  | MoveOp
  | HoistOp
  | DemoteOp
  | MigrateOp
  | GlueOp
  | DeleteOp;

// --- Proposal envelope (full, server-generated) ---

export type VoiceCheck = {
  glue_budget_used: number;
  forbidden_tokens_violated: string[];
  migrate_change_pct: number | null;
  operator_validations: Array<{ index: number; ok: boolean; reason?: string }>;
};

export type Proposal = {
  id: string;
  rationale: string;
  operators: Operator[];
  voice_check: VoiceCheck;
  alfred_says: string;
};

// --- Input proposal (for validation, before server enrichment) ---

export type ProposalInput = {
  id?: string;
  intent: string;
  rationale: string;
  operators: Operator[];
};

// --- Voice profile ---

export type LearnedPreference = {
  id: string;
  rule: string;
  evidence_count: number;
  example_quote?: string;
  inferred_at: string;
};

export type StylometricSignals = {
  sentence_length_mean: number;
  sentence_length_std: number;
  fragment_rate: number;
  sample_count: number;
};

export type VoiceProfile = {
  vibe_anchor: string;
  forbidden_tokens: string[];
  learned_preferences: LearnedPreference[];
  stylometric_signals?: StylometricSignals;
};

// --- AlfredProfile (extended profile with identity) ---

export type AlfredProfile = {
  id: string;
  display_name?: string;
  vibe_anchor: string;
  forbidden_tokens: string[];
  learned_preferences: LearnedPreference[];
  stylometric_signals?: StylometricSignals;
};

// --- AlfredSession ---

export type AlfredSession = {
  id: string;
  profile_id: string;
  document_id: string;
  created_at: string;
  updated_at: string;
  status: "active" | "closed";
  cma_session_id?: string;
};

// --- Panopticon ---

export type PanopticonEvent = {
  ts: string;
  kind: "proposal" | "decision" | "profile_update" | "voice_learn";
  summary: string;
  detail?: unknown;
};

// --- Validation ---

export type ValidationResult = {
  valid: boolean;
  errors: string[];
  warnings: string[];
  operatorSummary: string;
  beforeHash?: string;
  afterHash?: string;
};

// --- Session log ---

export type SessionLogEntry = {
  proposal_id: string;
  ts: string;
  intent: string;
  decision: "accept" | "reject" | "modify";
  reject_reason?: string;
  modified_text?: string;
  rationale: string;
  operator_kinds: string[];
};

// --- API shapes ---

export type ProposeRequest = {
  document: AlfredDocument;
  intent: string;
  selection?: { paragraph_ids: string[] };
  session_id: string;
};

export type ProposeResponse =
  | { ok: true; proposal: Proposal }
  | { ok: false; error: string; details?: string };

export type DecisionRequest = {
  session_id: string;
  proposal_id: string;
  decision: "accept" | "reject" | "modify";
  reject_reason?: string;
  modified_text?: string;
};

export type DecisionResponse = {
  ok: true;
  updated_profile_summary: string;
};

export type InspectRequest = {
  document: AlfredDocument;
  session_id: string;
};

export type InspectResponse = {
  read: string;
  claims: number;
  evidence_links: number;
  orphans: string[];
  voice_fingerprint: StylometricSignals;
};

export type ProfileResponse = {
  profile: VoiceProfile;
  recent_log: SessionLogEntry[];
};
