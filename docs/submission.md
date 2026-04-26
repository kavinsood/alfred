# Hackathon submission writeup

## Project name
**Alfred** — Inverse-Whitewashing.

## One-line pitch
A writing environment where Claude Opus 4.7 is architecturally constrained to operate on document *structure* — never on prose — and continuously surfaces what it has learned about the writer's voice.

## Track
**Build for What's Next** — Logomorphic interaction is a writing paradigm without a name yet. Alfred is the first instance.

## Special prizes targeted

- **Most Creative Opus 4.7 Exploration** — Opus is repositioned as a *structural reader and operator emitter*, never a content generator. The model that excels at writing is asked, architecturally, to never write.
- **Keep Thinking** — Nobody pointed Claude at the topology of writing rather than its prose. The framing is the thing nobody saw coming.
- **Best Use of Managed Agents** — Alfred ships two interchangeable orchestration backends. Default is the Messages API path (lowest friction for local demo). The Managed Agents path (`ALFRED_MODE=agents`) provisions a persistent Anthropic agent (system prompt + 8 custom tools) once via `setup-agent.mjs`, and creates one `client.beta.sessions.create` per writing document. Each Cmd+K invocation sends a `user.message` event, streams `agent.custom_tool_use` events back, replies with `user.custom_tool_result` for each, and finalizes on `session.status_idle: end_turn`. Same Voice Guardian validates regardless of transport. Real Anthropic resources: `agent_011CaT5HVEQjmjqWyig2GF2A`, `env_01TSdHgrkbChhZX2q9AeUEx7`. The architectural argument is that the constraint thesis is **transport-independent** — agent definition, tool list, voice rules all live above the transport layer. Either backend can serve the demo identically.

## What it does

Most AI writing tools generate prose. They regress to the median — writers call this whitewashing. Alfred inverts that. Claude is given a fixed operator algebra (`split`, `merge`, `move`, `hoist`, `demote`, `migrate`, `glue`) and is **architecturally forbidden** from authoring free prose. It can move your text around, collapse redundancies, promote a buried thesis, reproject foreign-voice fragments. It cannot rewrite your sentences.

A **Voice Guardian** validates every proposal before showing it: glue text capped at 15 tokens per operator (60 total), forbidden tokens blocked, the only word-rewriting operator (`migrate`) capped at **50% token-edit distance**. If Claude tries to ghostwrite, the validator rejects and re-prompts the model with the failure reason. Up to 2 retries, then the proposal surfaces or fails cleanly.

A side panel — the **Panopticon** — shows you, in real time, what Alfred has learned about how you write. Your voice profile is a flat file you can edit, export, or delete. The model's model of you is yours.

## Why this matters
The bottleneck in AI writing isn't capability. The model is more than smart enough to do the structural reasoning. The bottleneck is **action space**. If you let the AI generate prose, it regresses to the mean — every time. Constrain its action space to topology, and the writer keeps every word. The thesis is that architectural constraint, not prompt instruction, is what preserves authorship when AI enters the loop. Alfred is the proof case.

## What's in the demo

1. Hit **demo · essay** — a messy 600-word draft loads. The thesis is buried in §4.
2. Press `Cmd+K`, type *"this graf drags — find the buried thesis"*. Alfred returns a hoist + move proposal in 5–10s. Editorial voice. Voice unchanged.
3. Look at the **Voice Integrity badge** at the top of the diff: *"4 structural · 0 generative · glue 0/60 tok — pure structural; no AI prose generated"*. The architectural claim, made concrete.
4. Press `P` to flip to the **projected document** preview — what the doc would look like after accept. Press `P` again to flip back.
5. Press `Tab` to accept. Press `Cmd+.` to open the **Panopticon** — the learned preference *"accepts hoists to intro/thesis"* just appeared.
6. Hit **demo · skyfall** — multi-source fragments load (`[me — ...]` vs `[from Gemini, foreign voice — ...]` vs `[from Claude, foreign voice — ...]`). Press `Cmd+K`, type *"unify these into one argument; reproject the foreign-voice grafs into mine"*. Alfred returns hoists + moves + 2 `migrate`s that strip the foreign-voice openers and reproject fragments into the writer's lowercase-terse register, all within the 50% change budget.

## Stack

- **Frontend:** Vite + React + TypeScript + Tiptap + Tailwind. Custom `AlfredParagraph` node carrying paragraph IDs as attrs. Diff overlay renders ghost annotations + voice integrity readout. Panopticon side panel with Read / Profile / Log tabs.
- **Backend:** Node + Express + TypeScript + Anthropic SDK (`@anthropic-ai/sdk@0.91.1`).
- **Two transports** (`ALFRED_MODE` env var):
  - **Messages API** (default): `client.messages.create` with `tool_choice: { type: "any" }`, prompt caching via the `prompt-caching-2024-07-31` beta header, retry-with-feedback on validation failure.
  - **Managed Agents**: `client.beta.agents.create` (one-time bootstrap) + `client.beta.sessions.create` (per writing session) + `client.beta.sessions.events.stream` (per Cmd+K invocation). Same retry-with-feedback loop; tool_use ack tracking to keep the session moving.
- **Storage:** `~/.alfred/proserc.md` (vibe_anchor + forbidden_tokens, human-editable), `~/.alfred/voice-profile.json` (learned preferences), `~/.alfred/sessions/<id>.md` (chronological accept/reject log), `~/.alfred/agent.json` (provisioned agent + environment IDs for the agents transport). All flat files. User-owned.

## What's open-source
Everything: frontend, backend, prompts, operator schemas, validator, demo content, both transports. MIT.

## Smoke test (works on either transport)

```bash
npm run dev          # starts backend on :3001 (Messages mode by default)
# OR
ALFRED_MODE=agents npm run dev:backend   # after node backend/scripts/setup-agent.mjs

npm run smoke
# All checks passed. Alfred is alive on http://localhost:3001.
```

## What's next (post-hackathon)

1. **Per-user LoRA via Prime Intellect Lab.** Every accept/reject is already a logged training signal. Lab's multi-tenant LoRA inference is the bridge to post-trained voice models without raising $10M for compute.
2. **Cross-document voice persistence.** Profile already follows the user; documents are still per-session. With Managed Agents, the agent definition outlives the Express process — multi-document memory becomes free.
3. **Real writers using it.** YAOS audience (#3 all-time on r/obsidianmd, ~460 stars, 195k views) is exactly the user — knowledge workers in Obsidian who care about voice.
4. **The paradigm beyond writing.** Logomorphic interaction = action-space constraint + reciprocal transparency. Code editing (refactor-only operators on AST), design (layout operators on component trees), research (claim-graph manipulation). Writing was the demo domain.

## Repo
`https://github.com/kavinsood/alfred`
