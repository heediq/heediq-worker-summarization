import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SQSEvent } from 'aws-lambda'

// Mock at the module boundary — test the handler's orchestration logic without touching
// DynamoDB/S3/Claude internals (those are covered by their own unit tests).
const mockLoadContent = vi.fn()
const mockExtract = vi.fn()
const mockWriteStatus = vi.fn()
const mockWriteSummary = vi.fn()

vi.mock('../config.js', () => ({
  loadConfig: vi.fn().mockResolvedValue({
    jobsTable: 'heediq-jobs',
    recordingsTable: 'heediq-recordings',
    audioBucket: 'heediq-audio',
    claudeApiKey: 'test-key',
    awsRegion: 'eu-west-1',
  }),
}))
vi.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: vi.fn().mockReturnValue({}) }))
vi.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: vi.fn().mockReturnValue({}) },
}))
vi.mock('@aws-sdk/client-s3', () => ({ S3Client: vi.fn().mockReturnValue({}) }))
vi.mock('../content-loader.js', () => ({ loadContent: mockLoadContent }))
vi.mock('../provider.js', () => ({
  ClaudeProvider: vi.fn().mockImplementation(() => ({ extract: mockExtract })),
}))
vi.mock('../writer.js', () => ({ writeStatus: mockWriteStatus, writeSummary: mockWriteSummary }))

const { handler } = await import('../handler.js')

function makeSQSEvent(body: object): SQSEvent {
  return {
    Records: [
      {
        messageId: 'test-id',
        receiptHandle: 'test-receipt',
        body: JSON.stringify(body),
        attributes: {} as any,
        messageAttributes: {},
        md5OfBody: '',
        eventSource: 'aws:sqs',
        eventSourceARN: 'arn:aws:sqs:eu-west-1:123:heediq-summarization',
        awsRegion: 'eu-west-1',
      },
    ],
  }
}

const VALID_MSG = {
  jobId: '00000000-0000-0000-0000-000000000001',
  recordingId: '00000000-0000-0000-0000-000000000002',
  orgId: '00000000-0000-0000-0000-000000000003',
  sourceType: 'text',
  contentRef: '00000000-0000-0000-0000-000000000002',
}

beforeEach(() => {
  vi.clearAllMocks()
  mockLoadContent.mockResolvedValue('transcript text')
  mockExtract.mockResolvedValue({
    requirements: ['req-1'],
    decisions: ['dec-1'],
    openQuestions: [],
    actionItems: [],
  })
  mockWriteStatus.mockResolvedValue(undefined)
  mockWriteSummary.mockResolvedValue(undefined)
})

describe('handler', () => {
  it('writes summarizing status, extracts, writes summary, then done in order', async () => {
    await handler(makeSQSEvent(VALID_MSG), {} as any, () => undefined)

    const statusCalls = mockWriteStatus.mock.calls.map((c) => c[1])
    expect(statusCalls[0]).toBe('summarizing')
    expect(statusCalls[statusCalls.length - 1]).toBe('done')

    expect(mockLoadContent).toHaveBeenCalledOnce()
    expect(mockExtract).toHaveBeenCalledWith('transcript text')
    expect(mockWriteSummary).toHaveBeenCalledOnce()
  })

  it('writes failed status and rethrows when extraction fails', async () => {
    mockExtract.mockRejectedValue(new Error('Claude API down'))

    await expect(
      handler(makeSQSEvent(VALID_MSG), {} as any, () => undefined),
    ).rejects.toThrow('Claude API down')

    const statusCalls = mockWriteStatus.mock.calls.map((c) => c[1])
    expect(statusCalls).toContain('failed')
    expect(statusCalls).not.toContain('done')
  })

  it('throws (SQS retries) on invalid message body', async () => {
    await expect(
      handler(makeSQSEvent({ bad: 'payload' }), {} as any, () => undefined),
    ).rejects.toThrow()
    expect(mockWriteStatus).not.toHaveBeenCalled()
  })
})
