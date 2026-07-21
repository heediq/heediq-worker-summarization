import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { S3Client } from '@aws-sdk/client-s3'
import type { SQSHandler } from 'aws-lambda'
import type { Tier } from '@heediq/shared'
import { SummarizationJobMessageSchema, createLogger } from '@heediq/shared'
import { loadConfig } from './config.js'
import { loadContent, loadSourceUserId } from './content-loader.js'
import { loadExistingContexts } from './context-loader.js'
import { ClaudeProvider } from './provider.js'
import { writeStatus, writeExtractedItems, writeSummaryAndClassification } from './writer.js'

const MODELS: Record<Tier, string> = {
  free: 'claude-haiku-4-5-20251001',
  paid: 'claude-sonnet-4-6',
}

const logger = createLogger('heediq-worker-summarization')

// Config and clients are initialised once per cold start — not per invocation.
// loadConfig() fetches the Claude API key from Secrets Manager; subsequent invocations reuse it.
let cachedDynamodb: DynamoDBDocumentClient | undefined
let cachedS3: S3Client | undefined
let cachedApiKey: string | undefined
let cachedJobsTable: string | undefined
let cachedSourcesTable: string | undefined
let cachedContextsTable: string | undefined
let cachedExtractedItemsTable: string | undefined
let cachedAudioBucket: string | undefined

async function getClients(tier: Tier) {
  if (!cachedDynamodb || !cachedS3 || !cachedApiKey) {
    const config = await loadConfig()
    cachedDynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: config.awsRegion }))
    cachedS3 = new S3Client({ region: config.awsRegion })
    cachedApiKey = config.claudeApiKey
    cachedJobsTable = config.jobsTable
    cachedSourcesTable = config.sourcesTable
    cachedContextsTable = config.contextsTable
    cachedExtractedItemsTable = config.extractedItemsTable
    cachedAudioBucket = config.audioBucket
  }
  return {
    dynamodb: cachedDynamodb,
    s3: cachedS3,
    provider: new ClaudeProvider(cachedApiKey, MODELS[tier]),
    jobsTable: cachedJobsTable!,
    sourcesTable: cachedSourcesTable!,
    contextsTable: cachedContextsTable!,
    extractedItemsTable: cachedExtractedItemsTable!,
    audioBucket: cachedAudioBucket!,
  }
}

export const handler: SQSHandler = async (event) => {
  // SummarizationStack wires batchSize=1; iterate defensively in case that ever changes
  for (const record of event.Records) {
    const msg = SummarizationJobMessageSchema.parse(JSON.parse(record.body))
    const clients = await getClients(msg.tier)
    const { dynamodb, s3, provider } = clients

    logger.info('Summarization job started', { sourceId: msg.sourceId, jobId: msg.jobId, tier: msg.tier })

    // Tracked so a failure's log line names the stage it broke in — the D-085 dashboard's
    // job-stage funnel query relies on this rather than parsing error messages.
    let stage: 'loading_content' | 'classifying_extracting' | 'writing_results' = 'loading_content'
    try {
      await writeStatus(msg.sourceId, 'summarizing', dynamodb, clients.jobsTable)

      const content = await loadContent(msg, clients.sourcesTable, clients.audioBucket, { dynamodb, s3 })
      const userId = await loadSourceUserId(msg.sourceId, msg.orgId, clients.sourcesTable, dynamodb)

      // Fail-soft: a Contexts read hiccup must not fail the whole ingest — the classifier still
      // extracts and proposes a new Context, and full Source content is never lost (D-135). The
      // Contexts table is also legitimately empty until the API step ships Context creation.
      const existingContexts = await loadExistingContexts(
        msg.orgId,
        userId,
        clients.contextsTable,
        dynamodb,
      ).catch((err: unknown) => {
        logger.warn('Failed to load existing contexts; proceeding with none', {
          sourceId: msg.sourceId,
          jobId: msg.jobId,
          error: (err as Error).message,
        })
        return []
      })

      stage = 'classifying_extracting'
      const result = await provider.classifyExtract({ content, existingContexts })

      stage = 'writing_results'
      const itemCount = await writeExtractedItems(
        msg.sourceId,
        msg.orgId,
        result,
        dynamodb,
        clients.extractedItemsTable,
      )
      // Sets classification='pending_review' on the Source — the trigger the heediq-api
      // classification-pusher turns into a `classification_ready` WS event (D-133).
      await writeSummaryAndClassification(msg.sourceId, msg.orgId, result, dynamodb, clients.sourcesTable)
      await writeStatus(msg.sourceId, 'done', dynamodb, clients.jobsTable)

      logger.info('Summarization job done', {
        sourceId: msg.sourceId,
        jobId: msg.jobId,
        proposedDomain: result.domain,
        confidence: result.confidence,
        itemCount,
      })
    } catch (err) {
      // Log job/source IDs only — never transcript text (D-038 PII rule); the logger's own
      // denylist also strips it if it were ever accidentally passed as metadata.
      logger.error('Summarization job failed', {
        sourceId: msg.sourceId,
        jobId: msg.jobId,
        stage,
        error: (err as Error).message,
      })
      await writeStatus(msg.sourceId, 'failed', dynamodb, clients.jobsTable).catch(() => undefined)
      throw err
    }
  }
}
