import { describe, it, expect, vi } from 'vitest'
import {
  writeStatus,
  writeExtractedItems,
  writeSummaryAndClassification,
} from '../writer.js'
import type { ClassifyExtractResult } from '../provider.js'

function makeDynamoMock() {
  return { send: vi.fn().mockResolvedValue({}) } as any
}

const ORG = '00000000-0000-0000-0000-0000000000a1'
const SRC = '00000000-0000-0000-0000-0000000000b2'
const CTX = '00000000-0000-0000-0000-0000000000c3'

const MATCHED: ClassifyExtractResult = {
  proposedContextId: CTX,
  domain: 'work',
  labels: ['auth'],
  confidence: 0.9,
  gist: 'A short gist.',
  items: [
    { category: 'requirements', text: 'Support SSO', confidence: 0.8, sourceQuote: 'need SSO' },
    { category: 'decisions', text: 'Use Cognito', confidence: 0.7 },
  ],
}

describe('writeStatus', () => {
  it('sends an UpdateCommand keyed by sourceId with the given status', async () => {
    const dynamodb = makeDynamoMock()
    await writeStatus(SRC, 'done', dynamodb, 'heediq-jobs')

    const cmd = dynamodb.send.mock.calls[0][0]
    expect(cmd.input.TableName).toBe('heediq-jobs')
    expect(cmd.input.Key).toEqual({ sourceId: SRC })
    expect(cmd.input.ExpressionAttributeValues[':status']).toBe('done')
  })
})

describe('writeExtractedItems', () => {
  it('batch-writes one PutRequest per item with provenance and proposed status', async () => {
    const dynamodb = makeDynamoMock()
    const count = await writeExtractedItems(SRC, ORG, MATCHED, dynamodb, 'heediq-extracted-items')

    expect(count).toBe(2)
    const cmd = dynamodb.send.mock.calls[0][0]
    const puts = cmd.input.RequestItems['heediq-extracted-items']
    expect(puts).toHaveLength(2)
    const first = puts[0].PutRequest.Item
    expect(first.sourceId).toBe(SRC)
    expect(first.orgId).toBe(ORG)
    expect(first.status).toBe('proposed')
    expect(first.contextId).toBeUndefined() // set on approval, not ingest
    expect(typeof first.itemId).toBe('string')
    expect(first.sourceQuote).toBe('need SSO')
  })

  it('chunks writes to DynamoDB\'s 25-item BatchWrite limit', async () => {
    const dynamodb = makeDynamoMock()
    const many: ClassifyExtractResult = {
      ...MATCHED,
      items: Array.from({ length: 30 }, (_, i) => ({
        category: 'requirements',
        text: `item ${i}`,
        confidence: 0.5,
      })),
    }
    const count = await writeExtractedItems(SRC, ORG, many, dynamodb, 'heediq-extracted-items')

    expect(count).toBe(30)
    expect(dynamodb.send).toHaveBeenCalledTimes(2) // 25 + 5
  })

  it('writes nothing to DynamoDB when there are no items', async () => {
    const dynamodb = makeDynamoMock()
    const count = await writeExtractedItems(SRC, ORG, { ...MATCHED, items: [] }, dynamodb, 't')

    expect(count).toBe(0)
    expect(dynamodb.send).not.toHaveBeenCalled()
  })

  it('retries UnprocessedItems until the batch drains', async () => {
    const dynamodb = {
      send: vi
        .fn()
        .mockResolvedValueOnce({
          UnprocessedItems: { 'heediq-extracted-items': [{ PutRequest: { Item: { itemId: 'x' } } }] },
        })
        .mockResolvedValueOnce({ UnprocessedItems: {} }),
    } as any

    await writeExtractedItems(SRC, ORG, MATCHED, dynamodb, 'heediq-extracted-items')

    expect(dynamodb.send).toHaveBeenCalledTimes(2) // initial + one retry of the remainder
  })

  it('throws when UnprocessedItems never drain (SQS will retry the job)', async () => {
    const dynamodb = {
      send: vi.fn().mockResolvedValue({
        UnprocessedItems: { 'heediq-extracted-items': [{ PutRequest: { Item: { itemId: 'x' } } }] },
      }),
    } as any

    await expect(
      writeExtractedItems(SRC, ORG, MATCHED, dynamodb, 'heediq-extracted-items'),
    ).rejects.toThrow('unprocessed items')
  })
})

describe('writeSummaryAndClassification', () => {
  it('sets gist, pending_review classification, and the proposal; removes the old flat arrays', async () => {
    const dynamodb = makeDynamoMock()
    await writeSummaryAndClassification(SRC, ORG, MATCHED, dynamodb, 'heediq-sources')

    const cmd = dynamodb.send.mock.calls[0][0]
    expect(cmd.input.TableName).toBe('heediq-sources')
    expect(cmd.input.Key).toEqual({ orgId: ORG, sourceId: SRC })
    expect(cmd.input.UpdateExpression).toContain('REMOVE requirements, decisions, openQuestions, actionItems')

    const vals = cmd.input.ExpressionAttributeValues
    expect(vals[':gist']).toBe('A short gist.')
    expect(vals[':cls']).toBe('pending_review')
    expect(vals[':pc'].proposedContextId).toBe(CTX)
    expect(vals[':pc'].newContextName).toBeUndefined()
    expect(vals[':pc'].domain).toBe('work')
  })

  it('persists newContextName (not proposedContextId) for a new-Context proposal', async () => {
    const dynamodb = makeDynamoMock()
    const proposal: ClassifyExtractResult = {
      newContextName: 'Fresh project',
      domain: 'study',
      labels: [],
      confidence: 0.8,
      gist: 'g',
      items: [],
    }
    await writeSummaryAndClassification(SRC, ORG, proposal, dynamodb, 'heediq-sources')

    const vals = dynamodb.send.mock.calls[0][0].input.ExpressionAttributeValues
    expect(vals[':pc'].newContextName).toBe('Fresh project')
    expect(vals[':pc'].proposedContextId).toBeUndefined()
  })
})
