// Voice profile storage + the /api/profile and /api/decision handlers.

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { v4 as uuidv4 } from "uuid";
import type {
  DecisionRequest,
  DecisionResponse,
  ProfileResponse,
  SessionLogEntry,
  VoiceProfile,
} from "./types.js";
import { getSession, recordDecision } from "./session.js";

const ALFRED_HOME =
  process.env.ALFRED_HOME && process.env.ALFRED_HOME.length > 0
    ? process.env.ALFRED_HOME.replace(/^~/, os.homedir())
    : path.join(os.homedir(), ".alfred");

const PROSERC_PATH = path.join(ALFRED_HOME, "proserc.md");
const PROFILE_JSON_PATH = path.join(ALFRED_HOME, "voice-profile.json");
const SESSIONS_DIR = path.join(ALFRED_HOME, "sessions");

const DEFAULT_PROFILE: VoiceProfile = {
  vibe_anchor: "",
  forbidden_tokens: [
    "delve",
    "tapestry",
    "leverage",
    "landscape",
    "bustling",
    "navigate",
    "underscore",
    "elevate",
    "nestled",
    "myriad",
  ],
  learned_preferences: [],
};

const DEFAULT_PROSERC = `# Alfred .proserc
# This file is yours to edit. Alfred reads it on every invocation.
# Lines starting with '#' are comments and ignored.

## vibe_anchor

(empty)

## forbidden_tokens

delve
tapestry
leverage
landscape
bustling
navigate
underscore
elevate
nestled
myriad

## learned_preferences

(empty)
`;

async function ensureHome(): Promise<void> {
  await fs.mkdir(ALFRED_HOME, { recursive: true });
  await fs.mkdir(SESSIONS_DIR, { recursive: true });
  try {
    await fs.access(PROSERC_PATH);
  } catch {
    await fs.writeFile(PROSERC_PATH, DEFAULT_PROSERC, "utf8");
  }
  try {
    await fs.access(PROFILE_JSON_PATH);
  } catch {
    await fs.writeFile(PROFILE_JSON_PATH, JSON.stringify(DEFAULT_PROFILE, null, 2), "utf8");
  }
}

export async function loadProfile(): Promise<VoiceProfile> {
  await ensureHome();
  // Merge: proserc.md is the authoritative source for vibe_anchor + forbidden_tokens
  // (human-editable). voice-profile.json is the source for learned_preferences
  // (machine-written but human-correctable).
  const proserc = await fs.readFile(PROSERC_PATH, "utf8");
  const json = JSON.parse(await fs.readFile(PROFILE_JSON_PATH, "utf8")) as VoiceProfile;

  const parsed = parseProserc(proserc);

  return {
    vibe_anchor: parsed.vibe_anchor || json.vibe_anchor || "",
    forbidden_tokens:
      parsed.forbidden_tokens.length > 0
        ? parsed.forbidden_tokens
        : json.forbidden_tokens ?? DEFAULT_PROFILE.forbidden_tokens,
    learned_preferences: json.learned_preferences ?? [],
    stylometric_signals: json.stylometric_signals,
  };
}

export async function saveProfile(profile: VoiceProfile): Promise<void> {
  await ensureHome();
  await fs.writeFile(PROFILE_JSON_PATH, JSON.stringify(profile, null, 2), "utf8");
  await fs.writeFile(PROSERC_PATH, renderProserc(profile), "utf8");
}

function parseProserc(src: string): { vibe_anchor: string; forbidden_tokens: string[] } {
  const sections = src.split(/^##\s+/m);
  let vibe_anchor = "";
  let forbidden_tokens: string[] = [];
  for (const section of sections) {
    const head = section.slice(0, section.indexOf("\n")).trim().toLowerCase();
    const body = section.slice(section.indexOf("\n") + 1).trim();
    if (head === "vibe_anchor") {
      vibe_anchor = body === "(empty)" ? "" : body;
    } else if (head === "forbidden_tokens") {
      forbidden_tokens = body
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .filter((line) => !line.startsWith("#") && !line.startsWith("("))
        // forbidden tokens are single words; reject anything with whitespace
        .filter((line) => /^[A-Za-z][A-Za-z0-9'-]*$/.test(line));
    }
  }
  return { vibe_anchor, forbidden_tokens };
}

function renderProserc(profile: VoiceProfile): string {
  const tokens = profile.forbidden_tokens.length > 0
    ? profile.forbidden_tokens.join("\n")
    : "(empty)";
  const learnedSection = profile.learned_preferences.length === 0
    ? "(empty)"
    : profile.learned_preferences
        .map((p) => `- (${p.evidence_count}×) ${p.rule}`)
        .join("\n");
  return `# Alfred .proserc

This file is yours to edit. Alfred reads it on every invocation and respects it as architectural constraint.

## vibe_anchor

${profile.vibe_anchor.trim().length > 0 ? profile.vibe_anchor.trim() : "(empty)"}

## forbidden_tokens

${tokens}

## learned_preferences

${learnedSection}
`;
}

export async function appendSessionLog(
  sessionId: string,
  entry: SessionLogEntry
): Promise<void> {
  await ensureHome();
  const file = path.join(SESSIONS_DIR, `${sessionId}.md`);
  const line = `## ${entry.ts} — ${entry.decision.toUpperCase()} — ${entry.operator_kinds.join(", ")}

**Intent:** ${entry.intent}
**Rationale:** ${entry.rationale}
${entry.reject_reason ? `**Reject reason:** ${entry.reject_reason}` : ""}
${entry.modified_text ? `**Modified text:** ${entry.modified_text}` : ""}
`.trim() + "\n\n";
  await fs.appendFile(file, line, "utf8");
}

export async function readRecentSessionLog(sessionId: string, max = 20): Promise<SessionLogEntry[]> {
  // We keep canonical session log in memory (session.ts). For the panopticon "Log" tab
  // we return the in-memory entries, not parse the markdown. Markdown is for the human.
  const session = getSession(sessionId);
  return session.log.slice(-max);
}

// --- Handlers ---

export async function handleGetProfile(): Promise<ProfileResponse> {
  const profile = await loadProfile();
  // For a generic GET we return the global profile and an empty recent log.
  return { profile, recent_log: [] };
}

export async function handlePutProfile(body: { profile: VoiceProfile }): Promise<{ ok: true }> {
  await saveProfile(body.profile);
  return { ok: true };
}

export async function handleDecision(req: DecisionRequest): Promise<DecisionResponse> {
  const { profile, summary } = await recordDecision(req);
  await saveProfile(profile);
  return { ok: true, updated_profile_summary: summary };
}

export function alfredHomePath(): string {
  return ALFRED_HOME;
}
