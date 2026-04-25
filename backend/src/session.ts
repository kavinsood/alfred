// In-memory session state. The "Managed Agent" framing: a single Alfred
// orchestrator session per open document. State persists across /api/propose
// calls within one server lifetime; rehydrates from the global voice profile.

import { v4 as uuidv4 } from "uuid";
import type {
  AlfredDocument,
  DecisionRequest,
  LearnedPreference,
  Operator,
  Proposal,
  SessionLogEntry,
  VoiceProfile,
} from "./types.js";
import { loadProfile } from "./profile.js";
import { appendSessionLog } from "./profile.js";

export type FewShotExample = {
  intent: string;
  rationale: string;
  operators_summary: string; // human-readable summary of the operators
  decision: "accept" | "reject" | "modify";
  reject_reason?: string;
};

export type SessionState = {
  id: string;
  created_at: string;
  proposal_index: Map<string, { proposal: Proposal; intent: string; doc_at_propose: AlfredDocument }>;
  hoarded: FewShotExample[]; // last N decisions
  log: SessionLogEntry[];
};

const HOARD_MAX = 12;

const sessions = new Map<string, SessionState>();

export function getOrCreateSession(id: string): SessionState {
  const existing = sessions.get(id);
  if (existing) return existing;
  const fresh: SessionState = {
    id,
    created_at: new Date().toISOString(),
    proposal_index: new Map(),
    hoarded: [],
    log: [],
  };
  sessions.set(id, fresh);
  return fresh;
}

export function getSession(id: string): SessionState {
  return getOrCreateSession(id);
}

export function recordProposal(
  sessionId: string,
  intent: string,
  doc: AlfredDocument,
  proposal: Proposal
): void {
  const s = getOrCreateSession(sessionId);
  s.proposal_index.set(proposal.id, { proposal, intent, doc_at_propose: doc });
}

export async function recordDecision(
  req: DecisionRequest
): Promise<{ profile: VoiceProfile; summary: string }> {
  const session = getOrCreateSession(req.session_id);
  const stored = session.proposal_index.get(req.proposal_id);
  if (!stored) {
    throw new Error(`unknown proposal_id ${req.proposal_id}`);
  }
  const { proposal, intent } = stored;
  const operatorsSummary = summarizeOperators(proposal.operators);

  const example: FewShotExample = {
    intent,
    rationale: proposal.rationale,
    operators_summary: operatorsSummary,
    decision: req.decision,
    reject_reason: req.reject_reason,
  };
  session.hoarded.push(example);
  if (session.hoarded.length > HOARD_MAX) {
    session.hoarded.splice(0, session.hoarded.length - HOARD_MAX);
  }

  const entry: SessionLogEntry = {
    proposal_id: proposal.id,
    ts: new Date().toISOString(),
    intent,
    decision: req.decision,
    reject_reason: req.reject_reason,
    rationale: proposal.rationale,
    operator_kinds: proposal.operators.map((o) => o.kind),
  };
  session.log.push(entry);
  await appendSessionLog(req.session_id, entry);

  // Update voice profile with a new learned preference if the signal is strong.
  const profile = await loadProfile();
  const updated = inferPreference(profile, example);

  const summary = describeProfileUpdate(updated, profile);
  return { profile: updated, summary };
}

function summarizeOperators(ops: Operator[]): string {
  return ops
    .map((op) => {
      switch (op.kind) {
        case "split":
          return `split ${op.paragraph_id} after sentence ${op.after_sentence_index}`;
        case "merge":
          return `merge ${op.first_paragraph_id}+${op.second_paragraph_id}${op.glue_text ? ` (glue: "${op.glue_text}")` : ""}`;
        case "move":
          return `move ${op.paragraph_id} to ${describePosition(op.target_position)}`;
        case "hoist":
          return `hoist ${op.paragraph_id} as ${op.target_role} to ${describePosition(op.target_position)}`;
        case "demote":
          return `demote ${op.paragraph_id} under ${op.parent_paragraph_id}`;
        case "migrate":
          return `migrate ${op.paragraph_id} (Δ${op.change_budget_tokens} tokens)`;
        case "glue":
          return `glue at ${describePosition(op.position)}: "${op.text}"`;
        case "delete":
          return `delete ${op.paragraph_id}`;
      }
    })
    .join("; ");
}

function describePosition(p: { kind: string; paragraph_id?: string; where?: string }): string {
  if (p.kind === "after") return `after ${p.paragraph_id}`;
  return `at ${p.where}`;
}

function inferPreference(profile: VoiceProfile, ex: FewShotExample): VoiceProfile {
  // Heuristic: a single accept/reject is a weak signal. We look for repeated patterns
  // in the operator kinds. For v1, we keep this lightweight: track simple rules.
  const rules = [...profile.learned_preferences];
  const opsSummary = ex.operators_summary.toLowerCase();
  const ts = new Date().toISOString();

  const candidates: Array<{ rule: string; matched: boolean }> = [
    {
      rule: "rejects merges with non-empty glue",
      matched: ex.decision === "reject" && opsSummary.includes("merge") && opsSummary.includes("glue:"),
    },
    {
      rule: "accepts hoists to intro/thesis",
      matched: ex.decision === "accept" && opsSummary.includes("hoist") && (opsSummary.includes("intro") || opsSummary.includes("thesis")),
    },
    {
      rule: "rejects deletes (prefers move/demote over kill)",
      matched: ex.decision === "reject" && opsSummary.includes("delete"),
    },
    {
      rule: "accepts splits at sentence boundaries",
      matched: ex.decision === "accept" && opsSummary.includes("split"),
    },
    {
      rule: "accepts migrates under 30% change",
      matched: ex.decision === "accept" && opsSummary.includes("migrate"),
    },
  ];

  for (const c of candidates) {
    if (!c.matched) continue;
    const idx = rules.findIndex((r) => r.rule === c.rule);
    if (idx >= 0) {
      rules[idx] = {
        ...rules[idx]!,
        evidence_count: rules[idx]!.evidence_count + 1,
        inferred_at: ts,
      };
    } else {
      rules.push({
        id: uuidv4(),
        rule: c.rule,
        evidence_count: 1,
        example_quote: ex.rationale,
        inferred_at: ts,
      });
    }
  }

  return { ...profile, learned_preferences: rules };
}

function describeProfileUpdate(updated: VoiceProfile, prev: VoiceProfile): string {
  const newRules = updated.learned_preferences.length - prev.learned_preferences.length;
  const reinforced = updated.learned_preferences.filter((u) => {
    const old = prev.learned_preferences.find((p) => p.id === u.id);
    return old && old.evidence_count < u.evidence_count;
  }).length;
  if (newRules === 0 && reinforced === 0) return "no profile changes";
  const parts: string[] = [];
  if (newRules > 0) parts.push(`${newRules} new rule${newRules === 1 ? "" : "s"}`);
  if (reinforced > 0) parts.push(`${reinforced} rule${reinforced === 1 ? "" : "s"} reinforced`);
  return parts.join(", ");
}

export function buildHoardedContext(sessionId: string): string {
  const s = getOrCreateSession(sessionId);
  if (s.hoarded.length === 0) return "(no prior decisions in this session)";
  return s.hoarded
    .map((ex, i) => {
      return [
        `### Past decision ${i + 1}`,
        `intent: ${ex.intent}`,
        `proposed: ${ex.operators_summary}`,
        `rationale: ${ex.rationale}`,
        `decision: ${ex.decision.toUpperCase()}${ex.reject_reason ? ` — ${ex.reject_reason}` : ""}`,
      ].join("\n");
    })
    .join("\n\n");
}
