# Cleanup Notes — Pre-Cloudflare Stabilization

Date: 2026-06-01

## Changed files

- `backend/src/operator-parse.ts` — NEW. Single source of truth for operator validation (expectString, expectFiniteNumber, expectEnum, parsePosition, parseOperator)
- `backend/src/transport.ts` — NEW. Exports `getTransport()` and `AlfredTransport` type
- `backend/src/server.ts` — removed API key logging, imports from transport.ts, fixed fallback logic (uses activeTransport local), health endpoint distinguishes selected vs configured
- `backend/src/alfred.ts` — imports parseOperator from operator-parse.ts, removed local copies, catches parse errors at call sites
- `backend/src/alfred-agents.ts` — same: imports from operator-parse.ts, removed local copies
- `backend/src/operators.ts` — fixed migrate tool description from 30% to 50%
- `backend/src/session.ts` — fixed learned preference heuristic from 30% to 50%
- `backend/src/tests/operator-parsing.test.ts` — imports real operator-parse.ts functions
- `backend/src/tests/transport.test.ts` — imports real transport.ts function
- `backend/package.json` — added vitest, test script
- `frontend/src/App.tsx` — profile refresh after accept/reject/alternative decisions
- `.env.example` — removed `sk-ant-...` placeholder, added all env vars
- `.gitignore` — broadened to catch .env.*, .dev.vars*, *.local
- `OPERATORS.md` — changed "≤30%" to "≤50%" in validation pipeline section (line 109)

## Safety fixes

- Removed API key prefix/suffix/length logging from server startup
- Removed `sk-ant-...` from .env.example
- `.gitignore` now catches `.env.*`, `.dev.vars`, `.dev.vars.*`, `*.local`

## Operator validation fixes

- `expectFiniteNumber` rejects all non-number types (strings, null, booleans). No `Number()` coercion.
- Missing/null target_position throws instead of defaulting to `{kind:"at", where:"end"}`
- Empty string paragraph_id throws instead of being coerced via `String(undefined)`
- Invalid target_role enum values throw instead of being unsafely cast
- Unknown position.kind throws instead of being coerced
- Unknown operator tool names throw with a clear message instead of returning null
- All validation lives in one exported module (`operator-parse.ts`), used by both `alfred.ts` and `alfred-agents.ts`

## Transport behavior

- Default transport: `messages` (preserves existing local demo)
- env var: `ALFRED_TRANSPORT` (accepts `managed-agents` or legacy `agents`)
- Legacy `ALFRED_MODE` still read as fallback
- managed-agents without agent.json + no fallback flag: returns 503
- `ALLOW_TRANSPORT_FALLBACK=true`: actually falls back to messages transport (uses local `activeTransport` variable so the code path truly switches to `handlePropose`)
- Health endpoint: `{transport, managedAgentsSelected, managedAgentsConfigured}`

## Tests added (42 total)

- `operator-parsing.test.ts` — 35 tests: expectString (6), expectFiniteNumber (10), expectEnum (4), parsePosition (9), parseOperator (6). All import from the real `operator-parse.ts`.
- `transport.test.ts` — 7 tests. Imports from the real `transport.ts`.

## Docs touched

- `OPERATORS.md` line 109: "≤30%" → "≤50%" (aligning with actual validator constant)

## Deferred intentionally

- No Cloudflare code/config/directory added
- No D1/Vectorize/AI Gateway/Containers
- No docs reorganization or narrative rewriting
- No frontend styling changes
- Panopticon not redesigned (only receives profile refresh now)
- README.md line 104 still says "≤ 30%" — protected narrative file
- `docs/demo-script.md` mentions 30% in two places — protected narrative
- `docs/tasks/01-foundations.md` and `docs/tasks/02-backend.md` mention 30% — protected narrative
