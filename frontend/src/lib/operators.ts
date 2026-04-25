// Client-side mirror of backend operator application. Used to apply accepted
// proposals to the in-memory Document.

import type { AlfredDocument, Operator, Paragraph, Position } from "./types";

const SENTENCE_RE = /(?<=[.!?])\s+(?=[A-Z"'(])/;

export function splitSentences(text: string): string[] {
  return text.split(SENTENCE_RE).map((s) => s.trim()).filter(Boolean);
}

export function applyOperators(doc: AlfredDocument, ops: Operator[]): AlfredDocument {
  let next: AlfredDocument = { paragraphs: doc.paragraphs.map((p) => ({ ...p })) };
  for (const op of ops) {
    next = applyOne(next, op);
  }
  return next;
}

function indexOf(doc: AlfredDocument, id: string): number {
  return doc.paragraphs.findIndex((p) => p.id === id);
}

function applyOne(doc: AlfredDocument, op: Operator): AlfredDocument {
  switch (op.kind) {
    case "split": {
      const idx = indexOf(doc, op.paragraph_id);
      if (idx < 0) return doc;
      const target = doc.paragraphs[idx]!;
      const sentences = splitSentences(target.text);
      const after = Math.max(0, Math.min(op.after_sentence_index, sentences.length - 2));
      const first = sentences.slice(0, after + 1).join(" ");
      const second = sentences.slice(after + 1).join(" ");
      const newPara: Paragraph = { id: randomId(), text: second, role: target.role, parent_id: target.parent_id };
      const out = [...doc.paragraphs];
      out[idx] = { ...target, text: first };
      out.splice(idx + 1, 0, newPara);
      return { paragraphs: out };
    }
    case "merge": {
      const a = indexOf(doc, op.first_paragraph_id);
      const b = indexOf(doc, op.second_paragraph_id);
      if (a < 0 || b < 0) return doc;
      const first = doc.paragraphs[a]!;
      const second = doc.paragraphs[b]!;
      const glue = (op.glue_text ?? "").trim();
      const joined = glue.length > 0 ? `${first.text} ${glue} ${second.text}` : `${first.text} ${second.text}`;
      const out = [...doc.paragraphs];
      out[a] = { ...first, text: joined };
      out.splice(b, 1);
      return { paragraphs: out };
    }
    case "move": {
      const idx = indexOf(doc, op.paragraph_id);
      if (idx < 0) return doc;
      const para = doc.paragraphs[idx]!;
      const without = doc.paragraphs.filter((_, i) => i !== idx);
      return { paragraphs: insertAt(without, para, op.target_position) };
    }
    case "hoist": {
      const idx = indexOf(doc, op.paragraph_id);
      if (idx < 0) return doc;
      const para = { ...doc.paragraphs[idx]!, role: op.target_role };
      const without = doc.paragraphs.filter((_, i) => i !== idx);
      return { paragraphs: insertAt(without, para, op.target_position) };
    }
    case "demote": {
      const idx = indexOf(doc, op.paragraph_id);
      if (idx < 0 || indexOf(doc, op.parent_paragraph_id) < 0) return doc;
      const out = [...doc.paragraphs];
      out[idx] = { ...out[idx]!, role: "supporting", parent_id: op.parent_paragraph_id };
      return { paragraphs: out };
    }
    case "migrate": {
      const idx = indexOf(doc, op.paragraph_id);
      if (idx < 0) return doc;
      const out = [...doc.paragraphs];
      out[idx] = { ...out[idx]!, text: op.rewrite_text };
      return { paragraphs: out };
    }
    case "glue": {
      const para: Paragraph = { id: randomId(), text: op.text };
      return { paragraphs: insertAt(doc.paragraphs, para, op.position) };
    }
    case "delete": {
      const idx = indexOf(doc, op.paragraph_id);
      if (idx < 0) return doc;
      return { paragraphs: doc.paragraphs.filter((_, i) => i !== idx) };
    }
    default: {
      const _exhaustive: never = op;
      return doc;
    }
  }
}

function insertAt(paragraphs: Paragraph[], para: Paragraph, target: Position): Paragraph[] {
  const out = [...paragraphs];
  if (target.kind === "at") {
    if (target.where === "start") out.unshift(para);
    else out.push(para);
    return out;
  }
  const idx = out.findIndex((p) => p.id === target.paragraph_id);
  if (idx < 0) {
    out.push(para);
    return out;
  }
  out.splice(idx + 1, 0, para);
  return out;
}

export function randomId(): string {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

export function describeOperator(op: Operator, idLabel?: Map<string, string>): string {
  const label = (id: string) =>
    idLabel?.get(id) ?? `${id.slice(0, 4)}…`;
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
