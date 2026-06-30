import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { S3Client } from '@aws-sdk/client-s3'
import type { SQSHandler } from 'aws-lambda'
import { SummarizationJobMessageSchema } from '@heediq/shared'
import { loadConfig } from './config.js'
import { loadContent } from './content-loader.js'
import { ClaudeProvider } from './provider.js'
import { writeStatus, writeSummary } from './writer.js'

// Config and clients are initialised once per cold start — not per invocation.
// loadConfig() fetches the Claude API key from Secrets Manager; subsequent invocations reuse it.
let cachedDynamodb: DynamoDBDocumentClient | undefined
let cachedS3: S3Client | undefined
let cachedProvider: ClaudeProvider | undefined
let cachedJobsTable: string | undefined
let cachedRecordingsTable: string | undefined
let cachedAudioBucket: string | undefined

async function getClients() {
  if (!cachedDynamodb || !cachedS3 || !cachedProvider) {
    const config = await loadConfig()
    cachedDynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: config.awsRegion }))
    cachedS3 = new S3Client({ region: config.awsRegion })
    cachedProvider = new ClaudeProvider(config.claudeApiKey)
    cachedJobsTable = config.jobsTable
    cachedRecordingsTable = config.recordingsTable
    cachedAudioBucket = config.audioBucket
  }
  return {
    dynamodb: cachedDynamodb,
    s3: cachedS3,
    provider: cachedProvider,
    jobsTable: cachedJobsTable!,
    recordingsTable: cachedRecordingsTable!,
    audioBucket: cachedAudioBucket!,
  }
}

export const handler: SQSHandler = async (event) => {
  const { dynamodb, s3, provider, jobsTable, recordingsTable, audioBucket } = await getClients()

  // SummarizationStack wires batchSize=1; iterate defensively in case that ever changes
  for (const record of event.Records) {
    const msg = SummarizationJobMessageSchema.parse(JSON.parse(record.body))

    try {
      await writeStatus(msg.jobId, 'summarizing', dynamodb, jobsTable)

      const content = await loadContent(msg, recordingsTable, audioBucket, { dynamodb, s3 })
      const extraction = await provider.extract(content)

      await writeSummary(msg.recordingId, msg.orgId, extraction, dynamodb, recordingsTable)
      await writeStatus(msg.jobId, 'done', dynamodb, jobsTable)
    } catch (err) {
      // Log job ID only — never transcript text (D-038 PII rule)
      console.error('Summarization failed for job', msg.jobId, (err as Error).message)
      await writeStatus(msg.jobId, 'failed', dynamodb, jobsTable).catch(() => undefined)
      throw err
    }
  }
}
