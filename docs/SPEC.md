# Alfred — Product Spec

## What Alfred is
Alfred is a desktop writing environment (running as a local web app at `localhost:5173`) where the user drafts in a blank-page editor and Claude Opus 4.7 continuously analyzes the document's structure but is **architecturally constrained** to propose only structure-preserving moves from a fixed operator algebra. The user invokes Alfred via hotkeys; Alfred returns a structural diff; user accepts (Tab) or rejects (Esc). Alfred hoards the user's accept/reject decisions into a session-resident few-shot buffer and a persistent voice profile, both of which the user can inspect and edit via the Panopticon side panel.

## Core thesis
- **Whitewashing** = AI writing assistants regressing prose to the median while improving clarity.
- **Inverse-whitewashing** = constrain AI's action space to *structure* (topology), not *content* (prose). AI can move / split / merge text but cannot author new sentences. Voice is preserved by construction.
- Architectural constraint > prompt instruction. Saying "preserve voice" in a system prompt fails. Removing the AI's ability to emit prose at all succeeds.

## Demo user
A Batman-mode writer drafting a piece they care about (essay, technical post, research memo, argumentative blog). 1-document-at-a-time. Single user. Structure matters because reader takeaway matters.

## Demo flow (90 seconds, what the judges see)

### Cold open
1. Open Alfred at `localhost:5173`. Blank page. Bottom-corner status: "Alfred ready."
2. Paste a messy 600-word draft (we ship two pre-loaded demo drafts in `demo/`).
3. Hit `Cmd+K`. Type: *"this graf drags."*
4. Alfred returns an inline ghost diff: a **Hoist** operation that moves a buried claim from §4 to §1, plus a 9-token glue insertion. Voice unchanged — same words, different position.
5. `Tab` to accept. The doc reorganizes. Status flashes: "+1 hoist accepted."

### Profile reveal
6. Hit `Cmd+.` to open the Panopticon. Panel slides in from the right.
7. Panel shows:
   - **What I see in this document**: 5 claims, 3 with evidence, 1 orphan. Voice is concise-with-fragments.
   - **What I've learned about you** (3 bullets that just updated): "you accept claim-first hoists when there's evidence behind the claim", "you keep fragment rhythm", "you reject hedging modifiers".
   - **Your `.proserc`**: editable text view of forbidden_tokens, vibe_anchor, etc.
   - **Session log**: the accept/reject feed, each entry editable.

### Skyfall (multi-source synthesis)
8. Close Panopticon. Paste two more fragments below the existing draft (Gemini-style raw notes, mid-thought scratches).
9. Hit `Cmd+K`. Type: *"unify these into one argument."*
10. Alfred returns a sequence of operators: 2 Migrates (reproject the older fragments into current voice frame), 1 Merge (collapse a redundant claim across sources), 1 Move (reorder for argument flow). Glue capped at ~30 tokens total.
11. `Tab` to accept all. Doc reorganizes into one coherent argument.
12. Panopticon updates: "Voice profile incorporated 3 new exemplars. Coordinate frame: v2."

End. Total demo time: 60-90 seconds.

## Surfaces (only four)

### 1. The Page
- Tiptap editor, full-bleed, max content width ~720px centered.
- Warm paper background `#FAF7F2`. Serif body type (Iowan Old Style / Charter / Source Serif). 18-19px base, 1.6 line-height.
- No structural annotation in the text by default. No claim-coloring. No orphan-glow.
- Bottom-right small status: `Alfred ready` / `thinking…` / `+1 hoist`.

### 2. Command Palette (`Cmd+K`)
- Centered modal, ~480px wide. Single text input. Subtle backdrop dim.
- User types intent in natural language. On Enter, sends to backend.
- Operator-specific hotkeys also exist for direct invocation:
  - `Cmd+S` Split selection
  - `Cmd+M` Merge selection (must select 2+ paragraphs)
  - `Cmd+H` Hoist selection
  - `Cmd+J` Demote selection
  - `Cmd+B` (move) — Move selection (palette asks for target)
  - `Cmd+G` (migrate) — Migrate selection from old voice frame to current
  - `Cmd+I` Inspect — ask Alfred to read and report what it sees
- Recent commands shown when palette opens with empty input.

### 3. Diff Overlay (inline, not a separate surface, but a distinct UI mode)
- When Alfred returns a proposal, the affected paragraphs render as ghost diffs inline.
- Green underline = inserted glue. Red strikethrough = removed text. Translucent block + arrow = moved paragraph (shows source and target).
- `Tab` accept all proposed operators (sequence is atomic). `Esc` reject. `Cmd+Shift+K` ask for an alternative.
- During diff mode, typing is disabled. Cursor goes to the first ghost element.
- Reject prompts a one-line "why?" input (optional, can be skipped). Reason gets logged.

### 4. Panopticon (`Cmd+.`)
- Slide-out panel from the right, ~440px wide. Page reflows. Panel can stay open while writing.
- Three tabs at the top: **Read** | **Profile** | **Log**.
  - **Read**: Alfred's current understanding of the document — claim count, evidence map, orphans, voice fingerprint. Plain English. Refreshed on demand or every 30s of editing.
  - **Profile**: voice profile in editable form. `vibe_anchor` (textarea), `forbidden_tokens` (chip input), `learned_preferences` (editable list — each rule is editable / deletable).
  - **Log**: chronological feed of every proposal Alfred made and the user's response. Each entry is editable (you can correct Alfred's inferred reason).

## Data files (in `~/.alfred/`)
```
~/.alfred/
├── proserc.md             # the static rules + vibe_anchor (single user-global file)
├── voice-profile.json     # learned preferences, stylometric signals
└── sessions/
    └── 2026-04-25-<slug>.md   # session log per document (markdown, human-readable)
```

## What persists vs. what doesn't
- Persists across sessions: `proserc.md`, `voice-profile.json`
- Per-session, kept on disk for inspection: session log
- Not persisted: the document content itself (Alfred is a writing tool, not a doc store — we don't auto-save the doc; user copies out at the end)

For the hackathon demo, we ship two pre-loaded demo drafts in `frontend/public/demo/` and let the user paste anything else.

## What the demo proves (the thesis surfaced as artifacts)
1. **Inverse-whitewashing works.** The ghost diff visibly moves text without changing words. Voice is preserved by construction, not by prompt.
2. **The user can see what Alfred has learned.** Panopticon makes the in-context RL legible.
3. **One Alfred, not five tools.** A single managed agent persists across the session.
4. **It's faster than chat.** From "this graf drags" to a finished structural reorganization in <10 seconds.

## What we explicitly do NOT build for the hackathon
- LoRA fine-tuning (Phase 3, post-hackathon, via Prime Intellect Lab — gestured at in the README)
- Real-time stylometric metrics dashboards
- Multi-document workspaces
- Cloud sync
- Mobile / tablet
- Auth / accounts (single local user)
- Export to anything other than Markdown copy-paste
- Vim mode, Markdown shortcuts beyond what Tiptap gives free
- Spell-check / grammar (Tiptap's defaults are fine; nothing more)
- Settings UI beyond editing `proserc.md`

## Hackathon prize positioning
- **Main track:** "Build for What's Next" — Alfred is "an interface that doesn't have a name yet" (logomorphic interaction; structure-preserving AI collaboration with transparent user model).
- **Most Creative Opus 4.7 Exploration:** Opus 4.7 is used as a *structural reader and operator emitter*, never as a content generator. That's a creative repositioning of what an LLM is for.
- **Keep Thinking:** Nobody pointed Claude at the topology of writing rather than the prose of writing. We did.
- **Best Use of Managed Agents:** A single Alfred orchestrator runs as a long-lived managed-agent session, holding the document, the .proserc, and the hoarded few-shot in its context, persisting across user invocations. Meaningful, sustained, ship-ready.
