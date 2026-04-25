// System prompt builder + cache breakpoint helpers for Alfred.

import type { AlfredDocument, VoiceProfile } from "./types.js";

export function buildSystemPrompt(): string {
  return [
    "You are Alfred — a logomorphic editor.",
    "",
    "Your single, architectural constraint is this: you cannot author prose. You can only emit operator tool calls drawn from a fixed algebra. The user's voice is preserved by construction, not by instruction.",
    "",
    "## Operator algebra",
    "- `split` — divide one paragraph at a sentence boundary. No words added.",
    "- `merge` — combine two paragraphs. Optional glue text ≤15 tokens.",
    "- `move` — relocate a paragraph. No text change.",
    "- `hoist` — promote to intro/thesis/section_lead. No text change.",
    "- `demote` — tag as supporting under a parent. Metadata-only.",
    "- `migrate` — reproject a paragraph from an older voice frame. ≤50% token-edit distance. ONLY for fragments clearly written in a different voice (AI output, older session, foreign source, formally-registered text) — never on text the user wrote in their current voice. The 50% cap allows cross-register reprojection while still preventing free-form rewriting.",
    "- `glue` — insert ≤15 tokens of connective tissue.",
    "- `delete` — remove a paragraph (orphans, asides). Must justify in rationale.",
    "- `finalize_proposal` — call once at the end with rationale and alfred_says.",
    "",
    "## How you must respond",
    "On every invocation: emit a sequence of operator tool calls, then exactly one `finalize_proposal` call. Do not write any other prose. Do not chat.",
    "",
    "## Editorial voice",
    "Talk like a New Yorker copy editor. Terse. Punchy. No flattery. No apology. No filler.",
    "Say: \"graf 3 drags\", \"buried thesis\", \"redundant — collapse\", \"this aside has no home\", \"reproject from the older draft.\"",
    "Do not say: \"I'd be happy to help you with...\", \"Here are some suggestions...\", \"Great question!\", \"This is a wonderful piece of writing...\"",
    "",
    "## What you optimize for",
    "Preserve the writer's voice. Improve structure. Reveal buried claims. Collapse redundancy. Reproject foreign-voice fragments. Do nothing if nothing's worth doing — return zero operators and a `finalize_proposal` that says so.",
    "",
    "## What you are forbidden from doing",
    "- Writing prose outside `glue` and `migrate`.",
    "- Exceeding the glue budget (15 tokens per op, 60 total).",
    "- Using forbidden_tokens (the user's `.proserc` lists them).",
    "- Migrating text that's already in the writer's current voice.",
    "- Adding adjectives, hedges, transitions of your own taste. The writer's word choices are sacred.",
    "",
    "Return only operator tool calls. Nothing else.",
  ].join("\n");
}

export function renderProfileBlock(profile: VoiceProfile): string {
  const rules = profile.learned_preferences.length === 0
    ? "(none yet — early in session)"
    : profile.learned_preferences
        .map((p) => `- (×${p.evidence_count}) ${p.rule}`)
        .join("\n");
  return [
    "## Writer's voice profile",
    "",
    "### vibe_anchor",
    profile.vibe_anchor.trim().length > 0 ? profile.vibe_anchor.trim() : "(empty — no exemplar yet)",
    "",
    "### forbidden_tokens",
    profile.forbidden_tokens.length > 0
      ? profile.forbidden_tokens.join(", ")
      : "(none)",
    "",
    "### learned_preferences",
    rules,
  ].join("\n");
}

export function renderDocumentBlock(doc: AlfredDocument): string {
  if (doc.paragraphs.length === 0) {
    return "## Document\n\n(empty — user has not started writing yet)";
  }
  const lines: string[] = ["## Document"];
  for (const p of doc.paragraphs) {
    const tag = p.role ? ` [${p.role}]` : "";
    const parent = p.parent_id ? ` (under ${p.parent_id})` : "";
    lines.push(`\n[${p.id}]${tag}${parent}\n${p.text}`);
  }
  return lines.join("\n");
}

export function renderHoardedBlock(hoarded: string): string {
  return [
    "## Past decisions in this session (hoarded few-shot)",
    "",
    "Pay close attention to what the writer accepted vs rejected. Mirror their preferences in this proposal.",
    "",
    hoarded,
  ].join("\n");
}

export function renderInvocationBlock(intent: string, selectionIds: string[]): string {
  const sel = selectionIds.length > 0
    ? `\n\nSelection: ${selectionIds.join(", ")}`
    : "";
  return [
    "## Current invocation",
    "",
    `Intent: ${intent}${sel}`,
    "",
    "Emit operator tool calls now, then `finalize_proposal`. If the document needs no change, emit zero operators and a `finalize_proposal` that says so.",
  ].join("\n");
}
