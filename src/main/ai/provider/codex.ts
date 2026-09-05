/**
 * Request shaping for the OpenAI Codex provider (ChatGPT backend codex
 * responses endpoint). Kept in its own module — free of the electron/app import
 * graph in `config.ts` — so the body/header coercion can be unit-tested
 * directly.
 */

import { EventSourceParserStream } from '@ai-sdk/provider-utils'

const CODEX_REASONING_INCLUDE = 'reasoning.encrypted_content'

export interface CodexCredentials {
  accessToken: string
  accountId: string | null
}

/**
 * Rewrite a parsed OpenAI Responses payload (mutated in place and returned) into
 * the shape the ChatGPT codex backend requires: server-side `store` is rejected,
 * response length caps are not accepted, and encrypted reasoning must round-trip.
 */
export function coerceCodexRequestJson(json: Record<string, any>): Record<string, any> {
  json.store = false
  json.stream = true
  delete json.max_output_tokens
  const include = new Set<string>(Array.isArray(json.include) ? json.include : [])
  include.add(CODEX_REASONING_INCLUDE)
  json.include = [...include]
  return json
}

/**
 * Coerce a serialized Responses body via {@link coerceCodexRequestJson}.
 * Non-JSON bodies pass through untouched.
 */
export function coerceCodexRequestBody(body: BodyInit | null | undefined): BodyInit | null | undefined {
  if (typeof body !== 'string') return body
  try {
    return JSON.stringify(coerceCodexRequestJson(JSON.parse(body)))
  } catch {
    return body
  }
}

/** Codex only streams; return its terminal response object to non-streaming SDK callers. */
export async function adaptCodexResponse(
  response: Response,
  requestBody: BodyInit | null | undefined
): Promise<Response> {
  if (!response.ok || !response.body || typeof requestBody !== 'string' || JSON.parse(requestBody).stream === true) {
    return response
  }
  const reader = response.body
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream())
    .getReader()
  const output = new Map<number, unknown>()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) throw new Error('Codex stream ended without a terminal response')
      if (value.data === '[DONE]') continue
      const event = JSON.parse(value.data)
      if (event.type === 'response.output_item.done') output.set(event.output_index, event.item)
      if (event.type === 'response.completed' || event.type === 'response.incomplete') {
        // Codex sends completed items separately and leaves the terminal output array empty.
        if (!event.response.output?.length) {
          event.response.output = [...output.entries()].sort(([a], [b]) => a - b).map(([, item]) => item)
        }
        const headers = new Headers(response.headers)
        headers.delete('content-length')
        headers.delete('content-encoding')
        headers.set('content-type', 'application/json')
        return Response.json(event.response, { headers })
      }
      if (event.type === 'response.failed' || event.type === 'error') {
        throw new Error(event.response?.error?.message ?? event.message ?? 'Codex response failed')
      }
    }
  } finally {
    await reader.cancel()
    reader.releaseLock()
  }
}

/**
 * Build the request headers for a codex call: the OAuth bearer token plus the
 * ChatGPT account id and the codex-specific beta/originator markers, layered
 * over whatever the SDK already set.
 */
export function buildCodexRequestHeaders(base: HeadersInit | undefined, creds: CodexCredentials): Headers {
  const headers = new Headers(base)
  headers.set('Authorization', `Bearer ${creds.accessToken}`)
  if (creds.accountId) headers.set('chatgpt-account-id', creds.accountId)
  else headers.delete('chatgpt-account-id')
  headers.set('OpenAI-Beta', 'responses=experimental')
  headers.set('originator', 'cherry-studio')
  return headers
}
