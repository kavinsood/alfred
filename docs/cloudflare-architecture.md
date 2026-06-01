# Alfred Cloudflare Architecture

## Conceptual split

```
Claude Managed Agents = brain / planning / session orchestration
Cloudflare            = hands / runtime / trust boundary / persistence
Alfred operator runtime = deterministic policy layer
```

## Why this split works

Claude Managed Agents handles:
- Agent loop and continuation
- Session state
- Tool selection and planning
- Natural language understanding of user intent

Cloudflare handles:
- Custom tool execution (validate, store, decide)
- D1 persistence (profiles, documents, sessions, proposals, decisions)
- Vectorize voice memory
- AI Gateway observability for direct model calls
- The isolate runtime that executes tool code

The Alfred operator runtime (shared between local and Cloudflare) handles:
- Parsing raw operator JSON into typed operators
- Applying operators to documents (pure functions)
- Validating proposals against voice profile constraints
- Enforcing glue cap (15 tokens/op, 60 total), migrate cap (50%), forbidden tokens

## Isolates are still Managed Agents

Using Cloudflare isolates / Dynamic Workers is a supported CMA backend. Claude Managed Agents is the Anthropic orchestration layer. Cloudflare provides the self-managed runtime where custom tools execute.

Alfred avoids Containers by default because:
- The core operation is structural validation + D1 writes
- No filesystem, shell, or long-running process needed
- Isolates cold-start in <5ms vs seconds for containers
- Containers solve the wrong problem for document operators

## Data flow

```
User types intent in Alfred UI
→ Frontend POST /api/propose
→ Worker creates/reuses CMA session
→ Claude agent receives document + profile + intent
→ Agent calls alfred_validate_ops (custom tool)
  → Worker executes: parse operators, apply to doc, check constraints
  → Returns validation result to agent
→ Agent calls alfred_store_proposal (custom tool)
  → Worker executes: insert into D1, append Panopticon event
  → Returns proposal_id to agent
→ Worker returns proposal to frontend
→ User accepts/rejects (Tab/Esc)
→ Frontend POST /api/decision
→ Worker records decision in D1
→ Worker upserts voice memory in Vectorize
→ Worker updates profile learned preferences
```

## Storage

- **D1** is canonical for all structured state. No SQLite/filesystem fallback on Cloudflare.
- **Vectorize** stores voice memory embeddings for retrieval during context building.
- **AI Gateway** (optional) provides logging/caching for any direct model calls the Worker makes.

## Custom tools (the trust boundary)

| Tool | Purpose |
|------|---------|
| `alfred_get_context` | Load profile + document + voice memories for agent context |
| `alfred_validate_ops` | Parse and validate operator proposal against document + profile |
| `alfred_store_proposal` | Persist validated proposal to D1 |
| `alfred_record_decision` | Record accept/reject, update profile, upsert memory |
| `alfred_get_panopticon` | Return profile + event history for transparency |

The model cannot bypass these tools. It proposes operators; the tools validate and persist.

## Durable Objects

The CMA isolate backend uses `IsolateRunner` (Agents SDK DO) internally as session containers. Alfred tools run inside the IsolateRunner's tool dispatch loop. Alfred does not introduce its own Durable Objects.

## AI Gateway

Set `ANTHROPIC_BASE_URL` to an AI Gateway URL to route all CMA API calls through the gateway for observability:

```
https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/anthropic
```
