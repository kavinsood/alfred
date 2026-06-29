// Trajectory emission. This is what makes Alfred an *environment that produces a
// dataset* rather than an app that logs prose.
//
// Every completed episode (one propose -> decide cycle) is appended as a single
// JSON line to ~/.alfred/trajectories/<session>.jsonl in the canonical RL shape:
//
//   { state, action, verifier, reward }
//
// - state    : what the policy conditioned on (document the model saw, the writer's
//              voice profile, the hoarded few-shot buffer, the intent).
// - action   : the operators Alfred emitted (the constrained action space).
// - verifier : the Voice Guardian result (the hard-constraint / verifiable-reward
//              component) that gated the proposal before the writer ever saw it.
// - reward   : the graded scalar from the writer's decision (see reward.ts).
//
// The file is local and user-owned, consistent with the Panopticon ethos: the data
// extracted about the writer lives on the writer's disk, inspectable and deletable.
// It is also exactly the rollout format a future hosted-RL run would train on — the
// environment is training-ready today even though no training is run today.

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { AlfredDocument, Operator, Proposal, VoiceProfile } from "./types.js";
import type { FewShotExample } from "./session.js";
import type { Reward } from "./reward.js";

export const TRAJECTORY_SCHEMA_VERSION = 1;

const ALFRED_HOME =
  process.env.ALFRED_HOME && process.env.ALFRED_HOME.length > 0
    ? process.env.ALFRED_HOME.replace(/^~/, os.homedir())
    : path.join(os.homedir(), ".alfred");

const TRAJ_DIR = path.join(ALFRED_HOME, "trajectories");

export type TrajectoryRecord = {
  schema_version: number;
  ts: string;
  env: "alfred-writer-align";
  session_id: string;
  proposal_id: string;
  state: {
    intent: string;
    document: AlfredDocument;
    profile: {
      vibe_anchor_present: boolean;
      forbidden_tokens: string[];
      learned_preferences: string[];
    };
    hoarded: Array<{ intent: string; operators_summary: string; decision: string }>;
  };
  action: {
    operators: Operator[];
    operator_kinds: string[];
    rationale: string;
    alfred_says: string;
  };
  verifier: {
    glue_budget_used: number;
    migrate_change_pct: number | null;
    forbidden_tokens_violated: string[];
  };
  reward: {
    decision: Reward["decision"];
    scalar: number;
    edit_change_fraction: number | null;
    components: Reward["components"];
    reject_reason?: string;
  };
};

export type TrajectoryInput = {
  sessionId: string;
  proposal: Proposal;
  intent: string;
  docAtPropose: AlfredDocument;
  hoarded: FewShotExample[];
  profile: VoiceProfile;
  reward: Reward;
  rejectReason?: string;
};

export function buildTrajectoryRecord(input: TrajectoryInput): TrajectoryRecord {
  const { proposal, profile, reward } = input;
  return {
    schema_version: TRAJECTORY_SCHEMA_VERSION,
    ts: new Date().toISOString(),
    env: "alfred-writer-align",
    session_id: input.sessionId,
    proposal_id: proposal.id,
    state: {
      intent: input.intent,
      document: input.docAtPropose,
      profile: {
        vibe_anchor_present: profile.vibe_anchor.trim().length > 0,
        forbidden_tokens: profile.forbidden_tokens,
        learned_preferences: profile.learned_preferences.map((p) => p.rule),
      },
      hoarded: input.hoarded.map((h) => ({
        intent: h.intent,
        operators_summary: h.operators_summary,
        decision: h.decision,
      })),
    },
    action: {
      operators: proposal.operators,
      operator_kinds: proposal.operators.map((o) => o.kind),
      rationale: proposal.rationale,
      alfred_says: proposal.alfred_says,
    },
    verifier: {
      glue_budget_used: proposal.voice_check.glue_budget_used,
      migrate_change_pct: proposal.voice_check.migrate_change_pct,
      forbidden_tokens_violated: proposal.voice_check.forbidden_tokens_violated,
    },
    reward: {
      decision: reward.decision,
      scalar: reward.scalar,
      edit_change_fraction: reward.edit_change_fraction,
      components: reward.components,
      reject_reason: input.rejectReason,
    },
  };
}

export async function appendTrajectory(input: TrajectoryInput): Promise<void> {
  const record = buildTrajectoryRecord(input);
  await fs.mkdir(TRAJ_DIR, { recursive: true });
  const file = path.join(TRAJ_DIR, `${input.sessionId}.jsonl`);
  await fs.appendFile(file, JSON.stringify(record) + "\n", "utf8");
}

export function trajectoryDir(): string {
  return TRAJ_DIR;
}
