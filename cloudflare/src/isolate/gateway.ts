import { WorkerEntrypoint } from "cloudflare:workers";
import { applyEgressPolicy } from "../egress/handler";
import type { CompiledPolicy } from "../egress/types";

// Per-instance context attached at construction time via
// `ctx.exports.IsolateOutboundGateway({ props: ... })`. The control plane DO
// passes the session id (for logs) plus the resolved egress policy (for
// enforcement) so the gateway can act exactly like the MicroVM Sandbox
// path's outbound handler.
export interface IsolateOutboundProps {
  sessionId?: string;
  // The same shape that Sandbox.outboundHandlers.policy receives via
  // `ctx.params.policy`. When null, the gateway short-circuits to a
  // plain passthrough fetch — same default behaviour as the Sandbox
  // outbound handler when no policy is attached.
  policy?: CompiledPolicy | null;
}

// `WorkerEntrypoint` whose `fetch()` intercepts every outbound HTTP call
// from an Isolate-Sandbox dynamic Worker (execute /
// run_file). Wired up via `ctx.exports.IsolateOutboundGateway()`
// and passed as `globalOutbound` when the codemode executor loads the
// user code as a Worker module.
//
// Cloudflare's recommended pattern for dynamic-Worker egress control:
// https://developers.cloudflare.com/dynamic-workers/usage/egress-control/
//
// Egress parity with the MicroVM Sandbox path: every outbound call is
// handed to the same `applyEgressPolicy()` that
// `Sandbox.outboundHandlers.policy` uses, so allow/deny lists,
// header-injection rules, VPC-service routing, and Dynamic-Worker proxy
// functions all behave identically across the two backends. The compiled
// policy is resolved once at runner.start() time via
// `resolveSessionPolicy()` and rides along on `props`.
export class IsolateOutboundGateway extends WorkerEntrypoint<
  Env,
  IsolateOutboundProps
> {
  override async fetch(request: Request): Promise<Response> {
    const sessionId = this.ctx.props?.sessionId ?? "(unknown)";
    const policy = this.ctx.props?.policy ?? null;

    let host = "(unparsable)";
    let pathname = "";
    try {
      const url = new URL(request.url);
      host = url.host;
      pathname = url.pathname;
    } catch {
      // ignore — host/pathname stay at defaults
    }
    console.log(
      `[isolate][outbound] session=${sessionId} ${request.method} ${host}${pathname} policy=${policy?.policyId ?? "(none)"}`,
    );

    // Hand the request to the shared egress handler. When `policy` is
    // null it falls through to global fetch — same behaviour as the
    // MicroVM Sandbox path running without a policy attached.
    // applyEgressPolicy is record-shaped for test-friendliness; widen
    // our typed Env to that contract.
    return applyEgressPolicy(
      request,
      this.env as unknown as Record<string, unknown>,
      policy ? { policy } : undefined,
    );
  }
}
