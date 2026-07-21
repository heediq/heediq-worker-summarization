import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import {
  DomainSchema,
  DOMAIN_PROFILES,
  DOMAIN_FIT_CONFIDENCE_THRESHOLD,
  type Domain,
} from '@heediq/shared'

// An existing Context the classifier may file this Source into (name/desc/domain only — no content).
export interface ExistingContext {
  contextId: string
  name: string
  description?: string
  domain: Domain
}

// One extracted statement in the *chosen* Domain's shape. `category` is validated against that
// Domain's `extractionFields` by the provider before returning (an item doesn't carry its own
// Domain — its Context does, D-135), so the writer can persist it as-is.
export interface ClassifiedItem {
  category: string
  text: string
  confidence: number
  sourceQuote?: string
}

// The combined classify+extract result (D-130): one Claude call yields both the placement proposal
// and the extracted items in the proposed Domain's shape, plus a short prose gist for the Summary.
export interface ClassifyExtractResult {
  // Exactly one of these is set (enforced here): match an existing Context, or propose a new one.
  proposedContextId?: string
  newContextName?: string
  domain: Domain
  labels: string[]
  confidence: number
  gist: string
  items: ClassifiedItem[]
}

export interface ClassifyExtractInput {
  content: string
  existingContexts: ExistingContext[]
}

// Provider interface (D-032) — swap model/vendor without rewriting the worker.
export interface ExtractionProvider {
  classifyExtract(input: ClassifyExtractInput): Promise<ClassifyExtractResult>
}

// Permissive schema for Claude's raw JSON — the strict shaping (threshold, category validity,
// exactly-one-of placement) is applied in post-processing below, not trusted from the model.
const RawResponseSchema = z.object({
  proposedContextId: z.string().nullish(),
  // Always requested as a fallback name even when matching an existing Context.
  newContextName: z.string().min(1).max(255),
  domain: DomainSchema,
  labels: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1),
  gist: z.string().default(''),
  items: z
    .array(
      z.object({
        category: z.string(),
        text: z.string().min(1),
        confidence: z.number().min(0).max(1).default(0.5),
        sourceQuote: z.string().nullish(),
      }),
    )
    .default([]),
})

function buildSystemPrompt(existingContexts: ExistingContext[]): string {
  const domainCatalog = (Object.keys(DOMAIN_PROFILES) as Domain[])
    .map((d) => `- ${d}: extraction categories = [${DOMAIN_PROFILES[d].extractionFields.join(', ')}]`)
    .join('\n')

  const contextList =
    existingContexts.length === 0
      ? '(none yet — you will propose a new Context)'
      : existingContexts
          .map(
            (c) =>
              `- id="${c.contextId}" name="${c.name}" domain=${c.domain}${
                c.description ? ` desc="${c.description}"` : ''
              }`,
          )
          .join('\n')

  return `You classify an ingested Source and extract structured items from it in ONE pass.

DOMAINS (pick the single best fit; each has its own extraction categories):
${domainCatalog}

The user's EXISTING CONTEXTS (projects/activities this Source might belong to):
${contextList}

Return ONLY a JSON object (no markdown, no explanation) with exactly these keys:
- proposedContextId: the id of an existing Context this Source clearly belongs to, or null if none fits
- newContextName: a concise proposed Context name (1-255 chars). ALWAYS provide this, even when proposedContextId is set, as a fallback
- domain: one of ${Object.keys(DOMAIN_PROFILES).join(' | ')}
- labels: array of short free-form topic tags (max 20)
- confidence: number 0..1 — your confidence in the DOMAIN fit (not the Context match)
- gist: a 1-3 sentence plain-language summary of the Source
- items: array of extracted statements, each { category, text, confidence, sourceQuote }.
  category MUST be one of the chosen domain's extraction categories listed above.

If your domain-fit confidence is below ${DOMAIN_FIT_CONFIDENCE_THRESHOLD}, classify as domain "other" and use its
categories (${DOMAIN_PROFILES.other.extractionFields.join(', ')}) so no items are lost.`
}

export class ClaudeProvider implements ExtractionProvider {
  private readonly client: Anthropic
  private readonly model: string

  constructor(apiKey: string, model: string) {
    this.client = new Anthropic({ apiKey })
    this.model = model
  }

  async classifyExtract(input: ClassifyExtractInput): Promise<ClassifyExtractResult> {
    const message = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      system: buildSystemPrompt(input.existingContexts),
      messages: [{ role: 'user', content: input.content }],
    })

    const text = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('')

    const raw = RawResponseSchema.parse(JSON.parse(text))
    return shapeResult(raw, input.existingContexts)
  }
}

// Enforce the invariants we don't trust the model to hold: low domain-fit confidence falls back to
// `other` (D-130); items are kept only if their category is valid for the *final* Domain; placement
// is exactly one of an existing-Context match or a new-name proposal.
export function shapeResult(
  raw: z.infer<typeof RawResponseSchema>,
  existingContexts: ExistingContext[],
): ClassifyExtractResult {
  const belowThreshold = raw.confidence < DOMAIN_FIT_CONFIDENCE_THRESHOLD
  const domain: Domain = belowThreshold ? 'other' : raw.domain

  const validCategories = new Set(DOMAIN_PROFILES[domain].extractionFields)
  const items = raw.items
    .filter((i) => validCategories.has(i.category))
    .map((i) => ({
      category: i.category,
      text: i.text,
      confidence: i.confidence,
      ...(i.sourceQuote ? { sourceQuote: i.sourceQuote } : {}),
    }))

  // A matched Context id only counts if it's real and the domain fit is confident enough;
  // otherwise we propose creating a new Context (guarantees exactly-one-of on the Source).
  const knownIds = new Set(existingContexts.map((c) => c.contextId))
  const matchedId =
    !belowThreshold && raw.proposedContextId && knownIds.has(raw.proposedContextId)
      ? raw.proposedContextId
      : undefined

  const labels = raw.labels.filter((l) => l.length > 0 && l.length <= 50).slice(0, 20)

  return {
    ...(matchedId ? { proposedContextId: matchedId } : { newContextName: raw.newContextName }),
    domain,
    labels,
    confidence: raw.confidence,
    gist: raw.gist,
    items,
  }
}
