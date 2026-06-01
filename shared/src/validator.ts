// Voice Guardian. Architectural enforcement of "AI cannot freeform-write".
// Every proposal goes through this before reaching the user.

import type {
  AlfredDocument,
  AlfredProfile,
  Operator,
  ProposalInput,
  ValidationResult,
} from "./alfred-types.js";
import { applyOperators } from "./operators.js";
import { changeFraction, tokenCount, tokenizeLower } from "./tokenize.js";

const GLUE_TOKEN_LIMIT_PER_OP = 15;
const GLUE_TOKEN_LIMIT_TOTAL = 60;
const MIGRATE_CHANGE_LIMIT = 0.50;

export type ValidateProposalInput = {
  document: AlfredDocument;
  proposal: ProposalInput;
  profile?: AlfredProfile;
};

export type ValidateProposalResult = ValidationResult & {
  afterDocument?: AlfredDocument;
};

export function validateProposal(input: ValidateProposalInput): ValidateProposalResult {
  const { document: doc, proposal, profile } = input;
  const ops = proposal.operators;
  const errors: string[] = [];
  const warnings: string[] = [];

  const forbiddenSet = new Set(
    (profile?.forbidden_tokens ?? []).map((t) => t.toLowerCase())
  );

  let glueTotal = 0;
  let migrateChangePct: number | null = null;
  const opKinds: string[] = [];

  // 1. Per-operator checks.
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    opKinds.push(op.kind);

    if (op.kind === "merge" && op.glue_text) {
      const c = tokenCount(op.glue_text);
      glueTotal += c;
      if (c > GLUE_TOKEN_LIMIT_PER_OP) {
        errors.push(`op[${i}](merge): glue_text exceeds ${GLUE_TOKEN_LIMIT_PER_OP} tokens (saw ${c})`);
      }
      checkForbidden(op.glue_text, forbiddenSet, errors, i, "merge.glue_text");
    }

    if (op.kind === "glue") {
      const c = tokenCount(op.text);
      glueTotal += c;
      if (c > GLUE_TOKEN_LIMIT_PER_OP) {
        errors.push(`op[${i}](glue): text exceeds ${GLUE_TOKEN_LIMIT_PER_OP} tokens (saw ${c})`);
      }
      checkForbidden(op.text, forbiddenSet, errors, i, "glue.text");
    }

    if (op.kind === "migrate") {
      const original = doc.paragraphs.find((p) => p.id === op.paragraph_id)?.text ?? "";
      const pct = changeFraction(original, op.rewrite_text);
      migrateChangePct = Math.max(migrateChangePct ?? 0, pct);
      if (pct > MIGRATE_CHANGE_LIMIT) {
        errors.push(
          `op[${i}](migrate): change-pct ${(pct * 100).toFixed(1)}% exceeds limit ${(MIGRATE_CHANGE_LIMIT * 100).toFixed(0)}%`
        );
      }
      checkForbidden(op.rewrite_text, forbiddenSet, errors, i, "migrate.rewrite_text");
    }
  }

  // 2. Aggregate glue budget.
  if (glueTotal > GLUE_TOKEN_LIMIT_TOTAL) {
    errors.push(`total glue tokens ${glueTotal} exceeds budget ${GLUE_TOKEN_LIMIT_TOTAL}`);
  }

  // 3. Topology validity — try to apply.
  let afterDocument: AlfredDocument | undefined;
  try {
    afterDocument = applyOperators(doc, ops);
  } catch (err) {
    errors.push(`topology error: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 4. Warnings (non-blocking).
  if (migrateChangePct !== null && migrateChangePct > 0.3 && migrateChangePct <= MIGRATE_CHANGE_LIMIT) {
    warnings.push(`migrate change-pct ${(migrateChangePct * 100).toFixed(1)}% is approaching the 50% limit`);
  }

  const operatorSummary = opKinds.length > 0
    ? opKinds.join(" -> ")
    : "(no operators)";

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    operatorSummary,
    afterDocument,
  };
}

function checkForbidden(
  text: string,
  forbiddenSet: Set<string>,
  errors: string[],
  opIdx: number,
  field: string
): void {
  if (forbiddenSet.size === 0) return;
  const violated: string[] = [];
  for (const t of tokenizeLower(text)) {
    if (forbiddenSet.has(t)) violated.push(t);
  }
  if (violated.length > 0) {
    errors.push(`op[${opIdx}](${field}): forbidden tokens used: ${[...new Set(violated)].join(", ")}`);
  }
}
