import { createOpenAI } from '@ai-sdk/openai'
import { describe, expect, it } from 'vitest'

import { adaptCodexResponse, buildCodexRequestHeaders, coerceCodexRequestBody } from '../codex'

describe('coerceCodexRequestBody', () => {
  it('forces store:false and adds encrypted reasoning to include', () => {
    const out = coerceCodexRequestBody(JSON.stringify({ model: 'gpt-5.5', store: true }))
    const json = JSON.parse(out as string)
    expect(json.store).toBe(false)
    expect(json.stream).toBe(true)
    expect(json.include).toEqual(['reasoning.encrypted_content'])
  })

  it('drops max_output_tokens because the codex backend rejects it', () => {
    const out = coerceCodexRequestBody(JSON.stringify({ model: 'gpt-5.5', max_output_tokens: 32000 }))
    const json = JSON.parse(out as string)
    expect(json).not.toHaveProperty('max_output_tokens')
  })

  it('preserves existing include entries without duplicating', () => {
    const out = coerceCodexRequestBody(
      JSON.stringify({ include: ['file_search_call.results', 'reasoning.encrypted_content'] })
    )
    const json = JSON.parse(out as string)
    expect(json.include).toEqual(['file_search_call.results', 'reasoning.encrypted_content'])
  })

  it('passes through non-string and non-JSON bodies untouched', () => {
    expect(coerceCodexRequestBody(undefined)).toBeUndefined()
    expect(coerceCodexRequestBody('not json')).toBe('not json')
  })
})

describe('Codex non-streaming calls', () => {
  const completed = {
    id: 'resp_test',
    created_at: 1,
    model: 'gpt-6-astra',
    status: 'completed',
    output: [
      {
        type: 'message',
        id: 'msg_test',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'OK', annotations: [] }]
      }
    ],
    usage: {
      input_tokens: 10,
      output_tokens: 1,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 }
    }
  }
  const sse = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`

  it('satisfies SDK generation through a streaming-only backend, preserving text and usage', async () => {
    const model = createOpenAI({
      apiKey: 'test',
      fetch: async (_input, init) => {
        const body = JSON.parse(coerceCodexRequestBody(init?.body) as string)
        if (body.stream !== true) return Response.json({ detail: 'Stream must be set to true' }, { status: 400 })
        const encoded = new TextEncoder().encode(
          sse({ type: 'response.output_item.done', output_index: 0, item: completed.output[0] }) +
            sse({ type: 'response.completed', response: { ...completed, output: [] } })
        )
        const response = new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoded.slice(0, 17))
              controller.enqueue(encoded.slice(17))
              controller.close()
            }
          }),
          { headers: { 'content-type': 'text/event-stream' } }
        )
        return adaptCodexResponse(response, init?.body)
      }
    }).responses('gpt-6-astra')
    const result = await model.doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'Reply OK' }] }] })
    expect(result.content).toContainEqual(expect.objectContaining({ type: 'text', text: 'OK' }))
    expect(result.usage.inputTokens.total).toBe(10)
    expect(result.usage.outputTokens.total).toBe(1)
  })

  it('preserves streaming responses and HTTP errors', async () => {
    const body = sse({ type: 'response.completed', response: completed })
    const stream = await adaptCodexResponse(new Response(body), JSON.stringify({ stream: true }))
    expect(await stream.text()).toBe(body)
    const error = await adaptCodexResponse(Response.json({ error: 'unauthorized' }, { status: 401 }), '{}')
    expect(error.status).toBe(401)
    expect(await error.json()).toEqual({ error: 'unauthorized' })
  })

  it('releases the upstream stream as soon as a terminal response arrives', async () => {
    let cancelled = false
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sse({ type: 'response.completed', response: completed })))
      },
      cancel() {
        cancelled = true
      }
    })
    const response = await adaptCodexResponse(new Response(body), '{}')
    expect((await response.json()).id).toBe('resp_test')
    expect(cancelled).toBe(true)
  })

  it.each([
    [sse({ type: 'response.failed', response: { error: { message: 'Capacity exceeded' } } }), 'Capacity exceeded'],
    [sse({ type: 'error', message: 'Bad request' }), 'Bad request'],
    [sse({ type: 'response.created' }), 'without a terminal response']
  ])('rejects failed or truncated streams', async (body, message) => {
    await expect(adaptCodexResponse(new Response(body), '{}')).rejects.toThrow(message)
  })
})

describe('buildCodexRequestHeaders', () => {
  it('sets the bearer token, account id and codex markers', () => {
    const headers = buildCodexRequestHeaders(
      { 'content-type': 'application/json' },
      { accessToken: 'tok', accountId: 'acct-1' }
    )
    expect(headers.get('Authorization')).toBe('Bearer tok')
    expect(headers.get('chatgpt-account-id')).toBe('acct-1')
    expect(headers.get('OpenAI-Beta')).toBe('responses=experimental')
    expect(headers.get('originator')).toBe('cherry-studio')
    expect(headers.get('content-type')).toBe('application/json')
  })

  it('omits the account id header when none is known', () => {
    const headers = buildCodexRequestHeaders(
      { Authorization: 'Bearer old-token', 'ChatGPT-Account-Id': 'old-account' },
      { accessToken: 'tok', accountId: null }
    )
    expect(headers.get('Authorization')).toBe('Bearer tok')
    expect(headers.has('chatgpt-account-id')).toBe(false)
  })
})
