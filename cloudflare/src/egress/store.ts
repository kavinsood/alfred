// KV-backed store for egress policies and the secrets they reference.

import type { EgressPolicy } from "./types";

const POLICY_PREFIX = "policy:";
const DATA_FIELDS_KEY = "meta:data-fields";

// Default field names always offered as suggestions in the policy form, even
// before any webhook arrives. `id`, `organization_id`, and `workspace_id`
// come from Anthropic's webhook payload. `agent_id` is injected by
// `resolveSessionPolicy()` from the local sessions row so the policy
// form's "Apply to agent…" picker can write a canonical
// `agent_id equals <id>` matcher.
export const DEFAULT_DATA_FIELDS = [
  "id",
  "organization_id",
  "workspace_id",
  "agent_id",
] as const;

export async function listPolicies(env: Env): Promise<EgressPolicy[]> {
  const out: EgressPolicy[] = [];
  let cursor: string | undefined;

  do {
    const list = await env.EGRESS_POLICIES.list({ prefix: POLICY_PREFIX, cursor });
    for (const key of list.keys) {
      const value = await env.EGRESS_POLICIES.get(key.name, "json");
      if (value) out.push(value as EgressPolicy);
    }
    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);

  // Stable order: most recently updated first.
  out.sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : -1));
  return out;
}

export async function getPolicy(env: Env, id: string): Promise<EgressPolicy | null> {
  return (await env.EGRESS_POLICIES.get(POLICY_PREFIX + id, "json")) as EgressPolicy | null;
}

export async function savePolicy(env: Env, policy: EgressPolicy): Promise<void> {
  await env.EGRESS_POLICIES.put(POLICY_PREFIX + policy.id, JSON.stringify(policy));
}

export async function deletePolicy(env: Env, id: string): Promise<void> {
  await env.EGRESS_POLICIES.delete(POLICY_PREFIX + id);
}

// Looks up a single secret by name via the SECRETS KV namespace. Returns null
// when the secret is missing — callers decide whether that's an error or an
// expected no-op.
export async function getSecret(env: Env, name: string): Promise<string | null> {
  return env.SECRETS.get(`secret:${name}`, "text");
}

// Registry of webhook `data.*` attribute names we've observed. Powers the
// auto-suggest in the policy editor's "Apply to" matcher field. Stored as a
// single JSON array under `meta:data-fields` in EGRESS_POLICIES — the
// `policy:` prefixed list above ignores it.
export async function listKnownDataFields(env: Env): Promise<string[]> {
  const stored = ((await env.EGRESS_POLICIES.get(DATA_FIELDS_KEY, "json")) as
    | string[]
    | null) ?? [];
  // Always merge defaults so suggestions work on a fresh install.
  const set = new Set<string>([...DEFAULT_DATA_FIELDS, ...stored]);
  return [...set].sort();
}

export async function recordDataFields(env: Env, names: string[]): Promise<void> {
  const incoming = names.filter((n) => typeof n === "string" && n.length > 0);
  if (incoming.length === 0) return;
  const stored = ((await env.EGRESS_POLICIES.get(DATA_FIELDS_KEY, "json")) as
    | string[]
    | null) ?? [];
  const set = new Set<string>([...DEFAULT_DATA_FIELDS, ...stored]);
  let changed = false;
  for (const name of incoming) {
    if (!set.has(name)) {
      set.add(name);
      changed = true;
    }
  }
  // Skip the write if nothing new arrived — KV writes are billable and most
  // webhooks only repeat the standard fields.
  if (!changed) return;
  await env.EGRESS_POLICIES.put(DATA_FIELDS_KEY, JSON.stringify([...set].sort()));
}
