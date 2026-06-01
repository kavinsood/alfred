export type AlfredTransport = "messages" | "managed-agents" | "cloudflare-cma";

export function getTransport(env: Record<string, string | undefined>): AlfredTransport {
  const raw = (env.ALFRED_TRANSPORT ?? env.ALFRED_MODE ?? "messages").toLowerCase().trim();
  if (raw === "messages") return "messages";
  if (raw === "managed-agents" || raw === "agents") return "managed-agents";
  if (raw === "cloudflare-cma") return "cloudflare-cma";
  throw new Error(
    `Invalid ALFRED_TRANSPORT="${raw}". Expected "messages", "managed-agents", or "cloudflare-cma".`
  );
}
