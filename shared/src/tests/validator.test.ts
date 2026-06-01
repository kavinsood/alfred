import { describe, it, expect } from "vitest";
import { validateProposal } from "../validator.js";
import type { AlfredDocument, Operator, AlfredProfile } from "../alfred-types.js";

function makeDoc(texts: string[]): AlfredDocument {
  return {
    paragraphs: texts.map((text, i) => ({ id: `p${i + 1}`, text })),
  };
}

function makeProfile(overrides?: Partial<AlfredProfile>): AlfredProfile {
  return {
    id: "test-profile",
    vibe_anchor: "",
    forbidden_tokens: [],
    learned_preferences: [],
    ...overrides,
  };
}

describe("validateProposal", () => {
  it("validates a correct split proposal", () => {
    const doc = makeDoc(["First sentence. Second sentence."]);
    const result = validateProposal({
      document: doc,
      proposal: {
        intent: "split paragraph",
        rationale: "two ideas",
        operators: [{ kind: "split", paragraph_id: "p1", after_sentence_index: 0 }],
      },
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.afterDocument).toBeDefined();
    expect(result.afterDocument!.paragraphs).toHaveLength(2);
  });

  it("rejects malformed operator — missing paragraph", () => {
    const doc = makeDoc(["Hello world."]);
    const result = validateProposal({
      document: doc,
      proposal: {
        intent: "delete",
        rationale: "remove",
        operators: [{ kind: "delete", paragraph_id: "nonexistent" }],
      },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("topology error"))).toBe(true);
  });

  it("enforces migrate cap at 50%", () => {
    const doc = makeDoc(["The quick brown fox jumps over the lazy dog near the river bank today."]);
    const result = validateProposal({
      document: doc,
      proposal: {
        intent: "migrate",
        rationale: "voice mismatch",
        operators: [
          {
            kind: "migrate",
            paragraph_id: "p1",
            rewrite_text: "Completely different text that shares absolutely nothing with the original paragraph at all.",
            change_budget_tokens: 20,
          },
        ],
      },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("change-pct") && e.includes("exceeds limit 50%"))).toBe(true);
  });

  it("enforces glue cap per operator (15 tokens)", () => {
    const doc = makeDoc(["First.", "Second."]);
    const longGlue = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen";
    const result = validateProposal({
      document: doc,
      proposal: {
        intent: "glue",
        rationale: "bridge",
        operators: [
          { kind: "glue", position: { kind: "after", paragraph_id: "p1" }, text: longGlue },
        ],
      },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("exceeds 15 tokens"))).toBe(true);
  });

  it("enforces total glue budget (60 tokens)", () => {
    const doc = makeDoc(["A.", "B.", "C.", "D.", "E."]);
    const glue14 = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen";
    const ops: Operator[] = [];
    for (let i = 0; i < 5; i++) {
      ops.push({
        kind: "glue",
        position: { kind: "after", paragraph_id: `p${i + 1}` },
        text: glue14,
      });
    }
    const result = validateProposal({
      document: doc,
      proposal: { intent: "glue", rationale: "bridge", operators: ops },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("total glue tokens") && e.includes("exceeds budget 60"))).toBe(true);
  });

  it("detects forbidden tokens in glue text", () => {
    const doc = makeDoc(["Hello."]);
    const profile = makeProfile({ forbidden_tokens: ["synergy", "leverage"] });
    const result = validateProposal({
      document: doc,
      proposal: {
        intent: "glue",
        rationale: "bridge",
        operators: [
          { kind: "glue", position: { kind: "at", where: "end" }, text: "leverage this synergy" },
        ],
      },
      profile,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("forbidden tokens"))).toBe(true);
  });

  it("passes a valid move proposal", () => {
    const doc = makeDoc(["First.", "Second.", "Third."]);
    const result = validateProposal({
      document: doc,
      proposal: {
        intent: "reorder",
        rationale: "flow",
        operators: [
          { kind: "move", paragraph_id: "p3", target_position: { kind: "at", where: "start" } },
        ],
      },
    });
    expect(result.valid).toBe(true);
    expect(result.afterDocument!.paragraphs[0]!.id).toBe("p3");
  });
});
