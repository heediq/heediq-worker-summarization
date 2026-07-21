# heediq-worker-summarization

## Purpose

Node.js Lambda worker that reads a completed Source's transcript and, in **one Claude call**,
**classifies** it (which Context Library Domain + which Context it belongs to) *and* **extracts**
structured items in that Domain's shape (D-130). It writes the extracted items to
`heediq-extracted-items`, a short prose `gist` + the classifier's placement proposal onto the Source,
and flags the Source `classification: pending_review` for the interactive review wizard. Deployed by
CI (`aws lambda update-function-code`) — infra shell is a placeholder in `heediq-infra/SummarizationStack`.

## Key Files

- `src/handler.ts` — SQS handler entry point; orchestrates load → classify+extract → write
- `src/lambda.ts` — Lambda entrypoint re-export
- `src/config.ts` — loads runtime config; fetches Claude API key from Secrets Manager at cold start
- `src/content-loader.ts` — `loadContent` (transcript from DynamoDB text / S3 audio) + `loadSourceUserId` (off the Source row, to scope the Contexts query)
- `src/context-loader.ts` — `loadExistingContexts`: reads the uploader's candidate Contexts via the `heediq-contexts` `by-scope` GSI (org + personal scope), fed to the classifier (D-130/D-141)
- `src/provider.ts` — `ExtractionProvider` interface + `ClaudeProvider.classifyExtract` (combined classify+extract, D-032/D-130); `shapeResult` enforces the `other` fallback + category validity
- `src/writer.ts` — DynamoDB writes: `writeStatus` (jobs), `writeExtractedItems` (batch → extracted-items, with UnprocessedItems retry), `writeSummaryAndClassification` (gist + proposal + `pending_review` on the Source)
- `.github/workflows/ci.yml` — PR gate: typecheck + unit tests
- `.github/workflows/deploy.yml` — push gate: test → esbuild bundle → `lambda update-function-code` per environment

## Data Flow

```
SQS heediq-summarization (batchSize=1)
  │  SummarizationJobMessage { jobId, sourceId, orgId, sourceType, contentRef, tier }
  ▼
Lambda handler
  ├── writeStatus(sourceId, 'summarizing')          → heediq-jobs table, keyed by sourceId
  ├── loadContent(msg) →
  │     sourceType='text': GET heediq-sources[orgId, sourceId].transcript (contentRef IS sourceId)
  │     sourceType='audio': S3 GetObject(contentRef)                (future path)
  ├── loadSourceUserId(orgId, sourceId)             → heediq-sources (uploader's userId)
  ├── loadExistingContexts(orgId, userId)           → heediq-contexts by-scope GSI (O#org + U#user)
  │       (fail-soft: on error, log warn + proceed with none — never fails the job)
  ├── ClaudeProvider.classifyExtract({content, existingContexts})
  │       → { proposedContextId|newContextName, domain, labels[], confidence, gist, items[] }
  │       free: claude-haiku-4-5-20251001 · paid: claude-sonnet-4-6 (D-067)
  │       confidence < 0.75 → domain 'other'; items with an invalid category for the final domain dropped
  ├── writeExtractedItems(...)                       → heediq-extracted-items (PK sourceId, SK itemId), status 'proposed'
  ├── writeSummaryAndClassification(...)             → heediq-sources: SET gist, classification='pending_review',
  │                                                     proposedClassification; REMOVE old flat arrays
  │       (classification='pending_review' is the trigger the heediq-api classification-pusher turns
  │        into a `classification_ready` WS event via the heediq-sources DDB stream — D-133/D-109)
  └── writeStatus(sourceId, 'done')                  → heediq-jobs table
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

### DynamoDB reads & writes

- `heediq-jobs` (RW): `Key: { sourceId }` — `{ sourceId, jobId, status, updatedAt }` — status transitions `summarizing → done | failed`
- `heediq-sources` (RW): `Key: { orgId, sourceId }` (pk=orgId, sk=sourceId) — reads `transcript` + `userId`; writes `gist`, `classification='pending_review'`, `proposedClassification`, `updatedAt`, and **REMOVEs** the superseded flat `requirements/decisions/openQuestions/actionItems` arrays (D-132 → D-135)
- `heediq-extracted-items` (W): `Key: { sourceId, itemId }` — one `ExtractedItem` per proposed statement, `status: 'proposed'`, no `contextId` yet (set on approval). Written via `BatchWriteItem` (25/batch) with UnprocessedItems retry
- `heediq-contexts` (R, via `by-scope` GSI): candidate Contexts for the classifier — queried at `O#<orgId>` + `U#<userId>` (D-141)

### Environment variables (CDK-injected, D-038)

| Var | Source |
|---|---|
| `JOBS_TABLE_NAME` | DynamoDB table name (CDK-injected) |
| `SOURCES_TABLE_NAME` | DynamoDB table name (CDK-injected) |
| `CONTEXTS_TABLE_NAME` | DynamoDB table name (CDK-injected) |
| `EXTRACTED_ITEMS_TABLE_NAME` | DynamoDB table name (CDK-injected) |
| `AUDIO_BUCKET_NAME` | S3 bucket name (CDK-injected) |
| `CLAUDE_SECRET_NAME` | Hardcoded to `/heediq/summarization/anthropic-api-key` by CDK |
| `AWS_REGION` | Injected automatically by Lambda runtime |

Claude API key is fetched from Secrets Manager at cold start — never passed as an env var in plaintext (D-038).

### IAM grants (from SummarizationStack)

- `heediq-jobs`: ReadWrite
- `heediq-sources`: ReadWrite
- `heediq-extracted-items`: Write
- `heediq-contexts` (+ its `by-scope` GSI): Read
- `heediq-audio-uploads` bucket: Read (for `sourceType=audio` future path)
- Secrets Manager: `GetSecretValue` on `/heediq/summarization/*`

## Dependencies

- **Upstream**: `heediq-infra/SummarizationStack` (SQS queue, Lambda shell, IAM grants, env vars) — must be deployed first
- **Upstream**: `heediq-worker-transcription` — writes `heediq-sources[sourceId].transcript`; summarization worker reads it
- **Downstream**: nothing yet (Jira/Confluence push is a future feature)
- **Downstream (new)**: `heediq-api` classification-pusher (reads the `classification='pending_review'` write off the `heediq-sources` DDB stream to emit `classification_ready`); the review-wizard UI (Step 5) reads `heediq-extracted-items` + the Source's `proposedClassification`
- **Shared**: `@heediq/shared` (SummarizationJobMessage, Context Library contracts, shared types) — pinned to `^0.14.0` (Context/ExtractedItem/ProposedClassification schemas, `DOMAIN_PROFILES`, `DOMAIN_FIT_CONFIDENCE_THRESHOLD`). Renovate (D-048) keeps this pin current; bump only when a published change is actually consumed here.

## Testing

```bash
pnpm install
pnpm run test:pre-pr   # typecheck + unit tests (28 tests across 5 suites)
pnpm run test          # unit tests only
```

Tests mock at the module boundary (`content-loader`, `context-loader`, `writer`, `provider`) — handler tests verify orchestration order (incl. the fail-soft contexts load), not DynamoDB internals. DynamoDB internals covered by `writer.test.ts`, `content-loader.test.ts`, `context-loader.test.ts`; the classify+extract shaping (`other` fallback, category validity, exactly-one placement) covered by `provider.test.ts`; Claude API mocked via `msw`.

## Gotchas & Constraints

- **`sourceType=text` → contentRef IS the sourceId** (not an S3 key). The field is named generically for the future `audio` path. Don't assume it's an S3 key for text jobs.
- **Claude API key fetched at cold start** — any Secrets Manager error on init fails all warm invocations until the next cold start. Rotate secrets carefully.
- **Module-level client caching** — `handler.ts` caches DynamoDB, S3, and provider instances at module level. Cold start pays the init cost once; warm invocations reuse. Tests must mock at the module boundary (not the SDK level) to avoid state leakage between tests.
- **First deploy**: the Lambda placeholder (in `SummarizationStack`) must be deployed by CDK before CI can update function code. CI's `aws lambda update-function-code` will fail if the function doesn't exist yet. See `heediq-infra/README.md` §"Initial Setup" for the full account/CDK-bootstrap prerequisites.
- **`@heediq/shared` install:** CI uses `NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}` to pull from GitHub Packages. Local dev requires a GitHub PAT with `read:packages` scope set as `NODE_AUTH_TOKEN` — add `//npm.pkg.github.com/:_authToken=<PAT>` to `~/.npmrc` or export the var before running `pnpm install`.
- **`sourceType=audio` path** — S3 load is wired but untested beyond unit level. It is a future path for when transcript text is too large for DynamoDB item limits (~400KB).
- **Category validity is enforced here, not by the schema (D-135).** An `ExtractedItem` carries no Domain (its Context does), so `ExtractedItemSchema` can't check `category`. `shapeResult` drops any item whose `category` isn't in the final Domain's `DOMAIN_PROFILES[domain].extractionFields`. Low domain-fit confidence (`< DOMAIN_FIT_CONFIDENCE_THRESHOLD`) coerces the domain to `other` *before* that filter — so items must be extracted in `other`'s shape when unsure, or they're dropped (the prompt instructs the model accordingly). Full Source content is always retained, so this is never lossy — dropped items just don't pre-populate the review wizard.
- **Existing-Contexts load is fail-soft, and group-scoped Contexts are not queried.** `loadExistingContexts` queries only `O#<orgId>` + `U#<userId>` on the `by-scope` GSI — group (`G#<groupId>`) Contexts need the RBAC group-membership lookup and are deferred. A read failure logs a warn and proceeds with none (never fails the job). Both degrade the same way: a missed candidate becomes a `newContextName` proposal the user re-places in the wizard. The Contexts table is also legitimately empty until the API step ships Context creation.
- **The worker does not push WS.** It sets `classification='pending_review'` on the Source; a DDB stream on `heediq-sources` → the `classification-pusher` Lambda in `heediq-api` emits `classification_ready` (D-109/D-133). Workers never call `PostToConnection` directly — same pattern as `job_status` via the jobs-table stream.
- **Structured logging (D-085/D-093):** `handler.ts` logs job start/done and failures via `@heediq/shared`'s `createLogger('heediq-worker-summarization')` — structured JSON correlated by `sourceId`/`jobId`. Raw `console.log`/`console.error` is disallowed (D-093) — always go through the logger. Default log level is `info` in every environment; `debug` is opt-in via the `LOG_LEVEL` env var, read at runtime with no redeploy needed. The logger's own PII denylist redacts transcript/email/token-like metadata. X-Ray active tracing is enabled on the Lambda (`heediq-infra` `SummarizationStack`, D-085).
