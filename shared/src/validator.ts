// Voice Guardian. The architectural enforcement of "AI cannot freeform-write".
// Every proposal goes through this before reaching the user.
// Canonical single source — imported by the backend (and any future transport).

import type {
  AlfredDocument,
  Operator,
  VoiceCheck,
  VoiceProfile,
} from "./alfred-types.js";
import { applyOperators } from "./operators.js";
import { changeFraction, tokenCount, tokenizeLower } from "./tokenize.js";

const GLUE_TOKEN_LIMIT_PER_OP = 15;
const GLUE_TOKEN_LIMIT_TOTAL = 60;
const MIGRATE_CHANGE_LIMIT = 0.50;

export type ValidationFailure = {
  ok: false;
  reasons: string[];
};

export type ValidationOk = {
  ok: true;
  voice_check: VoiceCheck;
};

export function validateProposal(
  doc: AlfredDocument,
  ops: Operator[],
  profile: VoiceProfile
): ValidationOk | ValidationFailure {
  const reasons: string[] = [];
  const opValidations: VoiceCheck["operator_validations"] = [];
  const forbiddenSet = new Set(profile.forbidden_tokens.map((t) => t.toLowerCase()));
  const violatedTokens = new Set<string>();

  let glueTotal = 0;
  let migrateChangePct: number | null = null;

  // 1. Per-operator checks.
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    const opReasons: string[] = [];

    if (op.kind === "merge" && op.glue_text) {
      const c = tokenCount(op.glue_text);
      glueTotal += c;
      if (c > GLUE_TOKEN_LIMIT_PER_OP) {
        opReasons.push(`merge.glue_text exceeds ${GLUE_TOKEN_LIMIT_PER_OP} tokens (saw ${c})`);
      }
      for (const t of tokenizeLower(op.glue_text)) {
        if (forbiddenSet.has(t)) violatedTokens.add(t);
      }
    }

    if (op.kind === "glue") {
      const c = tokenCount(op.text);
      glueTotal += c;
      if (c > GLUE_TOKEN_LIMIT_PER_OP) {
        opReasons.push(`glue.text exceeds ${GLUE_TOKEN_LIMIT_PER_OP} tokens (saw ${c})`);
      }
      for (const t of tokenizeLower(op.text)) {
        if (forbiddenSet.has(t)) violatedTokens.add(t);
      }
    }

    if (op.kind === "migrate") {
      const original = doc.paragraphs.find((p) => p.id === op.paragraph_id)?.text ?? "";
      const pct = changeFraction(original, op.rewrite_text);
      migrateChangePct = Math.max(migrateChangePct ?? 0, pct);
      if (pct > MIGRATE_CHANGE_LIMIT) {
        opReasons.push(
          `migrate change-pct ${(pct * 100).toFixed(1)}% exceeds limit ${(MIGRATE_CHANGE_LIMIT * 100).toFixed(0)}%`
        );
      }
      for (const t of tokenizeLower(op.rewrite_text)) {
        if (forbiddenSet.has(t)) violatedTokens.add(t);
      }
    }

    opValidations.push(
      opReasons.length === 0
        ? { index: i, ok: true }
        : { index: i, ok: false, reason: opReasons.join("; ") }
    );
    reasons.push(...opReasons.map((r) => `op[${i}](${op.kind}): ${r}`));
  }

  // 2. Aggregate glue budget.
  if (glueTotal > GLUE_TOKEN_LIMIT_TOTAL) {
    reasons.push(
      `total glue tokens ${glueTotal} exceeds budget ${GLUE_TOKEN_LIMIT_TOTAL}`
    );
  }

  // 3. Forbidden tokens.
  if (violatedTokens.size > 0) {
    reasons.push(
      `forbidden tokens used: ${[...violatedTokens].join(", ")}`
    );
  }

  // 4. Topology validity — try to apply.
  try {
    applyOperators(doc, ops);
  } catch (err) {
    reasons.push(
      `topology error: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (reasons.length > 0) {
    return { ok: false, reasons };
  }

  return {
    ok: true,
    voice_check: {
      glue_budget_used: glueTotal,
      forbidden_tokens_violated: [...violatedTokens],
      migrate_change_pct: migrateChangePct,
      operator_validations: opValidations,
    },
  };
}

export function describeFailureForRetry(failure: ValidationFailure): string {
  return [
    "Your previous proposal was rejected by the voice guardian:",
    ...failure.reasons.map((r) => `- ${r}`),
    "",
    "Re-emit the proposal. Tighten glue. Stay within budget. Do not use forbidden tokens. Do not exceed migrate change limit.",
  ].join("\n");
}
