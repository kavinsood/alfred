import { asSchema, type Tool as AiTool } from "ai";
import type {
  BetaRunnableTool,
  BetaToolRunContext,
} from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";

// `Tool<I, O>` is invariant in I because `needsApproval` accepts I
// contravariantly. We don't read either of those parameters — the dispatcher
// shuttles JSON through us — so we type the adapter input as the most
// permissive shape and let callers pass any concrete tool.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyAiTool = AiTool<any, any>;

// Adapter: convert an AI SDK Tool (the shape used by @cloudflare/think helpers
// — createExecuteTool, createBrowserTools) into a BetaRunnableTool the
// Anthropic SDK ToolDispatcher can call.
//
// The AI SDK's `Tool` ships with a flexible schema (Zod, plain JSON Schema,
// StandardSchema) and an optional async `execute(input, opts)`. Anthropic's
// dispatcher needs a fixed JSON-Schema input descriptor and a
// `run(args, ctx) -> string | content blocks`.
//
// We resolve the input schema once at adapter time (it can be a Promise),
// stringify the model output if it isn't already string-shaped, and surface
// errors as plain text since that's what the agent expects.
export async function aiToolToBetaTool(
  name: string,
  tool: AnyAiTool,
): Promise<BetaRunnableTool> {
  const schema = asSchema(tool.inputSchema);
  // jsonSchema may be a Promise — await once and use the resolved object.
  const json = await Promise.resolve(schema.jsonSchema);
  // The Anthropic InputSchema requires `type: "object"`. JSON Schema
  // produced by zod is already object-shaped; default the rest defensively.
  const inputSchema = {
    type: "object" as const,
    properties:
      json && typeof json === "object" && "properties" in json
        ? (json as { properties?: unknown }).properties ?? {}
        : {},
    required:
      json && typeof json === "object" && "required" in json
        ? (json as { required?: string[] }).required
        : undefined,
  };

  return {
    name,
    description: tool.description ?? "",
    input_schema: inputSchema,
    parse: (input) => input,
    run: async (args, ctx?: BetaToolRunContext) => {
      const execute = tool.execute;
      if (!execute) {
        return `error: tool ${name} has no execute function`;
      }
      try {
        // The AI SDK execute fn expects ToolExecutionOptions; the dispatcher
        // gives us the original tool-use block. We forward the abort signal
        // so cancellation propagates, and synthesize the rest from what we
        // know — `messages: []` is fine because Think tools don't read it.
        const result = await execute(args, {
          toolCallId: ctx?.toolUseBlock?.id ?? "anthropic-runner",
          messages: [],
          abortSignal: ctx?.signal ?? undefined,
        });
        if (typeof result === "string") return result;
        return JSON.stringify(result);
      } catch (error) {
        return `error: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  };
}

// Adapt an AI SDK ToolSet (record of Tools) into an array of BetaRunnableTools.
// Used by createBrowserTools, which returns a record keyed by tool name.
//
// `renameWith` lets callers remap each tool's name on the way out — useful
// when the AI SDK helpers produce names that conflict with Anthropic-built-in
// tool names (e.g. `execute`, `browser_search`) and we need to namespace
// them with a `think_` prefix to satisfy the Agents API validation.
export async function aiToolSetToBetaTools(
  set: Record<string, AnyAiTool>,
  renameWith?: (originalName: string) => string,
): Promise<BetaRunnableTool[]> {
  const entries = Object.entries(set);
  return Promise.all(
    entries.map(([name, tool]) =>
      aiToolToBetaTool(renameWith ? renameWith(name) : name, tool),
    ),
  );
}
