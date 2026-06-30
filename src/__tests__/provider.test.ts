import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { ClaudeProvider } from '../provider.js'

const EXTRACTION_RESPONSE = {
  requirements: ['The system must handle 1000 concurrent users'],
  decisions: ['Use DynamoDB for storage'],
  openQuestions: ['What is the SLA for uptime?'],
  actionItems: ['John to draft the API spec by Friday'],
}

const server = setupServer(
  http.post('https://api.anthropic.com/v1/messages', () =>
    HttpResponse.json({
      content: [{ type: 'text', text: JSON.stringify(EXTRACTION_RESPONSE) }],
      stop_reason: 'end_turn',
      model: 'claude-sonnet-4-6',
      id: 'msg_test',
      role: 'assistant',
      type: 'message',
      usage: { input_tokens: 10, output_tokens: 20 },
    }),
  ),
)

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('ClaudeProvider', () => {
  it('extracts structured fields from transcript text via Claude API', async () => {
    const provider = new ClaudeProvider('test-api-key')
    const result = await provider.extract('Meeting transcript content here.')

    expect(result.requirements).toEqual(EXTRACTION_RESPONSE.requirements)
    expect(result.decisions).toEqual(EXTRACTION_RESPONSE.decisions)
    expect(result.openQuestions).toEqual(EXTRACTION_RESPONSE.openQuestions)
    expect(result.actionItems).toEqual(EXTRACTION_RESPONSE.actionItems)
  })

  it('throws when Claude returns invalid JSON', async () => {
    server.use(
      http.post('https://api.anthropic.com/v1/messages', () =>
        HttpResponse.json({
          content: [{ type: 'text', text: 'not json' }],
          stop_reason: 'end_turn',
          model: 'claude-sonnet-4-6',
          id: 'msg_test',
          role: 'assistant',
          type: 'message',
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      ),
    )
    const provider = new ClaudeProvider('test-api-key')
    await expect(provider.extract('text')).rejects.toThrow()
  })
})
