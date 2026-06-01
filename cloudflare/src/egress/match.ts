// Hostname matching helpers shared by the outbound handlers and unit tests.
// Patterns may be exact hosts ("example.com"), wildcard subdomains
// ("*.example.com"), or IP/host strings — case-insensitive.

import type { ApplyToMatcher, EgressPolicy } from "./types";

export function matchesHost(pattern: string, hostname: string): boolean {
  if (!pattern) return false;
  const p = pattern.toLowerCase().trim();
  const h = hostname.toLowerCase();
  if (p === h) return true;
  if (p.startsWith("*.")) {
    const suffix = p.slice(1); // ".example.com"
    return h.endsWith(suffix) && h.length > suffix.length;
  }
  return false;
}

// `entry` may contain comma-separated patterns, mirroring the UI which lets
// users enter "api.example.com, *.cdn.example.com" in a single Allow rule.
export function matchesAnyHost(entry: string, hostname: string): boolean {
  if (!entry) return false;
  return entry
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .some((p) => matchesHost(p, hostname));
}

export interface SessionFields {
  id?: string;
  title?: string;
  agent_id?: string;
  status?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

function readPath(obj: Record<string, unknown> | undefined, path: string): unknown {
  if (!obj) return undefined;
  return path
    .split(".")
    .reduce<unknown>((acc, segment) => {
      if (acc && typeof acc === "object" && segment in (acc as Record<string, unknown>)) {
        return (acc as Record<string, unknown>)[segment];
      }
      return undefined;
    }, obj);
}

// Reject matchers that can't usefully test anything BEFORE we read the
// session field. A blank matcher is the default the policy editor seeds
// (`frontend/src/views/EgressView.tsx:91` ships
// `{field: "", operator: "equals", value: ""}` as the empty row), so a
// half-filled form persisted via the API would otherwise produce a
// rubber-stamp matcher:
//   - `equals ""`     → matches every session whose field is missing
//                       (`"" === ""` is true after the missing-field
//                       coercion below).
//   - `contains ""`   → matches every session (`"foo".includes("")` is
//                       always true).
//   - `matches ""`    → matches every string (`new RegExp("").test(x)`
//                       is always true).
//   - `is-one-of []`  → covered naturally by `[].includes(x)`, but we
//                       gate it here for symmetry.
// The API layer also rejects these shapes at policy save time
// (`src/api/index.ts` validatePolicy). The matcher-level guard is
// defence in depth so legacy KV rows from before that validation
// shipped don't silently match every session.
function matcherIsActionable(matcher: ApplyToMatcher): boolean {
  if (typeof matcher.field !== "string" || matcher.field.trim().length === 0) {
    return false;
  }
  if (matcher.operator === "is-one-of") {
    const values = matcher.values ?? [];
    return values.length > 0 && values.some((v) => typeof v === "string" && v.length > 0);
  }
  return typeof matcher.value === "string" && matcher.value.length > 0;
}

function matcherSatisfied(matcher: ApplyToMatcher, fields: SessionFields): boolean {
  if (!matcherIsActionable(matcher)) return false;
  const raw = readPath(fields as Record<string, unknown>, matcher.field);
  // Missing field → no match for any operator. Without this guard, an
  // `equals` matcher whose value was somehow empty would still fall
  // through to `"" === ""` and pass. matcherIsActionable already rejects
  // empty values, but the explicit early return makes the intent
  // legible.
  if (raw == null) return false;
  const candidate = String(raw);
  const value = matcher.value ?? "";
  if (matcher.operator === "equals") return candidate === value;
  if (matcher.operator === "contains") return candidate.includes(value);
  if (matcher.operator === "matches") {
    try {
      return new RegExp(value).test(candidate);
    } catch {
      return false;
    }
  }
  if (matcher.operator === "is-one-of") {
    return (matcher.values ?? []).includes(candidate);
  }
  return false;
}

// Picks the first policy that applies to a given session. Priority order:
//   1. A policy with `applyTo` matchers that all match the session fields
//      wins — that's the more specific case.
//   2. Otherwise, the first policy flagged `appliesToAll` is used as a
//      catch-all/default.
// Legacy `sessionIds` arrays on stored policies are ignored; binding to a
// specific session is now expressed as an `applyTo` matcher on `id`.
export function findPolicyForSession(
  policies: EgressPolicy[],
  _sessionId: string,
  fields: SessionFields = {},
): EgressPolicy | null {
  const dynamic = policies.find(
    (p) =>
      !p.appliesToAll &&
      p.applyTo.length > 0 &&
      p.applyTo.every((m) => matcherSatisfied(m, fields)),
  );
  if (dynamic) return dynamic;

  const fallback = policies.find((p) => p.appliesToAll === true);
  return fallback ?? null;
}
