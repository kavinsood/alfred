// VPC + Mesh support is opt-in. Users declare `vpc_networks` /
// `vpc_services` bindings in wrangler.jsonc and that's the only place the
// metadata lives — `scripts/sync-vpc-bindings.mjs` reads wrangler.jsonc
// at build time and emits `vpc.generated.ts` for the runtime to import.
//
// This file just defines the shape the generated module produces and the
// API surface returns. The egress outbound handler still consumes the
// runtime binding by name (env[binding].fetch()) — we don't enumerate
// bindings here at runtime.

export type VpcBindingType = "network" | "service";

export interface VpcBinding {
  binding: string;       // e.g. "MESH" — the env property on the Worker
  type: VpcBindingType;  // "network" (vpc_networks) or "service" (vpc_services)
  id: string;            // network_id or service_id from wrangler.jsonc
}
