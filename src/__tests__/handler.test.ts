import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SQSEvent } from 'aws-lambda'

// Mock at the module boundary — test the handler's orchestration logic without touching
// DynamoDB/S3/Claude internals (those are covered by their own unit tests).
const mockLoadContent = vi.fn()
const mockLoadSourceUserId = vi.fn()
const mockLoadExistingContexts = vi.fn()
const mockClassifyExtract = vi.fn()
const mockWriteStatus = vi.fn()
const mockWriteExtractedItems = vi.fn()
const mockWriteSummaryAndClassification = vi.fn()

vi.mock('../config.js', () => ({
  loadConfig: vi.fn().mockResolvedValue({
    jobsTable: 'heediq-jobs',
    sourcesTable: 'heediq-sources',
    contextsTable: 'heediq-contexts',
    extractedItemsTable: 'heediq-extracted-items',
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
vi.mock('../content-loader.js', () => ({
  loadContent: mockLoadContent,
  loadSourceUserId: mockLoadSourceUserId,
}))
vi.mock('../context-loader.js', () => ({ loadExistingContexts: mockLoadExistingContexts }))
vi.mock('../provider.js', () => ({
  ClaudeProvider: vi
    .fn()
    .mockImplementation((_key: string, _model: string) => ({ classifyExtract: mockClassifyExtract })),
}))
vi.mock('../writer.js', () => ({
  writeStatus: mockWriteStatus,
  writeExtractedItems: mockWriteExtractedItems,
  writeSummaryAndClassification: mockWriteSummaryAndClassification,
}))

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
  sourceId: '00000000-0000-0000-0000-000000000002',
  orgId: '00000000-0000-0000-0000-000000000003',
  sourceType: 'text',
  contentRef: '00000000-0000-0000-0000-000000000002',
  tier: 'free',
}

const RESULT = {
  newContextName: 'A project',
  domain: 'work',
  labels: [],
  confidence: 0.9,
  gist: 'g',
  items: [{ category: 'requirements', text: 'r', confidence: 0.8 }],
}

beforeEach(() => {
  vi.clearAllMocks()
  mockLoadContent.mockResolvedValue('transcript text')
  mockLoadSourceUserId.mockResolvedValue('user-1')
  mockLoadExistingContexts.mockResolvedValue([])
  mockClassifyExtract.mockResolvedValue(RESULT)
  mockWriteStatus.mockResolvedValue(undefined)
  mockWriteExtractedItems.mockResolvedValue(1)
  mockWriteSummaryAndClassification.mockResolvedValue(undefined)
})

describe('handler', () => {
  it('runs summarizing → classify+extract → write items → write summary → done, in order', async () => {
    await handler(makeSQSEvent(VALID_MSG), {} as any, () => undefined)

    const statusCalls = mockWriteStatus.mock.calls.map((c) => c[1])
    expect(statusCalls[0]).toBe('summarizing')
    expect(statusCalls[statusCalls.length - 1]).toBe('done')

    // heediq-jobs has no jobId key attribute — writeStatus must be keyed by sourceId.
    const idArgs = mockWriteStatus.mock.calls.map((c) => c[0])
    expect(idArgs).toEqual(idArgs.map(() => VALID_MSG.sourceId))

    expect(mockClassifyExtract).toHaveBeenCalledWith({
      content: 'transcript text',
      existingContexts: [],
    })
    expect(mockLoadExistingContexts).toHaveBeenCalledWith(
      VALID_MSG.orgId,
      'user-1',
      'heediq-contexts',
      expect.anything(),
    )
    expect(mockWriteExtractedItems).toHaveBeenCalledOnce()
    expect(mockWriteSummaryAndClassification).toHaveBeenCalledOnce()
  })

  it('proceeds with no existing contexts when the contexts query fails (fail-soft)', async () => {
    mockLoadExistingContexts.mockRejectedValue(new Error('GSI throttled'))

    await handler(makeSQSEvent(VALID_MSG), {} as any, () => undefined)

    expect(mockClassifyExtract).toHaveBeenCalledWith({
      content: 'transcript text',
      existingContexts: [],
    })
    const statusCalls = mockWriteStatus.mock.calls.map((c) => c[1])
    expect(statusCalls[statusCalls.length - 1]).toBe('done')
  })

  it('writes failed status and rethrows when classify+extract fails', async () => {
    mockClassifyExtract.mockRejectedValue(new Error('Claude API down'))

    await expect(
      handler(makeSQSEvent(VALID_MSG), {} as any, () => undefined),
    ).rejects.toThrow('Claude API down')

    const statusCalls = mockWriteStatus.mock.calls.map((c) => c[1])
    expect(statusCalls).toContain('failed')
    expect(statusCalls).not.toContain('done')
    expect(mockWriteExtractedItems).not.toHaveBeenCalled()
  })

  it('throws (SQS retries) on invalid message body', async () => {
    await expect(
      handler(makeSQSEvent({ bad: 'payload' }), {} as any, () => undefined),
    ).rejects.toThrow()
    expect(mockWriteStatus).not.toHaveBeenCalled()
  })

  it('instantiates ClaudeProvider with haiku model for free tier', async () => {
    const { ClaudeProvider } = await import('../provider.js')
    await handler(makeSQSEvent({ ...VALID_MSG, tier: 'free' }), {} as any, () => undefined)
    expect(ClaudeProvider).toHaveBeenCalledWith(expect.any(String), 'claude-haiku-4-5-20251001')
  })

  it('instantiates ClaudeProvider with sonnet model for paid tier', async () => {
    const { ClaudeProvider } = await import('../provider.js')
    await handler(makeSQSEvent({ ...VALID_MSG, tier: 'paid' }), {} as any, () => undefined)
    expect(ClaudeProvider).toHaveBeenCalledWith(expect.any(String), 'claude-sonnet-4-6')
  })
})
