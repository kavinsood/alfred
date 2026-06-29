// Voice drift metric. The empirical rubric of the Alfred environment.
//
// The architectural claim Alfred makes is: structural operations (move/merge/
// hoist/split/demote) rearrange a document without touching its voice, whereas
// generative rewriting ("whitewashing") changes the words. To make that claim
// *measurable* rather than asserted, we need a metric that:
//
//   1. is near-zero when text is only reordered (voice preserved), and
//   2. is large when vocabulary/rhythm changes (voice drifted),
//
// independent of structure. So voice drift is deliberately ORDER-INSENSITIVE.
// A pure reorder of paragraphs leaves the token multiset and the sentence-length
// distribution unchanged, so it scores ~0 by construction — which is exactly the
// architectural guarantee, turned into a number.
//
// drift = w_lex * lexical_drift + w_sty * stylometric_drift
//
//   lexical_drift     — multiset symmetric-difference fraction of word tokens.
//                       Reorder -> 0. Rewrite/substitution -> high.
//   stylometric_drift — normalized distance between sentence-length stats and
//                       fragment rate (sentence rhythm).
//
// This is intentionally cheap and explainable (no embeddings) so the metric is
// auditable by the writer in the Panopticon, consistent with the project ethos.

import { tokenizeLower } from "./tokenize.js";
import { splitSentences as cheapSplit } from "./operators.js";

export type VoiceDrift = {
  /** [0,1] order-insensitive vocabulary change. 0 = same words, 1 = disjoint. */
  lexical_drift: number;
  /** [0,1] change in sentence rhythm (length distribution + fragment rate). */
  stylometric_drift: number;
  /** [0,1] weighted composite. */
  composite: number;
};

const W_LEX = 0.7;
const W_STY = 0.3;

export function voiceDrift(before: string, after: string): VoiceDrift {
  const lexical_drift = lexicalDrift(before, after);
  const stylometric_drift = stylometricDrift(before, after);
  const composite = clamp01(W_LEX * lexical_drift + W_STY * stylometric_drift);
  return { lexical_drift, stylometric_drift, composite };
}

// --- Lexical drift: token multiset symmetric difference ---------------------

function lexicalDrift(before: string, after: string): number {
  const a = multiset(tokenizeLower(before).filter(isWord));
  const b = multiset(tokenizeLower(after).filter(isWord));
  const totalA = sumCounts(a);
  const totalB = sumCounts(b);
  if (totalA === 0 && totalB === 0) return 0;

  // Symmetric difference of multisets: sum over all tokens of |count_a - count_b|.
  let symDiff = 0;
  const keys = new Set<string>([...a.keys(), ...b.keys()]);
  for (const k of keys) {
    symDiff += Math.abs((a.get(k) ?? 0) - (b.get(k) ?? 0));
  }
  // Normalize by total tokens on both sides (max possible symmetric difference).
  return clamp01(symDiff / (totalA + totalB));
}

// --- Stylometric drift: sentence rhythm -------------------------------------

type Stylo = { meanLen: number; stdLen: number; fragmentRate: number };

function stylometrics(text: string): Stylo {
  const sentences = cheapSplit(text);
  if (sentences.length === 0) return { meanLen: 0, stdLen: 0, fragmentRate: 0 };
  const lens = sentences.map((s) => tokenizeLower(s).filter(isWord).length);
  const mean = lens.reduce((x, y) => x + y, 0) / lens.length;
  const variance = lens.reduce((x, y) => x + (y - mean) ** 2, 0) / lens.length;
  const std = Math.sqrt(variance);
  // A "fragment" here: a sentence of <= 4 word tokens (punchy fragments are a
  // voice marker we explicitly want to preserve).
  const fragments = lens.filter((l) => l > 0 && l <= 4).length;
  const fragmentRate = fragments / lens.length;
  return { meanLen: mean, stdLen: std, fragmentRate };
}

function stylometricDrift(before: string, after: string): number {
  const x = stylometrics(before);
  const y = stylometrics(after);
  // Normalize sentence-length differences against a soft scale (words).
  const meanTerm = normDiff(x.meanLen, y.meanLen, 20);
  const stdTerm = normDiff(x.stdLen, y.stdLen, 15);
  const fragTerm = Math.abs(x.fragmentRate - y.fragmentRate); // already [0,1]
  return clamp01((meanTerm + stdTerm + fragTerm) / 3);
}

// --- helpers ----------------------------------------------------------------

function multiset(tokens: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

function sumCounts(m: Map<string, number>): number {
  let s = 0;
  for (const v of m.values()) s += v;
  return s;
}

// Words only — drop standalone punctuation tokens so reordering punctuation
// doesn't register as voice change.
function isWord(t: string): boolean {
  return /[a-z0-9]/i.test(t);
}

function normDiff(a: number, b: number, scale: number): number {
  return clamp01(Math.abs(a - b) / scale);
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

// --- Stylometric feature vector + directional homogenization (RL-ENVIRONMENT §6) ---
// Mirrors experiments/mode-collapse/voice_collapse.py so the LIVE signal and the OFFLINE
// hero-experiment use the same representation. The "homogenization" measure is directional:
// did an edit drift TOWARD the generic centroid (magnitude alone can't separate a faithful
// authorial paraphrase from a whitewash).

function _mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function _std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = _mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
}

export const STYLOMETRIC_FEATURES = [
  "mean_sent_len", "std_sent_len", "fragment_rate",
  "type_token_ratio", "mean_word_len", "punct_density", "commas_per_sent",
] as const;

export function stylometricFeatureVector(text: string): number[] {
  const ws = tokenizeLower(text).filter(isWord);
  if (ws.length === 0) return STYLOMETRIC_FEATURES.map(() => 0);
  const sents = cheapSplit(text);
  const sentList = sents.length > 0 ? sents : [text];
  const lensAll = sentList.map((s) => tokenizeLower(s).filter(isWord).length).filter((l) => l > 0);
  const lens = lensAll.length > 0 ? lensAll : [ws.length];
  const fragmentRate = _mean(lens.map((l) => (l <= 4 ? 1 : 0)));
  const ttr = new Set(ws).size / ws.length;
  const meanWordLen = _mean(ws.map((w) => w.length));
  const punct = (text.match(/[,;:\-—()"']/g) ?? []).length;
  const commas = (text.match(/,/g) ?? []).length;
  return [
    _mean(lens), _std(lens), fragmentRate, ttr, meanWordLen,
    punct / ws.length, commas / Math.max(1, sentList.length),
  ];
}

export function centroidOf(texts: string[]): number[] {
  const vecs = texts.map(stylometricFeatureVector).filter((v) => v.some((x) => x !== 0));
  if (vecs.length === 0) return STYLOMETRIC_FEATURES.map(() => 0);
  const d = vecs[0]!.length;
  return Array.from({ length: d }, (_, j) => _mean(vecs.map((v) => v[j]!)));
}

export type CentroidDrift = {
  before_dist: number;
  after_dist: number;
  /** true if `after` moved TOWARD the centroid (homogenization toward the generic mean). */
  toward_centroid: boolean;
};

// `scale` should be the population std per feature for calibrated distances; defaults to
// unit scale (a caller with a corpus should pass the std so no single feature dominates).
export function driftTowardCentroid(
  before: string,
  after: string,
  centroid: number[],
  scale?: number[],
): CentroidDrift {
  const s = scale ?? centroid.map(() => 1);
  const distTo = (v: number[]) =>
    Math.sqrt(v.reduce((acc, x, j) => acc + ((x - (centroid[j] ?? 0)) / (s[j] || 1)) ** 2, 0));
  const bd = distTo(stylometricFeatureVector(before));
  const ad = distTo(stylometricFeatureVector(after));
  return { before_dist: bd, after_dist: ad, toward_centroid: ad < bd };
}
