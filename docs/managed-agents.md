# Managed Agents — second transport for Alfred

Alfred ships two interchangeable orchestration backends. The thesis (action-space constraint, Voice Guardian validation, Panopticon transparency) is the same in both; the transport is swappable.

| Mode | Endpoint | When to use | What lives where |
|---|---|---|---|
| `messages` (default) | `client.messages.create` | Local dev, single-user demo, low setup | All session state in our Express process; document re-sent each call (with prompt caching) |
| `agents` | `client.beta.agents.*` + `client.beta.sessions.*` | Multi-user hosting, persistent sessions across server restarts, agent-level cached prefix that doesn't expire on the 5-min ephemeral TTL | Agent definition (system prompt + 8 custom tools) lives at Anthropic; per-document sessions live at Anthropic; events streamed back |

## Setup

One-time bootstrap. Provisions the Alfred agent + a cloud environment, writes IDs to `<ALFRED_HOME>/agent.json`. Idempotent — re-running prints existing IDs and skips creation.

```bash
node backend/scripts/setup-agent.mjs
```

Output:
```
provisioning Alfred Managed Agent…
  creating environment…
    ✓ environment: env_01TSdHgrkbChhZX2q9AeUEx7
  creating agent…
    ✓ agent: agent_011CaT5HVEQjmjqWyig2GF2A (version 1)

wrote /home/you/.alfred/agent.json
```

The agent is created with:
- `model: "claude-opus-4-7"`
- `system`: the same Logomorphic system prompt used by the Messages path
- `tools`: all 8 operators (`split`, `merge`, `move`, `hoist`, `demote`, `migrate`, `glue`, `delete`) plus `finalize_proposal`, all with `type: "custom"`

## Run

```bash
ALFRED_MODE=agents npm run dev:backend
```

The frontend doesn't change. It still calls `/api/propose` / `/api/decision` / `/api/inspect`. The server routes the propose call through `handleProposeViaAgents` instead of `handlePropose` based on `ALFRED_MODE`.

The `/api/health` endpoint reports the active mode:
```json
{ "ok": true, "service": "alfred", "model": "claude-opus-4-7", "mode": "agents" }
```

## Runtime model

For each `/api/propose` invocation:

1. **Get-or-create an agent session** keyed by the Alfred session_id. First call for a doc creates a fresh `client.beta.sessions.create({ agent, environment_id })`; subsequent calls reuse.

2. **Send the invocation as a `user.message` event.** Body is the rendered profile + document + hoarded few-shot + intent — same content the Messages path sends.

3. **Stream events back** via `client.beta.sessions.events.stream(sessionId)`:
   - `agent.custom_tool_use` events carry operator calls. We capture name + input.
   - `session.status_idle` with `stop_reason.type === "requires_action"` lists pending tool_use ids; we send `user.custom_tool_result` events for each (content `"applied"` since we're not actually executing the operators server-side — the client renders them and the user accepts/rejects).
   - `session.status_idle` with `stop_reason.type === "end_turn"` ends the loop.

4. **Validate** the collected operators with the existing Voice Guardian. Same enforcement as the Messages path — glue budget, forbidden tokens, migrate change-pct, topology dry-run.

5. **Return** a `Proposal` envelope identical in shape to what the Messages path returns. The frontend can't tell the difference.

## What it costs

- One agent created at setup. Persistent. Free to query.
- One environment created at setup. Persistent. Free to query.
- One session per writing session. Lives until you delete it; the 14-day session TTL is more than enough for a single-document edit.

## Verified

```bash
ALFRED_MODE=agents PORT=3002 npm run dev:backend
ALFRED_BASE=http://localhost:3002 npm run smoke
# All checks passed. Alfred is alive on http://localhost:3002.
```

The smoke test walks `health → propose → decision → inspect → profile` against the agents-mode backend and confirms the full lifecycle works.

## Why this isn't the default

For local dev (one user, one browser tab, one process), the Messages path is simpler and faster. The agents path adds an HTTP round-trip per pending tool result — Skyfall's 4-operator proposals turn into ~5 round-trips instead of one. The latency cost is real.

The agents path becomes the right default once Alfred is hosted: persistent sessions outlive the Express process, agent-level caching avoids the 5-min ephemeral TTL, and the operator algebra lives at Anthropic as a versioned agent definition rather than an inline tool list re-sent every call.

## Files

- `backend/scripts/setup-agent.mjs` — one-time agent + environment provisioning
- `backend/scripts/probe-agent.mjs` — runtime probe (run a single propose against the live agent, dump the event stream)
- `backend/src/alfred-agents.ts` — `handleProposeViaAgents` orchestrator
- `backend/src/server.ts` — `ALFRED_MODE` switch
- `<ALFRED_HOME>/agent.json` — provisioned IDs
