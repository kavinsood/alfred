# Alfred on Cloudflare Managed Agents

## What this is

Cloudflare CMA control plane for Alfred. Receives Anthropic webhooks, runs the IsolateRunner, dispatches Alfred's custom tools.

## Architecture

```
Anthropic (Claude Platform on AWS)
→ webhook to Worker /webhooks
→ IsolateRunner (isolate backend)
→ Alfred custom tools (validate, store, decide)
→ D1 + Vectorize + AI Gateway
```

## Custom tools

| Tool | Purpose |
|------|---------|
| `alfred_get_context` | Load profile, document, voice memories |
| `alfred_validate_ops` | Deterministic operator validation (trust boundary) |
| `alfred_store_proposal` | Persist validated proposal to D1 |
| `alfred_record_decision` | Record accept/reject, update profile |
| `alfred_get_panopticon` | Profile + events + decision stats |

## Bindings

| Binding | Purpose |
|---------|---------|
| D1 (`DB`) | CMA webhook/session tracking |
| D1 (`ALFRED_DB`) | Profiles, documents, proposals, decisions, Panopticon |
| Vectorize (`ALFRED_VECTORS`) | Voice memory embeddings |
| AI (`AI`) | Workers AI for embeddings |
| IsolateRunner (DO) | Session state + tool dispatch |
| LOADER (Worker Loader) | Dynamic Worker execution |

## Setup

```bash
npm install

# Create resources
wrangler d1 create alfred-cma-db
wrangler d1 create alfred-db
wrangler vectorize create alfred-voice-memory --dimensions 768 --metric cosine

# Patch database_id values in wrangler.jsonc

# Set secrets
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put ANTHROPIC_ENVIRONMENT_KEY
wrangler secret put ENVIRONMENT_ID
wrangler secret put WEBHOOK_SECRET

# AI Gateway (routes CMA API calls through gateway for observability)
wrangler secret put ANTHROPIC_BASE_URL
# Value: https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/anthropic

# Deploy
npm run deploy
npm run db:migrate:remote
```

## Local development

```bash
npm run db:migrate
npm run dev
```
