// OutboundQueue — durable queue for notifications (email + WhatsApp + future).
// Workers claim items via SKIP LOCKED semantics; failed items get retried with
// exponential backoff. ADR-006.

export type QueueChannel = 'email' | 'whatsapp' | 'sms' | 'webhook'

export type QueueItemStatus = 'pending' | 'in_flight' | 'done' | 'failed' | 'dead'

export type QueueItem = {
  id: string
  tenantId: string
  submissionId: string
  channel: QueueChannel
  /** Channel-specific payload. Email: { subject, html, text, to }. WhatsApp: { to, contentSid, vars }. */
  payload: Record<string, unknown>
  status: QueueItemStatus
  attempts: number
  /** Latest error message for failed/dead items. */
  lastError: string | null
  /** Earliest time the worker should re-claim. */
  nextRetryAt: Date
  createdAt: Date
  updatedAt: Date
}

export type QueueEnqueue = Omit<
  QueueItem,
  'id' | 'status' | 'attempts' | 'lastError' | 'nextRetryAt' | 'createdAt' | 'updatedAt'
> & {
  /** Optional override for first-attempt time. Defaults to now. */
  scheduledFor?: Date
}

export interface OutboundQueue {
  enqueue(item: QueueEnqueue): Promise<string> // returns id

  /**
   * Atomically claim up to `max` ready items (status=pending, nextRetryAt<=now).
   * Marks them in_flight + returns. MUST use SELECT FOR UPDATE SKIP LOCKED in SQL
   * impls to prevent two workers grabbing the same item.
   */
  claim(max: number, workerId: string): Promise<QueueItem[]>

  markDone(itemId: string): Promise<void>

  /**
   * Mark failed. The queue computes nextRetryAt via exponential backoff
   * (configured at construction time). After `maxAttempts`, status flips to `dead`.
   */
  markFailed(itemId: string, error: string): Promise<void>

  /** Items in dead status — for operator inspection. */
  findDead(tenantId?: string, limit?: number): Promise<QueueItem[]>

  countByStatus(tenantId?: string): Promise<Record<QueueItemStatus, number>>

  health(): Promise<{ ok: boolean; name: string; error?: string }>
}

// ── Backoff helper ──────────────────────────────────────────────────────────

export type BackoffOptions = {
  /** Base delay in ms. Default 30_000 (30s). */
  baseMs?: number
  /** Cap delay in ms. Default 3_600_000 (1h). */
  maxMs?: number
  /** Hard limit on retries before flipping to dead. Default 10. */
  maxAttempts?: number
}

export function computeBackoff(attempts: number, opts: BackoffOptions = {}): number {
  const base = opts.baseMs ?? 30_000
  const max = opts.maxMs ?? 3_600_000
  return Math.min(base * Math.pow(2, attempts), max)
}

export function shouldFlipToDead(attempts: number, opts: BackoffOptions = {}): boolean {
  return attempts >= (opts.maxAttempts ?? 10)
}
