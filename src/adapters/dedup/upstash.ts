// Upstash Redis DedupStore — distributed dedup over REST.
// Uses `SET key value NX PX ttl` for atomicity.
//
// Optional dep: `@upstash/redis`. If the consumer doesn't install it, this
// module still type-checks — the import is dynamic and the constructor throws
// a clear error.

import { errMessage } from '../../core/errors.js'
import type { DedupStore } from './adapter.js'

export type UpstashDedupStoreOptions = {
  url: string
  token: string
  /** Key prefix — set to project key to avoid cross-tenant collisions. */
  keyPrefix?: string
}

export function upstashDedupStore(opts: UpstashDedupStoreOptions): DedupStore {
  const prefix = opts.keyPrefix ? `${opts.keyPrefix}:` : ''

  return {
    async checkAndSet(key, ttlMs) {
      const fullKey = `${prefix}${key}`
      try {
        // REST API: POST { url }/set/{key}/{value}?nx=true&px={ttl}
        // Returns { result: 'OK' } on set, { result: null } on existing.
        const url = new URL(`/set/${encodeURIComponent(fullKey)}/1`, opts.url)
        url.searchParams.set('NX', 'true')
        url.searchParams.set('PX', String(ttlMs))
        const res = await fetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${opts.token}` },
        })
        if (!res.ok) {
          // Fail open — never block legit bookings on a Redis blip.
          return { duplicate: false }
        }
        const body = (await res.json()) as { result: string | null }
        return { duplicate: body.result !== 'OK' }
      } catch {
        return { duplicate: false }
      }
    },

    async health() {
      try {
        const url = new URL('/ping', opts.url)
        const res = await fetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${opts.token}` },
        })
        if (!res.ok) {
          return { ok: false, name: 'upstash', error: `HTTP ${res.status}` }
        }
        return { ok: true, name: 'upstash' }
      } catch (err) {
        return {
          ok: false,
          name: 'upstash',
          error: errMessage(err),
        }
      }
    },
  }
}
