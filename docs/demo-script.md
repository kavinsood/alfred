# Demo Script — 90 seconds

For the Anthropic Opus 4.7 hackathon submission video (and live demos).

---

**[Open Alfred at localhost:5173. Empty page. Status bar bottom-right: "Alfred ready."]**

> "Most AI writing tools generate prose. They flatten voice — what writers call whitewashing. Alfred inverts it. Claude Opus 4.7 here is constrained to operate only on document **structure**. It can't write your sentences. It can only move them."

**[Click "demo · essay" in the header. The 600-word draft loads.]**

> "Here's a messy draft. The thesis is buried in the fourth paragraph. The opener is throat-clearing."

**[Press Cmd+K. The command palette opens.]**

**[Type:]** *"this graf drags — find the buried thesis"*

**[Press Enter. Status: "Alfred is reading…" Wait ~5 seconds.]**

**[Diff overlay appears.]**

> "Alfred returns a structural proposal. It reads in editorial voice — *'Buried thesis in graf 4. Hoisted to the lede; the structure-first prescription follows it.'* — and emits two operators: a hoist of paragraph 4 to the top, and a move of paragraph 5 to follow. Voice unchanged. Not one word of mine has been rewritten."

**[Point to the operator chips at the top of the diff.]**

> "Glue budget: zero tokens. The Voice Guardian validated this before I saw it — capped at 15 tokens per operator, no forbidden words. The architecture enforces voice preservation. It's not a prompt instruction the model can ignore."

**[Press Tab. The doc reorganizes. Status flashes "+1 accepted."]**

> "Tab to accept. Esc to reject. The reorganization is atomic."

**[Press Cmd+. The Panopticon slides in from the right.]**

> "This is the Panopticon. Alfred shows me, in real time, what it has learned about how I write. *'Accepts hoists to intro/thesis.'* That preference just became evidence-of-1 — by the end of a session, it's a textured profile. Every line is editable. The file lives in `~/.alfred/` on my disk. The model's model of me is mine."

**[Click the "Profile" tab in the Panopticon.]**

> "Forbidden tokens. Vibe anchor. Learned preferences. All file-resident, human-readable. No black box."

**[Close panopticon. Click "demo · skyfall" in the header.]**

> "Now the harder case. Three fragments from different voice frames — yesterday's notebook, an old Gemini session, a scratch paragraph — pasted together. The bracketed openers are foreign-voice."

**[Press Cmd+K. Type:]** *"unify these into one argument"* **[Enter.]**

**[Wait ~10 seconds. Diff overlay.]**

> "Alfred emits a sequence: hoist the question fragment to the lede, reorder the rest, and migrate the foreign-voice fragments by stripping their bracketed openers. Migrate is the only operator that may rewrite words — it's capped at 50% token-edit distance. The Voice Guardian shows it ran at 28%."

**[Press Tab. The fragments unify into one coherent draft in the writer's voice.]**

> "What I just did at 3AM in my dorm — integrating multiple AI conversations and scratches into one coordinate system — Alfred makes a 10-second action."

**[Pause.]**

> "Alfred is logomorphic interaction. Structure-only AI assistance with reciprocal transparency. The interface that doesn't have a name yet."

**[End.]**

---

## Talking points (in case of Q&A)

- **"Why no graph view?"** The structural model lives in Claude's context, not on screen. Activation energy is the metric. The blank page wins.
- **"Why not multi-agent?"** Tried it; lost context by the terabit. One contoured Alfred orchestrator holds document + .proserc + hoarded few-shot in a single call. Architectural simplicity is a feature.
- **"What about per-user fine-tuning?"** Phase 3, post-hackathon. Every accept/reject is already a logged training signal. Prime Intellect Lab gives us multi-tenant LoRA inference. The data flywheel exists today; the wiring is a week of work.
- **"How do you know voice is actually preserved?"** Architecturally: the action space allows no unbounded free-prose output. The only operator that can rewrite words is `migrate`, and it's capped at 50% token-edit distance, validated server-side. If Claude tries to ghostwrite, the Voice Guardian rejects.
- **"Why Opus and not Sonnet/Haiku?"** Opus is doing structural reasoning, not content generation. The latency is amortized across the editing session — agents run in the background. We get the quality of Opus's reading without paying its latency on the typing path.
