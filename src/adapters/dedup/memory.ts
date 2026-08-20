// In-memory DedupStore — for dev and tests. Same Map semantics as old kit.
// Lazy cleanup on each access keeps the Map bounded.

import type { DedupStore } from './adapter.js'

export type MemoryDedupStoreOptions = {
  /** Max entries before forced eviction of oldest (defensive cap). */
  maxEntries?: number
}

export function memoryDedupStore(opts: MemoryDedupStoreOptions = {}): DedupStore {
  const map = new Map<string, number>() // key -> expiresAt (ms)
  const maxEntries = opts.maxEntries ?? 10_000

  return {
    async checkAndSet(key, ttlMs) {
      const now = Date.now()
      const existing = map.get(key)
      if (existing !== undefined && existing > now) {
        return { duplicate: true }
      }
      map.set(key, now + ttlMs)
      // Lazy cleanup of expired entries
      if (map.size > maxEntries) {
        for (const [k, exp] of map) {
          if (exp <= now) map.delete(k)
          if (map.size <= maxEntries / 2) break
        }
      }
      return { duplicate: false }
    },
    async health() {
      return { ok: true, name: 'memory' }
    },
  }
}
