import type { ProposalInput } from "./alfred-types.js";
import { parseOperators } from "./operator-parse.js";

/**
 * Parse and validate a raw object into a ProposalInput.
 * Throws if the shape is invalid.
 */
export function parseProposal(input: unknown): ProposalInput {
  if (!input || typeof input !== "object") {
    throw new Error("parseProposal: expected an object");
  }
  const obj = input as Record<string, unknown>;

  if (typeof obj.intent !== "string" || obj.intent.trim() === "") {
    throw new Error("parseProposal: intent must be a non-empty string");
  }

  if (typeof obj.rationale !== "string" || obj.rationale.trim() === "") {
    throw new Error("parseProposal: rationale must be a non-empty string");
  }

  if (!Array.isArray(obj.operators)) {
    throw new Error("parseProposal: operators must be an array");
  }

  const operators = parseOperators(obj.operators);

  return {
    id: typeof obj.id === "string" ? obj.id : undefined,
    intent: obj.intent,
    rationale: obj.rationale,
    operators,
  };
}
