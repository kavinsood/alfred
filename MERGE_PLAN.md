# Post-recording merge plan

When you're done recording the demo, here's the exact sequence to bring the
Managed Agents transport from the `managed-agents` worktree branch into `main`.

## State of play

- **`main`**: Messages API path (default), the demo you just recorded. `@anthropic-ai/sdk@0.32.1`.
- **`managed-agents`**: branched off main 4 commits ago, adds the agents transport. SDK upgraded to `@anthropic-ai/sdk@0.91.1`. The agent + environment have already been provisioned on Anthropic's side and live in `/tmp/alfred-agents-test/agent.json` (worktree's data home).

## Divergent commits

```
managed-agents (4 commits ahead of main):
  1779709 fix: agents path — recover from "waiting on responses" 400 …
  a877d10 docs: submission writeup adds dual-transport framing …
  4d7a798 fix: agents path — validator-feedback retry loop + tool-use ack cleanup
  74d50cd feat: Managed Agents transport (alfred-agents.ts)

main (1 commit ahead of branch point):
  645ef9b docs: submission writeup — dual-transport framing; …
```

`a877d10` and `645ef9b` both edit `docs/submission.md`. The contents are
identical (I copied one to the other), so git's merge will see no conflict.

`git merge-tree --write-tree main managed-agents` confirmed the merge applies
cleanly with no conflicts.

## Procedure

```bash
# 1. Stop both backends so tsx doesn't fight the SDK upgrade mid-merge
#    (only do this AFTER you're done recording)
pkill -f "tsx watch" || true

# 2. From main, merge the worktree branch
cd ~/github/alfred
git merge --no-ff managed-agents -m "merge managed-agents — dual-transport (Messages + Managed Agents)"

# 3. The merge brings in @anthropic-ai/sdk@0.91.1 in backend/package.json.
#    Reinstall to make sure node_modules matches.
npm --prefix backend install

# 4. Move agent.json from the worktree's test home to your real ~/.alfred/
#    OR re-provision against your real home (free; Anthropic returns the
#    existing agent if asked again).
mkdir -p ~/.alfred
cp /tmp/alfred-agents-test/agent.json ~/.alfred/agent.json
# OR
node backend/scripts/setup-agent.mjs

# 5. Restart the dev servers. Default is Messages mode (the demo path).
npm run dev

# 6. Verify both transports
npm run smoke                                    # Messages mode (default)
ALFRED_MODE=agents npm run dev:backend &         # in another terminal
ALFRED_BASE=http://localhost:3001 npm run smoke  # Agents mode (after restart)

# 7. Once happy, drop the worktree
git worktree remove ../alfred-agents
git branch -d managed-agents      # (or -D to force; it's been merged)
```

## What the merge brings to main

- `backend/package.json` → `@anthropic-ai/sdk@^0.91.1` (was 0.32.1)
- `backend/src/alfred-agents.ts` (new, ~280 lines)
- `backend/src/server.ts` (adds `ALFRED_MODE` switch)
- `backend/scripts/setup-agent.mjs` (new — one-time agent + environment provisioning, idempotent)
- `backend/scripts/probe-agent.mjs` (new — runtime probe utility)
- `docs/managed-agents.md` (architecture notes)
- `docs/submission.md` (updated; identical to what's already on main)

Total diff: ~700 LOC added, 0 LOC removed (additive only).

## Rollback if something breaks

```bash
git reset --hard ORIG_HEAD       # immediately after merge, before any new commits
# OR if you've moved on:
git revert -m 1 <merge-commit-sha>
```

The `ALFRED_MODE` switch defaults to `messages`, so even with the merged code,
the demo path is unchanged unless you opt-in.

## After merge: submission write-up final pass

`docs/submission.md` already claims Best Use of Managed Agents. After merge,
the claim is grounded in source on the same branch the judge would clone. No
further edits needed unless you want to add the actual `agent_id` and
`environment_id` strings to the writeup as concrete proof.

## What can go wrong

- **SDK 0.91.1 surface differences.** I verified that `client.messages.create` still works on 0.91.1 with the existing alfred.ts code (smoke test green on the worktree before the merge). If something subtle breaks at runtime, the rollback above is one command.
- **Agent.json paths.** The worktree provisioned its agent + env using `ALFRED_HOME=/tmp/alfred-agents-test`. Your real `~/.alfred/` doesn't have `agent.json` yet. Step 4 above handles this either by copying or re-running setup (the latter creates a brand-new agent with a different ID — that's also fine; the bootstrap is idempotent in checking `agent.json` presence, not in dedup'ing on Anthropic's side).
- **Cron `90c0c62d`.** Still firing every 10 min. Run `CronDelete 90c0c62d` from a Claude Code session anytime to stop it; otherwise it auto-expires after 7 days.
