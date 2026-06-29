// Alfred orchestrator. Builds the prompt, calls Anthropic with tool defs,
// validates the result, and returns a Proposal.

import Anthropic from "@anthropic-ai/sdk";
import { v4 as uuidv4 } from "uuid";
import type {
  AlfredDocument,
  Operator,
  Proposal,
  ProposeRequest,
  ProposeResponse,
} from "./types.js";
import { parseOperator } from "./operator-parse.js";
import { TOOL_DEFS } from "./operators.js";
import { MODEL } from "./config.js";
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

const MAX_TOKENS = 4096;
const MAX_RETRIES = 2;
const NETWORK_RETRIES = 3;
const NETWORK_RETRY_BASE_MS = 800;

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  // SDK handles its own retries on 429/5xx by default (maxRetries: 2). We add
  // an outer retry below that catches network-level resets (ECONNRESET, etc.)
  // which the SDK sometimes propagates as APIConnectionError.
  maxRetries: 2,
  timeout: 120_000,
});

async function withNetworkRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < NETWORK_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const isNetwork =
        /econnreset|socket hang up|network|connection|fetch failed|tls/i.test(msg) ||
        (err as { name?: string })?.name === "APIConnectionError";
      if (!isNetwork || attempt === NETWORK_RETRIES - 1) throw err;
      const delay = NETWORK_RETRY_BASE_MS * 2 ** attempt;
      // eslint-disable-next-line no-console
      console.warn(`[alfred] ${label} network error (attempt ${attempt + 1}/${NETWORK_RETRIES}): ${msg.slice(0, 120)} — retrying in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

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

  // Prompt caching: mark the largest reusable blocks as `ephemeral` cache breakpoints.
  // The system prompt + voice profile block is the biggest reusable chunk (changes only
  // when the user edits .proserc). The document block is reused across rapid invocations
  // on the same draft. cache_control is in stable types as of SDK 0.91.1.
  const system: Anthropic.TextBlockParam[] = [
    { type: "text", text: buildSystemPrompt() },
    { type: "text", text: renderProfileBlock(profile), cache_control: { type: "ephemeral" } },
  ];

  const userBlocks: Anthropic.TextBlockParam[] = [
    { type: "text", text: renderDocumentBlock(req.document), cache_control: { type: "ephemeral" } },
    { type: "text", text: renderHoardedBlock(hoarded) },
    { type: "text", text: renderInvocationBlock(req.intent, req.selection?.paragraph_ids ?? []) },
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

    const response = await withNetworkRetry(
      () =>
        client.messages.create({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          system,
          tools: TOOL_DEFS as unknown as Anthropic.Tool[],
          tool_choice: { type: "any" },
          messages,
        }),
      "messages.create"
    );

    // Always log usage so we can see cache hits during the demo.
    const usage = response.usage as unknown as Record<string, number | undefined>;
    // eslint-disable-next-line no-console
    console.log(
      `[alfred] usage: input=${usage.input_tokens} cached_read=${usage.cache_read_input_tokens ?? 0} cached_create=${usage.cache_creation_input_tokens ?? 0} output=${usage.output_tokens} stop=${response.stop_reason}`
    );
    if (process.env.ALFRED_DEBUG === "1") {
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

    try {
      operators.push(parseOperator(name, input));
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : `malformed tool call: ${name}` };
    }
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
    try {
      operators.push(parseOperator(block.name, block.input as Record<string, unknown>));
    } catch {
      // malformed op in recovery path — skip it
    }
  }
  if (operators.length === 0) return null;
  return { ok: true, operators, finalize: synthesizeFallbackFinalize(operators) };
}

// Produce a short editorial-ish fallback when the model emits operator calls
// but skips `finalize_proposal`. Better than "1 structural move: hoist."
function synthesizeFallbackFinalize(ops: Operator[]): { rationale: string; alfred_says: string } {
  const counts: Record<string, number> = {};
  for (const op of ops) counts[op.kind] = (counts[op.kind] ?? 0) + 1;
  const verb: Record<string, string> = {
    split: "Splitting",
    merge: "Merging",
    move: "Reordering",
    hoist: "Hoisting",
    demote: "Demoting",
    migrate: "Reprojecting from a foreign-voice fragment",
    glue: "Gluing",
    delete: "Cutting",
  };
  const parts = (Object.keys(counts) as string[])
    .map((k) => {
      const n = counts[k]!;
      const stem = verb[k] ?? `${k}ing`;
      return n > 1 ? `${stem} (×${n})` : stem;
    });
  const says = parts.length === 1 ? `${parts[0]}.` : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}.`;
  return {
    rationale: `Operators: ${ops.map((o) => o.kind).join(", ")}. (Editorial commentary missing — model skipped finalize_proposal; this proposal still validated against the Voice Guardian.)`,
    alfred_says: says,
  };
}

