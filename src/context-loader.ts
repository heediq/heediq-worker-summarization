import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb'
import { DomainSchema } from '@heediq/shared'
import type { ExistingContext } from './provider.js'

// Contexts the classifier may file this Source into (D-130). We query the `heediq-contexts`
// `by-scope` GSI for the two scopes the uploader can always see: their org-shared Contexts
// (`O#<orgId>`) and their own personal Contexts (`U#<userId>`) (D-141). Group-scoped Contexts
// (`G#<groupId>`) are intentionally NOT queried here — resolving the uploader's group membership
// needs the RBAC group lookup and is deferred to a follow-up; the classifier degrades gracefully
// (a missed candidate just becomes a `newContextName` proposal the user re-places in the wizard).
const BY_SCOPE_INDEX = 'by-scope'

export async function loadExistingContexts(
  orgId: string,
  userId: string,
  contextsTable: string,
  dynamodb: DynamoDBDocumentClient,
): Promise<ExistingContext[]> {
  const scopeKeys = [`O#${orgId}`, `U#${userId}`]
  const results = await Promise.all(
    scopeKeys.map((scopeKey) => queryByScope(scopeKey, contextsTable, dynamodb)),
  )
  return results.flat()
}

async function queryByScope(
  scopeKey: string,
  contextsTable: string,
  dynamodb: DynamoDBDocumentClient,
): Promise<ExistingContext[]> {
  const contexts: ExistingContext[] = []
  let lastKey: Record<string, unknown> | undefined

  do {
    const result = await dynamodb.send(
      new QueryCommand({
        TableName: contextsTable,
        IndexName: BY_SCOPE_INDEX,
        KeyConditionExpression: 'scopeKey = :sk',
        ExpressionAttributeValues: { ':sk': scopeKey },
        ExclusiveStartKey: lastKey,
      }),
    )
    for (const item of result.Items ?? []) {
      const parsed = toExistingContext(item)
      if (parsed) contexts.push(parsed)
    }
    lastKey = result.LastEvaluatedKey
  } while (lastKey)

  return contexts
}

// Only the fields the classifier needs (name/desc/domain) — never a Context's accumulated content.
// An archived Context is skipped so we don't propose filing into it.
function toExistingContext(item: Record<string, unknown>): ExistingContext | undefined {
  const contextId = item['contextId']
  const name = item['name']
  const domain = DomainSchema.safeParse(item['domain'])
  if (typeof contextId !== 'string' || typeof name !== 'string' || !domain.success) return undefined
  if (item['status'] === 'archived') return undefined
  const description = item['description']
  return {
    contextId,
    name,
    domain: domain.data,
    ...(typeof description === 'string' ? { description } : {}),
  }
}
