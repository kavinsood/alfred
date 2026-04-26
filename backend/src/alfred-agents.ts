// Alfred orchestrator — Managed Agents implementation.
// Mirror of alfred.ts but routes through client.beta.sessions.events instead
// of client.messages.create. Agent + environment provisioned once via
// scripts/setup-agent.mjs; IDs read from <ALFRED_HOME>/agent.json.

import Anthropic from "@anthropic-ai/sdk";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";
import type {
  Operator,
  Position,
  Proposal,
  ProposeRequest,
  ProposeResponse,
} from "./types.js";
import {
  renderDocumentBlock,
  renderHoardedBlock,
  renderInvocationBlock,
  renderProfileBlock,
} from "./prompts.js";
import { describeFailureForRetry, validateProposal } from "./validator.js";
import { loadProfile } from "./profile.js";
import { buildHoardedContext, getOrCreateSession, recordProposal } from "./session.js";

const ALFRED_HOME = (process.env.ALFRED_HOME ?? path.join(os.homedir(), ".alfred")).replace(/^~/, os.homedir());
const AGENT_FILE = path.join(ALFRED_HOME, "agent.json");

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  maxRetries: 2,
  timeout: 180_000,
});

type AgentBootstrap = { agent_id: string; environment_id: string };
type AgentSession = { session_id: string; created_at: string };

let bootstrap: AgentBootstrap | null = null;
const sessionByAlfredSessionId = new Map<string, AgentSession>();

async function loadBootstrap(): Promise<AgentBootstrap> {
  if (bootstrap) return bootstrap;
  let raw: string;
  try {
    raw = await fs.readFile(AGENT_FILE, "utf8");
  } catch {
    throw new Error(
      `agent.json not found at ${AGENT_FILE}. Run \`node scripts/setup-agent.mjs\` first.`
    );
  }
  const parsed = JSON.parse(raw) as AgentBootstrap;
  if (!parsed.agent_id || !parsed.environment_id) {
    throw new Error(`agent.json missing agent_id or environment_id`);
  }
  bootstrap = parsed;
  return parsed;
}

async function getOrCreateAgentSession(alfredSessionId: string): Promise<string> {
  const existing = sessionByAlfredSessionId.get(alfredSessionId);
  if (existing) return existing.session_id;

  const { agent_id, environment_id } = await loadBootstrap();
  const created = await client.beta.sessions.create({
    agent: agent_id,
    environment_id,
    title: `alfred-${alfredSessionId.slice(0, 12)}`,
    metadata: { alfred_session_id: alfredSessionId },
  });
  sessionByAlfredSessionId.set(alfredSessionId, {
    session_id: created.id,
    created_at: new Date().toISOString(),
  });
  // eslint-disable-next-line no-console
  console.log(`[alfred-agents] created session ${created.id} for alfred-session ${alfredSessionId}`);
  return created.id;
}

export async function handleProposeViaAgents(
  req: ProposeRequest
): Promise<ProposeResponse> {
  if (!req.document || !Array.isArray(req.document.paragraphs)) {
    return { ok: false, error: "bad_request", details: "document.paragraphs required" };
  }
  if (!req.intent || !req.intent.trim()) {
    return { ok: false, error: "bad_request", details: "intent required" };
  }
  if (!req.session_id) {
    return { ok: false, error: "bad_request", details: "session_id required" };
  }

  getOrCreateSession(req.session_id);

  const profile = await loadProfile();
  const hoarded = buildHoardedContext(req.session_id);

  // The agent's system prompt is locked at creation time. We pass the dynamic
  // context (profile + document + hoarded + intent) as a single user.message.
  // Critically, paragraph IDs we send to the agent come from the input doc;
  // the agent should reference only those IDs in its operator calls.
  const userText = [
    renderProfileBlock(profile),
    renderDocumentBlock(req.document),
    renderHoardedBlock(hoarded),
    renderInvocationBlock(req.intent, req.selection?.paragraph_ids ?? []),
    "",
    "IMPORTANT: when you emit operator tool calls, every `paragraph_id`, `first_paragraph_id`, `second_paragraph_id`, `parent_paragraph_id`, and `target_position.paragraph_id` MUST be one of the IDs listed in the `## Document` block above. Do NOT invent new IDs (e.g. `p4b`) referencing paragraphs created by your own earlier operators in this turn — the validator only knows about the input document.",
  ].join("\n\n");

  let agentSessionId = await getOrCreateAgentSession(req.session_id);

  // If the cached session is in a bad state ("waiting on responses to events…"),
  // drop it and recreate. That state can come from a prior failed turn that left
  // tool_use events un-acked beyond what we tracked.
  const trySendUserMessage = async (sid: string, text: string): Promise<string> => {
    try {
      await client.beta.sessions.events.send(sid, {
        events: [{ type: "user.message", content: [{ type: "text", text }] }],
      });
      return sid;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("waiting on responses to events")) {
        // eslint-disable-next-line no-console
        console.warn(`[alfred-agents] session ${sid} stuck on un-acked events — dropping and recreating`);
        sessionByAlfredSessionId.delete(req.session_id);
        const fresh = await getOrCreateAgentSession(req.session_id);
        await client.beta.sessions.events.send(fresh, {
          events: [{ type: "user.message", content: [{ type: "text", text }] }],
        });
        return fresh;
      }
      throw err;
    }
  };

  // eslint-disable-next-line no-console
  console.log(`[alfred-agents] sending invocation to session ${agentSessionId}`);

  type IdleEvt = { stop_reason?: { type: string; event_ids?: string[] } };
  type ToolUseEvt = { id: string; name: string; input: Record<string, unknown> };

  const MAX_TURNS = 3;
  let operators: Operator[] = [];
  let finalize: { rationale: string; alfred_says: string } | null = null;
  let endTurn = false;
  let nextUserText: string = userText;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    operators = [];
    finalize = null;
    endTurn = false;
    const seenToolUseIds: string[] = [];
    const ackedToolUseIds = new Set<string>();

    agentSessionId = await trySendUserMessage(agentSessionId, nextUserText);

    const stream = await client.beta.sessions.events.stream(agentSessionId);
    const startedAt = Date.now();
    const HARD_TIMEOUT_MS = 180_000;

    for await (const ev of stream as AsyncIterable<{ type: string } & Record<string, unknown>>) {
      if (Date.now() - startedAt > HARD_TIMEOUT_MS) {
        // eslint-disable-next-line no-console
        console.warn(`[alfred-agents] hard timeout after ${HARD_TIMEOUT_MS}ms`);
        break;
      }
      const t = ev.type;
      if (t === "agent.custom_tool_use") {
        const tu = ev as unknown as ToolUseEvt;
        seenToolUseIds.push(tu.id);
        if (tu.name === "finalize_proposal") {
          finalize = {
            rationale: String(tu.input.rationale ?? ""),
            alfred_says: String(tu.input.alfred_says ?? ""),
          };
        } else {
          const op = parseOperator(tu.name, tu.input);
          if (op) operators.push(op);
        }
      } else if (t === "session.status_idle") {
        const idle = ev as unknown as IdleEvt;
        const stop = idle.stop_reason ?? { type: "" };
        if (stop.type === "end_turn") {
          endTurn = true;
          break;
        }
        if (stop.type === "requires_action") {
          const ids = stop.event_ids ?? [];
          if (ids.length > 0) {
            await client.beta.sessions.events.send(agentSessionId, {
              events: ids.map((tid: string) => ({
                type: "user.custom_tool_result" as const,
                custom_tool_use_id: tid,
                content: [{ type: "text" as const, text: "applied" }],
              })),
            });
            for (const id of ids) ackedToolUseIds.add(id);
          }
        }
        if (stop.type === "retries_exhausted") {
          return { ok: false, error: "model_retries_exhausted" };
        }
      } else if (t === "session.error") {
        // eslint-disable-next-line no-console
        console.error(`[alfred-agents] session.error:`, JSON.stringify(ev).slice(0, 400));
        return { ok: false, error: "session_error", details: JSON.stringify(ev).slice(0, 300) };
      } else if (t === "session.status_terminated") {
        // eslint-disable-next-line no-console
        console.warn(`[alfred-agents] session terminated mid-turn`);
        sessionByAlfredSessionId.delete(req.session_id);
        return { ok: false, error: "session_terminated" };
      }
    }

    // Acknowledge any tool_use events that didn't get acked via requires_action
    // (sometimes end_turn fires without a final requires_action wave). The
    // session refuses new user.message events while any tool_use is unacked.
    const unacked = seenToolUseIds.filter((id) => !ackedToolUseIds.has(id));
    if (unacked.length > 0) {
      try {
        await client.beta.sessions.events.send(agentSessionId, {
          events: unacked.map((tid) => ({
            type: "user.custom_tool_result" as const,
            custom_tool_use_id: tid,
            content: [{ type: "text" as const, text: "applied" }],
          })),
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[alfred-agents] couldn't ack ${unacked.length} leftover tool_uses:`, err instanceof Error ? err.message : String(err));
      }
    }

    if (!finalize) {
      if (operators.length === 0) {
        return {
          ok: false,
          error: "no_operators",
          details: "agent ended turn with no tool calls",
        };
      }
      finalize = {
        rationale: `Proposed: ${operators.map((o) => o.kind).join(", ")}.`,
        alfred_says: `${operators.length} structural move${operators.length === 1 ? "" : "s"}: ${operators.map((o) => o.kind).join(", ")}.`,
      };
    }

    const validation = validateProposal(req.document, operators, profile);
    if (validation.ok) {
      const proposal: Proposal = {
        id: uuidv4(),
        rationale: finalize.rationale,
        alfred_says: finalize.alfred_says,
        operators,
        voice_check: validation.voice_check,
      };
      recordProposal(req.session_id, req.intent, req.document, proposal);
      // eslint-disable-next-line no-console
      console.log(
        `[alfred-agents] returning proposal: turn ${turn + 1}, ${operators.length} ops, glue ${proposal.voice_check.glue_budget_used}/60, end_turn=${endTurn}`
      );
      return { ok: true, proposal };
    }

    // Validation failed — feed the failure back to the agent in the same session.
    // eslint-disable-next-line no-console
    console.warn(`[alfred-agents] turn ${turn + 1} validation failed:`, validation.reasons.join("; "));
    if (turn === MAX_TURNS - 1) {
      return {
        ok: false,
        error: "validation_failed",
        details: describeFailureForRetry(validation),
      };
    }
    nextUserText = describeFailureForRetry(validation) +
      "\n\nRe-emit the operator sequence with the constraints respected. Tighten glue, reduce migrate change-pct (≤50%), drop forbidden tokens, fix invalid paragraph IDs.";
  }

  // Should be unreachable.
  return { ok: false, error: "exhausted_turns" };

}

// --- shared with alfred.ts; kept duplicated here for transport-isolation ---

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
  if (!raw || typeof raw !== "object") return { kind: "at", where: "end" };
  const v = raw as Record<string, unknown>;
  if (v.kind === "after" && typeof v.paragraph_id === "string" && v.paragraph_id.length > 0) {
    return { kind: "after", paragraph_id: v.paragraph_id };
  }
  if (v.kind === "at") {
    const where = v.where === "start" ? "start" : "end";
    return { kind: "at", where };
  }
  if (typeof v.paragraph_id === "string" && v.paragraph_id.length > 0) {
    return { kind: "after", paragraph_id: v.paragraph_id };
  }
  if (v.where === "start" || v.where === "end") {
    return { kind: "at", where: v.where as "start" | "end" };
  }
  return { kind: "at", where: "end" };
}

export function getAgentBootstrap(): AgentBootstrap | null {
  return bootstrap;
}
