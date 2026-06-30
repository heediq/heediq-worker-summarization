import { describe, it, expect, vi } from 'vitest'
import { loadContent } from '../content-loader.js'
import type { SummarizationJobMessage } from '@heediq/shared'

const BASE_MSG: SummarizationJobMessage = {
  jobId: '00000000-0000-0000-0000-000000000001',
  recordingId: '00000000-0000-0000-0000-000000000002',
  orgId: '00000000-0000-0000-0000-000000000003',
  sourceType: 'text',
  contentRef: '00000000-0000-0000-0000-000000000002',
}

function makeDynamoMock(transcript: string | undefined) {
  return {
    send: vi.fn().mockResolvedValue({ Item: transcript ? { recordingId: BASE_MSG.recordingId, transcript } : {} }),
  } as any
}

function makeS3Mock(body: string) {
  return {
    send: vi.fn().mockResolvedValue({ Body: { transformToString: () => Promise.resolve(body) } }),
  } as any
}

describe('loadContent', () => {
  it('reads transcript from DynamoDB when sourceType is text', async () => {
    const dynamodb = makeDynamoMock('hello world')
    const s3 = makeS3Mock('')

    const content = await loadContent(BASE_MSG, 'heediq-recordings', 'heediq-audio', { dynamodb, s3 })

    expect(content).toBe('hello world')
    expect(dynamodb.send).toHaveBeenCalledOnce()
    expect(s3.send).not.toHaveBeenCalled()
  })

  it('throws when DynamoDB item has no transcript', async () => {
    const dynamodb = makeDynamoMock(undefined)
    const s3 = makeS3Mock('')

    await expect(
      loadContent(BASE_MSG, 'heediq-recordings', 'heediq-audio', { dynamodb, s3 }),
    ).rejects.toThrow('No transcript found')
  })

  it('reads from S3 when sourceType is audio', async () => {
    const s3 = makeS3Mock('audio-derived-content')
    const dynamodb = makeDynamoMock(undefined)
    const msg: SummarizationJobMessage = { ...BASE_MSG, sourceType: 'audio', contentRef: 'orgs/o/r/audio.txt' }

    const content = await loadContent(msg, 'heediq-recordings', 'heediq-audio', { dynamodb, s3 })

    expect(content).toBe('audio-derived-content')
    expect(s3.send).toHaveBeenCalledOnce()
    expect(dynamodb.send).not.toHaveBeenCalled()
  })
})
