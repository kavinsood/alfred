// Shared types between frontend and backend.
// Imported by `frontend/src/lib/types.ts` and `backend/src/types.ts`.

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

// --- Proposal envelope ---

export type VoiceCheck = {
  glue_budget_used: number;
  forbidden_tokens_violated: string[];
  migrate_change_pct: number | null;
  // For each operator, whether it passed validation.
  operator_validations: Array<{ index: number; ok: boolean; reason?: string }>;
};

export type Proposal = {
  id: string; // server-generated UUID
  rationale: string;
  operators: Operator[];
  voice_check: VoiceCheck;
  alfred_says: string; // 1-2 sentence editorial commentary
};

// --- Voice profile ---

export type LearnedPreference = {
  id: string;
  rule: string;
  evidence_count: number;
  example_quote?: string;
  // free-form context the model produced when inferring
  inferred_at: string; // ISO date
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

// --- Session ---

export type SessionLogEntry = {
  proposal_id: string;
  ts: string; // ISO date
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
