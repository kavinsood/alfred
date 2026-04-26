import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { handlePropose } from "./alfred.js";
import {
  handleProposeViaAgents,
  getAgentBootstrap,
  loadBootstrapEager,
  getAgentInfo,
} from "./alfred-agents.js";
import { handleDecision, handleGetProfile, handlePutProfile } from "./profile.js";
import { handleInspect } from "./inspect.js";

dotenv.config();

const ALFRED_MODE: "messages" | "agents" =
  (process.env.ALFRED_MODE ?? "messages").toLowerCase() === "agents" ? "agents" : "messages";

const app = express();
app.use(cors({ origin: "http://localhost:5173" }));
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", async (_req, res) => {
  const base = {
    ok: true,
    service: "alfred",
    model: "claude-opus-4-7",
    mode: ALFRED_MODE,
  };
  if (ALFRED_MODE === "agents") {
    try {
      const boot = (await loadBootstrapEager()) ?? getAgentBootstrap();
      if (boot) {
        res.json({
          ...base,
          agent_id: boot.agent_id,
          environment_id: boot.environment_id,
        });
        return;
      }
    } catch {
      // fall through to base — health stays green; agent_id field absent indicates "not provisioned yet"
    }
  }
  res.json(base);
});

app.post("/api/propose", async (req, res, next) => {
  try {
    const out =
      ALFRED_MODE === "agents"
        ? await handleProposeViaAgents(req.body)
        : await handlePropose(req.body);
    res.json(out);
  } catch (err) {
    next(err);
  }
});

app.post("/api/decision", async (req, res, next) => {
  try {
    const out = await handleDecision(req.body);
    res.json(out);
  } catch (err) {
    next(err);
  }
});

app.get("/api/profile", async (_req, res, next) => {
  try {
    res.json(await handleGetProfile());
  } catch (err) {
    next(err);
  }
});

app.put("/api/profile", async (req, res, next) => {
  try {
    res.json(await handlePutProfile(req.body));
  } catch (err) {
    next(err);
  }
});

app.post("/api/inspect", async (req, res, next) => {
  try {
    res.json(await handleInspect(req.body));
  } catch (err) {
    next(err);
  }
});

app.get("/api/agent/info", async (_req, res, next) => {
  try {
    if (ALFRED_MODE !== "agents") {
      res.status(404).json({
        ok: false,
        error: "agents_mode_only",
        details: "/api/agent/info is only available when ALFRED_MODE=agents",
      });
      return;
    }
    res.json(await getAgentInfo());
  } catch (err) {
    next(err);
  }
});

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  // eslint-disable-next-line no-console
  console.error("[alfred] error:", err);
  const message = err instanceof Error ? err.message : String(err);
  res.status(500).json({ ok: false, error: "server_error", details: message });
});

const port = Number(process.env.PORT ?? 3001);
app.listen(port, () => {
  /* eslint-disable no-console */
  console.log(`[alfred] listening on http://localhost:${port}`);
  console.log(`[alfred] mode:  ${ALFRED_MODE}`);
  console.log(`[alfred] model: claude-opus-4-7`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn("[alfred] ⚠  ANTHROPIC_API_KEY is not set — propose/inspect calls will fail. Set it in your shell or in backend/.env");
  } else {
    const k = process.env.ANTHROPIC_API_KEY;
    console.log(`[alfred] api key: ${k.slice(0, 7)}…${k.slice(-4)} (length ${k.length})`);
  }
  console.log(`[alfred] data home: ${process.env.ALFRED_HOME ?? "~/.alfred"}`);
  if (ALFRED_MODE === "agents") {
    void (async () => {
      const boot = await loadBootstrapEager();
      if (boot) {
        console.log(`[alfred] agent:    ${boot.agent_id}`);
        console.log(`[alfred] env:      ${boot.environment_id}`);
      } else {
        console.warn("[alfred] ⚠  ALFRED_MODE=agents but no agent.json found.");
        console.warn("[alfred] ⚠  Run: node backend/scripts/setup-agent.mjs");
        console.warn("[alfred] ⚠  /api/propose will fail until you do.");
      }
    })();
  }
  /* eslint-enable no-console */
});
