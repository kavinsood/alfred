# Changelog

All notable changes to Alfred during the Anthropic Opus 4.7 hackathon. Reverse chronological.

## main branch

### `e16d443 ... 3b626ef` — final docs pass

- `docs: STATUS.md — update to reflect 32 commits, both transports, all artifacts` (3b626ef)
- `docs: JUDGE.md — 30-second read for hackathon judges` (e16d443)
- `docs: README — add dual-transport section pointing at managed-agents branch` (dfaa68b)
- `docs: MERGE_PLAN references verify-managed-agents.sh as the post-merge agents proof` (acecf83)
- `docs: MERGE_PLAN.md — exact procedure for post-recording merge of managed-agents into main` (94d7dcf)

### `645ef9b` — submission writeup
- `docs: submission writeup — dual-transport framing; Managed Agents prize honest claim`

### `0559107` — network resilience
- `fix: explicit network-retry layer around the Anthropic call` — outer retry wrapper for ECONNRESET / TLS handshake failures (3 attempts, exponential backoff). SDK's built-in retry covers 429/5xx but not socket-level disconnects.

### `bd8efaf` — smoke test
- `test: tests/smoke.mjs walks the full API lifecycle in ~12 seconds`. `npm run smoke` exercises health → propose → decide → inspect → profile.

### `8d13d1e` — Skyfall content + migrate cap bump
- `fix: Skyfall demo content + bump migrate cap from 30% to 50%` — relabeled fragments as `[me — ...]` vs `[from Gemini, foreign voice — formal essayist]` so the model unambiguously knows which to migrate. Cap raised to 50% so cross-register reprojection actually fits.

### `7da7773` — health check + offline banner
- `feat: backend health check with offline banner + startup diagnostics` — frontend pings `/api/health` on mount, accent-tinted banner explains recovery if backend is down. Backend startup logs masked API key and data home.

### `3a35ee4` — README screenshot grid
- `docs: README adds rows for voice-integrity badge and preview-projected toggle`

### `736efa7` — refreshed screenshots
- `docs: refresh README screenshots with voice integrity badge + latest UI polish`

### `34d6a73` — Voice Integrity badge
- `feat: voice integrity badge in diff header — concrete proof of the thesis` — green pill: "4 structural · 0 generative · glue 0/60 tok — pure structural; no AI prose generated".

### `1d51762` — preview toggle
- `feat: P toggles preview-projected view in the diff overlay` — flip between annotated diff and clean render of projected document.

### `d2cf6c5` — session summary
- `feat: session summary headline in Panopticon Log tab` — N proposals · X accept · Y reject · Z% accept rate.

### `e968408` — timer + alternative
- `feat: live elapsed-time counter on status pill + Cmd+Shift+K alternative` — counter ticks during thinking; Shift+Cmd+K asks Alfred for a different angle.

### `e21f2d0` — operator hotkeys
- `feat: operator-specific hotkeys (Cmd+S/M/H/J/B) wired to current selection` — Tiptap exposes `getSelectedParagraphIds()`; selection IDs flow into propose.

### `4526eba` — prompt caching
- `perf: enable prompt caching on system + voice profile + document blocks` — verified `cached_read=4096` on warm calls vs 0 cold (~95% input-token reduction).

### `0001b2d` — forgiving target_position parser
- `fix: parsePosition is forgiving to model variants (before, missing kind, etc); never throws, defaults to at:end with warn`

### `54aaee7` — operator chip labels
- `polish: cleaner operator chip labels using §-position labels instead of UUID prefixes`

### `6140ed7` — placeholder visibility
- `fix: placeholder CSS selector (.alfred-prose and .ProseMirror are same node, not parent/child)` — empty editor now shows the coaching placeholder.

### `a87b457` — early polish
- `fix: header layout, empty placeholder, esc-during-thinking`

### `8d14aa8` — UI polish
- `polish: keep editor mounted across diff mode, surface alfred_says, expose inspect button`

### `bb613f7` — initial Alfred build
- `feat: alfred — inverse-whitewashing writing environment` — the 2-hour autonomous build that landed everything: backend (8 modules), frontend (4 surfaces), 7-operator algebra, Voice Guardian, Panopticon, demo content, screenshots.

## branch `managed-agents` (10 commits ahead of main)

The Managed Agents transport. Each commit below is additive on top of main; diff applies cleanly per `git merge-tree --write-tree`.

### `3d9adc5` — fallback polish
- `polish: synthesizeFallbackFinalize replaces robotic recovery copy` — shared helper, both transports. "Hoisting (×3) and Reordering." instead of "3 structural moves: hoist, hoist, hoist, move."

### `fc8e63d` — TS hack removed
- `chore: drop the cache_control TS hack now that SDK 0.91.1 has stable types` — `cache_control` is in stable `TextBlockParam`; the cast and the `prompt-caching-2024-07-31` beta header are no longer needed.

### `d9db633` — startup validation
- `chore: validate agent provisioning at startup when ALFRED_MODE=agents` — boot logs agent + env IDs; warns clearly if `agent.json` missing.

### `d9c270b` — mode-aware smoke
- `test: smoke.mjs — mode-aware; asserts agent_id + retrieves live agent when mode=agents`

### `50f5f10` — verify script
- `test: scripts/verify-managed-agents.sh — one-command proof of the agents transport` — bash + jq, hits four endpoints, exits non-zero on failure.

### `9776975` — agent info endpoint
- `feat: /api/agent/info round-trips to Anthropic for live agent definition` — `client.beta.agents.retrieve(agent_id)` returns name, version, model, system prompt preview, 9 tools.

### `081bb59` — health exposes IDs
- `feat: /api/health exposes agent_id and environment_id when ALFRED_MODE=agents`

### `1779709` — stuck-session recovery
- `fix: agents path — recover from "waiting on responses" 400 by recreating session` — caught a real failure mode where un-acked tool_uses left the session unresponsive.

### `a877d10` — submission writeup (worktree copy)
- `docs: submission writeup adds dual-transport framing + reclaims Managed Agents prize`

### `4d7a798` — validator-feedback retry
- `fix: agents path — validator-feedback retry loop + tool-use ack cleanup` — up to 3 turns per propose; sweeps unacked tool_use ids before retry.

### `74d50cd` — initial Managed Agents transport
- `feat: Managed Agents transport (alfred-agents.ts)` — the 2-hour build of the dual-transport story. SDK upgrade to 0.91.1, agent + environment provisioning, sessions/events stream, ALFRED_MODE switch.

## Real Anthropic resources (live)

- `agent_011CaT5HVEQjmjqWyig2GF2A` — Alfred Managed Agent
- `env_01TSdHgrkbChhZX2q9AeUEx7` — cloud environment

Both retrievable via `client.beta.agents.retrieve(...)` / `client.beta.environments.retrieve(...)`. See `scripts/verify-managed-agents.sh` for one-command verification.
