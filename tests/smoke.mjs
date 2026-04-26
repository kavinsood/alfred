#!/usr/bin/env node
// Alfred smoke test. Hits a running backend on localhost:3001 and walks the
// full lifecycle: health → propose → decide (accept) → inspect → profile.
// Usage: node tests/smoke.mjs

const BASE = process.env.ALFRED_BASE ?? "http://localhost:3001";

const c = {
  ok: "\x1b[32m✓\x1b[0m",
  fail: "\x1b[31m✗\x1b[0m",
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

function fail(msg) {
  console.error(`${c.fail} ${msg}`);
  process.exit(1);
}

async function step(name, fn) {
  process.stdout.write(`  ${c.dim("…")} ${name} `);
  try {
    const out = await fn();
    process.stdout.write(`\r  ${c.ok} ${name}\n`);
    return out;
  } catch (err) {
    process.stdout.write(`\r  ${c.fail} ${name}\n`);
    throw err;
  }
}

async function main() {
  console.log(c.bold("Alfred smoke test"));
  console.log(c.dim(`  base: ${BASE}\n`));

  // 1. health
  const health = await step("GET /api/health", async () => {
    const r = await fetch(`${BASE}/api/health`);
    if (!r.ok) throw new Error(`status ${r.status}`);
    const d = await r.json();
    if (!d.ok || d.model !== "claude-opus-4-7") {
      throw new Error(`unexpected health: ${JSON.stringify(d)}`);
    }
    if (d.mode === "agents") {
      if (!d.agent_id || !d.environment_id) {
        throw new Error(`mode=agents but missing agent_id/environment_id — run scripts/setup-agent.mjs`);
      }
    }
    return d;
  });
  console.log(c.dim(`     mode: ${health.mode ?? "messages"}${health.agent_id ? ` · agent ${health.agent_id.slice(0, 18)}…` : ""}`));

  // 1b. agent info — only when mode=agents
  if (health.mode === "agents") {
    await step("GET /api/agent/info (round-trip to Anthropic)", async () => {
      const r = await fetch(`${BASE}/api/agent/info`);
      if (!r.ok) throw new Error(`status ${r.status}`);
      const d = await r.json();
      if (d.name !== "Alfred") throw new Error(`agent.name is "${d.name}", expected "Alfred"`);
      const toolCount = Array.isArray(d.tools) ? d.tools.length : 0;
      if (toolCount < 9) throw new Error(`expected ≥9 tools, got ${toolCount}`);
      return d;
    });
  }

  // 2. propose
  const sessionId = `smoke-${Date.now()}`;
  const document = {
    paragraphs: [
      { id: "p1", text: "Most AI writing tools optimize for the wrong thing. They chase fluency. The result is uniformity. Voice flattens." },
      { id: "p2", text: "I used to feel this when I'd paste my drafts into ChatGPT. Something would come back smoother and duller." },
      { id: "p3", text: "There are two kinds of writing tools: ones that generate prose, and ones that organize what you've produced. The first kind is mostly noise now. The second kind barely exists." },
      { id: "p4", text: "The mistake the field made was treating writing as a generation problem. It is a topology problem. The writer's brain is a graph." },
    ],
  };

  const proposal = await step("POST /api/propose (essay flow, ~10s)", async () => {
    const r = await fetch(`${BASE}/api/propose`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        document,
        intent: "this graf drags — find the buried thesis and hoist it to the lede",
        session_id: sessionId,
      }),
    });
    if (!r.ok) throw new Error(`status ${r.status}`);
    const d = await r.json();
    if (!d.ok) throw new Error(`propose failed: ${d.error} ${d.details ?? ""}`);
    if (!Array.isArray(d.proposal?.operators)) throw new Error("missing operators");
    if (typeof d.proposal.alfred_says !== "string") throw new Error("missing alfred_says");
    return d.proposal;
  });

  console.log(c.dim(`     alfred says: "${proposal.alfred_says.slice(0, 80)}…"`));
  console.log(c.dim(`     operators: ${proposal.operators.map((o) => o.kind).join(", ")}`));
  console.log(c.dim(`     voice integrity: glue ${proposal.voice_check.glue_budget_used}/60 tok`));

  // 3. decision
  await step("POST /api/decision (accept)", async () => {
    const r = await fetch(`${BASE}/api/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        proposal_id: proposal.id,
        decision: "accept",
      }),
    });
    if (!r.ok) throw new Error(`status ${r.status}`);
    const d = await r.json();
    if (!d.ok) throw new Error(`decision failed: ${JSON.stringify(d)}`);
    return d;
  });

  // 4. inspect
  await step("POST /api/inspect (~5s)", async () => {
    const r = await fetch(`${BASE}/api/inspect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ document, session_id: sessionId }),
    });
    if (!r.ok) throw new Error(`status ${r.status}`);
    const d = await r.json();
    if (typeof d.read !== "string") throw new Error("missing read");
    if (typeof d.claims !== "number") throw new Error("missing claims");
    return d;
  });

  // 5. profile
  await step("GET /api/profile", async () => {
    const r = await fetch(`${BASE}/api/profile`);
    if (!r.ok) throw new Error(`status ${r.status}`);
    const d = await r.json();
    if (!d.profile) throw new Error("missing profile");
    if (!Array.isArray(d.profile.forbidden_tokens)) throw new Error("missing forbidden_tokens");
    return d;
  });

  console.log(`\n${c.bold("All checks passed.")} Alfred is alive on ${BASE}.`);
}

main().catch((err) => fail(err.message ?? String(err)));
