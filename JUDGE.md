# Alfred — for the judge

A 30-second read.

## Thesis

The bottleneck in AI writing isn't capability. It's action-space. Most AI writing tools generate prose, so they regress to the median — what writers call **whitewashing**. Alfred constrains Claude Opus 4.7 to a fixed operator algebra (`split`, `merge`, `move`, `hoist`, `demote`, `migrate`, `glue`) and architecturally forbids it from authoring free prose. **Voice preservation becomes an invariant, not an instruction.** The Voice Guardian validates every proposal server-side — if Claude tries to ghostwrite, the validator rejects.

## What runs

- **`localhost:5173`** — Tiptap editor, command palette (Cmd+K), diff overlay with operator chips and the Voice Integrity badge, Panopticon side panel showing learned preferences in real time.
- **`localhost:3001`** — Express backend. Default mode: Messages API + tool use. Switch to Managed Agents with `ALFRED_MODE=agents`.

## Two transports, one product

| Transport | Endpoint | Where state lives |
|---|---|---|
| `messages` (default) | `client.messages.create` + tool_use | In-process; document re-sent (with caching) |
| `agents` | `client.beta.sessions.events.stream` | At Anthropic; persistent agent + sessions |

Both share operator algebra, prompts, Voice Guardian, profile manager, Proposal envelope. Frontend can't tell which is running.

## 30-second verification (agents mode)

```bash
# In one terminal:
ALFRED_MODE=agents npm run dev:backend

# In another:
curl -s localhost:3001/api/health | jq
# → { "mode": "agents", "agent_id": "agent_011CaT5HVEQjmjqWyig2GF2A", "environment_id": "env_01TSdHgrkbChhZX2q9AeUEx7" }

curl -s localhost:3001/api/agent/info | jq '{name, version, tools: (.tools | length), system_prompt_length}'
# → { "name": "Alfred", "version": 1, "tools": 9, "system_prompt_length": 1469 }
# (round-trips to client.beta.agents.retrieve — these are real Anthropic resources)

./scripts/verify-managed-agents.sh
# Walks the full lifecycle in ~15s with colored ✓/✗ output.
```

## 90-second demo (messages mode)

1. `localhost:5173` → blank page (warm paper, serif type).
2. Click **demo · essay**. Hit `Cmd+K`. Type *"this graf drags — find the buried thesis."* Wait ~5s.
3. Diff overlay arrives. Top: **Voice integrity · 4 structural · 0 generative · glue 0/60 tok — pure structural; no AI prose generated**. The architectural claim made concrete.
4. `Tab` to accept. Doc reorganizes; not one of your words rewritten.
5. `Cmd+.` opens the **Panopticon**. Profile tab shows the learned preference *"accepts hoists to intro/thesis"* that just appeared. The model's model of you is yours, on disk, editable.
6. Click **demo · skyfall** for the harder case: 6 mixed-voice fragments, two foreign-voice (Gemini-formal, Claude-academic). Cmd+K *"unify these into one argument."* Alfred reorders + migrates the foreign-voice grafs into your lowercase-terse register, all within the 50% migrate change cap.

## Prizes claimed

| Prize | Why |
|---|---|
| **Build For What's Next** | Logomorphic interaction is a writing paradigm without a name yet. Alfred is the first instance. |
| **Most Creative Opus 4.7 Exploration** | Opus repositioned as a *structural reader and operator emitter* — the model that excels at writing is asked, architecturally, never to write. |
| **Keep Thinking** | Nobody pointed Claude at the topology of writing rather than its prose. |
| **Best Use of Managed Agents** | Real `agent_011CaT5HVEQjmjqWyig2GF2A` + `env_01TSdHgrkbChhZX2q9AeUEx7` provisioned via `client.beta.agents.create` / `client.beta.environments.create`. Per-document sessions via `client.beta.sessions.create`. Per-Cmd+K invocation via `client.beta.sessions.events.stream`. Verifiable with `./scripts/verify-managed-agents.sh`. |

## Where to look

- **`README.md`** — public pitch with screenshots
- **`SPEC.md`**, **`OPERATORS.md`**, **`ARCHITECTURE.md`** — full spec
- **`docs/submission.md`** — extended writeup for the hackathon form
- **`docs/managed-agents.md`** (on branch `managed-agents`) — agents transport architecture
- **`MERGE_PLAN.md`** — exact merge procedure for the worktree branch
- **`scripts/verify-managed-agents.sh`** (on `managed-agents`) — one-command proof
- **`tests/smoke.mjs`** — `npm run smoke` walks the API in ~12s; mode-aware

## What's open source

Everything. MIT.
