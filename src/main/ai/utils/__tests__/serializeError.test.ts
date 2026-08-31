import { NoSuchToolError, RetryError } from 'ai'
import { describe, expect, it } from 'vitest'

import { serializeError } from '../serializeError'

describe('serializeError', () => {
  it('preserves a structured provider stream error for display and diagnosis', () => {
    const error = {
      type: 'error',
      sequence_number: 7,
      error: {
        type: 'service_unavailable_error',
        code: 'server_is_overloaded',
        message: 'Our servers are currently overloaded. Please try again later.',
        param: null
      }
    }

    expect(JSON.parse(JSON.stringify(serializeError(error)))).toMatchObject({
      name: 'service_unavailable_error',
      message: error.error.message,
      code: 'server_is_overloaded',
      stack: null,
      data: error
    })
  })

  it('preserves plain error metadata across an IPC round trip', () => {
    const error = {
      name: 'APICallError',
      message: 'Invalid request',
      statusCode: 400,
      isRetryable: false,
      responseBody: '{"error":{"message":"Invalid request"}}'
    }

    expect(serializeError(error)).toMatchObject(error)
  })

  it('renders an unrecognized circular payload without losing its fields or throwing', () => {
    const error: Record<string, unknown> = { detail: 'Search failed', requestId: 123n }
    error.self = error

    const result = serializeError(error)

    expect(JSON.parse(result.message!)).toEqual({ detail: 'Search failed', requestId: '123', self: '[Circular]' })
    expect(() => JSON.stringify(result)).not.toThrow()
  })

  it.each([undefined, null, 'request failed', 503])('keeps primitive failures readable: %s', (error) => {
    expect(serializeError(error).message).toBe(String(error))
  })

  describe('null preservation (FIX error-1)', () => {
    it('serializes an absent cause to real null, not the string "null"', () => {
      const result = serializeError(new Error('boom'))

      expect(result.cause).toBeNull()
      expect(result.cause).not.toBe('null')
    })

    it('serializes an absent responseBody to real null, not the string "null"', () => {
      // APICallError-shaped error with statusCode/url/requestBodyValues present but responseBody absent.
      const err = Object.assign(new Error('api boom'), {
        url: 'https://example.com',
        requestBodyValues: { foo: 'bar' },
        statusCode: 500,
        isRetryable: false,
        data: null
      })

      const result = serializeError(err)

      // responseBody key is absent on the source error → not extracted at all.
      expect(result.responseBody).toBeUndefined()
    })

    it('preserves a present responseBody as a string', () => {
      const err = Object.assign(new Error('api boom'), {
        url: 'https://example.com',
        requestBodyValues: { foo: 'bar' },
        statusCode: 500,
        responseBody: '{"error":"bad"}',
        responseHeaders: { 'content-type': 'application/json' },
        isRetryable: true,
        data: { detail: 'x' }
      })

      const result = serializeError(err)

      expect(result.responseBody).toBe('{"error":"bad"}')
      // APICallError discriminant fields are carried through.
      expect(result.url).toBe('https://example.com')
      expect(result.statusCode).toBe(500)
      expect(result.isRetryable).toBe(true)
    })

    it('serializes a present responseBody of null to real null', () => {
      const err = Object.assign(new Error('api boom'), {
        url: 'https://example.com',
        requestBodyValues: {},
        statusCode: 500,
        responseBody: null,
        responseHeaders: null,
        isRetryable: false,
        data: null
      })

      const result = serializeError(err)

      expect(result.responseBody).toBeNull()
      expect(result.responseBody).not.toBe('null')
    })
  })

  describe('discriminant field extraction (FIX error-2)', () => {
    it('preserves a renderer translation key from application errors', () => {
      const error = Object.assign(new Error('fallback message'), {
        i18nKey: 'tool_call_limit_reached'
      })

      expect(serializeError(error).i18nKey).toBe('tool_call_limit_reached')
    })

    it('serializes a RetryError with its discriminant fields', () => {
      const retryError = new RetryError({
        message: 'retry failed',
        reason: 'maxRetriesExceeded',
        errors: [new Error('attempt 1'), new Error('attempt 2')]
      })

      const result = serializeError(retryError)

      expect(result.reason).toBe('maxRetriesExceeded')
      expect(Array.isArray(result.errors)).toBe(true)
      expect((result.errors as unknown[]).length).toBe(2)
      // lastError is also carried.
      expect('lastError' in result).toBe(true)
    })

    it('serializes a NoSuchToolError with its discriminant fields', () => {
      const noSuchTool = new NoSuchToolError({
        toolName: 'missing_tool',
        availableTools: ['alpha', 'beta']
      })

      const result = serializeError(noSuchTool)

      expect(result.toolName).toBe('missing_tool')
      expect(result.availableTools).toEqual(['alpha', 'beta'])
    })
  })
})
