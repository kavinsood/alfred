# Task 01 — Foundations

**Status: completed**

## What was done

Wrote the source-of-truth docs that drive every later task:

- `CLAUDE.md` — what an agent needs to know on entry. Hard convictions, anti-goals, build order.
- `SPEC.md` — product spec including demo flow, surfaces, hackathon prize positioning.
- `OPERATORS.md` — the seven-operator algebra (split, merge, move, hoist, demote, migrate, glue) plus the optional `delete` and the required `finalize_proposal`. Defines validation rules: ≤15 glue tokens per op, ≤60 total, ≤30% migrate change-pct, no forbidden tokens.
- `ARCHITECTURE.md` — full system diagram, API surface, file layout.
- `CONVENTIONS.md` — coding conventions.
- `shared/types.ts` — shared TypeScript types for Document, Paragraph, Operator, Proposal, VoiceProfile, SessionLogEntry.

## Anti-goals enforced

- Blank-page aesthetic (no graph viz, no in-text structural typography overlays)
- Single Alfred orchestrator (no multi-agent fan-out)
- Long-context only (no vector DB, KG, AST)
- Action-space constraint, not prompt-instruction
- Hotkey-driven (no unsolicited ambient suggestions)
