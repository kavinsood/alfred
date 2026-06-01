// Pure egress-policy enforcement logic. Importable from both the outbound
// handler that runs alongside the sandbox AND from unit tests, with the same
// signature: (request, env, params) -> Response.
//
// The runtime split looks like:
//
//   sandbox HTTP request
//     -> Sandbox.outboundHandlers.policy(req, env, ctx)
//        -> applyEgressPolicy(req, env, ctx.params)
//          -> deny check -> 403
//          -> allow check (if list set) -> 403 if not allowed
//          -> for each header injection matching the host: rewrite
//          -> if proxy code is set: load Dynamic Worker and forward
//          -> otherwise: fetch(req)

import type { CompiledPolicy } from "./types";
import { matchesAnyHost } from "./match";
import { ANTHROPIC_DEFAULT_BASE_URL } from "../anthropic";

// Minimal shape of the worker-loader binding we depend on. Mirrors the slice
// of the runtime `WorkerLoader` interface we exercise so tests can hand in a
// fake without dragging in the full Cloudflare runtime types.
export interface ProxyLoaderEnv {
  PROXY_LOADER?: ProxyLoader;
  // VPC bindings are dynamic — looked up by name at runtime — so we model the
  // env as an indexable record. Real bindings expose a `.fetch()` method.
  [binding: string]: unknown;
}

export interface ProxyLoader {
  get(
    id: string,
    callback: () => unknown,
  ): {
    getEntrypoint(name?: string): {
      fetch: (request: Request) => Promise<Response>;
    };
  };
}

// Anything with a fetch() that takes a Request and returns Response counts as
// a binding we can dispatch through (Fetcher, VPC binding, etc.).
interface FetcherLike {
  fetch(req: Request): Promise<Response>;
}

function isFetcher(value: unknown): value is FetcherLike {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { fetch?: unknown }).fetch === "function"
  );
}

export interface PolicyParams {
  policy: CompiledPolicy;
}

// Headers we strip from outbound requests before calling fetch — the sandbox
// adds these to the original request and they break upstream services.
const STRIPPED_HEADERS = ["host", "cf-connecting-ip", "cf-ray", "cf-visitor"];

// Fallback Anthropic API host used when env.ANTHROPIC_BASE_URL is not set.
// Derived from the central base-URL constant in src/anthropic.ts so the
// two can't drift.
const DEFAULT_ANTHROPIC_HOST = new URL(ANTHROPIC_DEFAULT_BASE_URL).hostname;

// Returns the hostname the agent runner uses to reach Anthropic for
// heartbeats, event streaming, and posting tool results. Read from the
// worker env so a per-deploy override (regional endpoint, staging) is
// respected automatically.
function anthropicHost(env: ProxyLoaderEnv): string {
  const raw = (env as { ANTHROPIC_BASE_URL?: unknown }).ANTHROPIC_BASE_URL;
  if (typeof raw === "string" && raw.length > 0) {
    try {
      return new URL(raw).hostname.toLowerCase();
    } catch {
      // Fall through to the default — an invalid override shouldn't take
      // the agent down too.
    }
  }
  return DEFAULT_ANTHROPIC_HOST;
}

// Control-plane traffic from the control plane (heartbeat / events.stream /
// events.send) MUST reach Anthropic regardless of the user's policy.
// Without this bypass, a policy with an allow-list that omits
// api.anthropic.com causes every tool result POST to 403; the control plane
// retries 3×, drops the result, and the dashboard shows the tool call as
// "running" forever (see src/isolate/runner.ts:276-278 for the matching
// note on the Isolate backend). The bypass is intentionally narrow — it
// only exempts the configured Anthropic host, so user-app traffic to
// every other destination still flows through deny / allow / header-
// injection / VPC / proxy rules as before.
export function isAnthropicControlPlane(
  env: ProxyLoaderEnv,
  hostname: string,
): boolean {
  return hostname.toLowerCase() === anthropicHost(env);
}

function rewriteHeaders(
  req: Request,
  hostname: string,
  policy: CompiledPolicy,
): Headers {
  const headers = new Headers(req.headers);
  for (const h of STRIPPED_HEADERS) headers.delete(h);
  for (const inj of policy.headerInjections) {
    if (matchesAnyHost(inj.target, hostname)) {
      headers.set(inj.header, inj.secretValue);
    }
  }
  return headers;
}

function denied(reason: string): Response {
  return new Response(JSON.stringify({ error: "egress denied", reason }), {
    status: 403,
    headers: { "content-type": "application/json" },
  });
}

// Main entry point. Exported separately so tests can call it with a fake env
// containing a fake WorkerLoader. Outbound handlers in microvm/sandbox.ts forward to
// this function.
export async function applyEgressPolicy(
  request: Request,
  env: ProxyLoaderEnv,
  params: PolicyParams | undefined,
): Promise<Response> {
  // No policy attached → fall through to default fetch (interception is
  // already in place; the caller decides not to enforce anything).
  if (!params || !params.policy) {
    return fetch(request);
  }

  const { policy } = params;
  const url = new URL(request.url);
  const hostname = url.hostname;

  // Always let agent control-plane traffic through, even when the policy
  // would otherwise reject it. Header injection / deny rules / proxy /
  // VPC routing all run after this guard so we don't accidentally rewrite
  // the control plane's Authorization header or proxy its tool-result POSTs
  // through a user-supplied dynamic worker.
  if (isAnthropicControlPlane(env, hostname)) {
    return fetch(request);
  }

  // Deny first — wins over allow lists and any other rule.
  for (const pat of policy.deny) {
    if (matchesAnyHost(pat, hostname)) {
      return denied(`host ${hostname} blocked by deny rule`);
    }
  }

  // If an allow list exists, hostname must match at least one entry.
  if (policy.allow.length > 0) {
    const ok = policy.allow.some((pat) => matchesAnyHost(pat, hostname));
    if (!ok) return denied(`host ${hostname} not in allow list`);
  }

  const headers = rewriteHeaders(request, hostname, policy);
  const rewritten = new Request(request, { headers });

  // VPC service routing: if a vpc-service rule matches the hostname, dispatch
  // the rewritten request through the matching env binding.
  for (const route of policy.vpcRoutes) {
    if (matchesAnyHost(route.host, hostname)) {
      const binding = env[route.binding];
      if (!isFetcher(binding)) {
        return new Response(
          JSON.stringify({
            error: "vpc binding unavailable",
            reason: `binding ${route.binding} is not configured or has no fetch()`,
          }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
      try {
        return await binding.fetch(rewritten);
      } catch (error) {
        return new Response(
          JSON.stringify({
            error: "vpc binding threw",
            message: error instanceof Error ? error.message : String(error),
          }),
          { status: 502, headers: { "content-type": "application/json" } },
        );
      }
    }
  }

  // Proxy function: load a Dynamic Worker for this policy id, hand it the
  // rewritten request + the policy's secrets as env, and forward whatever it
  // returns.
  if (policy.proxy) {
    if (!env.PROXY_LOADER) {
      return new Response(
        JSON.stringify({
          error: "egress proxy unavailable",
          reason: "PROXY_LOADER binding missing",
        }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }

    try {
      // We key by policyId+code-hash so the worker is reused across requests
      // until the proxy code changes; replacing it requires saving the policy
      // again, which writes the new id at the next savePolicy() call.
      const proxyCode = policy.proxy.code;
      const id = `proxy_${policy.proxy.policyId}`;
      const worker = env.PROXY_LOADER.get(
        id,
        () =>
          ({
            compatibilityDate: "2026-04-01",
            mainModule: "proxy.js",
            modules: { "proxy.js": proxyCode },
            env: policy.proxy?.secrets ?? {},
            // globalOutbound omitted → proxy inherits parent's network
            // access so user-supplied proxy code can call fetch() directly.
            // Deny/allow/header-injection rules run before the proxy is
            // invoked, so those policies still apply to the original
            // request. Proxy code is operator-authored and trusted.
          }) as unknown,
      );
      const entry = worker.getEntrypoint();
      return await entry.fetch(rewritten);
    } catch (error) {
      return new Response(
        JSON.stringify({
          error: "egress proxy threw",
          message: error instanceof Error ? error.message : String(error),
        }),
        { status: 502, headers: { "content-type": "application/json" } },
      );
    }
  }

  return fetch(rewritten);
}

// Compile a stored EgressPolicy down to the CompiledPolicy shape passed as
// outbound handler params, resolving secret references against the SECRETS KV.
// Centralised here so tests can call it directly.
import type { EgressPolicy } from "./types";

export async function compilePolicy(
  policy: EgressPolicy,
  resolveSecret: (name: string) => Promise<string | null>,
): Promise<CompiledPolicy> {
  const allow: string[] = [];
  const deny: string[] = [];
  const headerInjections: CompiledPolicy["headerInjections"] = [];
  const vpcRoutes: CompiledPolicy["vpcRoutes"] = [];
  const secrets: Record<string, string> = {};
  let proxyCode: string | null = null;

  for (const rule of policy.egressRules) {
    if (rule.type === "allow" && rule.host) allow.push(rule.host);
    else if (rule.type === "deny" && rule.host) deny.push(rule.host);
    else if (rule.type === "header-injection") {
      const value = await resolveSecret(rule.secretName);
      if (value != null) {
        headerInjections.push({
          target: rule.target,
          header: rule.header,
          secretValue: value,
        });
      }
    } else if (rule.type === "proxy") {
      proxyCode = rule.code;
    } else if (rule.type === "vpc-service" && rule.binding && rule.hostname) {
      vpcRoutes.push({ host: rule.hostname, binding: rule.binding });
    }
  }

  // Make every secret reachable as `env.<NAME>` inside the proxy function so
  // user code can authenticate to upstream APIs without seeing the raw values
  // in the sandbox.
  for (const inj of headerInjections) {
    secrets[inj.header.replace(/[^A-Za-z0-9_]/g, "_").toUpperCase()] =
      inj.secretValue;
  }

  return {
    policyId: policy.id,
    policyName: policy.name,
    allow,
    deny,
    headerInjections,
    proxy: proxyCode ? { policyId: policy.id, code: proxyCode, secrets } : null,
    vpcRoutes,
  };
}
