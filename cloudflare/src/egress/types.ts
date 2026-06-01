// Egress policy data types — shared between API, frontend, outbound handlers,
// and tests.

export type AllowRule = { type: "allow"; host: string };
export type DenyRule = { type: "deny"; host: string };
export type HeaderInjectionRule = {
  type: "header-injection";
  target: string;
  header: string;
  secretName: string;
};
export type ProxyRule = { type: "proxy"; code: string };
export type VpcServiceRule = { type: "vpc-service"; binding: string; hostname: string };

export type EgressRule =
  | AllowRule
  | DenyRule
  | HeaderInjectionRule
  | ProxyRule
  | VpcServiceRule;

export interface ApplyToMatcher {
  field: string;
  operator: "equals" | "contains" | "matches" | "is-one-of";
  // For "equals", "contains", and "matches" we store a single string in
  // `value`. For "is-one-of" we use `values`. We keep both fields optional so
  // the type doesn't fork into a discriminated union for one extra operator.
  value?: string;
  values?: string[];
}

export interface EgressPolicy {
  id: string;
  name: string;
  egressRules: EgressRule[];
  applyTo: ApplyToMatcher[];
  // When true, this policy applies to every sandbox as a fallback. The UI
  // prevents combining `appliesToAll` with `applyTo` matchers; if both happen
  // to be set on the wire, `appliesToAll` wins so the policy still attaches.
  appliesToAll?: boolean;
  // Legacy field — explicit session-id binding is no longer surfaced in the
  // UI and is no longer honoured by the matcher. Kept here so older stored
  // policies still parse without errors.
  sessionIds?: string[];
  createdAt: string;
  updatedAt: string;
}

// Compiled policy passed to the outbound handler at runtime. Drops any extra
// metadata so the params blob stays small.
export interface CompiledPolicy {
  policyId: string;
  policyName: string;
  allow: string[];
  deny: string[];
  headerInjections: Array<{
    target: string;
    header: string;
    secretValue: string;
  }>;
  proxy: { policyId: string; code: string; secrets: Record<string, string> } | null;
  // VPC service routes: when the request's hostname matches `host`, the
  // outbound handler dispatches the rewritten request via env[binding].fetch()
  // rather than calling global fetch(). The VPC binding routes through the
  // tunnel/mesh declared in wrangler.jsonc.
  vpcRoutes: Array<{ host: string; binding: string }>;
}
