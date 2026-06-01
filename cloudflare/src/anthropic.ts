export const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com";
export const ANTHROPIC_VERSION = "2023-06-01";
// As of the 0512 self-hosted integration guide, the Agent API + Environments
// betas are collapsed under a single managed-agents header. The SDK helpers
// add this automatically; we set it explicitly for raw fetch calls.
export const ANTHROPIC_BETA = "managed-agents-2026-04-01";

// Resolve the base URL to use for Anthropic API calls. Honours the
// `ANTHROPIC_BASE_URL` env override (regional endpoint / staging) and
// falls back to the public production host. Keeping the lookup in one
// place stops the default string drifting across modules.
export function resolveAnthropicBaseURL(env: Env): string {
  return env.ANTHROPIC_BASE_URL || ANTHROPIC_DEFAULT_BASE_URL;
}

// The managed-agents endpoints also gate behind a `?beta=true` query
// parameter (in addition to the header). Every SDK call appends it — see
// e.g. node_modules/@anthropic-ai/sdk/resources/beta/sessions/sessions.mjs.
// Without it, POSTs to `/v1/agents`, `/v1/sessions`, and
// `/v1/sessions/:id/events` can fall through to the non-beta route and
// return surprising shape errors or silently lose new fields like
// `agent_toolset_20260401`. Append it from one place so every raw fetch
// in this helper picks it up uniformly.
function withBetaQuery(path: string): string {
  // `path` may already carry a query string (e.g. ?limit=100 from list
  // endpoints). Append `beta=true` rather than overwriting.
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}beta=true`;
}

export async function anthropic(
  env: Env,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = {
    "x-api-key": env.ANTHROPIC_API_KEY,
    "anthropic-version": ANTHROPIC_VERSION,
    "anthropic-beta": ANTHROPIC_BETA,
    "content-type": "application/json",
  };

  const res = await fetch(`${resolveAnthropicBaseURL(env)}${withBetaQuery(path)}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  return new Response(res.body, {
    status: res.status,
    headers: {
      "content-type": res.headers.get("content-type") || "application/json",
      "access-control-allow-origin": "*",
    },
  });
}
