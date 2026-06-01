# Alfred — Project Context

You are working on **Alfred**: an AI writing environment for the Anthropic Opus 4.7 hackathon (deadline ~48h from 2026-04-25). This file is the source of truth. Read it before doing anything.

## Read these first
- `docs/SPEC.md` — what Alfred is and what it does
- `docs/ARCHITECTURE.md` — tech architecture, stack, file layout
- `docs/OPERATORS.md` — the operator algebra (Alfred's IR)
- `docs/CONVENTIONS.md` — coding style, conventions
- `docs/tasks/` — per-task specs assigned to agents

## One-line pitch
Alfred is **inverse-whitewashing**: a writing environment where Claude Opus 4.7 is constrained to operate only on document *structure* (Split / Merge / Move / Hoist / Demote / Migrate / minimal Glue) — never on prose — and continuously surfaces what it has learned about the writer's voice, transparently and editably.

## Hard convictions (do not relitigate)
1. **Blank-page aesthetic.** No graph viz. No structural typography overlays. iA Writer / Substack feel. Warm paper, serif type.
2. **Single Alfred orchestrator.** No multi-process / multi-agent fan-out at runtime. One Opus call holds document + .proserc + hoarded few-shot in context.
3. **Long context, not vector DB.** No HNSW, no KG, no AST parser. The model's KV cache is the database.
4. **Action-space constraint, not prompt-instruction.** AI cannot freeform-write prose. It can only emit operator calls (tool use). Glue text is capped at ≤15 tokens per operator and must come from a glue tool, not free generation.
5. **Hotkey-driven.** Cmd+K for natural-language invocation. Operator-specific hotkeys (Cmd+S split, Cmd+M merge, Cmd+H hoist, etc.). Nothing fires unsolicited.
6. **Accept = Tab. Reject = Esc.**
7. **Voice profile is human-readable, user-editable, file-resident.** `.proserc` and session log are markdown/JSON on disk. The Panopticon panel renders them.
8. **One document = one session.** Voice profile persists across sessions for the same user.

## Anti-goals (kill on sight)
- Graph viz centerpiece
- Three-agent / multi-agent runtime architectures (one orchestrator only)
- Vector DBs / HNSW / KGs / AST parsers
- Speculative ghost-text autocomplete (Cursor-style)
- Margin-dot ambient nudges firing without invocation
- Free-form prose generation by the AI
- Sidebars with chat, popups, modals over the page during writing
- Decorative metrics ("you wrote 1200 words today!")
- Cute illustrations, gradients, dark-mode-by-default, dev-tools chrome

## Stack
- **Frontend:** Vite + React + TypeScript + Tiptap + Tailwind
- **Backend:** Node + Express + Anthropic SDK + TypeScript
- **AI:** `claude-opus-4-7` via Anthropic Messages API with **tool use** for operator dispatch and **prompt caching** for the document
- **Storage:** Local filesystem under `~/.alfred/`. JSON + markdown. No DB.
- **Dev:** frontend on `:5173`, backend on `:3001`. Vite proxy to backend.

## Build order (chronological, agents must not skip ahead)
1. Scaffold frontend + backend
2. Implement Tiptap editor + Cmd+K command palette
3. Implement Anthropic backend with operator tool definitions
4. Wire frontend → backend → diff render → accept/reject
5. Implement `.proserc` + voice profile + Panopticon panel
6. Polish + landing + demo content

## When you finish a task
- Update the relevant `docs/tasks/<task>.md` with what you actually built and any deviations
- Run typecheck / lint
- Commit (no push)
- Hand back a 5-line summary

## When stuck
- Re-read SPEC.md and OPERATORS.md
- Do NOT redesign the architecture
- Do NOT add features that aren't in SPEC.md
- If genuinely blocked, write what you tried + what failed + what you'd try next, and stop. Don't invent.

## Style of the assistant (tone, when Alfred talks to user)
Editorial. Terse. Punchy. No flattery. No apology. No emojis. No "I'm here to help." When Alfred surfaces a proposal it speaks like a New Yorker copy editor: "graf 3 drags," "buried thesis," "kill this aside," not "Here is a suggestion: 🤔"
