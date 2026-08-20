// DedupStore — short-lived check-and-set for fingerprint collisions.
// See ADR-002 for why this is distributed (Upstash) by default.

export interface DedupStore {
  /**
   * Atomically: if `key` is unset, set it with TTL=`ttlMs` and return
   * { duplicate: false }. Otherwise return { duplicate: true }.
   *
   * Implementations MUST be atomic — a non-atomic check-then-set lets
   * concurrent requests both pass the dedup window.
   *
   * Errors should fail open (treat as duplicate=false + log) rather than
   * blocking legitimate bookings on a transient Redis blip.
   */
  checkAndSet(key: string, ttlMs: number): Promise<{ duplicate: boolean }>

  /**
   * Connectivity probe. Optional — implementations may no-op for memory store.
   */
  health(): Promise<{ ok: boolean; name: string; error?: string }>
}
