// tests/core/idempotency.test.ts — Tier 1 (unit) for the IdempotencyStore impls.
// Pipeline-level replay coverage lives in tests/server/pipeline.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  memoryIdempotencyStore,
  upstashIdempotencyStore,
  type IdempotencyKey,
  type IdempotencyRecord,
} from '../../src/core/idempotency.js'

function makeRecord(
  overrides: Partial<IdempotencyRecord> = {},
): IdempotencyRecord {
  return {
    key: 'client-key-abc-123' as IdempotencyKey,
    tenantId: 'tenant-a',
    requestHash: 'request-hash',
    responseStatus: 200,
    responseBody: JSON.stringify({ success: true, submissionId: 'bk_x' }),
    createdAt: new Date('2026-05-13T10:00:00.000Z'),
    ...overrides,
  }
}

// ── memoryIdempotencyStore ───────────────────────────────────────────────────

describe('memoryIdempotencyStore', () => {
  it('round-trips a record on put + get', async () => {
    const store = memoryIdempotencyStore()
    const rec = makeRecord()
    await store.put(rec, 60)
    const got = await store.get(rec.tenantId, rec.key)
    expect(got).not.toBeNull()
    expect(got?.key).toBe(rec.key)
    expect(got?.tenantId).toBe(rec.tenantId)
    expect(got?.responseStatus).toBe(rec.responseStatus)
    expect(got?.responseBody).toBe(rec.responseBody)
    expect(got?.createdAt.toISOString()).toBe(rec.createdAt.toISOString())
  })

  it('scopes records by tenantId — same key under two tenants is two records', async () => {
    const store = memoryIdempotencyStore()
    const key = 'shared-key' as IdempotencyKey
    await store.put(
      makeRecord({ key, tenantId: 'tenant-a', responseBody: '{"who":"a"}' }),
      60,
    )
    await store.put(
      makeRecord({ key, tenantId: 'tenant-b', responseBody: '{"who":"b"}' }),
      60,
    )
    const a = await store.get('tenant-a', key)
    const b = await store.get('tenant-b', key)
    expect(a?.responseBody).toBe('{"who":"a"}')
    expect(b?.responseBody).toBe('{"who":"b"}')
  })

  it('returns null after TTL expires', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-13T10:00:00.000Z'))
    const store = memoryIdempotencyStore()
    const rec = makeRecord()
    await store.put(rec, 60) // 60s TTL
    // Still within TTL
    vi.setSystemTime(new Date('2026-05-13T10:00:30.000Z'))
    expect(await store.get(rec.tenantId, rec.key)).not.toBeNull()
    // After TTL
    vi.setSystemTime(new Date('2026-05-13T10:01:01.000Z'))
    expect(await store.get(rec.tenantId, rec.key)).toBeNull()
    vi.useRealTimers()
  })

  it('returns null for unknown key', async () => {
    const store = memoryIdempotencyStore()
    expect(
      await store.get('tenant-a', 'never-seen' as IdempotencyKey),
    ).toBeNull()
  })
})

// ── upstashIdempotencyStore ──────────────────────────────────────────────────

describe('upstashIdempotencyStore', () => {
  const baseOpts = {
    url: 'https://example.upstash.io',
    token: 'tok_abc',
    keyPrefix: 'apointoo',
  }

  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch')
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it('put builds POST /set/<key>/<value>?EX=<ttl> with Bearer auth', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ result: 'OK' }), { status: 200 }),
    )
    const store = upstashIdempotencyStore(baseOpts)
    const rec = makeRecord()
    await store.put(rec, 3600)

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [calledUrl, init] = fetchSpy.mock.calls[0] as [URL, RequestInit]
    expect(calledUrl).toBeInstanceOf(URL)
    expect(calledUrl.origin).toBe('https://example.upstash.io')
    expect(calledUrl.pathname.startsWith('/set/')).toBe(true)
    // Tenant-scoped key with prefix
    const expectedKey = `apointoo:${rec.tenantId}:${rec.key}`
    expect(calledUrl.pathname).toContain(encodeURIComponent(expectedKey))
    expect(calledUrl.searchParams.get('EX')).toBe('3600')
    expect(init.method).toBe('POST')
    expect(
      (init.headers as Record<string, string>).Authorization,
    ).toBe('Bearer tok_abc')

    // Stored value is JSON containing the serialized record
    const segments = calledUrl.pathname.split('/')
    const encodedValue = segments[segments.length - 1] as string
    const decoded = JSON.parse(decodeURIComponent(encodedValue)) as {
      key: string
      tenantId: string
      requestHash: string
      responseStatus: number
      responseBody: string
      createdAt: string
    }
    expect(decoded.key).toBe(rec.key)
    expect(decoded.tenantId).toBe(rec.tenantId)
    expect(decoded.requestHash).toBe(rec.requestHash)
    expect(decoded.responseStatus).toBe(rec.responseStatus)
    expect(decoded.responseBody).toBe(rec.responseBody)
    expect(decoded.createdAt).toBe(rec.createdAt.toISOString())
  })

  it('get parses Upstash { result: <json-string> } response shape', async () => {
    const rec = makeRecord()
    const stored = JSON.stringify({
      key: rec.key,
      tenantId: rec.tenantId,
      responseStatus: rec.responseStatus,
      responseBody: rec.responseBody,
      createdAt: rec.createdAt.toISOString(),
    })
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ result: stored }), { status: 200 }),
    )
    const store = upstashIdempotencyStore(baseOpts)
    const got = await store.get(rec.tenantId, rec.key)

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [calledUrl, init] = fetchSpy.mock.calls[0] as [URL, RequestInit]
    expect(calledUrl.pathname.startsWith('/get/')).toBe(true)
    expect(calledUrl.pathname).toContain(
      encodeURIComponent(`apointoo:${rec.tenantId}:${rec.key}`),
    )
    expect(init.method).toBe('POST')
    expect(got).not.toBeNull()
    expect(got?.key).toBe(rec.key)
    expect(got?.tenantId).toBe(rec.tenantId)
    expect(got?.responseStatus).toBe(rec.responseStatus)
    expect(got?.responseBody).toBe(rec.responseBody)
    expect(got?.createdAt.toISOString()).toBe(rec.createdAt.toISOString())
  })

  it('get returns null when Upstash result is null (cache miss)', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ result: null }), { status: 200 }),
    )
    const store = upstashIdempotencyStore(baseOpts)
    const got = await store.get(
      'tenant-a',
      'missing-key' as IdempotencyKey,
    )
    expect(got).toBeNull()
  })

  it('get fails open (returns null) when fetch rejects', async () => {
    fetchSpy.mockRejectedValue(new Error('network down'))
    const store = upstashIdempotencyStore(baseOpts)
    const got = await store.get(
      'tenant-a',
      'any-key' as IdempotencyKey,
    )
    expect(got).toBeNull()
  })

  it('get fails open (returns null) on non-2xx HTTP status', async () => {
    fetchSpy.mockResolvedValue(new Response('boom', { status: 503 }))
    const store = upstashIdempotencyStore(baseOpts)
    const got = await store.get(
      'tenant-a',
      'any-key' as IdempotencyKey,
    )
    expect(got).toBeNull()
  })

  it('put fails open (does not throw) when fetch rejects', async () => {
    fetchSpy.mockRejectedValue(new Error('network down'))
    const store = upstashIdempotencyStore(baseOpts)
    await expect(store.put(makeRecord(), 60)).resolves.toBeUndefined()
  })

  it('omits keyPrefix segment when keyPrefix is not provided', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ result: 'OK' }), { status: 200 }),
    )
    const store = upstashIdempotencyStore({
      url: baseOpts.url,
      token: baseOpts.token,
    })
    const rec = makeRecord()
    await store.put(rec, 60)
    const [calledUrl] = fetchSpy.mock.calls[0] as [URL]
    // No leading "<prefix>:" — just "<tenant>:<key>"
    expect(calledUrl.pathname).toContain(
      encodeURIComponent(`${rec.tenantId}:${rec.key}`),
    )
    expect(calledUrl.pathname).not.toContain('apointoo%3A')
  })
})
