import { describe, it, expect } from "vitest";
import type { AlfredDocument, Operator, VoiceProfile } from "../alfred-types.js";
import { validateProposal } from "../validator.js";
import { applyOperators } from "../operators.js";

function profile(forbidden: string[] = []): VoiceProfile {
  return { vibe_anchor: "", forbidden_tokens: forbidden, learned_preferences: [] };
}

const doc: AlfredDocument = {
  paragraphs: [
    { id: "p1", text: "First sentence here. Second sentence here." },
    { id: "p2", text: "Another paragraph entirely." },
  ],
};

describe("Voice Guardian — validateProposal", () => {
  it("accepts a pure structural proposal", () => {
    const ops: Operator[] = [
      { kind: "move", paragraph_id: "p2", target_position: { kind: "at", where: "start" } },
    ];
    const r = validateProposal(doc, ops, profile());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.voice_check.glue_budget_used).toBe(0);
      expect(r.voice_check.forbidden_tokens_violated).toEqual([]);
    }
  });

  it("rejects glue over the per-op token budget", () => {
    const longGlue = Array.from({ length: 20 }, (_, i) => `word${i}`).join(" ");
    const ops: Operator[] = [
      { kind: "glue", position: { kind: "at", where: "end" }, text: longGlue },
    ];
    const r = validateProposal(doc, ops, profile());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.join(" ")).toMatch(/exceeds 15 tokens/);
  });

  it("rejects forbidden tokens in glue", () => {
    const ops: Operator[] = [
      { kind: "glue", position: { kind: "at", where: "end" }, text: "we delve deeper" },
    ];
    const r = validateProposal(doc, ops, profile(["delve"]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.join(" ")).toMatch(/forbidden tokens used: delve/);
  });

  it("rejects a migrate that changes more than 50% of tokens", () => {
    const ops: Operator[] = [
      {
        kind: "migrate",
        paragraph_id: "p2",
        rewrite_text: "Totally unrelated replacement content with nothing shared",
        change_budget_tokens: 8,
      },
    ];
    const r = validateProposal(doc, ops, profile());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.join(" ")).toMatch(/migrate change-pct/);
  });

  it("rejects topologically invalid operators", () => {
    const ops: Operator[] = [
      { kind: "move", paragraph_id: "does-not-exist", target_position: { kind: "at", where: "end" } },
    ];
    const r = validateProposal(doc, ops, profile());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.join(" ")).toMatch(/topology error/);
  });
});

describe("applyOperators — conformance", () => {
  it("move-to-start reorders deterministically", () => {
    const out = applyOperators(doc, [
      { kind: "move", paragraph_id: "p2", target_position: { kind: "at", where: "start" } },
    ]);
    expect(out.paragraphs.map((p) => p.id)).toEqual(["p2", "p1"]);
  });

  it("split divides a paragraph at the sentence boundary without adding words", () => {
    const out = applyOperators(doc, [
      { kind: "split", paragraph_id: "p1", after_sentence_index: 0 },
    ]);
    expect(out.paragraphs[0]!.text).toBe("First sentence here.");
    expect(out.paragraphs[1]!.text).toBe("Second sentence here.");
  });

  it("does not mutate the input document", () => {
    const before = JSON.stringify(doc);
    applyOperators(doc, [{ kind: "delete", paragraph_id: "p1" }]);
    expect(JSON.stringify(doc)).toBe(before);
  });
});
