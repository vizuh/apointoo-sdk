// RateLimitStore — bucketed rate limit keyed by IP + fingerprint.

export type RateLimitDecision = {
  allowed: boolean
  remaining: number
  retryAfterMs: number | undefined
}

export interface RateLimitStore {
  /**
   * Consume one token from the bucket identified by `key`.
   * Returns whether the request is allowed plus remaining quota.
   *
   * Failure modes (provider down, network) should fail open (allowed=true)
   * — same fail-open semantics as DedupStore.
   */
  consume(key: string): Promise<RateLimitDecision>

  health(): Promise<{ ok: boolean; name: string; error?: string }>
}
