// Canonical source: shared/src/. Kept in sync manually until workspace bundling is configured.
// Contains: operator parsing, application, validation, tokenization.

// --- Types (subset needed for runtime) ---

export type ParagraphRole = "intro" | "thesis" | "section_lead" | "supporting";

export type Paragraph = {
  id: string;
  text: string;
  role?: ParagraphRole;
  parent_id?: string;
};

export type AlfredDocument = {
  paragraphs: Paragraph[];
};

export type Position =
  | { kind: "after"; paragraph_id: string }
  | { kind: "at"; where: "start" | "end" };

export type Operator =
  | { kind: "split"; paragraph_id: string; after_sentence_index: number }
  | { kind: "merge"; first_paragraph_id: string; second_paragraph_id: string; glue_text?: string }
  | { kind: "move"; paragraph_id: string; target_position: Position }
  | { kind: "hoist"; paragraph_id: string; target_role: "intro" | "thesis" | "section_lead"; target_position: Position }
  | { kind: "demote"; paragraph_id: string; parent_paragraph_id: string }
  | { kind: "migrate"; paragraph_id: string; rewrite_text: string; change_budget_tokens: number }
  | { kind: "glue"; position: Position; text: string }
  | { kind: "delete"; paragraph_id: string };

export type VoiceCheck = {
  glue_budget_used: number;
  forbidden_tokens_violated: string[];
  migrate_change_pct: number | null;
  operator_validations: Array<{ index: number; ok: boolean; reason?: string }>;
};

export type VoiceProfile = {
  vibe_anchor: string;
  forbidden_tokens: string[];
  learned_preferences: unknown[];
  stylometric_signals?: unknown;
};

// --- Tokenizer ---

const TOKEN_RE = /[a-zA-Z0-9'\-]+|[.,;:!?()\[\]{}"]/g;

export function tokenize(text: string): string[] {
  return text.match(TOKEN_RE) ?? [];
}

export function tokenizeLower(text: string): string[] {
  return tokenize(text).map((t) => t.toLowerCase());
}

export function tokenCount(text: string): number {
  return tokenize(text).length;
}

export function tokenEditDistance(a: string[], b: string[], maxDistance = 1024): number {
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > maxDistance) return maxDistance + 1;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    let rowMin = curr[0]!;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
      if (curr[j]! < rowMin) rowMin = curr[j]!;
    }
    if (rowMin > maxDistance) return maxDistance + 1;
    [prev, curr] = [curr, prev];
  }
  return prev[n]!;
}

export function changeFraction(oldText: string, newText: string): number {
  const a = tokenize(oldText);
  const b = tokenize(newText);
  if (a.length === 0 && b.length === 0) return 0;
  const denom = Math.max(a.length, b.length);
  const dist = tokenEditDistance(a, b);
  return dist / denom;
}

// --- Operator parsing ---

function expectString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Invalid operator: ${field} must be a non-empty string`);
  }
  return value;
}

function expectFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid operator: ${field} must be a finite number`);
  }
  return value;
}

function parsePosition(raw: unknown, field: string): Position {
  if (!raw || typeof raw !== "object") {
    throw new Error(`Invalid operator: ${field} must be an object`);
  }
  const v = raw as Record<string, unknown>;
  if (v.kind === "after") {
    return { kind: "after", paragraph_id: expectString(v.paragraph_id, `${field}.paragraph_id`) };
  }
  if (v.kind === "at") {
    if (v.where !== "start" && v.where !== "end") {
      throw new Error(`Invalid operator: ${field}.where must be "start" or "end"`);
    }
    return { kind: "at", where: v.where };
  }
  throw new Error(`Invalid operator: ${field}.kind must be "after" or "at"`);
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
        target_role: expectString(input.target_role, "hoist.target_role") as "intro" | "thesis" | "section_lead",
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
      throw new Error(`Unknown operator: ${name}`);
  }
}

export function parseOperators(raw: unknown[]): Operator[] {
  if (!Array.isArray(raw)) throw new Error("operators must be an array");
  return raw.map((item, i) => {
    if (!item || typeof item !== "object") {
      throw new Error(`operators[${i}] must be an object`);
    }
    const obj = item as Record<string, unknown>;
    const kind = obj.kind;
    if (typeof kind !== "string") {
      throw new Error(`operators[${i}].kind must be a string`);
    }
    return parseOperator(kind, obj);
  });
}

// --- Operator application ---

const SENTENCE_RE = /(?<=[.!?])\s+(?=[A-Z"'(])/;

function splitSentences(text: string): string[] {
  return text.split(SENTENCE_RE).map((s) => s.trim()).filter(Boolean);
}

function indexOfParagraph(doc: AlfredDocument, id: string): number {
  return doc.paragraphs.findIndex((p) => p.id === id);
}

function insertAt(paragraphs: Paragraph[], para: Paragraph, target: Position): Paragraph[] {
  const out = [...paragraphs];
  if (target.kind === "at") {
    if (target.where === "start") out.unshift(para);
    else out.push(para);
    return out;
  }
  const idx = out.findIndex((p) => p.id === target.paragraph_id);
  if (idx < 0) throw new Error(`insertAt: target paragraph ${target.paragraph_id} not found`);
  out.splice(idx + 1, 0, para);
  return out;
}

function applyOne(doc: AlfredDocument, op: Operator): AlfredDocument {
  switch (op.kind) {
    case "split": {
      const idx = indexOfParagraph(doc, op.paragraph_id);
      if (idx < 0) throw new Error(`split: paragraph ${op.paragraph_id} not found`);
      const target = doc.paragraphs[idx]!;
      const sentences = splitSentences(target.text);
      if (op.after_sentence_index < 0 || op.after_sentence_index >= sentences.length - 1) {
        throw new Error(`split: after_sentence_index out of range`);
      }
      const first = sentences.slice(0, op.after_sentence_index + 1).join(" ");
      const second = sentences.slice(op.after_sentence_index + 1).join(" ");
      const newPara: Paragraph = { id: crypto.randomUUID(), text: second, role: target.role, parent_id: target.parent_id };
      const out = { paragraphs: [...doc.paragraphs] };
      out.paragraphs[idx] = { ...target, text: first };
      out.paragraphs.splice(idx + 1, 0, newPara);
      return out;
    }
    case "merge": {
      const firstIdx = indexOfParagraph(doc, op.first_paragraph_id);
      const secondIdx = indexOfParagraph(doc, op.second_paragraph_id);
      if (firstIdx < 0 || secondIdx < 0) throw new Error(`merge: paragraph not found`);
      const first = doc.paragraphs[firstIdx]!;
      const second = doc.paragraphs[secondIdx]!;
      const glue = op.glue_text?.trim() ?? "";
      const joined = glue.length > 0 ? `${first.text} ${glue} ${second.text}` : `${first.text} ${second.text}`;
      const out = { paragraphs: [...doc.paragraphs] };
      out.paragraphs[firstIdx] = { ...first, text: joined };
      out.paragraphs.splice(secondIdx, 1);
      return out;
    }
    case "move": {
      const idx = indexOfParagraph(doc, op.paragraph_id);
      if (idx < 0) throw new Error(`move: paragraph ${op.paragraph_id} not found`);
      const para = doc.paragraphs[idx]!;
      const without = doc.paragraphs.filter((_, i) => i !== idx);
      return { paragraphs: insertAt(without, para, op.target_position) };
    }
    case "hoist": {
      const idx = indexOfParagraph(doc, op.paragraph_id);
      if (idx < 0) throw new Error(`hoist: paragraph ${op.paragraph_id} not found`);
      const para = { ...doc.paragraphs[idx]!, role: op.target_role as ParagraphRole };
      const without = doc.paragraphs.filter((_, i) => i !== idx);
      return { paragraphs: insertAt(without, para, op.target_position) };
    }
    case "demote": {
      const idx = indexOfParagraph(doc, op.paragraph_id);
      if (idx < 0) throw new Error(`demote: paragraph ${op.paragraph_id} not found`);
      if (indexOfParagraph(doc, op.parent_paragraph_id) < 0) throw new Error(`demote: parent not found`);
      const out = { paragraphs: [...doc.paragraphs] };
      out.paragraphs[idx] = { ...out.paragraphs[idx]!, role: "supporting", parent_id: op.parent_paragraph_id };
      return out;
    }
    case "migrate": {
      const idx = indexOfParagraph(doc, op.paragraph_id);
      if (idx < 0) throw new Error(`migrate: paragraph ${op.paragraph_id} not found`);
      const out = { paragraphs: [...doc.paragraphs] };
      out.paragraphs[idx] = { ...out.paragraphs[idx]!, text: op.rewrite_text };
      return out;
    }
    case "glue": {
      const para: Paragraph = { id: crypto.randomUUID(), text: op.text };
      return { paragraphs: insertAt(doc.paragraphs, para, op.position) };
    }
    case "delete": {
      const idx = indexOfParagraph(doc, op.paragraph_id);
      if (idx < 0) throw new Error(`delete: paragraph ${op.paragraph_id} not found`);
      return { paragraphs: doc.paragraphs.filter((_, i) => i !== idx) };
    }
  }
}

export function applyOperators(doc: AlfredDocument, ops: Operator[]): AlfredDocument {
  let next: AlfredDocument = { paragraphs: doc.paragraphs.map((p) => ({ ...p })) };
  for (const op of ops) {
    next = applyOne(next, op);
  }
  return next;
}

// --- Validation ---

const GLUE_TOKEN_LIMIT_PER_OP = 15;
const GLUE_TOKEN_LIMIT_TOTAL = 60;
const MIGRATE_CHANGE_LIMIT = 0.50;

export type ValidationResult = {
  ok: boolean;
  voiceCheck?: VoiceCheck;
  reasons?: string[];
};

export function validateProposal(
  doc: AlfredDocument,
  ops: Operator[],
  profile: VoiceProfile
): ValidationResult {
  const reasons: string[] = [];
  const opValidations: VoiceCheck["operator_validations"] = [];
  const forbiddenSet = new Set(profile.forbidden_tokens.map((t) => t.toLowerCase()));
  const violatedTokens = new Set<string>();

  let glueTotal = 0;
  let migrateChangePct: number | null = null;

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
        opReasons.push(`migrate change-pct ${(pct * 100).toFixed(1)}% exceeds limit ${(MIGRATE_CHANGE_LIMIT * 100).toFixed(0)}%`);
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

  if (glueTotal > GLUE_TOKEN_LIMIT_TOTAL) {
    reasons.push(`total glue tokens ${glueTotal} exceeds budget ${GLUE_TOKEN_LIMIT_TOTAL}`);
  }

  if (violatedTokens.size > 0) {
    reasons.push(`forbidden tokens used: ${[...violatedTokens].join(", ")}`);
  }

  try {
    applyOperators(doc, ops);
  } catch (err) {
    reasons.push(`topology error: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (reasons.length > 0) {
    return { ok: false, reasons };
  }

  return {
    ok: true,
    voiceCheck: {
      glue_budget_used: glueTotal,
      forbidden_tokens_violated: [...violatedTokens],
      migrate_change_pct: migrateChangePct,
      operator_validations: opValidations,
    },
  };
}
