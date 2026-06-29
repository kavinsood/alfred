// Client-side operator helpers.
//
// `applyOperators` and `splitSentences` are imported from the canonical shared
// algebra so the browser's diff projection is byte-identical to the server's.
// `randomId` (paragraph/session ids) and `describeOperator` (diff chip labels)
// are browser-only concerns and stay local.

import type { Operator, Position } from "./types";

export { applyOperators, splitSentences } from "@shared/src/operators";

export function randomId(): string {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

export function describeOperator(op: Operator, idLabel?: Map<string, string>): string {
  const label = (id: string) => idLabel?.get(id) ?? `${id.slice(0, 4)}…`;
  switch (op.kind) {
    case "split":
      return `split after sentence ${op.after_sentence_index + 1}`;
    case "merge":
      return op.glue_text && op.glue_text.trim()
        ? `merge ${label(op.first_paragraph_id)} + ${label(op.second_paragraph_id)} (glue ${op.glue_text.trim().split(/\s+/).length}t)`
        : `merge ${label(op.first_paragraph_id)} + ${label(op.second_paragraph_id)}`;
    case "move":
      return `move ${label(op.paragraph_id)} ${describePosition(op.target_position, idLabel)}`;
    case "hoist":
      return `hoist ${label(op.paragraph_id)} as ${op.target_role}`;
    case "demote":
      return `demote ${label(op.paragraph_id)}`;
    case "migrate":
      return `migrate ${label(op.paragraph_id)} (~${op.change_budget_tokens}t)`;
    case "glue":
      return `glue: "${op.text}"`;
    case "delete":
      return `delete ${label(op.paragraph_id)}`;
  }
}

function describePosition(p: Position, idLabel?: Map<string, string>): string {
  if (p.kind === "after") {
    const target = idLabel?.get(p.paragraph_id) ?? `${p.paragraph_id.slice(0, 4)}…`;
    return `→ after ${target}`;
  }
  return p.where === "start" ? "→ to top" : "→ to end";
}
