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
import { getTransport } from "./transport.js";

dotenv.config();

const ALFRED_TRANSPORT = getTransport(process.env);

async function getManagedAgentsBootstrap() {
  try {
    return (await loadBootstrapEager()) ?? getAgentBootstrap();
  } catch {
    return null;
  }
}

const app = express();
app.use(cors({ origin: "http://localhost:5173" }));
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", async (_req, res) => {
  const boot = ALFRED_TRANSPORT === "managed-agents"
    ? await getManagedAgentsBootstrap()
    : null;
  res.json({
    ok: true,
    service: "alfred",
    model: "claude-opus-4-7",
    transport: ALFRED_TRANSPORT,
    managedAgentsSelected: ALFRED_TRANSPORT === "managed-agents",
    managedAgentsConfigured: Boolean(boot),
  });
});

app.post("/api/propose", async (req, res, next) => {
  try {
    let activeTransport = ALFRED_TRANSPORT;

    if (ALFRED_TRANSPORT === "managed-agents") {
      const boot = await getManagedAgentsBootstrap();
      if (!boot) {
        const allowFallback = process.env.ALLOW_TRANSPORT_FALLBACK === "true";
        if (!allowFallback) {
          res.status(503).json({
            ok: false,
            error: "managed_agents_not_configured",
            details: "ALFRED_TRANSPORT=managed-agents but agent.json is missing. Run `node backend/scripts/setup-agent.mjs` or set ALLOW_TRANSPORT_FALLBACK=true.",
          });
          return;
        }
        // eslint-disable-next-line no-console
        console.warn("[alfred] managed-agents not configured, falling back to messages transport");
        activeTransport = "messages";
      }
    }

    const out =
      activeTransport === "managed-agents"
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
    if (ALFRED_TRANSPORT !== "managed-agents") {
      res.status(404).json({
        ok: false,
        error: "agents_mode_only",
        details: "/api/agent/info is only available when ALFRED_TRANSPORT=managed-agents",
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
  console.log(`[alfred] transport: ${ALFRED_TRANSPORT}`);
  console.log(`[alfred] model: claude-opus-4-7`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn("[alfred] ⚠  ANTHROPIC_API_KEY is not set — propose/inspect calls will fail. Set it in your shell or in backend/.env");
  } else {
    console.log("[alfred] api key: configured");
  }
  console.log(`[alfred] data home: ${process.env.ALFRED_HOME ?? "~/.alfred"}`);
  if (ALFRED_TRANSPORT === "managed-agents") {
    void (async () => {
      const boot = await loadBootstrapEager();
      if (boot) {
        console.log(`[alfred] agent: configured`);
      } else {
        console.warn("[alfred] ⚠  ALFRED_TRANSPORT=managed-agents but no agent.json found.");
        console.warn("[alfred] ⚠  Run: node backend/scripts/setup-agent.mjs");
        if (process.env.ALLOW_TRANSPORT_FALLBACK !== "true") {
          console.warn("[alfred] ⚠  /api/propose will fail until you do (set ALLOW_TRANSPORT_FALLBACK=true to fall back to messages).");
        }
      }
    })();
  }
  /* eslint-enable no-console */
});
