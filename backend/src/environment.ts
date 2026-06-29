// Environment introspection. Makes the Alfred RL environment legible to its own
// subject — the writer.
//
// Standard RL environments are opaque to the entity being modeled: the subject
// never sees the action space, the reward function, or the statistics being
// accumulated about them. Alfred inverts this (the Panopticon thesis). This module
// is the data behind that inversion: it describes the environment's formal parts
// and reports the live reward signal being gathered, so the writer can read — and,
// via the profile + trajectory files, edit or delete — the model being built of them.

import { TOOL_DEFS } from "./operators.js";
import { getSession, type RewardEvent } from "./session.js";

// Mirrors the limits enforced in validator.ts (the Voice Guardian). Kept here as
// declared constants so the environment can *describe* its own constraints.
const GLUE_TOKEN_LIMIT_PER_OP = 15;
const GLUE_TOKEN_LIMIT_TOTAL = 60;
const MIGRATE_CHANGE_LIMIT = 0.5;

export type EnvironmentInfo = {
  env: "alfred-writer-align";
  description: string;
  action_space: Array<{ name: string; description: string }>;
  reward_function: {
    description: string;
    mapping: Array<{ decision: string; reward: string }>;
  };
  verifier: {
    description: string;
    constraints: string[];
  };
  episode: string;
  reward_stats: RewardStats | null;
};

export type RewardStats = {
  episodes: number;
  mean_reward: number;
  by_decision: Array<{ decision: string; count: number; mean_reward: number }>;
  by_operator: Array<{ operator: string; count: number; mean_reward: number }>;
  trajectory_count: number;
};

export function getEnvironmentInfo(sessionId?: string): EnvironmentInfo {
  const action_space = (TOOL_DEFS as ReadonlyArray<{ name: string; description: string }>)
    .filter((t) => t.name !== "finalize_proposal")
    .map((t) => ({ name: t.name, description: t.description }));

  return {
    env: "alfred-writer-align",
    description:
      "A constrained editing environment for writer-alignment. The policy observes a document, the writer's voice profile, and recent decisions, and acts only through a fixed algebra of structural operators — it cannot author prose. Reward is the writer's accept/reject/edit decision on the proposed diff.",
    action_space,
    reward_function: {
      description:
        "The writer's decision on the proposed diff, graded in [-1, 1]. A modify is graded by how much of the proposal survived the writer's editing (the edit-delta).",
      mapping: [
        { decision: "accept", reward: "+1.0" },
        { decision: "reject", reward: "-1.0" },
        { decision: "modify", reward: "+1 - 2 * edit_change_fraction" },
      ],
    },
    verifier: {
      description:
        "The Voice Guardian. A deterministic, verifiable constraint layer that rejects any proposal that could overwrite voice before the writer ever sees it.",
      constraints: [
        `glue text <= ${GLUE_TOKEN_LIMIT_PER_OP} tokens per operator`,
        `glue text <= ${GLUE_TOKEN_LIMIT_TOTAL} tokens total`,
        `migrate token-edit distance <= ${MIGRATE_CHANGE_LIMIT * 100}%`,
        "no forbidden_tokens (from the writer's .proserc)",
        "operators must apply cleanly to the document topology",
      ],
    },
    episode: "one propose -> decide cycle (state -> action -> verifier -> reward)",
    reward_stats: sessionId ? computeRewardStats(sessionId) : null,
  };
}

function computeRewardStats(sessionId: string): RewardStats | null {
  const session = getSession(sessionId);
  const rewards = session.rewards;
  if (rewards.length === 0) {
    return { episodes: 0, mean_reward: 0, by_decision: [], by_operator: [], trajectory_count: 0 };
  }

  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const mean_reward = mean(rewards.map((r) => r.scalar));

  const decisions = ["accept", "reject", "modify"] as const;
  const by_decision = decisions
    .map((d) => {
      const subset = rewards.filter((r) => r.decision === d);
      return { decision: d, count: subset.length, mean_reward: mean(subset.map((r) => r.scalar)) };
    })
    .filter((x) => x.count > 0);

  const opMap = new Map<string, number[]>();
  for (const r of rewards) {
    for (const k of new Set(r.operator_kinds)) {
      if (!opMap.has(k)) opMap.set(k, []);
      opMap.get(k)!.push(r.scalar);
    }
  }
  const by_operator = [...opMap.entries()]
    .map(([operator, scalars]) => ({ operator, count: scalars.length, mean_reward: mean(scalars) }))
    .sort((a, b) => b.count - a.count);

  return {
    episodes: rewards.length,
    mean_reward,
    by_decision,
    by_operator,
    trajectory_count: rewards.length,
  };
}
