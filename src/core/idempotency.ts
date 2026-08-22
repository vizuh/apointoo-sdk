// Idempotency-Key handling. ADR-013.
// Standard pattern (Stripe-style): client sends an Idempotency-Key header.
// Server caches the response keyed by (tenantId, key) for N hours; replays
// return the cached response without re-executing.
//
// Implementation: an `IdempotencyStore` interface, with memory + Upstash impls.
// The pipeline reads the header, checks the store, returns cached if hit,
// otherwise runs the pipeline + writes the result before returning.

export type IdempotencyKey = string

export type IdempotencyRecord = {
  key: IdempotencyKey
  tenantId: string
  requestHash: string
  /** Cached response body (status + JSON body serialized). */
  responseStatus: number
  responseBody: string
  createdAt: Date
}

export interface IdempotencyStore {
  /** Returns the cached record if (tenantId, key) was seen, else null. */
  get(tenantId: string, key: IdempotencyKey): Promise<IdempotencyRecord | null>
  /** Cache the response. TTL is impl-specific (default 24h). */
  put(record: IdempotencyRecord, ttlSeconds: number): Promise<void>
}

// ── Header extraction ──────────────────────────────────────────────────────
// Standard header name from RFC 9457-bis / Stripe convention.

export const IDEMPOTENCY_HEADER = 'idempotency-key'

export async function hashIdempotencyRequest(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  )
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}

export function readIdempotencyKey(headers: Headers | Record<string, string | undefined>): IdempotencyKey | undefined {
  if (headers instanceof Headers) {
    const v = headers.get(IDEMPOTENCY_HEADER)
    return v?.trim() || undefined
  }
  const v = headers[IDEMPOTENCY_HEADER] ?? headers['Idempotency-Key']
  return v?.trim() || undefined
}

// ── In-memory store ────────────────────────────────────────────────────────
// For dev + tests. Doesn't survive restarts — Upstash impl in adapters/.

export type MemoryIdempotencyStoreOptions = {
  maxEntries?: number
}

export function memoryIdempotencyStore(opts: MemoryIdempotencyStoreOptions = {}): IdempotencyStore {
  const map = new Map<string, IdempotencyRecord & { expiresAt: number }>()
  const maxEntries = opts.maxEntries ?? 10_000

  function fullKey(tenantId: string, key: IdempotencyKey): string {
    return `${tenantId}:${key}`
  }

  return {
    async get(tenantId, key) {
      const entry = map.get(fullKey(tenantId, key))
      if (!entry) return null
      if (entry.expiresAt < Date.now()) {
        map.delete(fullKey(tenantId, key))
        return null
      }
      const { expiresAt: _exp, ...record } = entry
      return record
    },
    async put(record, ttlSeconds) {
      if (map.size >= maxEntries) {
        // Evict oldest by reinsertion order
        const firstKey = map.keys().next().value
        if (firstKey !== undefined) map.delete(firstKey)
      }
      map.set(fullKey(record.tenantId, record.key), {
        ...record,
        expiresAt: Date.now() + ttlSeconds * 1000,
      })
    },
  }
}

// ── Upstash store ──────────────────────────────────────────────────────────
// Distributed idempotency cache over Upstash REST. Survives restarts, works
// across serverless invocations and edge runtimes. Mirrors the upstashDedupStore
// pattern (POST /op/key/value with Bearer auth, fail-open on network errors).
//
// Key shape: `${prefix}:${tenantId}:${key}` — tenant-scoped to prevent
// cross-tenant leakage of cached responses.

export type UpstashIdempotencyStoreOptions = {
  url: string
  token: string
  /** Key prefix — set to project key to avoid cross-tenant collisions. */
  keyPrefix?: string
}

export function upstashIdempotencyStore(
  opts: UpstashIdempotencyStoreOptions,
): IdempotencyStore {
  const prefix = opts.keyPrefix ? `${opts.keyPrefix}:` : ''

  function fullKey(tenantId: string, key: IdempotencyKey): string {
    return `${prefix}${tenantId}:${key}`
  }

  return {
    async get(tenantId, key) {
      const k = fullKey(tenantId, key)
      try {
        // REST API: POST { url }/get/{key}
        // Returns { result: <stored-string> | null }.
        const url = new URL(`/get/${encodeURIComponent(k)}`, opts.url)
        const res = await fetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${opts.token}` },
        })
        if (!res.ok) {
          // Fail open — treat as cache miss; pipeline runs normally.
          return null
        }
        const body = (await res.json()) as { result: string | null }
        if (body.result === null) return null
        const parsed = JSON.parse(body.result) as {
          key: IdempotencyKey
          tenantId: string
          requestHash: string
          responseStatus: number
          responseBody: string
          createdAt: string
        }
        return {
          key: parsed.key,
          tenantId: parsed.tenantId,
          requestHash: parsed.requestHash,
          responseStatus: parsed.responseStatus,
          responseBody: parsed.responseBody,
          createdAt: new Date(parsed.createdAt),
        }
      } catch {
        return null
      }
    },

    async put(record, ttlSeconds) {
      const k = fullKey(record.tenantId, record.key)
      const value = JSON.stringify({
        key: record.key,
        tenantId: record.tenantId,
        requestHash: record.requestHash,
        responseStatus: record.responseStatus,
        responseBody: record.responseBody,
        createdAt: record.createdAt.toISOString(),
      })
      try {
        // REST API: POST { url }/set/{key}/{value}?EX={ttlSeconds}
        // Returns { result: 'OK' } on success.
        const url = new URL(
          `/set/${encodeURIComponent(k)}/${encodeURIComponent(value)}`,
          opts.url,
        )
        url.searchParams.set('EX', String(ttlSeconds))
        await fetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${opts.token}` },
        })
        // Fail open — swallow any non-OK status. Replay cache is best-effort;
        // a missed put just means the next identical request will re-execute.
      } catch {
        // No logger available here — swallow per fail-open philosophy.
      }
    },
  }
}
