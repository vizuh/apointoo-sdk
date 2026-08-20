// Upstash sliding-window rate limit. Same fail-open semantics as the dedup store.
// Sliding window via INCR + PEXPIRE on a window-keyed counter.

import { errMessage } from '../../core/errors.js'
import type { RateLimitDecision, RateLimitStore } from './adapter.js'

export type UpstashRateLimitStoreOptions = {
  url: string
  token: string
  /** Allowed requests per window. */
  limit: number
  /** Window length in milliseconds. */
  windowMs: number
  /** Optional key prefix (project key recommended). */
  keyPrefix?: string
}

export function upstashRateLimitStore(opts: UpstashRateLimitStoreOptions): RateLimitStore {
  const prefix = opts.keyPrefix ? `${opts.keyPrefix}:` : ''

  return {
    async consume(key) {
      const window = Math.floor(Date.now() / opts.windowMs)
      const fullKey = `${prefix}rl:${key}:${window}`

      try {
        // INCR
        const incrUrl = new URL(`/incr/${encodeURIComponent(fullKey)}`, opts.url)
        const incrRes = await fetch(incrUrl, {
          method: 'POST',
          headers: { Authorization: `Bearer ${opts.token}` },
        })
        if (!incrRes.ok) return failOpen(opts.limit)
        const incrBody = (await incrRes.json()) as { result: number }
        const current = incrBody.result ?? 0

        // PEXPIRE (only matters on first INCR — Redis ignores if already set)
        if (current === 1) {
          const expUrl = new URL(
            `/pexpire/${encodeURIComponent(fullKey)}/${opts.windowMs}`,
            opts.url,
          )
          await fetch(expUrl, {
            method: 'POST',
            headers: { Authorization: `Bearer ${opts.token}` },
          })
        }

        if (current > opts.limit) {
          const retryAfterMs = opts.windowMs - (Date.now() % opts.windowMs)
          return { allowed: false, remaining: 0, retryAfterMs }
        }

        return {
          allowed: true,
          remaining: Math.max(0, opts.limit - current),
          retryAfterMs: undefined,
        }
      } catch {
        return failOpen(opts.limit)
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

function failOpen(limit: number): RateLimitDecision {
  return { allowed: true, remaining: limit, retryAfterMs: undefined }
}
