// Reward signal for the Alfred environment (RL-ENVIRONMENT §4–§5).
//
// Reward is a VECTOR of orthogonal invariants, not a single scalar (monism rejected).
// An action = a structural operation ∘ a generative patch; we judge each on Value
// (did it help?) × Integrity (did it avoid harm?). The deterministic axes are computed
// here; the neural/telemetry-dependent axes are null and documented:
//
//   Structure×Value      structural_survival   — null (needs editor telemetry, not backend-side)
//   Structure×Integrity  topological_valid     — hard floor (true once the Guardian admits it)
//   Content×Value        glue_retention        — fraction of ALFRED'S introduced tokens kept
//   Content×Integrity    voice_drift           — stylometric drift proposal→kept
//                        meaning_integrity     — null (NLI is a SOFT floor, neural; not implemented)
//
// Scalarization is LEXICOGRAPHIC, not weighted-sum: integrity gates, value ranks, and
// voice integrity CAPS value — voice is never traded for structure. Glue-only retention
// is the surgical anti-Goodhart fix: we score only the tokens ALFRED introduced, never
// the writer's rewrite of their OWN content.

import type { AlfredDocument, Operator } from "./types.js";
import { applyOperators } from "./operators.js";
import { changeFraction, tokenizeLower } from "./tokenize.js";
import { voiceDrift } from "./voice-drift.js";

export type Decision = "accept" | "reject" | "modify";

export type RewardComponents = {
  /** Content×Value: fraction of Alfred's INTRODUCED glue tokens the writer kept. null if no glue introduced. */
  glue_retention: number | null;
  /** Content×Integrity (voice): stylometric drift between the proposal and what the writer kept. */
  voice_drift: number | null;
  /** Structure×Value: did the structural footprint survive? null — needs editor telemetry. */
  structural_survival: number | null;
  /** Content×Integrity (meaning): NLI entailment. null — soft floor, neural sensor not implemented. */
  meaning_integrity: number | null;
  /** Structure×Integrity: hard floor. true once the Voice Guardian has admitted the proposal. */
  topological_valid: boolean;
};

export type Reward = {
  decision: Decision;
  /** lexicographic scalar in [-1, 1]: value, capped by voice integrity. */
  scalar: number;
  /** token-edit fraction between proposed result and what the writer kept (modify only) */
  edit_change_fraction: number | null;
  components: RewardComponents;
};

export function renderDocText(doc: AlfredDocument): string {
  return doc.paragraphs.map((p) => p.text).join("\n\n");
}

// The connective tissue ALFRED introduced — glue ops + merge glue. (migrate is reprojection,
// a separate axis, not "glue".)
function extractGlue(ops: Operator[]): string {
  const parts: string[] = [];
  for (const op of ops) {
    if (op.kind === "glue") parts.push(op.text);
    else if (op.kind === "merge" && op.glue_text) parts.push(op.glue_text);
  }
  return parts.join(" ");
}

function isWordTok(t: string): boolean {
  return /[a-z0-9]/i.test(t);
}

// Multiset retention of Alfred's glue word-tokens in the writer's kept text.
// null when Alfred introduced no glue (nothing of Alfred's to score on this axis).
function glueRetention(glue: string, kept: string): number | null {
  const need = new Map<string, number>();
  for (const t of tokenizeLower(glue).filter(isWordTok)) need.set(t, (need.get(t) ?? 0) + 1);
  if (need.size === 0) return null;
  const have = new Map<string, number>();
  for (const t of tokenizeLower(kept).filter(isWordTok)) have.set(t, (have.get(t) ?? 0) + 1);
  let total = 0;
  let retained = 0;
  for (const [t, n] of need) {
    total += n;
    retained += Math.min(n, have.get(t) ?? 0);
  }
  return total > 0 ? retained / total : null;
}

/**
 * Compute the reward vector for a decision.
 *
 * @param decision     accept | reject | modify
 * @param docAtPropose the document state Alfred acted on
 * @param operators    the operators Alfred proposed
 * @param modifiedText for `modify`: the text the writer ended up with
 */
export function computeReward(
  decision: Decision,
  docAtPropose: AlfredDocument,
  operators: Operator[],
  modifiedText?: string
): Reward {
  const base: RewardComponents = {
    glue_retention: null,
    voice_drift: null,
    structural_survival: null,
    meaning_integrity: null,
    topological_valid: true, // the proposal already passed the Voice Guardian upstream
  };

  if (decision === "accept") {
    const introducedGlue = extractGlue(operators).trim().length > 0;
    return {
      decision,
      scalar: 1,
      edit_change_fraction: 0,
      components: { ...base, glue_retention: introducedGlue ? 1 : null, voice_drift: 0 },
    };
  }

  if (decision === "reject") {
    return { decision, scalar: -1, edit_change_fraction: null, components: base };
  }

  // modify: grade by what survived of ALFRED's contribution, capped by voice integrity.
  if (!modifiedText || modifiedText.trim().length === 0) {
    return { decision, scalar: 0, edit_change_fraction: null, components: base };
  }

  let proposedText: string;
  try {
    proposedText = renderDocText(applyOperators(docAtPropose, operators));
  } catch {
    proposedText = renderDocText(docAtPropose);
  }

  const change = clamp01(changeFraction(proposedText, modifiedText));
  const gRet = glueRetention(extractGlue(operators), modifiedText);
  const vDrift = clamp01(voiceDrift(proposedText, modifiedText).composite);

  // Value: prefer high glue retention; if Alfred introduced no glue (pure structural
  // modify), fall back to overall survival (1 - 2*change).
  const value = gRet !== null ? 2 * gRet - 1 : 1 - 2 * change;
  // Integrity cap: voice drift erodes the reward — value cannot buy back lost voice.
  const scalar = clamp(Math.min(value, 1 - 2 * vDrift), -1, 1);

  return {
    decision,
    scalar,
    edit_change_fraction: change,
    components: { ...base, glue_retention: gRet, voice_drift: vDrift },
  };
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}
