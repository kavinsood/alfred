// Alfred orchestrator. Builds the prompt, calls Anthropic with tool defs,
// validates the result, and returns a Proposal.

import Anthropic from "@anthropic-ai/sdk";
import { v4 as uuidv4 } from "uuid";
import type {
  AlfredDocument,
  Operator,
  Position,
  Proposal,
  ProposeRequest,
  ProposeResponse,
} from "./types.js";
import { TOOL_DEFS } from "./operators.js";
import {
  buildSystemPrompt,
  renderDocumentBlock,
  renderHoardedBlock,
  renderInvocationBlock,
  renderProfileBlock,
} from "./prompts.js";
import { describeFailureForRetry, validateProposal } from "./validator.js";
import { loadProfile } from "./profile.js";
import { buildHoardedContext, getOrCreateSession, recordProposal } from "./session.js";

const MODEL = "claude-opus-4-7";
const MAX_TOKENS = 4096;
const MAX_RETRIES = 1;

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export async function handlePropose(req: ProposeRequest): Promise<ProposeResponse> {
  if (!req.document || !Array.isArray(req.document.paragraphs)) {
    return { ok: false, error: "bad_request", details: "document.paragraphs required" };
  }
  if (!req.intent || !req.intent.trim()) {
    return { ok: false, error: "bad_request", details: "intent required" };
  }
  if (!req.session_id) {
    return { ok: false, error: "bad_request", details: "session_id required" };
  }

  // Eagerly create session.
  getOrCreateSession(req.session_id);

  const profile = await loadProfile();
  const hoarded = buildHoardedContext(req.session_id);

  const system = [
    {
      type: "text" as const,
      text: buildSystemPrompt(),
      // Largest reusable block — cache aggressively.
    },
    {
      type: "text" as const,
      text: renderProfileBlock(profile),
    },
  ];

  const userBlocks = [
    {
      type: "text" as const,
      text: renderDocumentBlock(req.document),
    },
    {
      type: "text" as const,
      text: renderHoardedBlock(hoarded),
    },
    {
      type: "text" as const,
      text: renderInvocationBlock(req.intent, req.selection?.paragraph_ids ?? []),
    },
  ];

  let attempt = 0;
  let validatorFeedback: string | null = null;
  // We retry with validator feedback once if the first attempt fails validation.
  while (attempt <= MAX_RETRIES) {
    attempt++;
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: userBlocks },
    ];
    if (validatorFeedback) {
      messages.push({
        role: "user",
        content: [{ type: "text", text: validatorFeedback }],
      });
    }

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system,
      tools: TOOL_DEFS as unknown as Anthropic.Tool[],
      tool_choice: { type: "any" },
      messages,
    });

    if (process.env.ALFRED_DEBUG === "1") {
      // eslint-disable-next-line no-console
      console.log("[alfred] response.stop_reason =", response.stop_reason);
      // eslint-disable-next-line no-console
      console.log("[alfred] content blocks:", response.content.map((b) => b.type).join(","));
      for (const b of response.content) {
        if (b.type === "tool_use") {
          // eslint-disable-next-line no-console
          console.log("[alfred] tool_use:", b.name, JSON.stringify(b.input));
        } else if (b.type === "text") {
          // eslint-disable-next-line no-console
          console.log("[alfred] text:", b.text.slice(0, 200));
        }
      }
    }

    const parsed = parseToolCalls(response);
    if (!parsed.ok) {
      // If the model emitted operator calls but skipped finalize_proposal,
      // synthesize a default finalize from the operators.
      const recovered = recoverFromMissingFinalize(response);
      if (recovered) {
        const validation = validateProposal(req.document, recovered.operators, profile);
        if (validation.ok) {
          const proposal: Proposal = {
            id: uuidv4(),
            rationale: recovered.finalize.rationale,
            alfred_says: recovered.finalize.alfred_says,
            operators: recovered.operators,
            voice_check: validation.voice_check,
          };
          recordProposal(req.session_id, req.intent, req.document, proposal);
          return { ok: true, proposal };
        }
      }
      validatorFeedback = `Your response did not include the required tool calls. ${parsed.reason}\n\nEmit operator tool calls and exactly one finalize_proposal call.`;
      continue;
    }

    const validation = validateProposal(req.document, parsed.operators, profile);
    if (!validation.ok) {
      validatorFeedback = describeFailureForRetry(validation);
      continue;
    }

    const proposal: Proposal = {
      id: uuidv4(),
      rationale: parsed.finalize.rationale,
      alfred_says: parsed.finalize.alfred_says,
      operators: parsed.operators,
      voice_check: validation.voice_check,
    };
    recordProposal(req.session_id, req.intent, req.document, proposal);
    return { ok: true, proposal };
  }

  return {
    ok: false,
    error: "validation_failed",
    details: validatorFeedback ?? "exceeded retry budget",
  };
}

// --- Parse tool calls from an Anthropic response ---

type ParsedOk = {
  ok: true;
  operators: Operator[];
  finalize: { rationale: string; alfred_says: string };
};

type ParsedErr = { ok: false; reason: string };

function parseToolCalls(resp: Anthropic.Message): ParsedOk | ParsedErr {
  const operators: Operator[] = [];
  let finalize: { rationale: string; alfred_says: string } | null = null;

  for (const block of resp.content) {
    if (block.type !== "tool_use") continue;
    const name = block.name;
    const input = block.input as Record<string, unknown>;

    if (name === "finalize_proposal") {
      finalize = {
        rationale: String(input.rationale ?? ""),
        alfred_says: String(input.alfred_says ?? ""),
      };
      continue;
    }

    const op = parseOperator(name, input);
    if (!op) {
      return { ok: false, reason: `unknown or malformed tool call: ${name}` };
    }
    operators.push(op);
  }

  if (!finalize) {
    return { ok: false, reason: "missing finalize_proposal call" };
  }

  return { ok: true, operators, finalize };
}

function recoverFromMissingFinalize(resp: Anthropic.Message): ParsedOk | null {
  const operators: Operator[] = [];
  for (const block of resp.content) {
    if (block.type !== "tool_use") continue;
    if (block.name === "finalize_proposal") return null; // no recovery needed
    const op = parseOperator(block.name, block.input as Record<string, unknown>);
    if (op) operators.push(op);
  }
  if (operators.length === 0) return null;
  const opSummary = operators.map((o) => o.kind).join(", ");
  return {
    ok: true,
    operators,
    finalize: {
      rationale: `Proposed: ${opSummary}.`,
      alfred_says: `${operators.length} structural move${operators.length === 1 ? "" : "s"}: ${opSummary}.`,
    },
  };
}

function parseOperator(name: string, input: Record<string, unknown>): Operator | null {
  switch (name) {
    case "split":
      return {
        kind: "split",
        paragraph_id: String(input.paragraph_id),
        after_sentence_index: Number(input.after_sentence_index),
      };
    case "merge":
      return {
        kind: "merge",
        first_paragraph_id: String(input.first_paragraph_id),
        second_paragraph_id: String(input.second_paragraph_id),
        glue_text: typeof input.glue_text === "string" ? input.glue_text : undefined,
      };
    case "move":
      return {
        kind: "move",
        paragraph_id: String(input.paragraph_id),
        target_position: parsePosition(input.target_position),
      };
    case "hoist":
      return {
        kind: "hoist",
        paragraph_id: String(input.paragraph_id),
        target_role: input.target_role as "intro" | "thesis" | "section_lead",
        target_position: parsePosition(input.target_position),
      };
    case "demote":
      return {
        kind: "demote",
        paragraph_id: String(input.paragraph_id),
        parent_paragraph_id: String(input.parent_paragraph_id),
      };
    case "migrate":
      return {
        kind: "migrate",
        paragraph_id: String(input.paragraph_id),
        rewrite_text: String(input.rewrite_text),
        change_budget_tokens: Number(input.change_budget_tokens),
      };
    case "glue":
      return {
        kind: "glue",
        position: parsePosition(input.position),
        text: String(input.text),
      };
    case "delete":
      return { kind: "delete", paragraph_id: String(input.paragraph_id) };
    default:
      return null;
  }
}

function parsePosition(raw: unknown): Position {
  const v = raw as Record<string, unknown>;
  if (!v || typeof v !== "object") {
    throw new Error("invalid target_position");
  }
  if (v.kind === "after") {
    return { kind: "after", paragraph_id: String(v.paragraph_id) };
  }
  if (v.kind === "at") {
    const where = v.where === "start" ? "start" : "end";
    return { kind: "at", where };
  }
  throw new Error(`invalid target_position kind: ${String(v.kind)}`);
}
