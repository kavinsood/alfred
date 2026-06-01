#!/usr/bin/env node
// One-time bootstrap: creates Alfred's Managed Agent + a cloud environment.
// Idempotent — reads existing IDs from <ALFRED_HOME>/agent.json if present
// and only creates what's missing.
//
// Usage:
//   node tests/setup-agent.mjs
//   ALFRED_HOME=/tmp/alfred-agents-test node tests/setup-agent.mjs

import Anthropic from "@anthropic-ai/sdk";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const ALFRED_HOME =
  process.env.ALFRED_HOME && process.env.ALFRED_HOME.length > 0
    ? process.env.ALFRED_HOME.replace(/^~/, os.homedir())
    : path.join(os.homedir(), ".alfred");

const AGENT_FILE = path.join(ALFRED_HOME, "agent.json");

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = [
  "You are Alfred — a logomorphic editor.",
  "",
  "Your single, architectural constraint is this: you cannot author prose. You can only emit operator tool calls drawn from a fixed algebra. The user's voice is preserved by construction, not by instruction.",
  "",
  "## Operator algebra",
  "- `split` — divide one paragraph at a sentence boundary. No words added.",
  "- `merge` — combine two paragraphs. Optional glue text ≤15 tokens.",
  "- `move` — relocate a paragraph. No text change.",
  "- `hoist` — promote to intro/thesis/section_lead. No text change.",
  "- `demote` — tag as supporting under a parent. Metadata-only.",
  "- `migrate` — reproject a paragraph from an older voice frame. ≤50% token-edit distance. ONLY for fragments clearly written in a different voice (AI output, older session, foreign source, formally-registered text) — never on text the user wrote in their current voice.",
  "- `glue` — insert ≤15 tokens of connective tissue.",
  "- `delete` — remove a paragraph (orphans, asides). Must justify in rationale.",
  "- `finalize_proposal` — call once at the end with rationale and alfred_says.",
  "",
  "On every invocation: emit a sequence of operator tool calls, then exactly one `finalize_proposal` call. Do not write any other prose.",
  "",
  "## Editorial voice",
  "Talk like a New Yorker copy editor. Terse. Punchy. No flattery. No apology. No filler.",
  "Say: \"graf 3 drags\", \"buried thesis\", \"redundant — collapse\", \"this aside has no home\", \"reproject from the older draft.\"",
  "",
  "Return only operator tool calls. Nothing else.",
].join("\n");

const POSITION_SCHEMA = {
  type: "object",
  description: "Either { kind: 'after', paragraph_id } or { kind: 'at', where: 'start' | 'end' }",
  properties: {
    kind: { type: "string", enum: ["after", "at"] },
    paragraph_id: { type: "string" },
    where: { type: "string", enum: ["start", "end"] },
  },
};

const TOOLS = [
  {
    type: "custom",
    name: "split",
    description: "Divide one paragraph into two at a sentence boundary. Adds NO new words.",
    input_schema: {
      type: "object",
      required: ["paragraph_id", "after_sentence_index"],
      properties: {
        paragraph_id: { type: "string" },
        after_sentence_index: { type: "integer", minimum: 0 },
      },
    },
  },
  {
    type: "custom",
    name: "merge",
    description: "Combine two paragraphs into one. Optional glue_text is at most 15 tokens.",
    input_schema: {
      type: "object",
      required: ["first_paragraph_id", "second_paragraph_id"],
      properties: {
        first_paragraph_id: { type: "string" },
        second_paragraph_id: { type: "string" },
        glue_text: { type: "string" },
      },
    },
  },
  {
    type: "custom",
    name: "move",
    description: "Relocate a paragraph to a new position. No text alteration.",
    input_schema: {
      type: "object",
      required: ["paragraph_id", "target_position"],
      properties: {
        paragraph_id: { type: "string" },
        target_position: POSITION_SCHEMA,
      },
    },
  },
  {
    type: "custom",
    name: "hoist",
    description: "Move a paragraph to a higher structural role (intro/thesis/section_lead).",
    input_schema: {
      type: "object",
      required: ["paragraph_id", "target_role", "target_position"],
      properties: {
        paragraph_id: { type: "string" },
        target_role: { type: "string", enum: ["intro", "thesis", "section_lead"] },
        target_position: POSITION_SCHEMA,
      },
    },
  },
  {
    type: "custom",
    name: "demote",
    description: "Tag a paragraph as supporting under a parent claim. Metadata-only.",
    input_schema: {
      type: "object",
      required: ["paragraph_id", "parent_paragraph_id"],
      properties: {
        paragraph_id: { type: "string" },
        parent_paragraph_id: { type: "string" },
      },
    },
  },
  {
    type: "custom",
    name: "migrate",
    description: "Reproject a paragraph from an older voice frame. ≤50% token-edit distance.",
    input_schema: {
      type: "object",
      required: ["paragraph_id", "rewrite_text", "change_budget_tokens"],
      properties: {
        paragraph_id: { type: "string" },
        rewrite_text: { type: "string" },
        change_budget_tokens: { type: "integer", minimum: 0 },
      },
    },
  },
  {
    type: "custom",
    name: "glue",
    description: "Insert minimal connective text (≤15 tokens) to bridge structural moves.",
    input_schema: {
      type: "object",
      required: ["position", "text"],
      properties: { position: POSITION_SCHEMA, text: { type: "string" } },
    },
  },
  {
    type: "custom",
    name: "delete",
    description: "Remove a paragraph. Must justify in rationale.",
    input_schema: {
      type: "object",
      required: ["paragraph_id"],
      properties: { paragraph_id: { type: "string" } },
    },
  },
  {
    type: "custom",
    name: "finalize_proposal",
    description: "Emit the editorial commentary and rationale once all operator calls are made. Call exactly once at the end of the turn.",
    input_schema: {
      type: "object",
      required: ["rationale", "alfred_says"],
      properties: {
        rationale: { type: "string" },
        alfred_says: { type: "string" },
      },
    },
  },
];

async function main() {
  await fs.mkdir(ALFRED_HOME, { recursive: true });

  let existing = null;
  try {
    existing = JSON.parse(await fs.readFile(AGENT_FILE, "utf8"));
  } catch {}

  if (existing?.agent_id && existing?.environment_id) {
    console.log("alfred agent already provisioned:");
    console.log(`  agent_id:       ${existing.agent_id}`);
    console.log(`  environment_id: ${existing.environment_id}`);
    console.log(`(delete ${AGENT_FILE} to reprovision)`);
    return;
  }

  console.log("provisioning Alfred Managed Agent…");

  console.log("  creating environment…");
  const env = await client.beta.environments.create({
    name: "alfred-cloud",
    description: "Sandbox env for Alfred sessions (text-only; no shell tools used).",
  });
  console.log(`    ✓ environment: ${env.id}`);

  console.log("  creating agent…");
  const agent = await client.beta.agents.create({
    model: "claude-opus-4-7",
    name: "Alfred",
    description: "Logomorphic editor. Constrained to operator-algebra tool calls; never authors prose.",
    system: SYSTEM_PROMPT,
    tools: TOOLS,
  });
  console.log(`    ✓ agent: ${agent.id} (version ${agent.version})`);

  const out = {
    agent_id: agent.id,
    agent_version: agent.version,
    environment_id: env.id,
    created_at: new Date().toISOString(),
  };
  await fs.writeFile(AGENT_FILE, JSON.stringify(out, null, 2), "utf8");
  console.log(`\nwrote ${AGENT_FILE}`);
}

main().catch((err) => {
  console.error("setup failed:");
  console.error(err);
  process.exit(1);
});
