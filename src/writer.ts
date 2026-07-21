import { randomUUID } from 'node:crypto'
import {
  DynamoDBDocumentClient,
  UpdateCommand,
  BatchWriteCommand,
} from '@aws-sdk/lib-dynamodb'
import {
  ExtractedItemSchema,
  ProposedClassificationSchema,
  type JobStatus,
  type SourceClassification,
} from '@heediq/shared'
import type { ClassifyExtractResult } from './provider.js'

const PENDING_REVIEW: SourceClassification = 'pending_review'
const BATCH_SIZE = 25 // DynamoDB BatchWriteItem hard limit

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

// Persist every proposed ExtractedItem to heediq-extracted-items (PK=sourceId, SK=itemId).
// No contextId yet — it's set on review approval (D-135); the by-context GSI is sparse until then.
// Returns the number of items written (for the caller's non-PII log line).
export async function writeExtractedItems(
  sourceId: string,
  orgId: string,
  result: ClassifyExtractResult,
  dynamodb: DynamoDBDocumentClient,
  extractedItemsTable: string,
): Promise<number> {
  const now = new Date().toISOString()
  const items = result.items.map((i) =>
    ExtractedItemSchema.parse({
      itemId: randomUUID(),
      sourceId,
      orgId,
      category: i.category,
      text: i.text,
      confidence: i.confidence,
      ...(i.sourceQuote ? { sourceQuote: i.sourceQuote } : {}),
      status: 'proposed',
      createdAt: now,
    }),
  )

  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const chunk = items.slice(i, i + BATCH_SIZE)
    await writeBatch(
      chunk.map((Item) => ({ PutRequest: { Item } })),
      dynamodb,
      extractedItemsTable,
    )
  }
  return items.length
}

// BatchWriteItem can throttle part of a batch and return the rest as UnprocessedItems — silently
// dropping them would lose extracted items. Retry the unprocessed remainder with exponential
// backoff until it drains (or we exhaust attempts, then throw so the SQS message retries).
async function writeBatch(
  requests: { PutRequest: { Item: Record<string, unknown> } }[],
  dynamodb: DynamoDBDocumentClient,
  table: string,
): Promise<void> {
  let pending = requests
  for (let attempt = 0; attempt < 5 && pending.length > 0; attempt++) {
    if (attempt > 0) await sleep(2 ** attempt * 25)
    const res = await dynamodb.send(
      new BatchWriteCommand({ RequestItems: { [table]: pending } }),
    )
    pending = (res.UnprocessedItems?.[table] ?? []) as typeof pending
  }
  if (pending.length > 0) {
    throw new Error(`BatchWrite left ${pending.length} unprocessed items after retries`)
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Update the Source row: the shrunk Summary (gist), the classifier's placement proposal, and the
// review-gate axis (D-133). Replaces the old flat requirements/decisions/openQuestions/actionItems
// arrays (D-132 → D-135) — those now live as ExtractedItems.
export async function writeSummaryAndClassification(
  sourceId: string,
  orgId: string,
  result: ClassifyExtractResult,
  dynamodb: DynamoDBDocumentClient,
  sourcesTable: string,
): Promise<void> {
  const proposedClassification = ProposedClassificationSchema.parse({
    ...(result.proposedContextId
      ? { proposedContextId: result.proposedContextId }
      : { newContextName: result.newContextName }),
    domain: result.domain,
    labels: result.labels,
    confidence: result.confidence,
  })

  // heediq-sources' key is composite: pk=orgId, sk=sourceId.
  await dynamodb.send(
    new UpdateCommand({
      TableName: sourcesTable,
      Key: { orgId, sourceId },
      UpdateExpression:
        'SET gist = :gist, classification = :cls, proposedClassification = :pc, updatedAt = :now ' +
        'REMOVE requirements, decisions, openQuestions, actionItems',
      ExpressionAttributeValues: {
        ':gist': result.gist,
        ':cls': PENDING_REVIEW,
        ':pc': proposedClassification,
        ':now': new Date().toISOString(),
      },
    }),
  )
}
