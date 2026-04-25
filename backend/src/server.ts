import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { handlePropose } from "./alfred.js";
import { handleDecision, handleGetProfile, handlePutProfile } from "./profile.js";
import { handleInspect } from "./inspect.js";

dotenv.config();

const app = express();
app.use(cors({ origin: "http://localhost:5173" }));
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "alfred", model: "claude-opus-4-7" });
});

app.post("/api/propose", async (req, res, next) => {
  try {
    const out = await handlePropose(req.body);
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

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  // eslint-disable-next-line no-console
  console.error("[alfred] error:", err);
  const message = err instanceof Error ? err.message : String(err);
  res.status(500).json({ ok: false, error: "server_error", details: message });
});

const port = Number(process.env.PORT ?? 3001);
app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`[alfred] listening on http://localhost:${port}`);
});
