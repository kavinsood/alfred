import { z } from "zod";
import { defineTool, type CustomTool } from "./custom-tools-runtime";
import {
  parseOperators,
  validateProposal,
  applyOperators,
  type AlfredDocument,
  type VoiceProfile,
} from "../alfred/operator-runtime";

const paragraphSchema = z.object({
  id: z.string(),
  text: z.string(),
  role: z.string().optional(),
  parent_id: z.string().optional(),
});

const documentSchema = z.object({
  paragraphs: z.array(paragraphSchema),
});

const operatorSchema = z.object({
  kind: z.string(),
}).passthrough();

export const CUSTOM_TOOLS: CustomTool[] = [
  defineTool({
    name: "alfred_get_context",
    description:
      "Load the writer's voice profile, current document, and relevant voice memories. Call this before proposing operators to understand the writer's voice constraints.",
    inputSchema: z.object({
      profile_id: z.string().describe("Writer's profile ID"),
      document_id: z.string().optional().describe("Document ID to load from D1"),
      intent: z.string().optional().describe("What the writer wants — used for voice memory search"),
    }),
    requires: (env) => Boolean((env as unknown as { ALFRED_DB?: unknown }).ALFRED_DB),
    run: async ({ profile_id, document_id, intent }, { env }) => {
      const db = (env as unknown as { ALFRED_DB: D1Database }).ALFRED_DB;

      const profileRow = await db
        .prepare("SELECT * FROM profiles WHERE id = ?")
        .bind(profile_id)
        .first();

      let profile;
      if (profileRow) {
        profile = {
          id: profileRow.id as string,
          vibe_anchor: profileRow.vibe_anchor as string,
          forbidden_tokens: JSON.parse((profileRow.forbidden_tokens as string) || "[]"),
          learned_preferences: JSON.parse((profileRow.learned_preferences as string) || "[]"),
        };
      } else {
        const now = new Date().toISOString();
        await db
          .prepare("INSERT INTO profiles (id, created_at, updated_at) VALUES (?, ?, ?)")
          .bind(profile_id, now, now)
          .run();
        profile = { id: profile_id, vibe_anchor: "", forbidden_tokens: [], learned_preferences: [] };
      }

      let document = null;
      if (document_id) {
        const docRow = await db
          .prepare("SELECT * FROM documents WHERE id = ?")
          .bind(document_id)
          .first();
        if (docRow) {
          document = JSON.parse(docRow.document as string);
        }
      }

      let voiceMemories: string[] = [];
      if (intent) {
        try {
          const vectors = (env as unknown as { ALFRED_VECTORS?: VectorizeIndex }).ALFRED_VECTORS;
          const ai = (env as unknown as { AI?: Ai }).AI;
          if (vectors && ai) {
            const embedding = await ai.run("@cf/baai/bge-base-en-v1.5", { text: [intent] });
            const vec = (embedding as unknown as { data: number[][] }).data?.[0];
            if (vec) {
              const results = await vectors.query(vec, {
                topK: 5,
                filter: { profile_id },
              });
              voiceMemories = results.matches.map((m) => m.id);
            }
          }
        } catch {
          // Vectorize/embeddings not configured — skip gracefully
        }
      }

      return JSON.stringify({ profile, document, voice_memories: voiceMemories });
    },
  }),

  defineTool({
    name: "alfred_validate_ops",
    description:
      "Validate a batch of structural edit operators against the document and voice profile. Returns pass/fail with detailed reasons. MUST call before storing a proposal. This is Alfred's trust boundary — operators that fail are rejected.",
    inputSchema: z.object({
      profile_id: z.string().describe("Writer's profile ID"),
      document: documentSchema.describe("The AlfredDocument to validate against"),
      operators: z.array(operatorSchema).describe("Array of operator objects, each with a 'kind' field (split/merge/move/hoist/demote/migrate/glue/delete) and operator-specific fields"),
      intent: z.string().describe("What the writer asked for"),
      rationale: z.string().describe("Why these operators were chosen"),
    }),
    requires: (env) => Boolean((env as unknown as { ALFRED_DB?: unknown }).ALFRED_DB),
    run: async ({ profile_id, document, operators, intent, rationale }, { env }) => {
      const db = (env as unknown as { ALFRED_DB: D1Database }).ALFRED_DB;

      const profileRow = await db
        .prepare("SELECT forbidden_tokens FROM profiles WHERE id = ?")
        .bind(profile_id)
        .first();

      const voiceProfile: VoiceProfile = {
        vibe_anchor: "",
        forbidden_tokens: profileRow
          ? JSON.parse((profileRow.forbidden_tokens as string) || "[]")
          : [],
        learned_preferences: [],
      };

      let ops;
      try {
        ops = parseOperators(operators as unknown[]);
      } catch (err) {
        return JSON.stringify({
          valid: false,
          errors: [`Parse error: ${err instanceof Error ? err.message : String(err)}`],
          warnings: [],
          operatorSummary: "(parse failed)",
        });
      }

      const result = validateProposal(document as AlfredDocument, ops, voiceProfile);

      if (!result.ok) {
        return JSON.stringify({
          valid: false,
          errors: result.reasons ?? [],
          warnings: [],
          operatorSummary: ops.map((o) => o.kind).join(" -> "),
        });
      }

      let afterDocument;
      try {
        afterDocument = applyOperators(document as AlfredDocument, ops);
      } catch {
        // validated above — shouldn't fail
      }

      return JSON.stringify({
        valid: true,
        errors: [],
        warnings: [],
        operatorSummary: ops.map((o) => o.kind).join(" -> "),
        voiceCheck: result.voiceCheck,
        afterDocument,
      });
    },
  }),

  defineTool({
    name: "alfred_store_proposal",
    description:
      "Store a validated proposal in D1. Only call after alfred_validate_ops returns valid=true.",
    inputSchema: z.object({
      profile_id: z.string().describe("Writer's profile ID"),
      session_id: z.string().describe("Session ID"),
      intent: z.string().describe("What the writer asked for"),
      rationale: z.string().describe("Why these operators were chosen"),
      operators: z.array(operatorSchema).describe("The validated operator array"),
      alfred_says: z.string().describe("1-2 sentence editorial commentary in New Yorker copy-editor voice"),
    }),
    requires: (env) => Boolean((env as unknown as { ALFRED_DB?: unknown }).ALFRED_DB),
    run: async (input, { env }) => {
      const db = (env as unknown as { ALFRED_DB: D1Database }).ALFRED_DB;
      const id = crypto.randomUUID();
      const now = new Date().toISOString();

      await db
        .prepare(
          "INSERT INTO proposals (id, session_id, profile_id, intent, rationale, operators, alfred_says, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .bind(id, input.session_id, input.profile_id, input.intent, input.rationale, JSON.stringify(input.operators), input.alfred_says, now)
        .run();

      await db
        .prepare(
          "INSERT INTO panopticon_events (id, profile_id, session_id, kind, summary, created_at) VALUES (?, ?, ?, ?, ?, ?)"
        )
        .bind(crypto.randomUUID(), input.profile_id, input.session_id, "proposal_stored", `Stored: ${input.intent}`, now)
        .run();

      return JSON.stringify({ proposal_id: id, stored_at: now });
    },
  }),

  defineTool({
    name: "alfred_record_decision",
    description:
      "Record the writer's accept/reject/modify decision on a proposal. Updates voice profile learning.",
    inputSchema: z.object({
      profile_id: z.string().describe("Writer's profile ID"),
      session_id: z.string().describe("Session ID"),
      proposal_id: z.string().describe("ID of the proposal being decided on"),
      decision: z.enum(["accept", "reject", "modify"]).describe("The decision"),
      reason: z.string().optional().describe("Why the writer rejected/modified"),
    }),
    requires: (env) => Boolean((env as unknown as { ALFRED_DB?: unknown }).ALFRED_DB),
    run: async ({ profile_id, session_id, proposal_id, decision, reason }, { env }) => {
      const db = (env as unknown as { ALFRED_DB: D1Database }).ALFRED_DB;
      const id = crypto.randomUUID();
      const now = new Date().toISOString();

      await db
        .prepare(
          "INSERT INTO decisions (id, proposal_id, session_id, profile_id, decision, reject_reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
        )
        .bind(id, proposal_id, session_id, profile_id, decision, reason ?? null, now)
        .run();

      await db
        .prepare(
          "INSERT INTO panopticon_events (id, profile_id, session_id, kind, summary, created_at) VALUES (?, ?, ?, ?, ?, ?)"
        )
        .bind(crypto.randomUUID(), profile_id, session_id, "decision_recorded", `${decision} on ${proposal_id}${reason ? `: ${reason}` : ""}`, now)
        .run();

      return JSON.stringify({ decision_id: id, decision, recorded_at: now });
    },
  }),

  defineTool({
    name: "alfred_get_panopticon",
    description:
      "Get the Panopticon summary: voice profile + recent events + decision stats. Shows what Alfred has learned about the writer's preferences.",
    inputSchema: z.object({
      profile_id: z.string().describe("Writer's profile ID"),
      session_id: z.string().optional().describe("Filter to a specific session"),
      limit: z.number().optional().describe("Max events to return (default 50)"),
    }),
    requires: (env) => Boolean((env as unknown as { ALFRED_DB?: unknown }).ALFRED_DB),
    run: async ({ profile_id, session_id, limit }, { env }) => {
      const db = (env as unknown as { ALFRED_DB: D1Database }).ALFRED_DB;
      const maxEvents = limit ?? 50;

      const profile = await db
        .prepare("SELECT * FROM profiles WHERE id = ?")
        .bind(profile_id)
        .first();

      let events;
      if (session_id) {
        events = await db
          .prepare("SELECT * FROM panopticon_events WHERE profile_id = ? AND session_id = ? ORDER BY created_at DESC LIMIT ?")
          .bind(profile_id, session_id, maxEvents)
          .all();
      } else {
        events = await db
          .prepare("SELECT * FROM panopticon_events WHERE profile_id = ? ORDER BY created_at DESC LIMIT ?")
          .bind(profile_id, maxEvents)
          .all();
      }

      const decisions = await db
        .prepare("SELECT decision, COUNT(*) as count FROM decisions WHERE profile_id = ? GROUP BY decision")
        .bind(profile_id)
        .all();

      return JSON.stringify({
        profile: profile ? {
          id: profile.id,
          vibe_anchor: profile.vibe_anchor,
          forbidden_tokens: JSON.parse((profile.forbidden_tokens as string) || "[]"),
          learned_preferences: JSON.parse((profile.learned_preferences as string) || "[]"),
        } : null,
        events: events.results,
        decision_counts: Object.fromEntries(
          (decisions.results || []).map((r) => [r.decision, r.count])
        ),
      });
    },
  }),
];
