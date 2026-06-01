# Alfred Cloudflare Operations

## Required secrets

Set via `wrangler secret put <NAME>`:

| Secret | Required | Purpose |
|--------|----------|---------|
| `ANTHROPIC_API_KEY` | Yes | API calls to Anthropic |
| `ANTHROPIC_ENVIRONMENT_KEY` | For CMA | Environment auth for managed agents |
| `ENVIRONMENT_ID` | For CMA | Anthropic environment identifier |
| `WEBHOOK_SECRET` | For CMA | HMAC verification of Anthropic webhooks |

Optional (AWS Claude Platform path):
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `AWS_SESSION_TOKEN`

## Local development

```bash
cd cloudflare
npm install
npm run db:migrate:local
npm run dev
# Runs on http://localhost:8787
```

Test with:
```bash
curl http://localhost:8787/api/health
curl -X POST http://localhost:8787/api/profile -H 'Content-Type: application/json' -d '{"profile_id": "test-user"}'
```

## Remote deploy

```bash
cd cloudflare

# First time: create resources
wrangler d1 create alfred-db
# Update database_id in wrangler.jsonc

wrangler vectorize create alfred-voice-memory --dimensions 1024 --metric cosine

# Set secrets
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put ANTHROPIC_ENVIRONMENT_KEY
wrangler secret put ENVIRONMENT_ID
wrangler secret put WEBHOOK_SECRET

# Deploy
npm run deploy
# Migrations run automatically via postdeploy
```

## D1 migration commands

```bash
# Local
npm run db:migrate:local

# Remote
npm run db:migrate:remote

# Check status
wrangler d1 migrations list ALFRED_DB --local
wrangler d1 migrations list ALFRED_DB --remote
```

## Vectorize

```bash
# Create index
wrangler vectorize create alfred-voice-memory --dimensions 1024 --metric cosine

# Check info
wrangler vectorize get alfred-voice-memory
```

Dimensions depend on the embedding model used. Default 1024 matches Workers AI `@cf/baai/bge-large-en-v1.5`.

## AI Gateway setup

1. Create a gateway in the Cloudflare dashboard (AI > AI Gateway)
2. `wrangler secret put ANTHROPIC_BASE_URL`
3. Value: `https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/anthropic`
4. All CMA API calls route through the gateway for logging, caching, and rate limiting

## Known failure modes

| Symptom | Cause | Fix |
|---------|-------|-----|
| Webhook returns 401 | Bad WEBHOOK_SECRET | Re-set from Anthropic Console |
| IsolateRunner fails to start | Missing ANTHROPIC_ENVIRONMENT_KEY | `wrangler secret put ANTHROPIC_ENVIRONMENT_KEY` |
| Custom tools don't appear in agent catalog | Agent not configured for isolate backend | Set backend to "isolate" in agent_backends D1 table |
| Vectorize operations skip | AI binding not returning embeddings | Check Workers AI availability in region |
| D1 errors | Missing migrations | `npm run db:migrate:remote` |

## Security notes

- Protect with Cloudflare Access before public deployment.
- Never log API keys. The control plane redacts key prefixes in logs.
- D1 data uses Cloudflare's default disk encryption.
