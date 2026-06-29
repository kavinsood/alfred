import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { handlePropose } from "./alfred.js";
import { handleDecision, handleGetProfile, handlePutProfile } from "./profile.js";
import { handleInspect } from "./inspect.js";
import { getEnvironmentInfo } from "./environment.js";
import { MODEL } from "./config.js";

dotenv.config();

const app = express();
app.use(cors({ origin: "http://localhost:5173" }));
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "alfred", model: MODEL, transport: "messages" });
});

app.post("/api/propose", async (req, res, next) => {
  try {
    res.json(await handlePropose(req.body));
  } catch (err) {
    next(err);
  }
});

app.post("/api/decision", async (req, res, next) => {
  try {
    res.json(await handleDecision(req.body));
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

app.get("/api/environment", (req, res, next) => {
  try {
    const sessionId = typeof req.query.session_id === "string" ? req.query.session_id : undefined;
    res.json(getEnvironmentInfo(sessionId));
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
  console.log(`[alfred] model: ${MODEL}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn("[alfred] ⚠  ANTHROPIC_API_KEY is not set — propose/inspect calls will fail. Set it in your shell or in backend/.env");
  } else {
    console.log("[alfred] api key: configured");
  }
  console.log(`[alfred] data home: ${process.env.ALFRED_HOME ?? "~/.alfred"}`);
  /* eslint-enable no-console */
});
