import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { S3Client } from '@aws-sdk/client-s3'
import type { SQSHandler } from 'aws-lambda'
import type { Tier } from '@heediq/shared'
import { SummarizationJobMessageSchema, createLogger } from '@heediq/shared'
import { loadConfig } from './config.js'
import { loadContent } from './content-loader.js'
import { ClaudeProvider } from './provider.js'
import { writeStatus, writeSummary } from './writer.js'

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
let cachedAudioBucket: string | undefined

async function getClients(tier: Tier) {
  if (!cachedDynamodb || !cachedS3 || !cachedApiKey) {
    const config = await loadConfig()
    cachedDynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: config.awsRegion }))
    cachedS3 = new S3Client({ region: config.awsRegion })
    cachedApiKey = config.claudeApiKey
    cachedJobsTable = config.jobsTable
    cachedSourcesTable = config.sourcesTable
    cachedAudioBucket = config.audioBucket
  }
  return {
    dynamodb: cachedDynamodb,
    s3: cachedS3,
    provider: new ClaudeProvider(cachedApiKey, MODELS[tier]),
    jobsTable: cachedJobsTable!,
    sourcesTable: cachedSourcesTable!,
    audioBucket: cachedAudioBucket!,
  }
}

export const handler: SQSHandler = async (event) => {
  // SummarizationStack wires batchSize=1; iterate defensively in case that ever changes
  for (const record of event.Records) {
    const msg = SummarizationJobMessageSchema.parse(JSON.parse(record.body))
    const { dynamodb, s3, provider, jobsTable, sourcesTable, audioBucket } = await getClients(msg.tier)

    logger.info('Summarization job started', { sourceId: msg.sourceId, jobId: msg.jobId, tier: msg.tier })

    // Tracked so a failure's log line names the stage it broke in — the D-085 dashboard's
    // job-stage funnel query relies on this rather than parsing error messages.
    let stage: 'loading_content' | 'extracting' | 'writing_summary' = 'loading_content'
    try {
      await writeStatus(msg.jobId, 'summarizing', dynamodb, jobsTable)

      const content = await loadContent(msg, sourcesTable, audioBucket, { dynamodb, s3 })
      stage = 'extracting'
      const extraction = await provider.extract(content)

      stage = 'writing_summary'
      await writeSummary(msg.sourceId, msg.orgId, extraction, dynamodb, sourcesTable)
      await writeStatus(msg.jobId, 'done', dynamodb, jobsTable)
      logger.info('Summarization job done', { sourceId: msg.sourceId, jobId: msg.jobId })
    } catch (err) {
      // Log job/source IDs only — never transcript text (D-038 PII rule); the logger's own
      // denylist also strips it if it were ever accidentally passed as metadata.
      logger.error('Summarization job failed', {
        sourceId: msg.sourceId,
        jobId: msg.jobId,
        stage,
        error: (err as Error).message,
      })
      await writeStatus(msg.jobId, 'failed', dynamodb, jobsTable).catch(() => undefined)
      throw err
    }
  }
}
