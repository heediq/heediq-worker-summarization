import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import type { JobStatus } from '@heediq/shared'
import type { ExtractionResult } from './provider.js'

export async function writeStatus(
  jobId: string,
  status: JobStatus,
  dynamodb: DynamoDBDocumentClient,
  jobsTable: string,
): Promise<void> {
  await dynamodb.send(
    new UpdateCommand({
      TableName: jobsTable,
      Key: { jobId },
      UpdateExpression: 'SET #status = :status, updatedAt = :now',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':status': status, ':now': new Date().toISOString() },
    }),
  )
}

export async function writeSummary(
  recordingId: string,
  orgId: string,
  extraction: ExtractionResult,
  dynamodb: DynamoDBDocumentClient,
  recordingsTable: string,
): Promise<void> {
  await dynamodb.send(
    new UpdateCommand({
      TableName: recordingsTable,
      Key: { recordingId },
      UpdateExpression:
        'SET orgId = :orgId, requirements = :req, decisions = :dec, openQuestions = :oq, actionItems = :ai, updatedAt = :now',
      ExpressionAttributeValues: {
        ':orgId': orgId,
        ':req': extraction.requirements,
        ':dec': extraction.decisions,
        ':oq': extraction.openQuestions,
        ':ai': extraction.actionItems,
        ':now': new Date().toISOString(),
      },
    }),
  )
}
