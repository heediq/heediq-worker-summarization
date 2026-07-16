# heediq-worker-summarization

## Purpose

Node.js Lambda worker that reads a completed Source's transcript, sends it to Claude, and writes structured extraction results (requirements, decisions, open questions, action items) back to DynamoDB. Deployed by CI (`aws lambda update-function-code`) — infra shell is a placeholder in `heediq-infra/SummarizationStack`.

## Key Files

- `src/handler.ts` — SQS handler entry point; orchestrates load → extract → write
- `src/lambda.ts` — Lambda entrypoint re-export
- `src/config.ts` — loads runtime config; fetches Claude API key from Secrets Manager at cold start
- `src/content-loader.ts` — loads transcript from DynamoDB (`sourceType=text`) or S3 (`sourceType=audio`)
- `src/provider.ts` — `ExtractionProvider` interface + `ClaudeProvider` implementation (D-032)
- `src/writer.ts` — DynamoDB writes: `writeStatus` (jobs table) and `writeSummary` (sources table)
- `.github/workflows/ci.yml` — PR gate: typecheck + unit tests
- `.github/workflows/deploy.yml` — push gate: test → esbuild bundle → `lambda update-function-code` per environment

## Data Flow

```
SQS heediq-summarization (batchSize=1)
  │  SummarizationJobMessage { jobId, sourceId, orgId, sourceType, contentRef, tier }
  ▼
Lambda handler
  ├── writeStatus(sourceId, 'summarizing')       → heediq-jobs table, keyed by sourceId
  ├── loadContent(msg) →
  │     sourceType='text': GET heediq-sources[orgId, sourceId].transcript (contentRef IS sourceId)
  │     sourceType='audio': S3 GetObject(contentRef)                (future path)
  ├── ClaudeProvider.extract(transcript)         → free: claude-haiku-4-5-20251001
  │                                                paid: claude-sonnet-4-6  (D-067)
  ├── writeSummary(orgId, sourceId, extraction)  → heediq-sources table, keyed by orgId+sourceId
  └── writeStatus(sourceId, 'done')              → heediq-jobs table
      (on error: writeStatus(sourceId, 'failed') + rethrow → SQS retry → DLQ after 3 attempts)
```

## Contracts

### SQS message — SummarizationJobMessage (`@heediq/shared`)

| Field | Type | Notes |
|---|---|---|
| `jobId` | UUID | Plain attribute in `heediq-jobs`, NOT part of its key |
| `sourceId` | UUID | Key attribute in `heediq-jobs` (its only key, no sort key); sort key of `heediq-sources`' composite key (D-068) |
| `orgId` | UUID | For tenant isolation on writes; partition key of `heediq-sources`' composite key |
| `sourceType` | `'text' \| 'audio'` | Determines content-load path |
| `contentRef` | string | `sourceType=text` → sourceId; `sourceType=audio` → S3 key |
| `tier` | `'free' \| 'paid'` | Selects Claude model: free → Haiku, paid → Sonnet (D-067) |

### DynamoDB writes

- `heediq-jobs`: `Key: { sourceId }` — item shape `{ sourceId, jobId, status, updatedAt }` — status transitions: `summarizing → done | failed`
- `heediq-sources`: `Key: { orgId, sourceId }` (composite: pk=orgId, sk=sourceId) — item shape `{ orgId, sourceId, requirements[], decisions[], openQuestions[], actionItems[], updatedAt }`

### Environment variables (CDK-injected, D-038)

| Var | Source |
|---|---|
| `JOBS_TABLE_NAME` | DynamoDB table name (CDK-injected) |
| `SOURCES_TABLE_NAME` | DynamoDB table name (CDK-injected) |
| `AUDIO_BUCKET_NAME` | S3 bucket name (CDK-injected) |
| `CLAUDE_SECRET_NAME` | Hardcoded to `/heediq/summarization/anthropic-api-key` by CDK |
| `AWS_REGION` | Injected automatically by Lambda runtime |

Claude API key is fetched from Secrets Manager at cold start — never passed as an env var in plaintext (D-038).

### IAM grants (from SummarizationStack)

- `heediq-jobs`: ReadWrite
- `heediq-sources`: ReadWrite
- `heediq-audio-uploads` bucket: Read (for `sourceType=audio` future path)
- Secrets Manager: `GetSecretValue` on `/heediq/summarization/*`

## Dependencies

- **Upstream**: `heediq-infra/SummarizationStack` (SQS queue, Lambda shell, IAM grants, env vars) — must be deployed first
- **Upstream**: `heediq-worker-transcription` — writes `heediq-sources[sourceId].transcript`; summarization worker reads it
- **Downstream**: nothing yet (Jira/Confluence push is a future feature)
- **Shared**: `@heediq/shared` (SummarizationJobMessage schema, shared types) — pinned to `^0.12.0` (D-085/D-093 `createLogger` structured logger, mandatory per D-093). Renovate (D-048) keeps this pin current; bump only when a published change is actually consumed here.

## Testing

```bash
pnpm install
pnpm run test:pre-pr   # typecheck + unit tests (15 tests across 4 suites)
pnpm run test          # unit tests only
```

Tests mock at the module boundary (`content-loader`, `writer`, `provider`) — handler tests verify orchestration order, not DynamoDB internals. DynamoDB internals covered by `writer.test.ts` and `content-loader.test.ts`; Claude API mocked via `msw`.

## Gotchas & Constraints

- **`sourceType=text` → contentRef IS the sourceId** (not an S3 key). The field is named generically for the future `audio` path. Don't assume it's an S3 key for text jobs.
- **Claude API key fetched at cold start** — any Secrets Manager error on init fails all warm invocations until the next cold start. Rotate secrets carefully.
- **Module-level client caching** — `handler.ts` caches DynamoDB, S3, and provider instances at module level. Cold start pays the init cost once; warm invocations reuse. Tests must mock at the module boundary (not the SDK level) to avoid state leakage between tests.
- **First deploy**: the Lambda placeholder (in `SummarizationStack`) must be deployed by CDK before CI can update function code. CI's `aws lambda update-function-code` will fail if the function doesn't exist yet. See `heediq-infra/README.md` §"Initial Setup" for the full account/CDK-bootstrap prerequisites.
- **`@heediq/shared` install:** CI uses `NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}` to pull from GitHub Packages. Local dev requires a GitHub PAT with `read:packages` scope set as `NODE_AUTH_TOKEN` — add `//npm.pkg.github.com/:_authToken=<PAT>` to `~/.npmrc` or export the var before running `pnpm install`.
- **`sourceType=audio` path** — S3 load is wired but untested beyond unit level. It is a future path for when transcript text is too large for DynamoDB item limits (~400KB).
- **Structured logging (D-085/D-093):** `handler.ts` logs job start/done and failures via `@heediq/shared`'s `createLogger('heediq-worker-summarization')` — structured JSON correlated by `sourceId`/`jobId`. Raw `console.log`/`console.error` is disallowed (D-093) — always go through the logger. Default log level is `info` in every environment; `debug` is opt-in via the `LOG_LEVEL` env var, read at runtime with no redeploy needed. The logger's own PII denylist redacts transcript/email/token-like metadata. X-Ray active tracing is enabled on the Lambda (`heediq-infra` `SummarizationStack`, D-085).
