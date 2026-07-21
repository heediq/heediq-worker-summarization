import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb'
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import type { SummarizationJobMessage } from '@heediq/shared'

export interface ContentLoaderClients {
  dynamodb: DynamoDBDocumentClient
  s3: S3Client
}

// When sourceType='text', contentRef is the sourceId (NOT an S3 key). The transcript was
// written to heediq-sources[sourceId].transcript by heediq-worker-transcription, which
// has no S3 write grant on its task role.
export async function loadContent(
  msg: SummarizationJobMessage,
  sourcesTable: string,
  audioBucket: string,
  clients: ContentLoaderClients,
): Promise<string> {
  if (msg.sourceType === 'text') {
    return loadFromDynamoDB(msg.contentRef, msg.orgId, sourcesTable, clients.dynamodb)
  }
  return loadFromS3(msg.contentRef, audioBucket, clients.s3)
}

// The classifier scopes its "existing Contexts" query by the uploader's userId, which isn't on the
// SQS message (only orgId is) — read it off the Source row. One GetCommand on heediq-sources.
export async function loadSourceUserId(
  sourceId: string,
  orgId: string,
  sourcesTable: string,
  dynamodb: DynamoDBDocumentClient,
): Promise<string> {
  const result = await dynamodb.send(
    new GetCommand({
      TableName: sourcesTable,
      Key: { orgId, sourceId },
      ProjectionExpression: 'userId',
    }),
  )
  const userId = result.Item?.['userId'] as string | undefined
  if (!userId) throw new Error(`No userId found for sourceId=${sourceId}`)
  return userId
}

async function loadFromDynamoDB(
  sourceId: string,
  orgId: string,
  sourcesTable: string,
  dynamodb: DynamoDBDocumentClient,
): Promise<string> {
  // heediq-sources' key is composite: pk=orgId, sk=sourceId.
  const result = await dynamodb.send(
    new GetCommand({ TableName: sourcesTable, Key: { orgId, sourceId } }),
  )
  const transcript = result.Item?.['transcript'] as string | undefined
  if (!transcript) throw new Error(`No transcript found for sourceId=${sourceId}`)
  return transcript
}

async function loadFromS3(
  s3Key: string,
  bucket: string,
  s3: S3Client,
): Promise<string> {
  const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: s3Key }))
  if (!result.Body) throw new Error(`Empty S3 object: ${s3Key}`)
  return result.Body.transformToString()
}
