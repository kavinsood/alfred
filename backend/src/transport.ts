export type AlfredTransport = "messages" | "managed-agents";

export function getTransport(env: Record<string, string | undefined>): AlfredTransport {
  const raw = (env.ALFRED_TRANSPORT ?? env.ALFRED_MODE ?? "messages").toLowerCase().trim();
  if (raw === "messages") return "messages";
  if (raw === "managed-agents" || raw === "agents") return "managed-agents";
  throw new Error(
    `Invalid ALFRED_TRANSPORT="${raw}". Expected "messages" or "managed-agents".`
  );
}
