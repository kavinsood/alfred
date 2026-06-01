// Pure functions that apply operators to an AlfredDocument.

import type { AlfredDocument, Operator, Paragraph, Position } from "./alfred-types.js";

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
    id: crypto.randomUUID(),
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
  const para: Paragraph = { id: crypto.randomUUID(), text };
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
