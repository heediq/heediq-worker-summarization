import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import type { JobStatus } from '@heediq/shared'
import type { ExtractionResult } from './provider.js'

export async function writeStatus(
  sourceId: string,
  status: JobStatus,
  dynamodb: DynamoDBDocumentClient,
  jobsTable: string,
): Promise<void> {
  // heediq-jobs' only key attribute is sourceId (no jobId sort key) — jobId is a plain item attribute.
  await dynamodb.send(
    new UpdateCommand({
      TableName: jobsTable,
      Key: { sourceId },
      UpdateExpression: 'SET #status = :status, updatedAt = :now',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':status': status, ':now': new Date().toISOString() },
    }),
  )
}

export async function writeSummary(
  sourceId: string,
  orgId: string,
  extraction: ExtractionResult,
  dynamodb: DynamoDBDocumentClient,
  sourcesTable: string,
): Promise<void> {
  // heediq-sources' key is composite: pk=orgId, sk=sourceId.
  await dynamodb.send(
    new UpdateCommand({
      TableName: sourcesTable,
      Key: { orgId, sourceId },
      UpdateExpression:
        'SET requirements = :req, decisions = :dec, openQuestions = :oq, actionItems = :ai, updatedAt = :now',
      ExpressionAttributeValues: {
        ':req': extraction.requirements,
        ':dec': extraction.decisions,
        ':oq': extraction.openQuestions,
        ':ai': extraction.actionItems,
        ':now': new Date().toISOString(),
      },
    }),
  )
}
