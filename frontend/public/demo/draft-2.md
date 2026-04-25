[fragment from yesterday's notebook]

what i'm trying to articulate is that the bottleneck in AI writing is not capability but action-space. the model can write coherently. the question is what we let it do. if we let it generate prose, it regresses to the mean. if we constrain it to topology, the writer keeps every word. the difference is architectural not stylistic.

[from a Gemini session, Mar 20]

The interesting move is to think of the editor as the RL environment, not just a UI. Every accept/reject is a reward signal. The system prompt is the policy. Over the course of a session, the policy converges on the writer's preferences without ever updating model weights — it accumulates few-shot examples in context. This is in-context reinforcement learning. The state machine is the writer's hands.

[scratch paragraph from the dorm]

I keep coming back to a simple question. Why does AI-assisted writing feel bad? Not the output — the process. Even when the output is fine, the process feels like supervising a confident stranger who keeps inserting their voice into yours. You spend more time pruning than writing. You start to feel like a translator of your own thought into a language the machine understands. The whole point of the tool is gone.

[fragment from the notebook]

three layers: cognition (the writer's intent), structure (the topology of claims), surface (the prose). standard AI writing tools operate on the surface. that's where the regression to mean happens. operate on structure instead. preserve the surface as it was written. you keep the voice for free.

[from a chat with Claude, last week]

The cleanest way to think about this is as a separation of concerns. The writer produces high-frequency information (words, rhythm, idiosyncrasy). The AI handles low-frequency information (where things go, what connects to what, what's redundant). Generative AI inverts this — it produces high-frequency information that's average and accepts the writer's structural input as the ground truth. We want the opposite. The writer's high-frequency is sacred; the AI's structural reasoning is the tool.

[final paragraph attempt]

If you accept the premise that the bottleneck is action-space, the implementation falls out almost mechanically. The AI gets a fixed algebra: split, merge, move, hoist, demote, migrate, glue. Each operator is constrained at the schema level. The voice guardian validates every proposal before showing it. The user accepts or rejects. The system learns from the decisions. The architecture is forced by the thesis, not added on top of it.
