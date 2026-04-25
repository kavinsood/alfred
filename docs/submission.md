# Hackathon submission writeup

## Project name
**Alfred** — Inverse-Whitewashing.

## One-line pitch
A writing environment where Claude Opus 4.7 is architecturally constrained to operate on document *structure* — never on prose — and continuously surfaces what it has learned about the writer's voice.

## Track
**Build for What's Next** — Logomorphic interaction is a writing paradigm without a name yet. Alfred is the first instance.

## Special prizes targeted
- **Most Creative Opus 4.7 Exploration** — Opus is repositioned as a *structural reader and operator emitter*, never a content generator.
- **Keep Thinking** — Nobody pointed Claude at the topology of writing rather than its prose.
- **Best Use of Managed Agents** — A single Alfred orchestrator runs as a long-lived per-session agent, holding the document, the user's voice profile, and the hoarded few-shot buffer in one contoured Anthropic API session.

## What it does

Most AI writing tools generate prose. They regress to the median — writers call this whitewashing. Alfred inverts that. Claude is given a fixed operator algebra (`split`, `merge`, `move`, `hoist`, `demote`, `migrate`, `glue`) and is **architecturally forbidden** from authoring free prose. It can move your text around, collapse redundancies, promote a buried thesis, reproject foreign-voice fragments. It cannot rewrite your sentences.

A **Voice Guardian** validates every proposal before showing it: glue text capped at 15 tokens per operator (60 total), forbidden tokens blocked, the only word-rewriting operator (`migrate`) capped at 30% token-edit distance. If Claude tries to ghostwrite, the validator rejects.

A side panel — the **Panopticon** — shows you, in real time, what Alfred has learned about how you write. Your voice profile is a flat file you can edit, export, or delete. The model's model of you is yours.

## Why this matters
The bottleneck in AI writing isn't capability. The model is more than smart enough. The bottleneck is **action space**. If you let the AI generate prose, it regresses to the mean — every time. Constrain its action space to topology, and the writer keeps every word. The thesis is that architectural constraint, not prompt instruction, is what preserves authorship when AI enters the loop. Alfred is the proof case.

## What's in the demo

1. Hit "demo · essay" — a messy 600-word draft loads. The thesis is buried in §4.
2. Cmd+K, type *"this graf drags — find the buried thesis"*. Alfred returns a hoist + move proposal in 5s. Editorial voice. Voice unchanged.
3. Tab to accept. Cmd+. opens the Panopticon — the learned preference *"accepts hoists to intro/thesis"* just appeared.
4. Hit "demo · skyfall" — multi-source fragments load. Cmd+K, *"unify these into one argument"*. Alfred returns hoists + moves + 2 migrates that strip foreign-voice openers and reproject the fragments into the writer's frame, all within a 30% change budget.

## Stack
- Frontend: Vite + React + TypeScript + Tiptap + Tailwind
- Backend: Node + Express + TypeScript + Anthropic SDK (`@anthropic-ai/sdk`)
- Model: `claude-opus-4-7` via Messages API with **tool use** (each operator is a tool; `tool_choice: { type: "any" }` forces tool calls; one validation-feedback retry on failure)
- Storage: `~/.alfred/proserc.md`, `~/.alfred/voice-profile.json`, `~/.alfred/sessions/<id>.md` — flat files, human-readable, user-owned

## What's open-source
Everything: frontend, backend, prompts, operator schemas, validator, demo content. MIT.

## What's next (post-hackathon)
1. **Per-user LoRA via Prime Intellect Lab.** Every accept/reject is already a logged training signal. Lab's multi-tenant LoRA inference is the bridge to post-trained voice models without raising $10M for compute.
2. **Cross-document voice persistence.** Profile already follows the user; documents are still per-session. Multi-document memory is a small extension.
3. **Operator-specific hotkeys** (Cmd+S split, Cmd+M merge, etc.) for power-users.
4. **Real writers using it.** YAOS audience (#3 all-time on r/obsidianmd) is exactly the user.

## Repo
`https://github.com/kavinsood/alfred`
