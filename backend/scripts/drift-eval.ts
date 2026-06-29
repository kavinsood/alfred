// Voice-drift discrimination eval. Prints the table that backs the central
// empirical claim of the Alfred environment:
//
//   structure-first edits preserve voice (drift ~ 0);
//   rewrite-first edits do not (drift large).
//
// Run: npm run drift:eval   (from backend/)
//
// This is the offline, deterministic, key-free version of the rubric. The same
// voiceDrift() function scores live edits in production via the trajectory log,
// so the number you see here is the number the environment actually optimizes.

import { voiceDrift } from "../src/voice-drift.js";

type Case = { name: string; original: string; edited: string; arm: "structure" | "rewrite" };

const ORIGINAL_A = [
  "The market is not rational. It never was.",
  "Everyone repeats the efficient-markets line like a prayer, but prices lurch on rumor and mood, not on the slow arrival of fact.",
  "Here is the thing I actually believe: liquidity is a story we tell until the story breaks.",
  "Margin calls do not care about your model.",
].join("\n\n");

const cases: Case[] = [
  {
    name: "hoist buried thesis + reorder",
    arm: "structure",
    original: ORIGINAL_A,
    edited: [
      "Here is the thing I actually believe: liquidity is a story we tell until the story breaks.",
      "The market is not rational. It never was.",
      "Everyone repeats the efficient-markets line like a prayer, but prices lurch on rumor and mood, not on the slow arrival of fact.",
      "Margin calls do not care about your model.",
    ].join("\n\n"),
  },
  {
    name: "reverse paragraph order",
    arm: "structure",
    original: ORIGINAL_A,
    edited: ORIGINAL_A.split("\n\n").reverse().join("\n\n"),
  },
  {
    name: "generative 'improve the flow' rewrite",
    arm: "rewrite",
    original: ORIGINAL_A,
    edited: [
      "Financial markets are frequently characterized by irrational behavior rather than pure rationality.",
      "Although many investors subscribe to the efficient-market hypothesis, asset prices are often driven by speculation and sentiment instead of the gradual incorporation of new information.",
      "Fundamentally, market liquidity can be understood as a collective narrative that persists only until confidence erodes.",
      "Furthermore, margin calls are executed irrespective of an investor's analytical framework.",
    ].join("\n\n"),
  },
];

function pct(x: number): string {
  return (x * 100).toFixed(1).padStart(6) + "%";
}

console.log("\nAlfred — voice-drift discrimination\n");
console.log(
  "arm".padEnd(11) +
    "case".padEnd(38) +
    "lexical".padStart(9) +
    "stylo".padStart(9) +
    "composite".padStart(11)
);
console.log("-".repeat(11 + 38 + 9 + 9 + 11));

const byArm: Record<string, number[]> = { structure: [], rewrite: [] };
for (const c of cases) {
  const d = voiceDrift(c.original, c.edited);
  byArm[c.arm]!.push(d.composite);
  console.log(
    c.arm.padEnd(11) +
      c.name.padEnd(38) +
      pct(d.lexical_drift) +
      pct(d.stylometric_drift) +
      pct(d.composite)
  );
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const structMean = mean(byArm.structure!);
const rewriteMean = mean(byArm.rewrite!);

console.log("-".repeat(11 + 38 + 9 + 9 + 11));
console.log(`\nmean composite drift — structure-first: ${pct(structMean)}`);
console.log(`mean composite drift — rewrite-first:   ${pct(rewriteMean)}`);
console.log(`discrimination margin:                  ${pct(rewriteMean - structMean)}\n`);

if (rewriteMean - structMean > 0.4) {
  console.log("RESULT: rubric discriminates (margin > 40pts). Voice-preservation claim is measurable.\n");
} else {
  console.log("RESULT: margin too small — rubric does NOT discriminate. Thesis unsupported.\n");
  process.exit(1);
}
