# Task 03 — Frontend

**Status: completed**

## What was built

`frontend/src/`:

- `main.tsx` — React 18 root.
- `App.tsx` — main shell. Hotkey wiring (Cmd+K, Cmd+., Cmd+I). Submit/accept/reject lifecycle. Header with demo loaders and inspect/panopticon buttons. Editor stays mounted across diff mode (display: none) so accept's `setDocument` lands on the live editor instance.
- `index.css` — Tailwind base + custom serif typography (Iowan Old Style / Charter / Source Serif fallback). Diff annotation marks (glue, removed, migrate-old/new, moved-source/target, deleted). Warm paper background `#FAF7F2`, ink `#1a1a1a`, accent `#9b2c2c`.

### Components

- `Editor.tsx` — Tiptap editor. Uses an extended Paragraph node (`AlfredParagraph` from `lib/tiptap-extensions.ts`) that carries `alfredId`, `alfredRole`, `alfredParentId` attrs. Imperative handle: `getDocument`, `setDocument`, `loadMarkdown`, `focus`. `editable: () => !diffMode` plus useEffect to call `setEditable` reactively.
- `CommandPalette.tsx` — Raycast-style modal on `Cmd+K`. Recent intents + curated defaults. Enter submits, Esc dismisses.
- `DiffOverlay.tsx` — renders the proposal as inline annotations on a copy of the original doc. Shows alfred_says (serif italic prominent), rationale, operator chips, and per-paragraph annotation labels. Captures Tab/Esc.
- `Panopticon.tsx` — slide-out right panel with Read / Profile / Log tabs. Profile tab is fully editable: vibe_anchor textarea, forbidden_tokens line-list textarea, save-to-server. Log tab shows session decisions newest-first.
- `StatusBar.tsx` — bottom-right corner status bubble with colored dot + label.

### Lib

- `api.ts` — typed fetch wrappers for /api/*.
- `operators.ts` — client-side mirror of backend operator application. Used to apply accepted proposals to the in-memory document.
- `document.ts` — Tiptap JSON ↔ AlfredDocument conversion + Markdown loader.
- `tiptap-extensions.ts` — `AlfredParagraph` node extending Tiptap's default Paragraph with metadata attrs.
- `types.ts` — re-exports `shared/types.ts`.

### Store

- `store/session.ts` — Zustand store. Tracks sessionId, status, pendingProposal, panopticonOpen, panopticonTab, profile, recentDecisions, inspectRead.

## UX commitments honored

- Empty page by default. No graph view. No structural typography overlay.
- All AI behavior is invocation-only.
- Tab accepts atomically. Esc rejects.
- Profile is human-readable + user-editable.
- Single column, max-width 720px, serif body.
