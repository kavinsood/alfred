import { describe, it, expect } from "vitest";
import { computeReward } from "../reward.js";
import type { AlfredDocument } from "../types.js";

const doc: AlfredDocument = {
  paragraphs: [
    { id: "p1", text: "Alpha beta gamma delta." },
    { id: "p2", text: "Epsilon zeta eta theta." },
  ],
};

describe("reward vector", () => {
  it("accept = +1, zero voice drift, hard floor true", () => {
    const r = computeReward("accept", doc, []);
    expect(r.scalar).toBe(1);
    expect(r.components.voice_drift).toBe(0);
    expect(r.components.topological_valid).toBe(true);
  });

  it("reject = -1", () => {
    const r = computeReward("reject", doc, []);
    expect(r.scalar).toBe(-1);
  });

  it("glue-only retention: scores ONLY Alfred's glue, not the writer's own words", () => {
    // merge p1+p2 with glue "as a result" -> proposed joins them with the glue between.
    const ops = [
      { kind: "merge", first_paragraph_id: "p1", second_paragraph_id: "p2", glue_text: "as a result" },
    ] as any;
    const keptWithGlue = "Alpha beta gamma delta. as a result Epsilon zeta eta theta.";
    const keptDroppedGlue = "Alpha beta gamma delta. Epsilon zeta eta theta.";

    const keep = computeReward("modify", doc, ops, keptWithGlue);
    const drop = computeReward("modify", doc, ops, keptDroppedGlue);

    expect(keep.components.glue_retention).toBeCloseTo(1, 5);
    expect(drop.components.glue_retention).toBe(0);
    expect(keep.components.glue_retention!).toBeGreaterThan(drop.components.glue_retention!);
  });

  it("rewriting the writer's OWN content (glue kept) is not penalized on the glue axis", () => {
    const ops = [
      { kind: "merge", first_paragraph_id: "p1", second_paragraph_id: "p2", glue_text: "as a result" },
    ] as any;
    // writer rewrote their own words heavily but kept Alfred's glue verbatim
    const rewroteOwnWordsKeptGlue = "Totally different opening clause. as a result a totally different closing clause.";
    const r = computeReward("modify", doc, ops, rewroteOwnWordsKeptGlue);
    expect(r.components.glue_retention).toBeCloseTo(1, 5); // glue survived => glue axis is happy
  });

  it("pure structural modify (no glue) falls back to survival on the glue axis = null", () => {
    const ops = [
      { kind: "hoist", paragraph_id: "p2", target_role: "thesis", target_position: { kind: "at", where: "start" } },
    ] as any;
    const reordered = "Epsilon zeta eta theta.\n\nAlpha beta gamma delta."; // words preserved, reordered
    const r = computeReward("modify", doc, ops, reordered);
    expect(r.components.glue_retention).toBeNull();
    expect(r.components.voice_drift!).toBeLessThan(0.05); // reorder => ~0 voice drift
    expect(r.scalar).toBeGreaterThan(0.8);
  });

  it("voice integrity caps the reward: heavy re-voicing scores lower than a light edit", () => {
    const ops = [
      { kind: "hoist", paragraph_id: "p2", target_role: "thesis", target_position: { kind: "at", where: "start" } },
    ] as any;
    const light = "Epsilon zeta eta theta.\n\nAlpha beta gamma delta.";
    const heavy = "The introductory passage now reads as a thoroughly genericized corporate sentence with none of the original terse vocabulary or rhythm whatsoever.";
    const rLight = computeReward("modify", doc, ops, light);
    const rHeavy = computeReward("modify", doc, ops, heavy);
    expect(rLight.scalar).toBeGreaterThan(rHeavy.scalar);
    expect(rHeavy.components.voice_drift!).toBeGreaterThan(rLight.components.voice_drift!);
  });
});
