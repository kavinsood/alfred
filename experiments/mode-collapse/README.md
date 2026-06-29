# Mode-collapse / voice-drift experiment (DESIGN-LEDGER §8.A.1)

The one measurement that gates the alignment claim. Tests whether generative
rewriting collapses distinct authorial voices toward a generic centroid (mode
collapse) while originals stay spread — the empirical seed of "whitewashing ==
sycophancy's structural cousin."

## Run

```bash
python3 voice_collapse.py --samples samples.example.json
```

Stdlib-only for the core numbers (runs without numpy). The optional PCA figure
needs `numpy` + `matplotlib`.

## Outputs

- **directional collapse rate** — % of (original, rewrite) pairs where the rewrite
  moved *toward* the generic centroid. This is the **directional** measure: a faithful
  authorial paraphrase and a whitewash can have equal change *magnitude*; only
  direction-toward-the-mean distinguishes them.
- **voice spread ratio** — originals' pairwise diversity ÷ rewrites' diversity (>1 ⇒
  originals more diverse).
- **Cohen's d** — effect size of "originals sit farther from the mean than rewrites."

## What makes this evidence (it is NOT, yet)

`samples.example.json` is a **hand-authored smoke-test**. I wrote both arms, so the
numbers are rigged-able and prove only that the pipeline runs. Real evidence needs:

1. **A multi-author corpus** of genuine writing (held out; not authored by the experimenter).
2. **The rewrite arm produced by a real model** — run with `--api` (needs an SDK + key).
3. **Blind human "does this still sound like the author?" judgments**, correlated against
   the metric. This is the construct-validity check (does the number track *voice*, or
   just *lexical churn*?) and this script does **not** perform it — it's the next step.

If (1)–(3) come back with high directional collapse *and* human-correlated drift, the
62.7% discrimination becomes an earned result and the alignment lead is real. If they
don't, we learn that now — which is the entire point of running it before drafting.

## Why stylometric space (not semantic embeddings)

Semantic encoders normalize style and cluster by topic, so same-topic texts cluster
regardless of voice — they'd show neither spread nor collapse. The features here mirror
`backend/src/voice-drift.ts` (sentence-length mean/std, fragment rate) + style enrichers,
so the experiment validates the **same representation the reward uses**.
