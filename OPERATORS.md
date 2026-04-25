# Operator Algebra

Alfred's IR. The action space of the AI. Every proposal Alfred returns must decompose into a sequence of these operators. The AI cannot emit free prose; it can only emit operator calls (Anthropic tool use).

## The seven operators

### 1. `split`
Divide one paragraph into two at a specified sentence boundary.
- **Args:**
  - `paragraph_id`: string (the paragraph to split)
  - `after_sentence_index`: number (0-indexed; split after this sentence)
- **Effect:** Original paragraph keeps sentences `[0..after_sentence_index]`; new paragraph contains `[after_sentence_index+1..]`. New paragraph gets a new ID and is inserted immediately after.
- **Constraint:** No words are added, removed, or changed.

### 2. `merge`
Combine two paragraphs into one. Must be adjacent in the final ordering OR explicitly call `move` first.
- **Args:**
  - `first_paragraph_id`: string
  - `second_paragraph_id`: string
  - `glue_text`: string, optional, ≤15 tokens, default empty
- **Effect:** First paragraph absorbs second. Glue inserted between if provided. Second paragraph removed.
- **Constraint:** No words from either paragraph are altered. Glue must be ≤15 tokens, validated server-side.

### 3. `move`
Relocate a paragraph to a new position.
- **Args:**
  - `paragraph_id`: string
  - `target_position`: `{ after: paragraph_id }` | `{ at: "start" }` | `{ at: "end" }`
- **Effect:** Paragraph is removed from current position and inserted at the target.
- **Constraint:** No text alteration.

### 4. `hoist`
Promote a paragraph to a higher structural role (move it to intro / thesis position) and optionally tag it.
- **Args:**
  - `paragraph_id`: string
  - `target_role`: `"intro" | "thesis" | "section_lead"`
  - `target_position`: same shape as `move`'s target_position
- **Effect:** A `move` plus a structural-role tag (stored in document metadata, not visible in prose).
- **Constraint:** Same as move. No prose change.

### 5. `demote`
Make a claim into supporting material under a parent claim.
- **Args:**
  - `paragraph_id`: string
  - `parent_paragraph_id`: string
- **Effect:** Tag the paragraph as supporting content for the parent (metadata only). Optionally moves it to be adjacent to parent. No visible change to prose.
- **Constraint:** No prose change.

### 6. `migrate`
Reproject a paragraph from an older voice / coordinate frame into the current voice profile. This is the only operator that can rewrite words, and it must do so within a strict glue budget.
- **Args:**
  - `paragraph_id`: string
  - `rewrite_text`: string (the new version)
  - `change_budget_tokens`: number (estimated # of tokens changed; max 30% of the paragraph's token count)
- **Effect:** Replace the paragraph's text with `rewrite_text`.
- **Constraint:** `change_budget_tokens` ≤ 30% of original token count. Server validates: tokenize both, count unchanged tokens, fail if > 30% changed. Vocabulary and tone must align with `vibe_anchor`. Forbidden tokens must not appear.
- **Use only when:** the user's `migrate` is invoked on a fragment from a clearly-different coordinate frame (different voice, older session, AI-generated source). Do not migrate paragraphs the user wrote in current voice.

### 7. `glue`
Insert minimal connective text to bridge two paragraphs after structural moves.
- **Args:**
  - `position`: `{ after: paragraph_id }` | `{ at_start_of: paragraph_id }`
  - `text`: string, ≤15 tokens
- **Effect:** Insert as a new short paragraph or as a prefix to the target paragraph.
- **Constraint:** ≤15 tokens, validated server-side.

## Optional auxiliary

### `delete`
Remove a paragraph. Used when Alfred proposes killing an orphan claim.
- **Args:**
  - `paragraph_id`: string
- **Effect:** Paragraph removed from document.
- **Constraint:** Alfred must have explained why in the proposal's `rationale` field.

### `inspect` (no document mutation)
Used when the user asks Alfred to report on the document without proposing changes.
- **Returns:** a structured read of the document — claim count, evidence map, orphans, voice fingerprint.

## Proposal envelope (what the AI returns)
Every Cmd+K invocation returns this shape:
```ts
type Proposal = {
  rationale: string;          // 1-2 sentences, editorial voice ("graf 3 drags...")
  operators: Operator[];      // sequence of operator calls, applied in order
  voice_check: {              // server fills this; AI doesn't
    glue_budget_used: number;
    forbidden_tokens_violated: string[];
    migrate_change_pct: number | null;
  };
};

type Operator =
  | { kind: "split"; ... }
  | { kind: "merge"; ... }
  | { kind: "move"; ... }
  | { kind: "hoist"; ... }
  | { kind: "demote"; ... }
  | { kind: "migrate"; ... }
  | { kind: "glue"; ... }
  | { kind: "delete"; ... };
```

## Validation pipeline (the Voice Guardian)
Before showing a proposal to the user, the backend runs:
1. **Glue budget check.** Sum tokens of all `glue_text` and `text` fields across operators. If > 15 per operator OR > 60 total, reject the proposal and ask the AI to redo with tighter glue.
2. **Forbidden tokens check.** Tokenize all glue + migrate output. If any token is in `forbidden_tokens`, reject and redo.
3. **Migrate change-pct check.** For migrate operators, tokenize old and new; ratio of changed tokens must be ≤30%.
4. **Topology validity.** Apply operators in a dry-run. If they reference nonexistent paragraph IDs or violate ordering, reject and redo.

This validation is the architectural constraint that makes "voice preservation" load-bearing rather than aspirational. If Claude tries to ghostwrite, the validator rejects.

## Tool definitions for Anthropic API

These map 1:1 to Anthropic tool-use schema. Each operator is a tool. The system prompt instructs the model to call these tools and only these tools — never to write prose outside a `glue` or `migrate` call.

The tool schemas live in `backend/src/operators.ts`. The system prompt lives in `backend/src/prompts.ts`.

## What the user sees in the diff overlay
- `split`: a thin horizontal divider appears at the split point. Two ghost paragraph blocks fade in.
- `merge`: the second paragraph slides up into the first; if glue is present, the glue text appears in green.
- `move`: source paragraph fades to translucent; an arrow shows it relocating; target position highlights.
- `hoist`: identical to `move` but the new role (`intro` / `thesis`) shows in a tiny corner tag.
- `demote`: a faint indent shift on the demoted paragraph. Parent paragraph gets a corner tag.
- `migrate`: the original text shown struck-through above; new text shown in italic below; change-pct shown as a small chip.
- `glue`: green underline on inserted text.
- `delete`: red strikethrough across the entire paragraph.

Tab applies all in sequence. Esc reverts and clears the overlay.
