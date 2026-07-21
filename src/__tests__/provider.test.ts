import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { ClaudeProvider, shapeResult, type ExistingContext } from '../provider.js'

const CTX_ID = '00000000-0000-0000-0000-0000000000c1'

function claudeJson(body: object) {
  return HttpResponse.json({
    content: [{ type: 'text', text: JSON.stringify(body) }],
    stop_reason: 'end_turn',
    model: 'claude-sonnet-4-6',
    id: 'msg_test',
    role: 'assistant',
    type: 'message',
    usage: { input_tokens: 10, output_tokens: 20 },
  })
}

const server = setupServer(
  http.post('https://api.anthropic.com/v1/messages', () =>
    claudeJson({
      proposedContextId: CTX_ID,
      newContextName: 'Auth revamp',
      domain: 'work',
      labels: ['auth', 'security'],
      confidence: 0.92,
      gist: 'A meeting about the auth revamp.',
      items: [
        { category: 'requirements', text: 'Support SSO', confidence: 0.8, sourceQuote: 'we need SSO' },
        { category: 'decisions', text: 'Use Cognito', confidence: 0.7 },
        { category: 'bogus', text: 'should be dropped', confidence: 0.5 },
      ],
    }),
  ),
)

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const EXISTING: ExistingContext[] = [{ contextId: CTX_ID, name: 'Auth revamp', domain: 'work' }]

describe('ClaudeProvider.classifyExtract', () => {
  it('returns placement, gist, and items in the chosen domain shape', async () => {
    const provider = new ClaudeProvider('test-api-key', 'claude-sonnet-4-6')
    const result = await provider.classifyExtract({ content: 'transcript', existingContexts: EXISTING })

    expect(result.proposedContextId).toBe(CTX_ID)
    expect(result.newContextName).toBeUndefined()
    expect(result.domain).toBe('work')
    expect(result.gist).toBe('A meeting about the auth revamp.')
    // 'bogus' is not a `work` extraction category, so it is dropped.
    expect(result.items.map((i) => i.category)).toEqual(['requirements', 'decisions'])
    expect(result.items[0].sourceQuote).toBe('we need SSO')
  })

  it('throws when Claude returns non-JSON text', async () => {
    server.use(
      http.post('https://api.anthropic.com/v1/messages', () =>
        HttpResponse.json({
          content: [{ type: 'text', text: 'not json at all' }],
          stop_reason: 'end_turn',
          model: 'x',
          id: 'm',
          role: 'assistant',
          type: 'message',
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      ),
    )
    const provider = new ClaudeProvider('test-api-key', 'claude-haiku-4-5-20251001')
    await expect(provider.classifyExtract({ content: 'x', existingContexts: [] })).rejects.toThrow()
  })
})

describe('shapeResult (invariant enforcement)', () => {
  const rawBase = {
    proposedContextId: CTX_ID,
    newContextName: 'Auth revamp',
    domain: 'work' as const,
    labels: ['auth'],
    confidence: 0.92,
    gist: 'gist',
    items: [
      { category: 'requirements', text: 'r', confidence: 0.8 },
      { category: 'notes', text: 'n', confidence: 0.6 },
    ],
  }

  it('keeps a matched Context id only when it is known and confidence is high', () => {
    const result = shapeResult(rawBase, EXISTING)
    expect(result.proposedContextId).toBe(CTX_ID)
    expect(result.newContextName).toBeUndefined()
    // 'notes' is not a `work` category → dropped; only 'requirements' survives.
    expect(result.items.map((i) => i.category)).toEqual(['requirements'])
  })

  it('falls back to domain "other" and a new-name proposal below the confidence threshold', () => {
    const result = shapeResult({ ...rawBase, confidence: 0.4 }, EXISTING)
    expect(result.domain).toBe('other')
    expect(result.proposedContextId).toBeUndefined()
    expect(result.newContextName).toBe('Auth revamp')
    // Now 'notes' IS a valid `other` category and 'requirements' is not.
    expect(result.items.map((i) => i.category)).toEqual(['notes'])
  })

  it('proposes a new Context when the matched id is unknown', () => {
    const result = shapeResult({ ...rawBase, proposedContextId: 'not-a-known-id' }, EXISTING)
    expect(result.proposedContextId).toBeUndefined()
    expect(result.newContextName).toBe('Auth revamp')
  })
})
