import { describe, it, expect } from "vitest";
import { voiceDrift } from "../voice-drift.js";

// The discrimination result, made CI-verifiable.
//
// Claim under test: voice drift is LOW for structure-first edits (the words are
// preserved, only rearranged) and HIGH for rewrite-first edits (the words are
// regenerated toward the mean — "whitewashing"). If the metric can't separate
// these two, the whole environment thesis is unfalsifiable. This test is the
// minimal demonstration that the rubric fires.

// A writer's original draft — deliberately jagged: fragments, a buried thesis,
// idiosyncratic punctuation.
const ORIGINAL = [
  "The market is not rational. It never was.",
  "Everyone repeats the efficient-markets line like a prayer, but prices lurch on rumor and mood, not on the slow arrival of fact.",
  "Here is the thing I actually believe: liquidity is a story we tell until the story breaks.",
  "Margin calls do not care about your model.",
].join("\n\n");

// STRUCTURE-FIRST arm: a `hoist` (move the buried thesis to the lede) plus a
// `merge`. Same words. Reordered. This is what Alfred's operators produce.
const STRUCTURE_FIRST = [
  "Here is the thing I actually believe: liquidity is a story we tell until the story breaks.",
  "The market is not rational. It never was.",
  "Everyone repeats the efficient-markets line like a prayer, but prices lurch on rumor and mood, not on the slow arrival of fact.",
  "Margin calls do not care about your model.",
].join("\n\n");

// REWRITE-FIRST arm: a fluent generative "improve the flow" pass. Vocabulary
// regenerated, fragments smoothed into full sentences, rhythm flattened. This is
// the ghostwriter/whitewashing baseline.
const REWRITE_FIRST = [
  "Financial markets are frequently characterized by irrational behavior rather than pure rationality.",
  "Although many investors subscribe to the efficient-market hypothesis, asset prices are often driven by speculation and sentiment instead of the gradual incorporation of new information.",
  "Fundamentally, market liquidity can be understood as a collective narrative that persists only until confidence erodes.",
  "Furthermore, margin calls are executed irrespective of an investor's analytical framework.",
].join("\n\n");

describe("voice drift discriminates structure-first from rewrite-first", () => {
  it("scores a pure structural reorder near zero", () => {
    const d = voiceDrift(ORIGINAL, STRUCTURE_FIRST);
    // Same multiset of words -> lexical drift must be exactly zero.
    expect(d.lexical_drift).toBe(0);
    // Sentence rhythm is unchanged by reordering whole sentences.
    expect(d.composite).toBeLessThan(0.05);
  });

  it("scores a generative rewrite substantially higher", () => {
    const d = voiceDrift(ORIGINAL, REWRITE_FIRST);
    expect(d.lexical_drift).toBeGreaterThan(0.5);
    expect(d.composite).toBeGreaterThan(0.4);
  });

  it("separates the two arms by a wide margin", () => {
    const structural = voiceDrift(ORIGINAL, STRUCTURE_FIRST).composite;
    const rewrite = voiceDrift(ORIGINAL, REWRITE_FIRST).composite;
    // The whole thesis in one assertion: structure-first preserves voice,
    // rewrite-first does not, and the gap is large.
    expect(rewrite - structural).toBeGreaterThan(0.4);
  });

  it("is order-insensitive: reversing paragraph order is still zero lexical drift", () => {
    const reversed = ORIGINAL.split("\n\n").reverse().join("\n\n");
    expect(voiceDrift(ORIGINAL, reversed).lexical_drift).toBe(0);
  });
});
