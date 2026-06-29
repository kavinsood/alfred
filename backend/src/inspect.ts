// /api/inspect — Alfred reads the document and reports without proposing changes.

import Anthropic from "@anthropic-ai/sdk";
import type { InspectRequest, InspectResponse, StylometricSignals } from "./types.js";
import { renderDocumentBlock, renderProfileBlock } from "./prompts.js";
import { loadProfile } from "./profile.js";
import { tokenize } from "./tokenize.js";
import { splitSentences } from "./operators.js";
import { MODEL } from "./config.js";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const READ_SYSTEM = [
  "You are Alfred — a logomorphic editor.",
  "",
  "When asked to inspect, you do NOT propose changes. You report on the document's structural state in plain English, briefly and editorially.",
  "",
  "Output JSON exactly matching this shape (no preamble, no closing remarks):",
  "{",
  "  \"read\": \"<2-4 sentence read of the document; editorial voice>\",",
  "  \"claims\": <integer count of distinct claims>,",
  "  \"evidence_links\": <integer count of evidence-supporting paragraphs>,",
  "  \"orphans\": [<paragraph_ids of orphan claims>]",
  "}",
].join("\n");

export async function handleInspect(req: InspectRequest): Promise<InspectResponse> {
  const profile = await loadProfile();
  const stylo = computeStylometrics(req.document.paragraphs.map((p) => p.text).join("\n\n"));

  if (req.document.paragraphs.length === 0) {
    return {
      read: "Empty page. Nothing to read.",
      claims: 0,
      evidence_links: 0,
      orphans: [],
      voice_fingerprint: stylo,
    };
  }

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: [
      { type: "text", text: READ_SYSTEM },
      { type: "text", text: renderProfileBlock(profile) },
    ],
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: renderDocumentBlock(req.document) }],
      },
    ],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  let parsed: { read: string; claims: number; evidence_links: number; orphans: string[] };
  try {
    parsed = JSON.parse(extractJson(text));
  } catch (err) {
    parsed = { read: text.slice(0, 400), claims: 0, evidence_links: 0, orphans: [] };
  }

  return {
    read: parsed.read ?? "",
    claims: Number(parsed.claims ?? 0),
    evidence_links: Number(parsed.evidence_links ?? 0),
    orphans: Array.isArray(parsed.orphans) ? parsed.orphans.map(String) : [],
    voice_fingerprint: stylo,
  };
}

function extractJson(s: string): string {
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end < 0) return s;
  return s.slice(start, end + 1);
}

function computeStylometrics(text: string): StylometricSignals {
  const sentences = splitSentences(text);
  if (sentences.length === 0) {
    return { sentence_length_mean: 0, sentence_length_std: 0, fragment_rate: 0, sample_count: 0 };
  }
  const lens = sentences.map((s) => tokenize(s).length);
  const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
  const variance = lens.reduce((acc, l) => acc + (l - mean) ** 2, 0) / lens.length;
  const std = Math.sqrt(variance);
  // "Fragment" rough heuristic: sentence with no verb-form word AND under 8 tokens.
  const fragments = sentences.filter((s) => {
    const toks = tokenize(s);
    return toks.length < 8 && !/\b(is|are|was|were|be|been|being|am|do|does|did|have|has|had|will|shall|can|could|may|might|must|should|would|go|goes|went|gone|come|came|see|saw|seen|say|said|make|made|take|took|find|found|tell|told|think|thought|know|knew|known)\b/i.test(s);
  }).length;
  return {
    sentence_length_mean: Number(mean.toFixed(1)),
    sentence_length_std: Number(std.toFixed(1)),
    fragment_rate: Number((fragments / sentences.length).toFixed(2)),
    sample_count: sentences.length,
  };
}
