import type Anthropic from "@anthropic-ai/sdk";
import { ANTHROPIC_BETA } from "../anthropic";
import { ISOLATE_TOOL_NAMES } from "../tools/schemas";

// `auditAgentTools` fetches the agent's current tool list and warns
// when it doesn't look like a properly-saved Isolate-Sandbox agent —
// stock toolset entries left in, or custom names that aren't registered
// with the dispatcher. The most common cause is an agent saved before a
// schema change landed but never re-saved.
//
// Run at dispatcher start so a misconfigured agent fails loudly + fast
// rather than silently hanging on a tool call the dispatcher won't
// answer. Stray `agent.tool_use` events themselves are answered by the
// SDK's `SessionToolRunner` (returns `Error: Tool '<name>' not found`)
// — we don't need to hand-roll a fallback here.

interface AgentToolEntry {
  type?: string;
  name?: string;
  configs?: Array<{ name: string; enabled?: boolean }>;
}

export async function auditAgentTools(
  client: Anthropic,
  agentId: string,
  sessionId: string,
): Promise<void> {
  let agent: { tools?: AgentToolEntry[] };
  try {
    agent = (await client.beta.agents.retrieve(agentId, {
      betas: [ANTHROPIC_BETA],
    })) as { tools?: AgentToolEntry[] };
  } catch (error) {
    console.warn(
      `[isolate] audit failed to fetch agent=${agentId} session=${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }

  const tools = agent.tools ?? [];
  const builtinToolsets = tools.filter(
    (t) => typeof t.type === "string" && t.type.startsWith("agent_toolset_"),
  );
  const customTools = tools.filter((t) => t.type === "custom");
  // Any `type: "custom"` entry whose name isn't in the current registry
  // is suspicious — most often an agent saved when the catalog used
  // different names (e.g. the old `screenshot` after we dropped the
  // prefix). Both prefixed (cf_read / cf_grep / cf_web_fetch) and
  // unprefixed names live in ISOLATE_TOOL_NAMES, so a single membership
  // check covers everything.
  const unknownCustom = customTools.filter(
    (t) =>
      typeof t.name === "string" &&
      !ISOLATE_TOOL_NAMES.has(t.name),
  );

  if (builtinToolsets.length > 0) {
    console.warn(
      `[isolate] AUDIT: agent=${agentId} session=${sessionId} has ${builtinToolsets.length} server-side toolset entr${
        builtinToolsets.length === 1 ? "y" : "ies"
      } (${builtinToolsets.map((t) => t.type).join(", ")}). The model will emit agent.tool_use events that the Isolate dispatcher does NOT handle — tool calls will hang forever. Re-save this agent through /api/agents to convert it to Isolate custom tools.`,
    );
  }
  if (unknownCustom.length > 0) {
    console.warn(
      `[isolate] AUDIT: agent=${agentId} session=${sessionId} has ${unknownCustom.length} custom tool(s) the dispatcher doesn't recognise (${unknownCustom.map((t) => t.name).join(", ")}). Most often this means the agent was saved before a tool was renamed — re-save the agent through /api/agents to apply the current catalog.`,
    );
  }
  if (builtinToolsets.length === 0 && unknownCustom.length === 0) {
    console.log(
      `[isolate] AUDIT: agent=${agentId} session=${sessionId} tools OK (${customTools.length} custom)`,
    );
  }
}
