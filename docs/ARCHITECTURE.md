# Architecture

## High level
```
┌────────────────────────────────────────────┐
│ Browser (localhost:5173, Vite dev server)  │
│  ┌──────────────────────────────────────┐  │
│  │ React + Tiptap editor                 │  │
│  │ Command palette (Cmd+K)               │  │
│  │ Diff overlay (Tab/Esc)                │  │
│  │ Panopticon side panel (Cmd+.)         │  │
│  └────────────────┬──────────────────────┘  │
└───────────────────┼─────────────────────────┘
                    │ /api/* (proxied via Vite)
┌───────────────────▼─────────────────────────┐
│ Node + Express backend (localhost:3001)     │
│  ┌──────────────────────────────────────┐  │
│  │ Alfred orchestrator                   │  │
│  │  - Single Anthropic Messages session  │  │
│  │  - Tool definitions (operators)       │  │
│  │  - Prompt caching on document         │  │
│  │  - System prompt: Logomorphic role    │  │
│  └────────────────┬──────────────────────┘  │
│                   │                          │
│  ┌────────────────▼──────────────────────┐  │
│  │ Voice Guardian (validator)            │  │
│  │  - Glue budget check                  │  │
│  │  - Forbidden tokens check             │  │
│  │  - Migrate change-pct check           │  │
│  │  - Topology validity check            │  │
│  └────────────────┬──────────────────────┘  │
│                   │                          │
│  ┌────────────────▼──────────────────────┐  │
│  │ Profile manager                       │  │
│  │  - Read/write proserc.md              │  │
│  │  - Read/write voice-profile.json      │  │
│  │  - Append session log                 │  │
│  └──────────────────────────────────────┘  │
└─────────────────────┬───────────────────────┘
                      │
              Anthropic API
            claude-opus-4-7
```

## Stack
- **Frontend:** Vite, React 18, TypeScript, Tiptap 2 (with starter-kit), Tailwind CSS, lucide-react icons
- **Backend:** Node 25, Express 4, TypeScript, `@anthropic-ai/sdk`, `tsx` for dev, `dotenv`
- **Shared types:** A `shared/types.ts` consumed by both (or duplicated if monorepo tooling is overkill)
- **Build:** `npm` (no pnpm). Two `package.json`s: `frontend/` and `backend/`.

## Document model (frontend)
A document is a flat list of paragraphs. Each paragraph has:
```ts
type Paragraph = {
  id: string;            // UUID generated client-side
  text: string;          // markdown allowed (bold, italic, code spans), but NO block-level structure inside a paragraph
  role?: "intro" | "thesis" | "section_lead" | "supporting"; // set by hoist/demote
  parent_id?: string;    // set by demote
};

type Document = {
  paragraphs: Paragraph[];
};
```

In Tiptap we use the standard paragraph node and stash the ID + role + parent_id in the node's `attrs`. We do NOT use Tiptap's heading nodes for `intro`/`thesis` — those are metadata, not visible style. (We may render a tiny corner tag.)

## Backend API

All endpoints accept and return JSON.

### `POST /api/propose`
Send the document, the user's intent, and optional context. Backend invokes Alfred, validates, returns proposal.

Request:
```ts
{
  document: Document;
  intent: string;       // "this graf drags" or "unify these into one argument"
  selection?: { paragraph_ids: string[] };  // if user invoked from a selection
  session_id: string;   // client-generated, persists across invocations within one open document
}
```

Response (success):
```ts
{
  proposal: Proposal;   // see OPERATORS.md
  alfred_says: string;  // 1-2 sentence editorial commentary, distinct from rationale
}
```

Response (error):
```ts
{ error: "validation_failed" | "model_error" | "..."; details: string; }
```

### `POST /api/decision`
User accepted or rejected. Backend updates voice profile and session log.

Request:
```ts
{
  session_id: string;
  proposal_id: string;
  decision: "accept" | "reject" | "modify";
  reject_reason?: string;
  modified_text?: string; // if user edited after accept
}
```

Response:
```ts
{ ok: true; updated_profile_summary: string; }
```

### `GET /api/profile`
Returns the current voice profile (proserc + voice-profile.json + last 20 session-log entries).

### `PUT /api/profile`
User edited the profile in the Panopticon. Save it.

### `POST /api/inspect`
Ask Alfred to report on the document without proposing changes.

Request: `{ document, session_id }`
Response: `{ read: string; claims: number; evidence_links: number; orphans: string[]; voice_fingerprint: object }`

## The Alfred prompt (system prompt template)

Lives in `backend/src/prompts.ts`. Has these sections, concatenated with prompt-cache markers between them:

1. **Role.** Logomorphic editor. Constraint = no free prose.
2. **Operator algebra.** Inline definitions of all 7 operators with one-line descriptions.
3. **Voice profile.** From `proserc.md` + `voice-profile.json` (cached, invalidated on profile edit).
4. **Hoarded few-shot.** Last N accept/reject pairs from this session.
5. **Document.** The current document state (cached, invalidated on document change).
6. **Intent.** The user's current invocation.
7. **Output spec.** Use tool calls. Return a Proposal envelope.

Cache breakpoints: after Role+Operator (largest reusable block), after Voice Profile (changes only when user edits profile), after Document (changes per major edit, but stays stable across rapid invocations). This is the prompt caching strategy.

## Managed Agent framing

Alfred is presented (in README and to judges) as a Managed Agent — a long-running session that holds context. Implementation: each editor session creates a `session_id`. The backend keeps an in-memory map `session_id → SessionState` containing the hoarded buffer, the recent prompts, and a last-known document snapshot. The state is rehydrated from disk if the server restarts. Each `/api/propose` call uses the same Anthropic API session conceptually (we don't use Anthropic's "stateful agent" beta endpoint for v1; we use the standard Messages API with prompt caching, but the *user-facing framing* is one persistent agent per session).

If the standard Messages API works fine with caching, we ship that. If we have time at the end and the Anthropic Agents SDK is straightforward to swap in, we swap it in for the prize narrative. Either way the user-facing story is the same.

## File layout

```
/home/kavin/github/alfred/
├── CLAUDE.md
├── SPEC.md
├── ARCHITECTURE.md            (this file)
├── OPERATORS.md
├── CONVENTIONS.md
├── README.md                  (public)
├── LICENSE
├── package.json               (root: workspace scripts)
├── .env.example
├── .gitignore
├── shared/
│   └── types.ts               (Document, Paragraph, Operator, Proposal)
├── frontend/
│   ├── package.json
│   ├── vite.config.ts
│   ├── tsconfig.json
│   ├── tailwind.config.js
│   ├── postcss.config.js
│   ├── index.html
│   ├── public/
│   │   └── demo/
│   │       ├── draft-1.md     (the messy 600-word essay we paste in demo)
│   │       └── draft-2.md     (Skyfall multi-source)
│   ├── src/
│   │   ├── main.tsx
│   │   ├── App.tsx
│   │   ├── index.css           (tailwind + custom typography)
│   │   ├── components/
│   │   │   ├── Editor.tsx
│   │   │   ├── CommandPalette.tsx
│   │   │   ├── DiffOverlay.tsx
│   │   │   ├── Panopticon.tsx
│   │   │   ├── StatusBar.tsx
│   │   ├── lib/
│   │   │   ├── api.ts          (fetch wrappers)
│   │   │   ├── tiptap-extensions.ts
│   │   │   ├── document.ts     (Document <-> Tiptap conversion)
│   │   │   ├── operators.ts    (apply operators to Document)
│   │   │   ├── hotkeys.ts
│   │   │   ├── types.ts        (re-exports from ../../shared)
│   │   └── store/
│   │       └── session.ts      (Zustand or simple useState; session state)
├── backend/
│   ├── package.json
│   ├── tsconfig.json
│   ├── src/
│   │   ├── server.ts
│   │   ├── alfred.ts           (orchestrator: builds prompt, calls Anthropic)
│   │   ├── operators.ts        (tool schemas, operator handlers)
│   │   ├── validator.ts        (Voice Guardian)
│   │   ├── prompts.ts          (system prompt builder)
│   │   ├── profile.ts          (read/write proserc, voice profile, session log)
│   │   ├── session.ts          (in-memory session state)
│   │   ├── types.ts            (re-exports from ../../shared)
│   │   └── tokenize.ts         (simple whitespace tokenizer for budget checks)
└── docs/
    └── tasks/                  (per-task specs; agents read these)
```

## Conventions
See `CONVENTIONS.md`. Highlights:
- TypeScript strict everywhere.
- No tests for the hackathon (Voice Guardian is the only validator that matters; it's exercised by usage).
- Default to functional React components, hooks, Zustand for shared state if multi-component (otherwise lift state).
- Server stays simple: no DI, no class hierarchies, plain functions.
- Comments only where the WHY is non-obvious. Otherwise none.
