// Ponytail-audit finding: createBlvdClient()'s retry/backoff loop
// (isTransient() classification of HTTP 5xx / network errors + exponential
// backoff) had zero test coverage — every mock fetchImpl in the existing
// suite always returns status 200, and vitest.config's coverage.exclude
// comment claims BLVD is "tested in live tier only," but the one live test
// only smoke-checks health(). retry.baseDelayMs is set tiny so this stays fast.

import { describe, expect, it, vi } from 'vitest'
import { createBlvdClient } from '../../src/adapters/booking/blvd/client.js'
import { isBlvdError } from '../../src/adapters/booking/blvd/errors.js'
import type { BlvdError } from '../../src/adapters/booking/blvd/errors.js'

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('createBlvdClient — retry/backoff on transient errors', () => {
  it('retries once on a 503 and succeeds on the second attempt', async () => {
    let call = 0
    const fetchImpl = vi.fn(async () => {
      call++
      if (call === 1) return new Response('unavailable', { status: 503 })
      return jsonOk({ data: { ok: true } })
    })
    const client = createBlvdClient({
      apiKey: 'k',
      businessId: 'b',
      fetchImpl: fetchImpl as typeof fetch,
      retry: { attempts: 1, baseDelayMs: 1 },
    })

    const result = await client.exec<{ ok: boolean }>('probe', 'query { __typename }')

    expect(result).toEqual({ ok: true })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('retries a rejected fetch (network error) and succeeds', async () => {
    let call = 0
    const fetchImpl = vi.fn(async () => {
      call++
      if (call === 1) throw new Error('ECONNRESET')
      return jsonOk({ data: { ok: true } })
    })
    const client = createBlvdClient({
      apiKey: 'k',
      businessId: 'b',
      fetchImpl: fetchImpl as typeof fetch,
      retry: { attempts: 1, baseDelayMs: 1 },
    })

    const result = await client.exec<{ ok: boolean }>('probe', 'query { __typename }')

    expect(result).toEqual({ ok: true })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('exhausts the retry budget and throws the last transient error', async () => {
    const fetchImpl = vi.fn(async () => new Response('unavailable', { status: 502 }))
    const client = createBlvdClient({
      apiKey: 'k',
      businessId: 'b',
      fetchImpl: fetchImpl as typeof fetch,
      retry: { attempts: 2, baseDelayMs: 1 },
    })

    await expect(client.exec('probe', 'query { __typename }')).rejects.toSatisfy(
      (e) => isBlvdError(e) && (e as BlvdError).code === 'HTTP_ERROR',
    )
    // 1 initial attempt + 2 retries = 3 calls.
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('does NOT retry a non-transient error (HTTP 400)', async () => {
    const fetchImpl = vi.fn(async () => new Response('bad request', { status: 400 }))
    const client = createBlvdClient({
      apiKey: 'k',
      businessId: 'b',
      fetchImpl: fetchImpl as typeof fetch,
      retry: { attempts: 2, baseDelayMs: 1 },
    })

    await expect(client.exec('probe', 'query { __typename }')).rejects.toSatisfy(
      (e) => isBlvdError(e) && (e as BlvdError).code === 'HTTP_ERROR',
    )
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('does NOT retry a GraphQL-level error (HTTP 200 + errors array)', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonOk({ data: null, errors: [{ message: 'Unknown field' }] }),
    )
    const client = createBlvdClient({
      apiKey: 'k',
      businessId: 'b',
      fetchImpl: fetchImpl as typeof fetch,
      retry: { attempts: 2, baseDelayMs: 1 },
    })

    await expect(client.exec('probe', 'query { __typename }')).rejects.toSatisfy(
      (e) => isBlvdError(e) && (e as BlvdError).code === 'GRAPHQL_ERROR',
    )
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})
