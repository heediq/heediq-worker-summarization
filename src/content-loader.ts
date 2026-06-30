import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb'
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import type { SummarizationJobMessage } from '@heediq/shared'

export interface ContentLoaderClients {
  dynamodb: DynamoDBDocumentClient
  s3: S3Client
}

// When sourceType='text', contentRef is the recordingId (NOT an S3 key). The transcript was
// written to heediq-recordings[recordingId].transcript by heediq-worker-transcription, which
// has no S3 write grant on its task role.
export async function loadContent(
  msg: SummarizationJobMessage,
  recordingsTable: string,
  audioBucket: string,
  clients: ContentLoaderClients,
): Promise<string> {
  if (msg.sourceType === 'text') {
    return loadFromDynamoDB(msg.contentRef, recordingsTable, clients.dynamodb)
  }
  return loadFromS3(msg.contentRef, audioBucket, clients.s3)
}

async function loadFromDynamoDB(
  recordingId: string,
  recordingsTable: string,
  dynamodb: DynamoDBDocumentClient,
): Promise<string> {
  const result = await dynamodb.send(
    new GetCommand({ TableName: recordingsTable, Key: { recordingId } }),
  )
  const transcript = result.Item?.['transcript'] as string | undefined
  if (!transcript) throw new Error(`No transcript found for recordingId=${recordingId}`)
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
