# Task 02 — Backend

**Status: completed**

## What was built

`backend/src/`:

- `tokenize.ts` — whitespace+punctuation tokenizer, token-level Levenshtein, change-fraction helpers.
- `operators.ts` — Anthropic tool schemas for all 8 operators + `finalize_proposal`. Pure operator-application functions consumed by both validation (dry-run) and the frontend mirror.
- `validator.ts` — Voice Guardian. Rejects proposals violating: glue budget per-op (15) or total (60), forbidden tokens, migrate change-pct (>30%), or topology errors (referenced paragraph IDs missing).
- `session.ts` — in-memory session state (proposal index, hoarded few-shot, log). `recordDecision` infers learned preferences from accept/reject patterns and updates the on-disk profile.
- `prompts.ts` — system-prompt builder with sections: role, operator algebra, voice profile, hoarded few-shot, document, invocation. Editorial-voice instructions explicit.
- `profile.ts` — `~/.alfred/proserc.md` + `voice-profile.json` + `sessions/<id>.md`. Markdown is human-editable (vibe_anchor, forbidden_tokens). JSON is machine-written (learned_preferences, stylometric_signals). Handlers for /api/profile, /api/decision.
- `inspect.ts` — /api/inspect — Alfred reads the document and reports without proposing changes; computes stylometric fingerprint locally.
- `alfred.ts` — orchestrator: builds prompt → calls Anthropic Messages API with tool_choice: "any" → parses tool calls → recovers if `finalize_proposal` missing (synthesize default) → validates → returns proposal. One retry on validation failure with feedback to the model.
- `server.ts` — Express, /api/health, /api/propose, /api/decision, /api/profile (GET/PUT), /api/inspect.

## Smoke tests passed

- `POST /api/propose` with messy 5-paragraph essay → Alfred returned `hoist` + `move` proposal with editorial rationale ("The fluency/uniformity opener is throat-clearing. The topology claim is the real argument.") in 3-5 seconds.
- `POST /api/propose` with empty document → returned 0 operators with `alfred_says: "Nothing to edit — document's empty. Write something first."`
- Skyfall multi-source flow → returned `hoist` + `move` + 2 `migrate`s, all within budget. migrate change-pct: 28.5%.
- Decision endpoint logs to `~/.alfred/sessions/<id>.md` and updates `voice-profile.json` with inferred learned preferences.

## Known notes

- Prompt caching not yet enabled (would require beta header / `client.beta.promptCaching.messages.create`). Latency is acceptable without it.
- `claude-opus-4-7` model is hardcoded.
- `tool_choice: { type: "any" }` forces tool calls, prevents the model from reverting to chat.
