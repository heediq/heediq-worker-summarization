import { describe, it, expect, vi } from 'vitest'
import { loadExistingContexts } from '../context-loader.js'

const ORG = '00000000-0000-0000-0000-0000000000a1'
const USER = 'user-42'

describe('loadExistingContexts', () => {
  it('queries the by-scope GSI for both the org and personal scope keys', async () => {
    const dynamodb = { send: vi.fn().mockResolvedValue({ Items: [] }) } as any

    await loadExistingContexts(ORG, USER, 'heediq-contexts', dynamodb)

    const scopeKeys = dynamodb.send.mock.calls.map(
      (c: any[]) => c[0].input.ExpressionAttributeValues[':sk'],
    )
    expect(dynamodb.send.mock.calls[0][0].input.IndexName).toBe('by-scope')
    expect(scopeKeys).toContain(`O#${ORG}`)
    expect(scopeKeys).toContain(`U#${USER}`)
  })

  it('maps rows to name/desc/domain and skips archived or malformed ones', async () => {
    const dynamodb = {
      send: vi
        .fn()
        .mockResolvedValueOnce({
          Items: [
            { contextId: 'c1', name: 'Org project', domain: 'work', description: 'shared' },
            { contextId: 'c2', name: 'Archived', domain: 'work', status: 'archived' },
            { contextId: 'c3', name: 'Bad domain', domain: 'nonsense' },
          ],
        })
        .mockResolvedValueOnce({ Items: [{ contextId: 'c4', name: 'My notes', domain: 'personal' }] }),
    } as any

    const contexts = await loadExistingContexts(ORG, USER, 'heediq-contexts', dynamodb)

    expect(contexts.map((c) => c.contextId).sort()).toEqual(['c1', 'c4'])
    const c1 = contexts.find((c) => c.contextId === 'c1')!
    expect(c1).toEqual({ contextId: 'c1', name: 'Org project', domain: 'work', description: 'shared' })
  })

  it('follows pagination until LastEvaluatedKey is exhausted', async () => {
    // The two scope queries run concurrently (Promise.all), so key the mock off scopeKey +
    // cursor rather than call order. The org scope returns two pages; personal returns none.
    const dynamodb = {
      send: vi.fn().mockImplementation((cmd: any) => {
        const sk = cmd.input.ExpressionAttributeValues[':sk']
        const cursor = cmd.input.ExclusiveStartKey
        if (sk === `O#${ORG}` && !cursor) {
          return Promise.resolve({
            Items: [{ contextId: 'c1', name: 'A', domain: 'work' }],
            LastEvaluatedKey: { k: 1 },
          })
        }
        if (sk === `O#${ORG}`) {
          return Promise.resolve({ Items: [{ contextId: 'c2', name: 'B', domain: 'work' }] })
        }
        return Promise.resolve({ Items: [] })
      }),
    } as any

    const contexts = await loadExistingContexts(ORG, USER, 'heediq-contexts', dynamodb)

    expect(contexts.map((c) => c.contextId).sort()).toEqual(['c1', 'c2'])
  })
})
