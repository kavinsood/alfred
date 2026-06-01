// Operator tool definitions for Anthropic tool-use, plus pure functions
// that apply operators to an AlfredDocument.

import type { AlfredDocument, Operator, Paragraph, Position } from "./types.js";

// --- Anthropic tool schemas ------------------------------------------------

export const POSITION_SCHEMA = {
  oneOf: [
    {
      type: "object",
      required: ["kind", "paragraph_id"],
      properties: {
        kind: { type: "string", const: "after" },
        paragraph_id: { type: "string" },
      },
      additionalProperties: false,
    },
    {
      type: "object",
      required: ["kind", "where"],
      properties: {
        kind: { type: "string", const: "at" },
        where: { type: "string", enum: ["start", "end"] },
      },
      additionalProperties: false,
    },
  ],
};

export const TOOL_DEFS = [
  {
    name: "split",
    description:
      "Divide one paragraph into two at a sentence boundary. Adds NO new words. Use when a paragraph fuses two distinct ideas.",
    input_schema: {
      type: "object",
      required: ["paragraph_id", "after_sentence_index"],
      properties: {
        paragraph_id: { type: "string" },
        after_sentence_index: { type: "integer", minimum: 0 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "merge",
    description:
      "Combine two paragraphs into one. Optional glue_text is at most 15 tokens and serves only as connective tissue. Use to collapse redundant claims.",
    input_schema: {
      type: "object",
      required: ["first_paragraph_id", "second_paragraph_id"],
      properties: {
        first_paragraph_id: { type: "string" },
        second_paragraph_id: { type: "string" },
        glue_text: { type: "string", maxLength: 200 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "move",
    description:
      "Relocate a paragraph to a new position. No text alteration. Use to fix flow.",
    input_schema: {
      type: "object",
      required: ["paragraph_id", "target_position"],
      properties: {
        paragraph_id: { type: "string" },
        target_position: POSITION_SCHEMA,
      },
      additionalProperties: false,
    },
  },
  {
    name: "hoist",
    description:
      "Move a paragraph to a higher structural role (intro / thesis / section_lead). Like 'move' plus a structural-role tag.",
    input_schema: {
      type: "object",
      required: ["paragraph_id", "target_role", "target_position"],
      properties: {
        paragraph_id: { type: "string" },
        target_role: {
          type: "string",
          enum: ["intro", "thesis", "section_lead"],
        },
        target_position: POSITION_SCHEMA,
      },
      additionalProperties: false,
    },
  },
  {
    name: "demote",
    description:
      "Tag a paragraph as supporting content under a parent claim. Metadata-only; no prose change.",
    input_schema: {
      type: "object",
      required: ["paragraph_id", "parent_paragraph_id"],
      properties: {
        paragraph_id: { type: "string" },
        parent_paragraph_id: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "migrate",
    description:
      "Reproject a paragraph from an older voice/coordinate frame into the current voice profile. The ONLY operator that may rewrite words. Change is capped at 50% token-edit distance. Use only on fragments clearly written in a different voice (e.g., AI output, older session, foreign source).",
    input_schema: {
      type: "object",
      required: ["paragraph_id", "rewrite_text", "change_budget_tokens"],
      properties: {
        paragraph_id: { type: "string" },
        rewrite_text: { type: "string" },
        change_budget_tokens: { type: "integer", minimum: 0 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "glue",
    description:
      "Insert minimal connective text (≤15 tokens) to bridge structural moves.",
    input_schema: {
      type: "object",
      required: ["position", "text"],
      properties: {
        position: POSITION_SCHEMA,
        text: { type: "string", maxLength: 200 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "delete",
    description:
      "Remove a paragraph (e.g., a clearly-orphaned aside). Must include rationale in the proposal.",
    input_schema: {
      type: "object",
      required: ["paragraph_id"],
      properties: { paragraph_id: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "finalize_proposal",
    description:
      "Emit the editorial commentary and rationale once all operator calls are made. Call this exactly once, AFTER all operator tool calls. The proposal is not complete without this call.",
    input_schema: {
      type: "object",
      required: ["rationale", "alfred_says"],
      properties: {
        rationale: {
          type: "string",
          description:
            "1-2 sentences. Editorial voice (e.g., 'Graf 3 drags. Hoisting the strongest claim to the lede.'). No flattery.",
        },
        alfred_says: {
          type: "string",
          description:
            "1-2 sentences shown to the user above the diff. Crisper than rationale.",
        },
      },
      additionalProperties: false,
    },
  },
] as const;

// --- Pure operator application --------------------------------------------

export function applyOperators(doc: AlfredDocument, ops: Operator[]): AlfredDocument {
  let next: AlfredDocument = cloneDoc(doc);
  for (const op of ops) {
    next = applyOne(next, op);
  }
  return next;
}

function cloneDoc(doc: AlfredDocument): AlfredDocument {
  return { paragraphs: doc.paragraphs.map((p) => ({ ...p })) };
}

function indexOfParagraph(doc: AlfredDocument, id: string): number {
  return doc.paragraphs.findIndex((p) => p.id === id);
}

function applyOne(doc: AlfredDocument, op: Operator): AlfredDocument {
  switch (op.kind) {
    case "split":
      return applySplit(doc, op.paragraph_id, op.after_sentence_index);
    case "merge":
      return applyMerge(doc, op.first_paragraph_id, op.second_paragraph_id, op.glue_text ?? "");
    case "move":
      return applyMove(doc, op.paragraph_id, op.target_position);
    case "hoist":
      return applyHoist(doc, op.paragraph_id, op.target_role, op.target_position);
    case "demote":
      return applyDemote(doc, op.paragraph_id, op.parent_paragraph_id);
    case "migrate":
      return applyMigrate(doc, op.paragraph_id, op.rewrite_text);
    case "glue":
      return applyGlue(doc, op.position, op.text);
    case "delete":
      return applyDelete(doc, op.paragraph_id);
    default: {
      const _exhaustive: never = op;
      throw new Error(`unknown operator: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

// crude sentence splitter — good enough for paragraph-internal split points
const SENTENCE_RE = /(?<=[.!?])\s+(?=[A-Z"'(])/;

export function splitSentences(text: string): string[] {
  return text.split(SENTENCE_RE).map((s) => s.trim()).filter(Boolean);
}

function applySplit(doc: AlfredDocument, id: string, afterIdx: number): AlfredDocument {
  const idx = indexOfParagraph(doc, id);
  if (idx < 0) throw new Error(`split: paragraph ${id} not found`);
  const target = doc.paragraphs[idx]!;
  const sentences = splitSentences(target.text);
  if (afterIdx < 0 || afterIdx >= sentences.length - 1) {
    throw new Error(`split: after_sentence_index ${afterIdx} out of range (max ${sentences.length - 2})`);
  }
  const first = sentences.slice(0, afterIdx + 1).join(" ");
  const second = sentences.slice(afterIdx + 1).join(" ");
  const newPara: Paragraph = {
    id: cryptoRandomId(),
    text: second,
    role: target.role,
    parent_id: target.parent_id,
  };
  const out = { paragraphs: [...doc.paragraphs] };
  out.paragraphs[idx] = { ...target, text: first };
  out.paragraphs.splice(idx + 1, 0, newPara);
  return out;
}

function applyMerge(
  doc: AlfredDocument,
  firstId: string,
  secondId: string,
  glue: string
): AlfredDocument {
  const firstIdx = indexOfParagraph(doc, firstId);
  const secondIdx = indexOfParagraph(doc, secondId);
  if (firstIdx < 0) throw new Error(`merge: paragraph ${firstId} not found`);
  if (secondIdx < 0) throw new Error(`merge: paragraph ${secondId} not found`);
  const first = doc.paragraphs[firstIdx]!;
  const second = doc.paragraphs[secondIdx]!;
  const joined =
    glue.trim().length > 0
      ? `${first.text} ${glue.trim()} ${second.text}`
      : `${first.text} ${second.text}`;
  const out = { paragraphs: [...doc.paragraphs] };
  out.paragraphs[firstIdx] = { ...first, text: joined };
  out.paragraphs.splice(secondIdx, 1);
  return out;
}

function applyMove(doc: AlfredDocument, id: string, target: Position): AlfredDocument {
  const idx = indexOfParagraph(doc, id);
  if (idx < 0) throw new Error(`move: paragraph ${id} not found`);
  const para = doc.paragraphs[idx]!;
  const without = doc.paragraphs.filter((_, i) => i !== idx);
  return { paragraphs: insertAt(without, para, target) };
}

function applyHoist(
  doc: AlfredDocument,
  id: string,
  role: "intro" | "thesis" | "section_lead",
  target: Position
): AlfredDocument {
  const idx = indexOfParagraph(doc, id);
  if (idx < 0) throw new Error(`hoist: paragraph ${id} not found`);
  const para = { ...doc.paragraphs[idx]!, role };
  const without = doc.paragraphs.filter((_, i) => i !== idx);
  return { paragraphs: insertAt(without, para, target) };
}

function applyDemote(doc: AlfredDocument, id: string, parentId: string): AlfredDocument {
  const idx = indexOfParagraph(doc, id);
  if (idx < 0) throw new Error(`demote: paragraph ${id} not found`);
  if (indexOfParagraph(doc, parentId) < 0) throw new Error(`demote: parent ${parentId} not found`);
  const out = { paragraphs: [...doc.paragraphs] };
  out.paragraphs[idx] = { ...out.paragraphs[idx]!, role: "supporting", parent_id: parentId };
  return out;
}

function applyMigrate(doc: AlfredDocument, id: string, rewrite: string): AlfredDocument {
  const idx = indexOfParagraph(doc, id);
  if (idx < 0) throw new Error(`migrate: paragraph ${id} not found`);
  const out = { paragraphs: [...doc.paragraphs] };
  out.paragraphs[idx] = { ...out.paragraphs[idx]!, text: rewrite };
  return out;
}

function applyGlue(doc: AlfredDocument, position: Position, text: string): AlfredDocument {
  const para: Paragraph = { id: cryptoRandomId(), text };
  return { paragraphs: insertAt(doc.paragraphs, para, position) };
}

function applyDelete(doc: AlfredDocument, id: string): AlfredDocument {
  const idx = indexOfParagraph(doc, id);
  if (idx < 0) throw new Error(`delete: paragraph ${id} not found`);
  return { paragraphs: doc.paragraphs.filter((_, i) => i !== idx) };
}

function insertAt(paragraphs: Paragraph[], para: Paragraph, target: Position): Paragraph[] {
  const out = [...paragraphs];
  if (target.kind === "at") {
    if (target.where === "start") {
      out.unshift(para);
    } else {
      out.push(para);
    }
    return out;
  }
  const idx = out.findIndex((p) => p.id === target.paragraph_id);
  if (idx < 0) throw new Error(`insertAt: target paragraph ${target.paragraph_id} not found`);
  out.splice(idx + 1, 0, para);
  return out;
}

export function cryptoRandomId(): string {
  return (
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2, 8) +
    Math.random().toString(36).slice(2, 6)
  );
}
