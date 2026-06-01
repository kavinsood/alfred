// VPC private service tool. Companion to the `vpc-service` egress
// rule: that rule routes any fetch targeting a magic hostname through
// a binding. This tool is the explicit, model-friendly path — the
// agent picks the binding from a short list and calls into it without
// learning a hostname convention.
//
// The set of available bindings is read at runtime from the same
// source the dashboard's VPC view uses: `src/vpc.generated.ts`. We
// narrow to service-typed bindings (vpc_services) because network
// bindings (Mesh) don't speak HTTP.

import { z } from "zod";
import { formatErr } from "../../helpers";
import { VPC_BINDINGS } from "../../vpc.generated";
import { truncate } from "./shared";

// Resolve the set of VPC service bindings actually present on the env.
// Returned as a `[first, ...rest]` tuple ready for `z.enum(...)` so the
// schema rejects unknown binding names; null when no bindings are
// configured (caller skips registration).
export function availableVpcServiceBindings(
  env: Env,
): [string, ...string[]] | null {
  const services = VPC_BINDINGS.filter((b) => b.type === "service");
  if (services.length === 0) return null;
  // Index `env` as a record — the binding name is dynamic (operator-
  // chosen in wrangler.jsonc) so there's no typed property to read.
  const envRecord = env as unknown as Record<string, unknown>;
  const available = services.filter(
    (b) => typeof envRecord[b.binding] === "object",
  );
  if (available.length === 0) return null;
  return available.map((b) => b.binding) as [string, ...string[]];
}

// Run-only handler for call_service. The schema is built per-env at
// the call site (see `buildCfCallServiceSchema` below) because the
// `binding` enum needs to reflect the live bindings.
export interface CfCallServiceInput {
  binding: string;
  path: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
  headers?: Record<string, string>;
  body?: string;
}

export async function runCfCallService(
  input: CfCallServiceInput,
  env: Env,
): Promise<string> {
  try {
    // VPC bindings are looked up by name at runtime, so we have to
    // index `env` as a record — there's no statically-typed property
    // for `env[binding]` because the operator picks the name.
    const fetcher = (env as unknown as Record<string, unknown>)[
      input.binding
    ] as { fetch: (req: Request) => Promise<Response> } | undefined;
    if (!fetcher || typeof fetcher.fetch !== "function") {
      return `error: binding ${input.binding} is not configured or has no fetch()`;
    }
    // The VPC binding routes by hostname; we use a synthetic localhost
    // URL so the binding accepts the call. Real VPC binding ignores
    // the host and uses the configured upstream.
    const url = new URL(
      input.path.startsWith("/") ? input.path : `/${input.path}`,
      "http://service.local",
    );
    const req = new Request(url.toString(), {
      method: input.method,
      headers: input.headers,
      body:
        input.method === "GET" || input.method === "HEAD"
          ? undefined
          : input.body,
    });
    const res = await fetcher.fetch(req);
    const text = await res.text();
    const respHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      respHeaders[k] = v;
    });
    return JSON.stringify({
      status: res.status,
      headers: respHeaders,
      body: truncate(text),
    });
  } catch (error) {
    return formatErr(error);
  }
}

// Build the input schema for call_service, parameterised on the live
// VPC service bindings. Returns null when no service bindings are
// configured (caller should skip tool registration).
export function buildCfCallServiceSchema(env: Env): {
  schema: ReturnType<typeof zCallServiceSchema>;
  description: string;
} | null {
  const enumValues = availableVpcServiceBindings(env);
  if (!enumValues) return null;
  return {
    schema: zCallServiceSchema(enumValues),
    description: `Call a private VPC service exposed to this Worker. Available bindings: ${enumValues.join(", ")}. The request runs through the binding (not public internet) so it reaches services that aren't reachable otherwise. Returns { status, headers, body } as JSON.`,
  };
}

function zCallServiceSchema(enumValues: [string, ...string[]]) {
  // VPC binding names in `wrangler.jsonc` are uppercase by convention,
  // and the runtime env lookup is exact-match. Models routinely mirror
  // the user's natural-language casing though (e.g. "service" because
  // the user said "service") and get rejected by the enum — a wasted
  // turn that just retries with the right case. Normalise to the
  // canonical binding name before the enum check so any casing the
  // model emits round-trips to the real env property.
  const canonical = new Map(enumValues.map((b) => [b.toLowerCase(), b]));
  return z.object({
    binding: z
      .preprocess(
        (val) =>
          typeof val === "string"
            ? (canonical.get(val.toLowerCase()) ?? val)
            : val,
        z.enum(enumValues),
      )
      .describe("Name of the VPC service binding to call (case-insensitive)."),
    path: z
      .string()
      .describe(
        "Request path including any query string, e.g. `/v1/users?limit=10`.",
      ),
    method: z
      .enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"])
      .default("GET"),
    headers: z
      .record(z.string(), z.string())
      .optional()
      .describe("Request headers."),
    body: z
      .string()
      .optional()
      .describe("Request body. JSON should be stringified by the caller."),
  });
}
