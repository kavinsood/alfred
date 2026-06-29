# Paper skeleton — Alfred

> Independent arXiv paper. Spine = **alignment, scoped** (whitewashing ≈ sycophancy ≈
> mode collapse). HCI = evidence backbone; the in-context RL environment = apparatus.
> Each section tags its evidence tier: **[earned]** / **[designed]** / **[speculative]**.
> Working title: *Voice-Preserving Structural Editing: An In-Context RL Environment for
> Individual Alignment in Writing.*

---

## Abstract (draft)

Generative writing assistants improve clarity but flatten authorial voice — they
"whitewash." We argue this is the structural cousin of sycophancy: in both, a model
optimizing a misspecified proxy (acceptance / approval) collapses its output toward a
pleasing population mean, sacrificing a protected quantity (voice / truth). We present
**Alfred**, a writing environment that mitigates this *by construction* rather than by
training against the proxy: the assistant acts only through a fixed algebra of structural
operators (it cannot author prose), every proposal passes a deterministic verifiable floor
(the Voice Guardian), and individual preference is learned **in-context, never pooled**. We
formalize the system as an in-context RL environment — the prompt is the policy, the
writer's accept/reject/edit is the reward — with a multi-axis reward rubric whose axes are
gated lexicographically so voice is never traded for structure. We contribute: a discrete
control surface for voice-preserving editing; a verifiable floor that bounds drift
mathematically; a competence/taste factorization that explains *why* individual alignment
must be in-context; and an order-insensitive voice-drift metric that **provably** cannot
penalize structural reordering. We report a discrimination result separating structural
edits from generative rewrites and scope what remains future work (cross-writer voice
validity; offline preference training).

---

## 1. Introduction  [earned + designed]

- The ghostwriter effect: AI writing help trades voice for clarity; writers feel the output
  "isn't theirs."
- **The reframe (spine):** whitewashing = sycophancy's structural cousin = *mode collapse
  under a misspecified objective*. Both collapse toward the mean of a proxy.
- The standard response is to *train against* the proxy (better RLHF, style fine-tuning).
  We take the opposite route: make the collapse-move **unrepresentable**, gate on a
  **verifiable floor**, and keep individual preference **in-context**.
- **Contributions (scoped — claim exactly these):**
  1. A discrete **control surface** (operator algebra) that decouples structural editing
     from content generation. [earned: the constraint preserves voice by construction]
  2. A **verifiable floor** (Voice Guardian) bounding drift deterministically. [earned]
  3. An **in-context RL** formulation whose reward rubric does live credit-assignment, with
     a **competence/taste factorization** that explains why individual alignment cannot be
     pooled. [designed]
  4. An **order-insensitive voice-drift metric** with a *discrimination* result and an
     impossibility-by-construction guarantee. [earned: discrimination; voice-validity future]
- Explicit non-claims: we do not claim a trained policy, cross-writer generalization, or
  solved scalable oversight.

## 2. Related work  [to write — this is the ally, not a chore]

- **RLHF diversity / mode collapse** (output entropy reduction under preference optimization)
  — *position the sycophancy↔whitewashing frame against this; it is the strongest support.*
- **Edit/revision models** (PEER, CoEdIT) — prior art on structured editing; contrast: they
  still generate prose.
- **In-context vs fine-tuned personalization** — why sparse single-user data forces in-context.
- **Verifier-gated generation / RLVR** — cite for the "hard floor"; we apply it to voice.
- **HCI: agency, ownership, the ghostwriter effect** — the interaction backbone.
- **Sycophancy** — the author's prior lineage; the sibling failure mode.

## 3. The control surface: structure-space, not content-space  [earned]

- Operator algebra (split/merge/move/hoist/demote/migrate/glue/delete + finalize).
- `tool_choice: any` → the model is architecturally unable to free-write.
- Claim: **voice preservation is an architectural property here, not a prompt instruction** —
  this is the part that's evidenced today.

## 4. The Voice Guardian: a verifiable floor  [earned]

- Deterministic constraints: glue ≤15/op ≤60 total; migrate ≤50% token-edit; forbidden
  tokens; topological validity. Inadmissible proposals never reach the writer; retry-on-fail.
- This is the **hard tier** of the floor (vs the soft semantic tier, §6).

## 5. The in-context RL environment (Loop A)  [designed]

- Episode: `state → action → verifier → reward → in-context update`. The prompt is the
  policy; the policy update is a prompt edit (hoarded buffer + profile), not a weight update.
- State (document tree + profile + hoarded + intent); action (operators); reward (§6).
- **Reward is Loop A's credit-assignment engine** — hoarding is reward-free, but learning the
  profile is credit assignment.
- **Reject-bit decomposition:** one decision conflates competence-failure and taste-mismatch;
  an offline judge decomposes it so the profile learns taste, not noise. (Honest cost:
  competence labels are judge-derived → the human signal's unique value is the taste axis.)

## 6. The reward rubric  [designed]

- Vector, not scalar (reject monism). 2×2: Structure/Content × Value/Integrity.
- **Lexicographic two-tier floor:** deterministic hard floor (Guardian) gates; NLI is a
  **soft** floor that scores/flags, not gates (a gate is only as hard as its softest sensor).
  Among admissible candidates, rank by Value → *voice is never traded for structure.*
- **Glue-only retention** — score only Alfred's introduced tokens, never the writer's rewrite
  of their own content (the surgical anti-Goodhart fix). [earned mechanism]
- **Per-axis floor/ceiling** = competence (universal, poolable) + taste (individual, in-context);
  floor height varies (meaning high, structure low, voice ~zero).
- **Orthogonality of measurement, correlation of occurrence → Pareto frontier:** the policy
  pushes structural value without paying voice cost; the correlation is the problem statement.
- **Timid-policy dissolved by design:** "bold ≫ trivial" is taste, not a poolable floor; the
  conservative cold-start is the *correct* expression of "boldness is taste"; the pooled layer
  carries no acceptance reward, so it cannot Goodhart into timidity.

## 7. Evaluation  [earned, scoped]

- **Discrimination result:** voice-drift 0.0% (structural reorder) vs 62.7% (generative
  rewrite). The 0% is **true by construction** (order-insensitive metric) → the metric *cannot*
  conflate structure with voice. Lead with this as a proof, not a measurement.
- **Hero experiment (built):** stylometric-space directional centroid-collapse
  (`experiments/mode-collapse/`). NOT semantic embeddings (they normalize style, cluster by
  topic).
- **What we do NOT claim:** that the metric tracks *voice* vs *lexical churn* — that needs
  blind human "sounds like the author?" judgments correlated against it (planned; a weak
  single-author version is runnable now). State this plainly.

## 8. The offline extension (Loop B)  [speculative — specified, not run]

- Offline DPO/KTO (never online PPO) on **writer-invariant competence only** (migrate-
  faithfulness, admissibility), via the §5 decomposition; action-space pairs with glue-token
  masking; locality-window state serialization; event-sourced lock-in.
- **Honest scope:** N=1 cannot validate cross-user pooling; the unique value of real telemetry
  is in-context conditioning (Loop A); the competence axis is largely judge-synthesizable.
  Claim "a new class of in-context conditioning data + a narrow pooled competence signal."

## 9. Limitations  [state, don't bury]

Construct validity pending; reject-bit confound; NLI soft floor; timid-policy is per-user not
guaranteed; cross-user pooling untestable at N=1; stable block IDs nontrivial. (Full list:
`RL-ENVIRONMENT.md` §10.)

## 10. Conclusion

Individual alignment in creative work is not a training problem but an *architecture +
in-context* problem: constrain the action space, verify the floor, and refuse to pool taste.
Alfred is an existence proof and an environment; the cross-writer and offline-training
questions are the road from here.

---

## Drafting order & open prerequisites

1. **Write §2 (related work) before prose drafting** — the mode-collapse literature is the
   spine's support; without it the sycophancy frame floats.
2. Lead the empirical section with **order-insensitivity-as-proof**, then the 62.7%; voice-
   validity is one honest sentence in §9 + §7.
3. The single de-risking action outside this thread: **a human from the author's prior lab**
   tries to break the alignment claim before posting.
