# Alfred — Build Status

32 commits across `main` and a `managed-agents` worktree branch. Built end-to-end during the Anthropic Opus 4.7 hackathon. Both transports verified.

## TL;DR for the judge

Read `JUDGE.md` (one page, 30 seconds). It has the thesis, the verification commands, the prize justifications, and the resource IDs.

## Demoable

Both servers running:
- Frontend: http://localhost:5173
- Backend: http://localhost:3001 (default `messages` mode)
- Optional second backend on `:3002` for the `agents` mode worktree

Smoke test: `npm run smoke` walks health → propose → decide → inspect → profile in ~12s. Mode-aware: when `mode: agents`, also asserts `/api/agent/info`.

## What's in the repo (main)

**Top-level docs:**
- `JUDGE.md` — 30-second read for hackathon judges. **Start here.**
- `README.md` — public pitch with screenshot grid
- `SPEC.md`, `OPERATORS.md`, `ARCHITECTURE.md`, `CONVENTIONS.md` — full spec
- `MERGE_PLAN.md` — exact procedure for merging the managed-agents worktree
- `CLAUDE.md` — agent context

**docs/:**
- `submission.md` — hackathon submission writeup (paste into the form)
- `demo-script.md` — 90-second video pitch
- `screenshots/` — 11 PNGs covering every state
- `tasks/01-04*` — per-task summaries

**Code (main, Messages-API path):**
- `backend/src/` — Express + Anthropic SDK 0.32.1
  - `alfred.ts` — orchestrator: forced tool use, validation-feedback retry, recovery from missing finalize, network retry
  - `operators.ts` — 8 tool schemas + pure operator-application
  - `validator.ts` — Voice Guardian: glue budget, forbidden tokens, migrate ≤50% change, topology
  - `prompts.ts`, `profile.ts`, `session.ts`, `inspect.ts`, `tokenize.ts`
- `frontend/src/` — Vite + React + Tiptap + Tailwind
  - `App.tsx`, `components/{Editor,CommandPalette,DiffOverlay,Panopticon,StatusBar}.tsx`
  - `lib/{operators,document,tiptap-extensions,api}.ts`
  - `store/session.ts` (Zustand)
- `tests/smoke.mjs` — full lifecycle smoke (`npm run smoke`)
- `frontend/public/demo/` — `draft-1.md` (essay) + `draft-2.md` (Skyfall)

## What's on branch `managed-agents` (10 commits ahead of main)

The Managed Agents transport. Adds, doesn't subtract:

- `backend/src/alfred-agents.ts` — `handleProposeViaAgents`, mirrors alfred.ts but routes through `client.beta.sessions.events.stream`. Same Voice Guardian, same Proposal envelope, identical product surface.
- `backend/src/server.ts` — `ALFRED_MODE` env var routes `/api/propose` to either path; `/api/health` exposes `agent_id` and `environment_id` when `mode: agents`; new `/api/agent/info` round-trips to `client.beta.agents.retrieve()` and surfaces the live agent definition; startup logs validate the bootstrap.
- `backend/scripts/setup-agent.mjs` — idempotent provisioning of the Alfred agent + cloud environment. Creates `<ALFRED_HOME>/agent.json`.
- `backend/scripts/probe-agent.mjs` — runtime probe that streams a single propose against the live agent and dumps the event stream.
- `scripts/verify-managed-agents.sh` — one-command end-to-end proof for judges (~15s, prints colored ✓/✗).
- `tests/smoke.mjs` — mode-aware; asserts agent_id on health and round-trips through `/api/agent/info` when in agents mode.
- `docs/managed-agents.md` — architectural notes
- `@anthropic-ai/sdk` upgraded `0.32.1 → 0.91.1`. The cache_control hack in alfred.ts cleaned up — now idiomatic.

**Live Anthropic resources (real, retrievable):**
- `agent_011CaT5HVEQjmjqWyig2GF2A` — Alfred agent (system prompt + 9 custom tools)
- `env_01TSdHgrkbChhZX2q9AeUEx7` — cloud environment

## Verified

| Test | Status |
|---|---|
| `npm run smoke` against `:3001` (messages mode) | ✓ |
| `npm run smoke` against `:3002` (agents mode) | ✓ |
| Essay flow on messages mode | ✓ (5–10s, single hoist, glue 0/60) |
| Essay flow on agents mode | ✓ (5–10s, single hoist, glue 0/60) |
| Skyfall flow on messages mode | ✓ (~30s, hoist + move + 2 migrates, Δ ≤ 50%) |
| Skyfall flow on agents mode | ✓ (one turn, hoist + 2 migrates, Δ 42.8%) |
| `./scripts/verify-managed-agents.sh` | ✓ |
| `curl /api/agent/info` returns live Anthropic data | ✓ |
| Frontend production build | ✓ (~480 KB / 148 KB gzipped) |
| Backend typecheck | ✓ |
| Frontend typecheck | ✓ |

## Quick run from scratch

```bash
git clone <repo> && cd alfred
export ANTHROPIC_API_KEY=sk-ant-...
npm run install:all
npm run dev                           # localhost:3001 + :5173
npm run smoke                         # ~12s, walks the API

# For Managed Agents transport (optional):
git checkout managed-agents
npm --prefix backend install          # picks up SDK 0.91.1
node backend/scripts/setup-agent.mjs  # one-time provisioning
ALFRED_MODE=agents npm run dev:backend
./scripts/verify-managed-agents.sh    # one-command proof
```

## Hackathon prizes targeted

- **Build for What's Next** (main track) — Logomorphic interaction
- **Most Creative Opus 4.7 Exploration** — model as structural reader, not generator
- **Keep Thinking** — Claude pointed at writing topology, not prose
- **Best Use of Managed Agents** — real agent + environment + sessions, verifiable

## Submitting

Paste `docs/submission.md` into the hackathon form. Repo URL: `https://github.com/kavinsood/alfred`. Demo video script in `docs/demo-script.md`.

## Known not-shipped (future work)

- Per-user LoRA via Prime Intellect Lab — Phase 3, gestured at in submission.
- Cross-document voice persistence — straightforward extension once Managed Agents is the default transport.
- Frontend mode badge — would touch frontend src; deliberately not done so the demo recording stays clean.
