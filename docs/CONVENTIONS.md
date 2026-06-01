# Coding conventions

## TypeScript
- `"strict": true` everywhere. No `any` unless dealing with truly opaque external data and a `// FIXME: type this` comment.
- `import type` for type-only imports.
- Prefer `type` over `interface` for plain shapes; use `interface` when extension is genuinely needed.
- No default exports. Named exports only.

## React
- Functional components, hooks. No classes.
- One component per file. Filename matches export.
- Props: explicit `type Props = { ... }` above the component.
- No `useEffect` for derived data — derive in render.
- Keyboard hooks live in `lib/hotkeys.ts` and are wired once at the App level.

## State
- Local UI state: `useState`.
- Cross-component shared: Zustand store. One store, slices keyed by domain (`session`, `editor`, `panopticon`).
- No Redux, no Context-based reducer ceremonies.

## Styling
- Tailwind for layout, spacing, color, typography utility.
- Custom CSS only for editor typography tuning (`index.css`). Use CSS variables for theme tokens.
- Theme: warm paper light mode only (no dark mode for v1). Background `#FAF7F2`. Text `#1a1a1a`. Accent `#9b2c2c` (deep editorial red, used sparingly for diff-removal markers).
- Body: serif (`Iowan Old Style`, `Charter`, `Source Serif Pro`, fallback `Georgia, serif`). 18-19px. 1.6 line-height. Max-width 720px content.
- UI chrome (palette, panel): sans (`Inter`, `system-ui`). 14px.

## Backend
- Plain functions. No DI containers. No class hierarchies unless modeling something truly stateful (e.g., session state — and even then, prefer a record + helper functions).
- Errors: throw, let the express error middleware return JSON. Don't swallow.
- All API responses are JSON. No HTML, no streaming for v1.
- Keep handler functions tiny; push logic into named module functions.

## Files
- File names: kebab-case for non-component files (`voice-guardian.ts`), PascalCase for components (`Editor.tsx`).
- Keep files under ~250 lines. Split if longer.

## Comments
- Default to none. Only when WHY is non-obvious (a workaround, a non-obvious invariant, a hidden constraint). Never explain what code does — names should do that.
- No JSDoc unless the function's behavior is genuinely subtle.

## Git
- Don't auto-push. Don't auto-commit. Wait for explicit instruction.
- When asked to commit, group by logical unit. No "fix typo" noise commits.

## What you don't do
- No tests. No CI configuration. No Docker. No deployment scripts. No analytics. No telemetry. No error reporting service. No feature flags.
- No README sections like "Installation" until the README task explicitly says to write them.
- No Storybook. No component libraries beyond Tailwind primitives.
- No new heavy dependencies without checking with the human first. You can add: tiptap extensions, lucide-react, zustand, dotenv, anthropic SDK, express middleware (cors, json). You cannot add: a UI kit, a state management framework other than Zustand, an ORM, a logger framework.
