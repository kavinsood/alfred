# Alfred: An In-Context RL Environment for Voice-Preserving Structural Editing

> **Frozen design spec.** Derived from `docs/DESIGN-LEDGER.md` after an adversarial
> review round. Read the scope posture in §1 before the mechanics — what is *earned*,
> what is *designed*, and what is *speculative* are marked throughout and must not be
> conflated in the paper.

---

## 1. Scope posture (read first)

Three tiers, kept distinct on purpose:

- **Earned (evidenced today):** the **action-space constraint** + the **Voice Guardian
  floor** preserve voice *by construction*; and the voice-drift metric *discriminates*
  structural reordering from generative rewriting (0% vs 62.7%, the 0% true by construction).
- **Designed (built & instrumented, not yet validated):** the **in-context RL loop (Loop A)** —
  state, action, reward rubric, episode — and the reward rubric as Loop A's credit-assignment
  engine.
- **Speculative (specified, not run):** **offline cross-user preference training (Loop B)**.
  N=1 cannot validate it; it is the extension, not the spine.

The empirical claim the paper leads with is **discrimination**, not **voice-validity**.
Voice-validity (does the metric track *voice* vs *lexical churn*?) is future work; a cheap
single-author construct-validity check is available (§9) but not yet a cross-writer result.

---

## 2. Thesis

Generative rewriting "whitewashes": optimizing a proxy (generic fluency / acceptance), the
model collapses text toward the pretraining mean and the author's voice is lost. This is the
**structural cousin of sycophancy** (optimizing approval → collapse toward what people want to
hear → loss of truth): both are **mode collapse under a misspecified objective**, a protected
quantity (voice / truth) sacrificed to a pleasing average.

Alfred mitigates this *by construction*, not by training against the proxy: (a) constrain the
action space so the collapse-move is unrepresentable; (b) gate on a verifiable floor; (c) never
pool individual taste — personalize it in-context. The system is an **in-context RL loop**: the
prompt is the policy, the writer's accept/reject/edit is the reward, and the policy update is a
prompt edit, not a weight update.

---

## 3. The environment (Loop A — the in-context RL system)

**Episode:** one `propose → decide` cycle: `state → action → verifier → reward`, followed by an
in-context policy update (hoarded buffer + profile).

**State** `s` — what the policy conditions on, captured at propose-time:
- the document (paragraphs with `id`, `role` ∈ {intro, thesis, section_lead, supporting}, `parent_id`) — a shallow structural tree, *not* an extracted argument graph;
- the voice profile (`vibe_anchor`, `forbidden_tokens`, learned preferences, voice signals);
- the hoarded buffer (last *N* ≤ 12 decisions as few-shot);
- the intent string (a *selector on Value*, §4 — not always present).

**Action** `a` — a sequence of operators from a fixed algebra, then one `finalize_proposal`.
The model is architecturally incapable of authoring free prose; only `glue`/`migrate` introduce
tokens, both verifier-capped:

| operator | effect | tokens |
|---|---|---|
| `split` | divide a paragraph at a sentence boundary | none |
| `merge` | combine two paragraphs | ≤15 glue (optional) |
| `move` | relocate a paragraph | none |
| `hoist` | promote to intro/thesis/section_lead | none |
| `demote` | tag supporting under a parent | none |
| `migrate` | reproject a foreign-voice fragment | ≤50% token-edit |
| `glue` | insert connective tissue | ≤15 |
| `delete` | remove an orphan | none |

This is the **new control surface**: a discrete, composable, auditable action space replacing
unconstrained generation.

**Verifier** — see §4 (two-tier floor). **Reward** — see §4–§5.

---

## 4. The reward rubric

Reward is a **vector of orthogonal invariants**, never a single scalar (monism rejected). An
action = a *structural operation* ∘ a *generative patch*; judge each on **Value** (did it help?)
× **Integrity** (did it avoid harm?):

|                          | **Value** (helped?)                                   | **Integrity** (avoided harm?)                                  |
|--------------------------|-------------------------------------------------------|----------------------------------------------------------------|
| **Structure** (topology) | structural survival (revealed preference) + impact    | topological validity → **hard floor**                          |
| **Content** (Alfred's tokens) | glue-only retention (% of *Alfred's* tokens kept) | voice (stylometric drift) + meaning (NLI) + forbidden tokens   |

**Wrappers (not axes):** temporal endorsement (regret/undo) is a *confidence multiplier* on the
episode; session phase (burst vs polish) is a *state-conditioning variable*.

**Scalarization = lexicographic, two-tier floor (not weighted sum):**
- **Hard floor (deterministic, verifiable):** glue budgets (≤15/op, ≤60 total), forbidden tokens,
  topological validity, `migrate` ≤50%. A violation is inadmissible — the writer never sees it.
- **Soft floor (semantic, noisy):** NLI meaning-integrity. **Scores/flags, does not gate** — a
  lexicographic gate is only as hard as its softest sensor, so NLI is not allowed to be a hard
  gate until its reliability on draft prose is characterized (§10).
- Among admissible candidates, rank by **Value**. Encodes the ethic in the math: **voice is never
  traded for structure** — no structural value buys back a voice/meaning failure.

**Glue-only retention** is the surgical anti-Goodhart fix: score retention of **only the tokens
Alfred introduced**, never the writer's rewrite of their *own* content (rewriting inside a kept
split is the system working, not a failure).

**Per-axis floor/ceiling (competence vs taste):** every axis = a *universal competence floor*
(poolable) + an *individual taste ceiling* (in-context). Floor height varies:
- **Meaning:** high floor (no fact-invention/contradiction is universal) + individual ceiling
  (acceptable inferential leaps).
- **Structure:** low floor (referential/topological integrity: no orphan refs, no cycles A⊢B∧B⊢A,
  no dangling forward-refs) + taste ceiling (thesis placement, pacing, density).
- **Glue:** competence = discourse-relation aptness (the right *relation*) + Verifier limits;
  taste = lexical realization (the right *word* among apt connectives).
- **Voice:** ~zero floor — almost pure taste. (Voice is the hardest axis precisely because it has
  no universal component.)

**Orthogonality is of *measurement*, not *occurrence*.** Bold structural moves correlate with
higher voice-risk; the axes are a **Pareto frontier**, and the policy's job is to push it
outward — high structural value without paying voice cost. The correlation is the problem
statement, not a defect.

---

## 5. Reward as Loop A's credit-assignment engine

The rubric is not (only) Loop-B training scaffolding — it is what makes Loop A a *learning* loop.
Hoarding recent decisions is reward-free; **learning the profile from them is not** ("the writer
rejected this — what rule do I infer?" is credit assignment). The rubric answers it.

**Reject-bit decomposition.** A user's decision is one bit; it confounds *competence-failure* and
*taste-mismatch*. An **offline batch judge** (a strong model + NLI, not a live gate, brittleness
tolerable) decomposes it post-hoc:
- *competence-failure* (e.g. a `migrate` hallucination, an orphaning move) → does **not** update
  the taste profile (and is the writer-invariant signal for the Loop-B extension);
- *taste-mismatch* (voice, structural preference) → updates the Loop-A profile.

This protects Loop A from learning the wrong lesson (hoarding "dislikes hoists" when the truth was
"that hoist hallucinated") and is the mechanism the writer-invariance criterion (§7) lacked.
Honest cost: on the competence axis the label is *judge-derived*, not human-derived — so the
human signal's irreplaceable value is the **taste** axis.

---

## 6. Voice / homogenization sensor

`backend/src/voice-drift.ts`: **order-insensitive** lexical-multiset drift + stylometric drift
(sentence-length mean/std, fragment rate). A pure reorder scores **0 by construction** — so it
cannot conflate structure with voice; that is a *proof*, not a measurement, and the paper leads
with it. Reframed as a **homogenization detector**, it measures **directional** drift *toward the
generic/population centroid* (magnitude alone can't separate a faithful authorial paraphrase from
a whitewash). Live uses (no training): flag/down-rank generic-drifting proposals; drive the
Panopticon display.

---

## 7. Competence vs taste (the partition)

> **Loop A learns taste. The offline extension learns only competence.**

The separation is by **pair construction under a writer-invariance criterion**, not token masking
alone: a preference is *competence* iff its direction is **writer-invariant** (every writer
agrees); otherwise it is *taste* and never enters pooled training. This makes the slogan precise:
**competence ≡ writer-invariant preference; taste ≡ writer-variant preference.**

Consequence — **the timid-policy "hole" is dissolved by design, not a Goodhart gap.** "Bold ≫
trivial" is writer-*variant* (minimalists vs maximalists) → it is taste → it cannot be a pooled
floor. The minimal-glue micro-splitter passes every hard floor, and that is *correct*: absent
per-user taste signal, the pooled policy is **deliberately conservative**, and boldness is
acquired only from Loop A. A system that boldly restructured a stranger's prose would be
committing structural whitewashing — the very thing we forbid. Crucially, the pooled extension
carries **no acceptance/survival reward** (survival is taste → Loop A), so there is no
acceptance signal for it to Goodhart into timidity. State this in the rubric, confidently: *value
is ranked, not floored; conservative cold-start is a design consequence of "boldness is taste."*

---

## 8. Offline extension (Loop B) — speculative, specified-not-run

Pools across writers to train the base operator-emitter on **writer-invariant competence only**
(chiefly `migrate`-faithfulness and operator-admissibility), via the §5 decomposition.

- Offline **DPO/KTO**, never online PPO (writing throughput too sparse for an in-loop reward).
  DPO from `modify` pairs (structurally silent — same operator both sides — so they carry glue/
  taste signal, routed to Loop A); KTO for unpaired clean accepts/rejects.
- Preference in **action-space** (operator + glue), not prose; **glue-text tokens masked** so word-
  choice taste never enters pooled weights (glue competence = discourse-relation, learnable;
  glue voice = Loop A).
- **State serialization = locality window:** target node + parent + immediate siblings + roles/IDs
  + intent + Loop-A conditioning, as flattened `<p id role parent>…</p> [INTENT: …]`; completion =
  `<op>…</op><glue>…</glue>`. If the prompt can't distinguish states that justify opposite moves,
  the model learns noise.
- **Constructed/synthetic pairs are rejected** (off-policy → DPO diverges; need no users → hollow
  the data claim). Loop B trains on *real, decomposed, writer-invariant* signal.
- **Lock-in handled by event-sourcing:** raw accepted text = immutable ground truth; voice
  vector / embeddings = materialized view, recomputed on embedding-model upgrade (declare the
  pinned version in the record).
- **Honest narrowing:** real telemetry's unique value is **in-context conditioning (Loop A)**;
  the pooled competence axis is largely judge-synthesizable. Claim "a new class of in-context
  conditioning data + a narrow pooled competence signal," not "a new class of training data."

---

## 9. Empirical status

- **Earned:** discrimination (`npm run drift:eval`: structure 0.0% vs rewrite 62.7%) +
  order-insensitivity-by-construction.
- **Harness built:** `experiments/mode-collapse/voice_collapse.py` — stylometric-space (NOT
  semantic embeddings, which normalize style and cluster by topic), directional centroid-collapse
  measure, runs stdlib-only.
- **Required for voice-validity (not done):** real multi-author corpus + `--api` rewrites +
  **blind human "sounds like the author?" judgments correlated against the metric.** A weaker
  single-author check (blind-rating rewrites of one's own older drafts) is runnable now and moves
  validity from 0 to >0, with the self-recognition caveat.

---

## 10. Limitations (stated, not buried)

1. **Construct validity pending** — the metric is shown to track *lexical churn*; that it tracks
   *voice* needs human correlation (§9). The paper claims discrimination, not voice-validity.
2. **Reject-bit confound** — a single decision conflates competence and taste; decomposition is
   an offline approximation (judge-derived competence labels).
3. **NLI soft floor** — brittle on mid-edit draft prose; scores/flags, does not hard-gate.
4. **Timid-policy is per-user, not guaranteed** — boldness is taste; conservative cold-start is
   by design; bold behavior depends on Loop A, which is unvalidated at N=1.
5. **Cross-user pooling untestable at N=1** — the Loop-B claims are framing, not result.
6. **Stable block IDs are nontrivial** — paste/merge/undo churn IDs in ProseMirror; the regret
   window adds a "same node after editing?" confound.

---

## 11. Map to source

| Component | File |
|---|---|
| Action space + apply functions | `backend/src/operators.ts` |
| Verifier (hard floor) | `backend/src/validator.ts` |
| Reward rubric (current scalar; to extend to the §4 vector) | `backend/src/reward.ts` |
| Voice / homogenization sensor | `backend/src/voice-drift.ts` |
| Trajectory log (state, action, verifier, reward) | `backend/src/trajectory.ts` |
| State capture + in-context update (Loop A) | `backend/src/session.ts` |
| Environment introspection + subject-legibility | `backend/src/environment.ts`, `GET /api/environment`, Panopticon |
| Discrimination eval / hero-experiment harness | `backend/scripts/drift-eval.ts`, `experiments/mode-collapse/` |
