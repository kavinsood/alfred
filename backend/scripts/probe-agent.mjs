#!/usr/bin/env node
// Probe: create a session against the provisioned Alfred agent, send a tiny
// document + intent, stream events back, collect tool calls, send tool
// results to keep the session moving, finalize on end_turn.
//
// Goal: prove the runtime model end-to-end before refactoring alfred.ts.

import Anthropic from "@anthropic-ai/sdk";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const ALFRED_HOME = (process.env.ALFRED_HOME ?? path.join(os.homedir(), ".alfred")).replace(/^~/, os.homedir());
const { agent_id, environment_id } = JSON.parse(await fs.readFile(path.join(ALFRED_HOME, "agent.json"), "utf8"));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

console.log(`agent: ${agent_id}`);
console.log(`environment: ${environment_id}`);

console.log("creating session…");
const session = await client.beta.sessions.create({
  agent: agent_id,
  environment_id: environment_id,
  title: "probe-session",
});
console.log(`  ✓ session: ${session.id}`);

const userMessage = `## Document

[p1]
Most AI writing tools optimize for the wrong thing. They chase fluency. The product of that chase is uniformity. Sentences regress to the median. Voice flattens.

[p2]
I used to feel this when I'd paste my drafts into ChatGPT. Something would come back smoother and duller.

[p3]
There are two kinds of writing tools: ones that generate prose, and ones that organize what you've produced. The first kind is mostly noise now. The second kind barely exists.

[p4]
The mistake the field made was treating writing as a generation problem. It is a topology problem. The writer's brain is a graph.

## Invocation

Intent: this graf drags — find the buried thesis and hoist it to the lede.

Emit operator tool calls now, then \`finalize_proposal\`.`;

console.log("sending user.message…");
await client.beta.sessions.events.send(session.id, {
  events: [
    {
      type: "user.message",
      content: [{ type: "text", text: userMessage }],
    },
  ],
});

console.log("streaming session events…");
const stream = await client.beta.sessions.events.stream(session.id);

const toolCalls = [];
let finalize = null;
let endTurn = false;
let lastStatus = "";

for await (const ev of stream) {
  const type = ev.type;
  if (type === "agent.custom_tool_use") {
    toolCalls.push({ id: ev.id, name: ev.name, input: ev.input });
    console.log(`  → tool_use: ${ev.name}(${JSON.stringify(ev.input).slice(0, 80)}…)`);
    if (ev.name === "finalize_proposal") {
      finalize = ev.input;
    }
  } else if (type === "agent.message") {
    const text = (ev.content ?? []).map((b) => b.text ?? "").join("");
    if (text) console.log(`  → agent text: ${text.slice(0, 120)}…`);
  } else if (type === "session.status_idle") {
    const stop = ev.stop_reason ?? {};
    if (stop.type === "end_turn") {
      console.log("  → end_turn");
      endTurn = true;
      break;
    } else if (stop.type === "requires_action") {
      const ids = stop.event_ids ?? [];
      console.log(`  → requires_action: ${ids.length} pending`);
      // Send results for all pending tool_use events so the session resumes.
      await client.beta.sessions.events.send(session.id, {
        events: ids.map((tid) => ({
          type: "user.custom_tool_result",
          custom_tool_use_id: tid,
          content: [{ type: "text", text: "applied" }],
        })),
      });
    } else if (stop.type === "retries_exhausted") {
      console.log("  → retries_exhausted");
      break;
    }
  } else if (type === "session.status_terminated") {
    console.log(`  → terminated: ${JSON.stringify(ev).slice(0, 200)}`);
    break;
  } else if (type === "session.error") {
    console.log(`  → ERROR: ${JSON.stringify(ev).slice(0, 300)}`);
    break;
  } else if (type !== lastStatus) {
    console.log(`  → ${type}`);
    lastStatus = type;
  }
}

console.log("\n=== RESULT ===");
console.log(`  tool_calls: ${toolCalls.length}`);
console.log(`  end_turn:   ${endTurn}`);
console.log(`  finalize:   ${finalize ? "✓" : "✗"}`);
if (finalize) {
  console.log(`  alfred_says: "${finalize.alfred_says}"`);
  console.log(`  rationale:   "${finalize.rationale}"`);
}
console.log("\noperators:");
for (const tc of toolCalls) {
  if (tc.name !== "finalize_proposal") {
    console.log(`  - ${tc.name}: ${JSON.stringify(tc.input)}`);
  }
}
