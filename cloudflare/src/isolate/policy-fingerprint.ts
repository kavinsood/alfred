import type { CompiledPolicy } from "../egress/types";

// Stable, non-reversible fingerprint of a compiled policy. Used to
// detect drift between the policy the running gateway was built with
// and a fresh resolution — when the two diverge, the dispatcher
// restarts so the new policy takes effect mid-session rather than on
// the next boot.
//
// Includes everything the outbound handler actually consumes (id, name,
// allow/deny patterns, header injection targets + values, vpc routes,
// proxy code, proxy secrets), then SHA-256s the canonical structure so
// the fingerprint we persist in runner state and log on drift never
// contains raw secret material or proxy code.
export async function fingerprintPolicy(
  policy: CompiledPolicy | null,
): Promise<string> {
  if (!policy) return "(none)";
  const canonical = JSON.stringify({
    id: policy.policyId,
    name: policy.policyName,
    allow: [...policy.allow].sort(),
    deny: [...policy.deny].sort(),
    headerInjections: [...policy.headerInjections]
      .map((h) => ({
        target: h.target,
        header: h.header,
        secret: h.secretValue,
      }))
      .sort((a, b) =>
        (a.header + a.target).localeCompare(b.header + b.target),
      ),
    vpcRoutes: [...policy.vpcRoutes].sort((a, b) =>
      (a.host + a.binding).localeCompare(b.host + b.binding),
    ),
    proxy: policy.proxy
      ? { code: policy.proxy.code, secrets: policy.proxy.secrets }
      : null,
  });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `sha256:${hex}`;
}
