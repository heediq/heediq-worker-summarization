# heediq-worker-summarization

## Purpose

Node.js Lambda worker that reads a completed recording's transcript, sends it to Claude, and writes structured extraction results (requirements, decisions, open questions, action items) back to DynamoDB. Deployed by CI (`aws lambda update-function-code`) — infra shell is a placeholder in `heediq-infra/SummarizationStack`.

## Key Files

- `src/handler.ts` — SQS handler entry point; orchestrates load → extract → write
- `src/lambda.ts` — Lambda entrypoint re-export
- `src/config.ts` — loads runtime config; fetches Claude API key from Secrets Manager at cold start
- `src/content-loader.ts` — loads transcript from DynamoDB (`sourceType=text`) or S3 (`sourceType=audio`)
- `src/provider.ts` — `ExtractionProvider` interface + `ClaudeProvider` implementation (D-032)
- `src/writer.ts` — DynamoDB writes: `writeStatus` (jobs table) and `writeSummary` (recordings table)
- `.github/workflows/ci.yml` — PR gate: typecheck + unit tests
- `.github/workflows/deploy.yml` — push gate: test → esbuild bundle → `lambda update-function-code` per environment

## Data Flow

```
SQS heediq-summarization (batchSize=1)
  │  SummarizationJobMessage { jobId, recordingId, orgId, sourceType, contentRef, tier }
  ▼
Lambda handler
  ├── writeStatus(jobId, 'summarizing')          → heediq-jobs table
  ├── loadContent(msg) →
  │     sourceType='text': GET heediq-recordings[recordingId].transcript  (contentRef IS recordingId)
  │     sourceType='audio': S3 GetObject(contentRef)                      (future path)
  ├── ClaudeProvider.extract(transcript)         → free: claude-haiku-4-5-20251001
  │                                                paid: claude-sonnet-4-6  (D-067)
  ├── writeSummary(recordingId, extraction)      → heediq-recordings table
  └── writeStatus(jobId, 'done')                 → heediq-jobs table
      (on error: writeStatus(jobId, 'failed') + rethrow → SQS retry → DLQ after 3 attempts)
```

## Contracts

### SQS message — SummarizationJobMessage (`@heediq/shared`)

| Field | Type | Notes |
|---|---|---|
| `jobId` | UUID | Keyed in `heediq-jobs` |
| `recordingId` | UUID | PK in `heediq-recordings` |
| `orgId` | UUID | For tenant isolation on writes |
| `sourceType` | `'text' \| 'audio'` | Determines content-load path |
| `contentRef` | string | `sourceType=text` → recordingId; `sourceType=audio` → S3 key |
| `tier` | `'free' \| 'paid'` | Selects Claude model: free → Haiku, paid → Sonnet (D-067) |

### DynamoDB writes

- `heediq-jobs`: `{ jobId, status, updatedAt }` — status transitions: `summarizing → done | failed`
- `heediq-recordings`: `{ recordingId, requirements[], decisions[], openQuestions[], actionItems[], orgId, summarizedAt }`

### Environment variables (CDK-injected, D-038)

| Var | Source |
|---|---|
| `JOBS_TABLE_NAME` | DynamoDB table name (CDK-injected) |
| `RECORDINGS_TABLE_NAME` | DynamoDB table name (CDK-injected) |
| `AUDIO_BUCKET_NAME` | S3 bucket name (CDK-injected) |
| `CLAUDE_SECRET_NAME` | Hardcoded to `/heediq/summarization/anthropic-api-key` by CDK |
| `AWS_REGION` | Injected automatically by Lambda runtime |

Claude API key is fetched from Secrets Manager at cold start — never passed as an env var in plaintext (D-038).

### IAM grants (from SummarizationStack)

- `heediq-jobs`: ReadWrite
- `heediq-recordings`: ReadWrite
- `heediq-audio-uploads` bucket: Read (for `sourceType=audio` future path)
- Secrets Manager: `GetSecretValue` on `/heediq/summarization/*`

## Dependencies

- **Upstream**: `heediq-infra/SummarizationStack` (SQS queue, Lambda shell, IAM grants, env vars) — must be deployed first
- **Upstream**: `heediq-worker-transcription` — writes `heediq-recordings[recordingId].transcript`; summarization worker reads it
- **Downstream**: nothing yet (Jira/Confluence push is a future feature)
- **Shared**: `@heediq/shared` (SummarizationJobMessage schema, shared types)

## Testing

```bash
pnpm install
pnpm run test:pre-pr   # typecheck + unit tests (10 tests across 4 suites)
pnpm run test          # unit tests only
```

Tests mock at the module boundary (`content-loader`, `writer`, `provider`) — handler tests verify orchestration order, not DynamoDB internals. DynamoDB internals covered by `writer.test.ts` and `content-loader.test.ts`; Claude API mocked via `msw`.

## Gotchas & Constraints

- **`sourceType=text` → contentRef IS the recordingId** (not an S3 key). The field is named generically for the future `audio` path. Don't assume it's an S3 key for text jobs.
- **Claude API key fetched at cold start** — any Secrets Manager error on init fails all warm invocations until the next cold start. Rotate secrets carefully.
- **Module-level client caching** — `handler.ts` caches DynamoDB, S3, and provider instances at module level. Cold start pays the init cost once; warm invocations reuse. Tests must mock at the module boundary (not the SDK level) to avoid state leakage between tests.
- **Rethrows on error** — Lambda rethrows so SQS retries the message. After 3 attempts the message goes to `heediq-summarization-dlq`. The `failed` status write is best-effort before the rethrow.
- **No ECR / no ECS** — this is a plain Lambda zip deploy (`lambda update-function-code`), not an ECS Fargate job. No SSM image-tag promotion needed.
- **First deploy**: the Lambda placeholder (in `SummarizationStack`) must be deployed by CDK before CI can update function code. CI's `aws lambda update-function-code` will fail if the function doesn't exist yet.
- **`sourceType=audio` path** — S3 load is wired but untested beyond unit level. It is a future path for when transcript text is too large for DynamoDB item limits (~400KB).
