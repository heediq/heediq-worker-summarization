import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'

export interface ExtractionResult {
  requirements: string[]
  decisions: string[]
  openQuestions: string[]
  actionItems: string[]
}

// Provider interface (D-032) — swap model/vendor without rewriting the worker.
export interface ExtractionProvider {
  extract(content: string): Promise<ExtractionResult>
}

const ExtractionSchema = z.object({
  requirements: z.array(z.string()),
  decisions: z.array(z.string()),
  openQuestions: z.array(z.string()),
  actionItems: z.array(z.string()),
})

const SYSTEM_PROMPT = `You are an expert meeting analyst. Extract structured information from the meeting transcript provided.
Return a JSON object with exactly these keys:
- requirements: array of strings, each a specific requirement or feature request mentioned
- decisions: array of strings, each a decision that was made during the meeting
- openQuestions: array of strings, each an unresolved question or open issue
- actionItems: array of strings, each an action item with owner if mentioned

Return only valid JSON, no markdown, no explanation.`

export class ClaudeProvider implements ExtractionProvider {
  private readonly client: Anthropic

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey })
  }

  async extract(content: string): Promise<ExtractionResult> {
    const message = await this.client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content }],
    })

    const text = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('')

    return ExtractionSchema.parse(JSON.parse(text))
  }
}
