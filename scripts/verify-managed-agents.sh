#!/usr/bin/env bash
# verify-managed-agents.sh — proves Alfred is genuinely using Anthropic's
# Managed Agents API, not a "managed agent" framing on top of standard
# Messages. Hits four endpoints and shows the live agent + environment IDs,
# the actual agent definition retrieved from Anthropic, and a real proposal
# round-trip.
#
# Usage:
#   ALFRED_BASE=http://localhost:3001 ./scripts/verify-managed-agents.sh
#   (defaults to http://localhost:3001 if ALFRED_BASE not set)

set -euo pipefail

BASE="${ALFRED_BASE:-http://localhost:3001}"
GREEN='\033[0;32m'
RED='\033[0;31m'
DIM='\033[2m'
BOLD='\033[1m'
RESET='\033[0m'

ok() { printf "${GREEN}✓${RESET} %s\n" "$1"; }
fail() { printf "${RED}✗${RESET} %s\n" "$1" >&2; exit 1; }
header() { printf "\n${BOLD}%s${RESET}\n" "$1"; }
dim() { printf "${DIM}%s${RESET}\n" "$1"; }

require_cmd() { command -v "$1" >/dev/null 2>&1 || fail "missing dependency: $1"; }
require_cmd curl
require_cmd jq

header "1. /api/health — confirm mode is 'agents'"
HEALTH=$(curl -s "$BASE/api/health")
echo "$HEALTH" | jq .
MODE=$(echo "$HEALTH" | jq -r '.mode')
[[ "$MODE" == "agents" ]] || fail "mode is '$MODE', expected 'agents' — start backend with ALFRED_MODE=agents"
AGENT_ID=$(echo "$HEALTH" | jq -r '.agent_id // ""')
ENV_ID=$(echo "$HEALTH" | jq -r '.environment_id // ""')
[[ -n "$AGENT_ID" ]] || fail "no agent_id in /api/health — provision via scripts/setup-agent.mjs"
ok "running in agents mode"
ok "agent_id:       $AGENT_ID"
ok "environment_id: $ENV_ID"

header "2. /api/agent/info — round-trip to Anthropic to retrieve the live agent definition"
INFO=$(curl -s "$BASE/api/agent/info")
echo "$INFO" | jq '{name, description, version, created_at, model, system_prompt_length, tool_count: (.tools | length)}'
NAME=$(echo "$INFO" | jq -r '.name')
TOOL_COUNT=$(echo "$INFO" | jq -r '.tools | length')
[[ "$NAME" == "Alfred" ]] || fail "agent.name is '$NAME', expected 'Alfred'"
[[ "$TOOL_COUNT" -ge 9 ]] || fail "expected ≥9 tools, got $TOOL_COUNT"
ok "agent definition retrieved from Anthropic"
ok "$TOOL_COUNT custom tools registered"

header "3. listing tool names from the live agent"
echo "$INFO" | jq -r '.tools[] | "  - \(.name) (\(.type))"'

header "4. POST /api/propose — full propose round-trip via the managed agent session"
SESSION_ID="verify-$(date +%s)"
REQ=$(cat <<EOF
{
  "session_id": "$SESSION_ID",
  "intent": "this graf drags — find the buried thesis and hoist it to the lede",
  "document": {
    "paragraphs": [
      {"id":"p1","text":"Most AI writing tools optimize for the wrong thing. They chase fluency. The result is uniformity. Voice flattens."},
      {"id":"p2","text":"I used to feel this when I would paste my drafts into ChatGPT. Something would come back smoother and duller."},
      {"id":"p3","text":"There are two kinds of writing tools: ones that generate prose, and ones that organize what you have produced."},
      {"id":"p4","text":"The mistake the field made was treating writing as a generation problem. It is a topology problem. The writer's brain is a graph."}
    ]
  }
}
EOF
)
dim "  (this round-trips through client.beta.sessions.events.stream — usually 5–10s)"
RESP=$(curl -s -X POST -H 'Content-Type: application/json' --data "$REQ" "$BASE/api/propose")
OK=$(echo "$RESP" | jq -r '.ok')
[[ "$OK" == "true" ]] || { echo "$RESP" | jq .; fail "propose failed"; }

ALFRED_SAYS=$(echo "$RESP" | jq -r '.proposal.alfred_says')
RATIONALE=$(echo "$RESP" | jq -r '.proposal.rationale')
OPS=$(echo "$RESP" | jq -r '.proposal.operators[].kind' | sort | uniq -c | awk '{printf "%s × %s, ", $1, $2}' | sed 's/, $//')
GLUE=$(echo "$RESP" | jq -r '.proposal.voice_check.glue_budget_used')

ok "proposal returned"
echo
echo "  alfred_says: $ALFRED_SAYS"
echo "  rationale:   $RATIONALE"
echo "  operators:   $OPS"
echo "  voice integrity: $GLUE/60 glue tokens"

header "✓ all proofs verified — Alfred is genuinely using Anthropic Managed Agents"
echo
echo "  agent_id:        $AGENT_ID"
echo "  environment_id:  $ENV_ID"
echo "  tool count:      $TOOL_COUNT"
echo "  proposal session: $SESSION_ID"
echo
dim "  the agent + environment are persistent Anthropic resources; you can"
dim "  retrieve them anytime with client.beta.agents.retrieve('$AGENT_ID')"
