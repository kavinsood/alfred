import type { Operator, Position } from "./types.js";

export function expectString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Invalid operator: ${field} must be a non-empty string, got ${JSON.stringify(value)}`);
  }
  return value;
}

export function expectFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid operator: ${field} must be a finite number, got ${JSON.stringify(value)}`);
  }
  return value;
}

export function expectEnum<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`Invalid operator: ${field} must be one of [${allowed.join(", ")}], got ${JSON.stringify(value)}`);
  }
  return value as T;
}

export function parsePosition(raw: unknown, field: string): Position {
  if (!raw || typeof raw !== "object") {
    throw new Error(`Invalid operator: ${field} must be an object, got ${JSON.stringify(raw)}`);
  }
  const v = raw as Record<string, unknown>;

  if (v.kind === "after") {
    if (typeof v.paragraph_id !== "string" || v.paragraph_id.trim() === "") {
      throw new Error(`Invalid operator: ${field}.paragraph_id must be a non-empty string when kind="after"`);
    }
    return { kind: "after", paragraph_id: v.paragraph_id };
  }
  if (v.kind === "at") {
    if (v.where !== "start" && v.where !== "end") {
      throw new Error(`Invalid operator: ${field}.where must be "start" or "end", got ${JSON.stringify(v.where)}`);
    }
    return { kind: "at", where: v.where };
  }

  throw new Error(`Invalid operator: ${field}.kind must be "after" or "at", got ${JSON.stringify(v.kind)}`);
}

export function parseOperator(name: string, input: Record<string, unknown>): Operator {
  switch (name) {
    case "split":
      return {
        kind: "split",
        paragraph_id: expectString(input.paragraph_id, "split.paragraph_id"),
        after_sentence_index: expectFiniteNumber(input.after_sentence_index, "split.after_sentence_index"),
      };
    case "merge":
      return {
        kind: "merge",
        first_paragraph_id: expectString(input.first_paragraph_id, "merge.first_paragraph_id"),
        second_paragraph_id: expectString(input.second_paragraph_id, "merge.second_paragraph_id"),
        glue_text: typeof input.glue_text === "string" ? input.glue_text : undefined,
      };
    case "move":
      return {
        kind: "move",
        paragraph_id: expectString(input.paragraph_id, "move.paragraph_id"),
        target_position: parsePosition(input.target_position, "move.target_position"),
      };
    case "hoist":
      return {
        kind: "hoist",
        paragraph_id: expectString(input.paragraph_id, "hoist.paragraph_id"),
        target_role: expectEnum(input.target_role, "hoist.target_role", ["intro", "thesis", "section_lead"] as const),
        target_position: parsePosition(input.target_position, "hoist.target_position"),
      };
    case "demote":
      return {
        kind: "demote",
        paragraph_id: expectString(input.paragraph_id, "demote.paragraph_id"),
        parent_paragraph_id: expectString(input.parent_paragraph_id, "demote.parent_paragraph_id"),
      };
    case "migrate":
      return {
        kind: "migrate",
        paragraph_id: expectString(input.paragraph_id, "migrate.paragraph_id"),
        rewrite_text: expectString(input.rewrite_text, "migrate.rewrite_text"),
        change_budget_tokens: expectFiniteNumber(input.change_budget_tokens, "migrate.change_budget_tokens"),
      };
    case "glue":
      return {
        kind: "glue",
        position: parsePosition(input.position, "glue.position"),
        text: expectString(input.text, "glue.text"),
      };
    case "delete":
      return { kind: "delete", paragraph_id: expectString(input.paragraph_id, "delete.paragraph_id") };
    default:
      throw new Error(`Invalid operator: unknown tool name ${JSON.stringify(name)}`);
  }
}
