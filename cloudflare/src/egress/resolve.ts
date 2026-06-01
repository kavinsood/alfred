// Resolve the egress policy that applies to a given session and compile it
// down to the runtime shape outbound handlers consume. Shared by both
// session-backend paths so they enforce the same rules:
//
//   - Sandbox: Sandbox.dispatch() calls this, then setOutboundHandler so
//     the container's outbound traffic flows through applyEgressPolicy.
//   - Think:   ThinkRunner.start() calls this, then passes the result via
//     props to ThinkOutboundGateway, which calls applyEgressPolicy on
//     every fetch() / connect() the dynamic Worker emits.
//
// Returns null when no policy applies. The caller decides what that
// means: Sandbox leaves the default no-op handler in place, Think still
// installs the gateway (passing null policy means "passthrough" inside
// applyEgressPolicy).
//
// Errors are caught + logged here so dispatch never fails because policy
// resolution hit a transient KV/D1 issue. The trade-off: a failed
// resolution silently degrades to no policy. Acceptable for now — egress
// rules are advisory in dev, and prod operators should monitor logs.

import { compilePolicy } from "./handler";
import { findPolicyForSession } from "./match";
import { listPolicies, getSecret } from "./store";
import type { CompiledPolicy } from "./types";
import { getSessionBackend, getSessionData } from "../storage";

export async function resolveSessionPolicy(
  env: Env,
  sessionId: string,
): Promise<CompiledPolicy | null> {
  try {
    const policies = await listPolicies(env);
    if (policies.length === 0) return null;
    // Build the matcher fields blob from three sources:
    //   - id: the session id (always present)
    //   - last_data_json: organization_id / workspace_id / etc. from the
    //     webhook payload
    //   - agent_id: cached on the sessions row by the dispatcher. Exposed
    //     here so the policy form's "Apply to agent…" picker can write
    //     a canonical `agent_id equals <id>` matcher that actually fires.
    //
    // Extending the matchable surface: add another key to `fields` here
    // and operators can reference it from policies as
    // `{field: "<name>", operator: ..., value: ...}`. Nested objects
    // are reachable via dot-paths (e.g. `metadata.region`) — readPath()
    // in src/egress/match.ts walks them. Anything you add must be
    // string-coercible — arrays end up rendered via `String()` (so
    // `["a","b"]` becomes the literal string `"a,b"`), which is
    // unlikely to be what you want. For multi-value fields, expose
    // them as a comma-joined string and document the convention here,
    // or land an `array-contains` operator first.
    const [stored, sessionRow] = await Promise.all([
      getSessionData(env.DB, sessionId),
      getSessionBackend(env.DB, sessionId),
    ]);
    const fields: Record<string, unknown> = {
      id: sessionId,
      ...(stored ?? {}),
    };
    if (sessionRow.agentId) fields.agent_id = sessionRow.agentId;
    // Future fields to consider threading through:
    //   if (sessionRow.backend) fields.backend = sessionRow.backend;
    //   if (vpcBindings.length) fields.vpc_bindings = vpcBindings.join(",");
    // Both are cheap reads (already in the sessions / agent_backends
    // rows the dispatcher loads). Left commented so adding them is a
    // deliberate decision tied to a UI affordance, not an accidental
    // matchable surface.
    const matched = findPolicyForSession(policies, sessionId, fields);
    if (!matched) return null;
    return await compilePolicy(matched, (name) => getSecret(env, name));
  } catch (error) {
    console.warn(
      `[egress] failed to resolve session policy session=${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}
