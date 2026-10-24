import { env } from '../config/env.js'

// Minimal client for OpenAI's Responses API (POST /v1/responses) — plain
// fetch rather than the SDK, so the backend picks up no new dependency.
//
// `store: false` keeps task/employee data out of OpenAI's stored-response
// history; the conversation (including the model's encrypted reasoning) is
// carried forward by sending the previous turns' output items back as input
// instead of relying on previous_response_id, which needs `store: true`.

export interface FunctionTool {
  type: 'function'
  name: string
  description: string
  strict: true
  parameters: Record<string, unknown>
}

export type InputItem =
  | { role: 'user' | 'assistant' | 'developer'; content: string }
  | { type: 'function_call_output'; call_id: string; output: string }
  | OutputItem

export interface FunctionCallItem {
  type: 'function_call'
  id?: string
  call_id: string
  name: string
  arguments: string
}

export type OutputItem =
  | FunctionCallItem
  | { type: 'message'; content: { type: string; text?: string }[] }
  | { type: string; [key: string]: unknown }

export interface ResponsesResult {
  output: OutputItem[]
  usage?: { input_tokens: number; output_tokens: number; total_tokens: number }
}

export class AiNotConfiguredError extends Error {
  constructor() {
    super('OPENAI_API_KEY is not set')
  }
}

// The OpenAI account itself is out of quota (billing, or a per-day request
// cap) — retrying can't help, and users need to be told plainly.
export class AiQuotaError extends Error {}

function isQuotaExhausted(status: number, detail: string): boolean {
  return status === 429 && /insufficient_quota|requests per day|tokens per day|billing/i.test(detail)
}

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504])
const MAX_ATTEMPTS = 3
const REQUEST_TIMEOUT_MS = 60_000

export async function createResponse(request: { instructions: string; input: InputItem[]; tools: FunctionTool[] }): Promise<ResponsesResult> {
  if (!env.OPENAI_API_KEY) throw new AiNotConfiguredError()

  const body = JSON.stringify({
    model: env.OPENAI_MODEL,
    instructions: request.instructions,
    input: request.input,
    tools: request.tools,
    store: false,
    include: ['reasoning.encrypted_content'],
    reasoning: { effort: env.OPENAI_REASONING_EFFORT }
  })

  let lastError: unknown
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.OPENAI_API_KEY}` },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      })
      if (res.ok) return (await res.json()) as ResponsesResult

      const detail = await res.text().catch(() => '')
      if (isQuotaExhausted(res.status, detail)) throw new AiQuotaError(`OpenAI quota exhausted: ${detail.slice(0, 500)}`)
      lastError = new Error(`OpenAI ${res.status}: ${detail.slice(0, 500)}`)
      if (!RETRYABLE_STATUS.has(res.status)) break
    } catch (err) {
      if (err instanceof AiQuotaError) throw err
      lastError = err
    }
    if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)))
  }
  throw lastError
}

export function outputText(result: ResponsesResult): string {
  return result.output
    .filter((o): o is { type: 'message'; content: { type: string; text?: string }[] } => o.type === 'message')
    .flatMap((o) => o.content)
    .map((c) => c.text ?? '')
    .join('')
    .trim()
}
