// Anthropic-issued identifier shapes. Defined once so the validators
// can't drift between routes, the WebSocket upgrade in `src/index.ts`,
// and the email handler's local-part parser.
//
// - Session ids: anchored `(session|sesn)_<id>`, no path separators.
// - Agent ids:   anchored `agent_<id>`, no path separators.
// - Policy ids:  anchored `pol_<id>`, restricted character set + length.
// - Secret keys: anchored, restricted character set + length (KV key).
//
// `SESSION_ID_PREFIX_REGEX` is the loose form used by the email handler
// when extracting a session id out of a recipient local-part — it
// matches from the start without an end-anchor so subaddressing tails
// like `alias+session_abc-tag@…` still resolve.
export const SESSION_ID_REGEX = /^(?:session|sesn)_[^/]+$/;
export const SESSION_ID_PREFIX_REGEX = /^(?:session|sesn)_[A-Za-z0-9_-]+/;
export const AGENT_ID_REGEX = /^agent_[^/]+$/;
export const POLICY_ID_REGEX = /^pol_[A-Za-z0-9._-]{1,64}$/;
export const SECRET_KEY_REGEX = /^[A-Za-z0-9._:-]{1,128}$/;

export function isSessionId(id: string): boolean {
  return SESSION_ID_REGEX.test(id);
}

export function isAgentId(id: string): boolean {
  return AGENT_ID_REGEX.test(id);
}

export function isPolicyId(id: string): boolean {
  return POLICY_ID_REGEX.test(id);
}

export function isSecretKey(key: string): boolean {
  return SECRET_KEY_REGEX.test(key);
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

// `error: <message>` — the shape custom-tool dispatchers return to the
// model when something fails. Kept separate from `toErrorMessage` so
// callers that just want the bare message (logs, banners) don't pull
// the prefix in by accident.
export function formatErr(error: unknown): string {
  return `error: ${toErrorMessage(error)}`;
}

export function parsePositiveInt(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number.parseInt(value || String(fallback), 10);
  if (Number.isNaN(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(parsed, min), max);
}

// Truncate a string to at most `max` characters, appending a marker so
// the model knows the output was cut. Used by the `cf_*` tools and the
// workspace tools to cap tool results at Anthropic's content-block
// budget.
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…(truncated, ${s.length - max} bytes — re-run with a narrower path / selector if you need the rest)`;
}

// Encode bytes as base64 in 32 KB chunks. The naive
// `btoa(String.fromCharCode(...bytes))` blows the call stack on large
// payloads because spread args hit the JS argument-count limit (~65k).
// Chunk size is small enough that the spread stays safe and big enough
// that the loop overhead disappears against any real-world binary.
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let out = "";
  for (let i = 0; i < bytes.byteLength; i += CHUNK) {
    out += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + CHUNK)),
    );
  }
  return btoa(out);
}
