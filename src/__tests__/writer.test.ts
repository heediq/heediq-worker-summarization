import { describe, it, expect, vi } from 'vitest'
import { writeStatus, writeSummary } from '../writer.js'
import type { ExtractionResult } from '../provider.js'

function makeDynamoMock() {
  return { send: vi.fn().mockResolvedValue({}) } as any
}

const EXTRACTION: ExtractionResult = {
  requirements: ['req-1'],
  decisions: ['dec-1'],
  openQuestions: ['oq-1'],
  actionItems: ['ai-1'],
}

describe('writeStatus', () => {
  it('sends an UpdateCommand with the given status', async () => {
    const dynamodb = makeDynamoMock()
    await writeStatus('job-1', 'done', dynamodb, 'heediq-jobs')

    expect(dynamodb.send).toHaveBeenCalledOnce()
    const cmd = dynamodb.send.mock.calls[0][0]
    expect(cmd.input.TableName).toBe('heediq-jobs')
    expect(cmd.input.ExpressionAttributeValues[':status']).toBe('done')
  })
})

describe('writeSummary', () => {
  it('writes all four extraction fields to the sources table', async () => {
    const dynamodb = makeDynamoMock()
    await writeSummary('src-1', 'org-1', EXTRACTION, dynamodb, 'heediq-sources')

    const cmd = dynamodb.send.mock.calls[0][0]
    expect(cmd.input.TableName).toBe('heediq-sources')
    const vals = cmd.input.ExpressionAttributeValues
    expect(vals[':req']).toEqual(['req-1'])
    expect(vals[':dec']).toEqual(['dec-1'])
    expect(vals[':oq']).toEqual(['oq-1'])
    expect(vals[':ai']).toEqual(['ai-1'])
    expect(vals[':orgId']).toBe('org-1')
  })
})
