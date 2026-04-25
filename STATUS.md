# Alfred — Build Status

Built in one orchestrated session (~2 hours, autonomous).

## Demoable today

Both servers running:
- Frontend: http://localhost:5173
- Backend: http://localhost:3001

Demo flow works end-to-end. Verified with Playwright. Screenshots in `docs/screenshots/`.

## What's in the repo

**Docs (read these first):**
- `CLAUDE.md` — agent context, hard convictions, anti-goals
- `SPEC.md` — product spec, demo flow, prize positioning
- `OPERATORS.md` — operator algebra (split/merge/move/hoist/demote/migrate/glue/delete + finalize) with validation rules
- `ARCHITECTURE.md` — system diagram, file layout, API
- `CONVENTIONS.md` — coding style
- `README.md` — public-facing pitch (with screenshots inlined)
- `docs/demo-script.md` — 90-second pitch script for the submission video
- `docs/submission.md` — hackathon submission writeup
- `docs/tasks/01-04*` — what was actually built per task

**Code:**
- `backend/src/` — Express + Anthropic SDK, 1,400+ LOC
  - `alfred.ts` orchestrator (forced tool use, validation feedback retry, recovery from missing finalize)
  - `operators.ts` (8 tool schemas + pure operator-application functions)
  - `validator.ts` (Voice Guardian — glue budget, forbidden tokens, migrate change-pct, topology)
  - `prompts.ts` (system prompt with editorial voice constraints)
  - `profile.ts` (~/.alfred/proserc.md + voice-profile.json + sessions/*.md)
  - `session.ts` (in-memory hoarded few-shot, learned-preference inference)
  - `inspect.ts` (read-only document analysis)
  - `tokenize.ts` (whitespace tokenizer + Levenshtein for migrate change-pct)
- `frontend/src/` — Vite + React + Tiptap + Tailwind, 1,750+ LOC
  - `App.tsx` (shell, hotkey wiring, propose/accept/reject lifecycle, abort on Esc)
  - `components/Editor.tsx` (Tiptap with `AlfredParagraph` extension carrying alfredId/role/parent)
  - `components/CommandPalette.tsx` (Raycast-style Cmd+K modal)
  - `components/DiffOverlay.tsx` (per-paragraph annotation rendering, operator chips, alfred_says prominence)
  - `components/Panopticon.tsx` (slide-out, Read/Profile/Log tabs, profile editing)
  - `components/StatusBar.tsx` (corner status pill)
  - `lib/operators.ts` (client-side mirror of operator application)
  - `lib/document.ts` (Tiptap JSON ↔ AlfredDocument conversion)
  - `lib/tiptap-extensions.ts` (AlfredParagraph node)
  - `store/session.ts` (Zustand session store)

**Demo content:**
- `frontend/public/demo/draft-1.md` — messy 600-word essay with buried thesis
- `frontend/public/demo/draft-2.md` — Skyfall multi-source fragments with bracketed source-tags

## What works

✅ End-to-end propose flow: user types intent → Alfred returns operator sequence in editorial voice → diff overlay renders → Tab/Esc → profile updates.

✅ Voice Guardian: validates every proposal. Rejects budget violations, forbidden tokens, migrate >30%. Retries once with feedback to model.

✅ Skyfall multi-source: paste 6 mixed-voice fragments, "unify these" → returns hoists + moves + delete bracketed labels + 2 migrates that strip foreign-voice openers within 30% budget.

✅ Panopticon: shows learned preferences after first accept; profile is fully editable and persisted to ~/.alfred/.

✅ Cmd+I inspect: editorial read of document with claim/evidence/orphan counts and stylometric fingerprint.

✅ Empty document, network errors, invalid model output — all handled gracefully.

✅ Esc during thinking aborts the in-flight call.

✅ Frontend builds clean (479 KB / 148 KB gzipped). Backend typechecks clean. No tests, no warnings.

## Known notes / room for v0.2

- **Skyfall latency.** Complex multi-operator proposals (6+ ops including 2 migrates) take 20-30s of Opus thinking time. Acceptable for a writing tool but worth pre-warning the demo audience.
- **Prompt caching enabled.** Two ephemeral breakpoints (system+profile and document). Verified: warm calls show `cached_read=4096`, cold call `cached_read=0`. ~95% input-token reduction on repeat invocations within the 5-minute cache TTL.
- **Operator-specific hotkeys** (Cmd+S split, Cmd+M merge, etc.) — not implemented. Cmd+K with NL covers the action space.
- **Per-user LoRA via Prime Intellect Lab** — Phase 3, README gestures at it. Every accept/reject is already a logged training signal.

## Run from scratch

```bash
cd ~/github/alfred
export ANTHROPIC_API_KEY=...     # already set in your env
npm run install:all              # ~30s if cached
npm run dev                      # backend on :3001, frontend on :5173
```

## Submission checklist

- [x] Open source (MIT)
- [x] Started from scratch during hackathon (no prior work in repo)
- [x] Solo (1 ≤ 2)
- [x] Uses Opus 4.7 (`claude-opus-4-7`)
- [x] Has working demo
- [x] Has README, demo script, submission writeup
- [ ] Submit to hackathon form (you do this when you're back)
- [ ] Record demo video (script in `docs/demo-script.md`)

## Last commit

`34e53f6 docs: ship screenshots from end-to-end visual verification + reference in README`
