/**
 * Audit-log subscriber — kit #76.
 *
 * Hooks into the domain event bus via `subscribeAll` and writes a durable
 * record to `audit_log` for every domain event the pipeline emits.
 *
 * Key properties (following ADR-018 §8 and cal.com BookingAudit pattern):
 *   - Entries use a plain string `submissionId`, not a FK — they survive
 *     booking_state deletes and GDPR erasure (they record *that* something
 *     happened, not what the content was).
 *   - `eventId` is deterministic: same event re-emitted → same ID → the
 *     unique index on `audit_log.eventId` makes the write idempotent.
 *   - Subscriber is fail-open: a write failure is logged but never propagates
 *     to the caller. Audit lag is preferable to booking failure.
 *   - `idempotencyKey` is stripped from payloads before persistence (minor
 *     privacy surface — clients sometimes encode user-visible tokens as IK).
 *
 * Usage (in consumer, e.g. Next.js route.ts or Express app):
 * ```ts
 * import { inMemoryEventBus } from '@vizuh/apointoo-sdk/core/events'
 * import { createAuditLogSubscriber } from '@vizuh/apointoo-sdk/adapters/audit'
 * import { mongoAuditLogWriter } from '@/lib/audit/mongo-audit-writer'
 *
 * const bus = inMemoryEventBus({ onSubscriberError: console.error })
 * const auditUnsub = createAuditLogSubscriber(mongoAuditLogWriter(db), bus)
 * // auditUnsub() to detach (useful in tests)
 * ```
 */

import { createHash } from 'node:crypto'
import type { DomainEvent, DomainEventBus, DomainEventType } from '../../core/events.js'

// ── Types ─────────────────────────────────────────────────────────────────────

export type AuditLogEntry = {
  /**
   * Stable, deterministic ID derived from event identity fields.
   * Keyed by a unique index — duplicate events produce the same ID and the
   * second write is rejected silently (idempotent on replay / sweeper rerun).
   */
  eventId: string
  /** Event wall-clock time as a Date (converted from event.ts Unix ms). */
  ts: Date
  tenantId: string
  eventType: DomainEventType
  /** Submission ID this event relates to (always present per DomainEventBase). */
  submissionId: string
  /**
   * Event payload with sensitive fields stripped.
   * Never contains PII, idempotency keys, or raw vendor tokens.
   */
  payload: Record<string, unknown>
  schemaVersion: 1
}

/**
 * Thin write interface. Implement against whatever persistence layer the
 * consumer uses. The kit ships with no concrete implementation (to avoid
 * hard-wiring a driver); the dashboard provides `mongoAuditLogWriter`.
 */
export interface AuditLogWriter {
  /**
   * Persist one audit entry. Must be idempotent on `entry.eventId` —
   * i.e. a duplicate eventId must not throw, just silently ignore.
   */
  write(entry: AuditLogEntry): Promise<void>
}

// ── Subscriber ────────────────────────────────────────────────────────────────

/**
 * Attach an audit-log subscriber to `bus`. Subscribes to all events and
 * maps each to an `AuditLogEntry` written via `writer`.
 *
 * Returns an unsubscribe function — call it to detach (useful in tests and
 * graceful shutdown handlers).
 */
export function createAuditLogSubscriber(
  writer: AuditLogWriter,
  bus: DomainEventBus,
  opts: { onError?: (event: DomainEvent, err: unknown) => void } = {},
): () => void {
  return bus.subscribeAll(async (event) => {
    try {
      const entry = eventToEntry(event)
      await writer.write(entry)
    } catch (err) {
      opts.onError?.(event, err)
      // Fail-open: swallow. Audit lag is acceptable; booking failure is not.
    }
  })
}

// ── Event → Entry mapping ─────────────────────────────────────────────────────

function eventToEntry(event: DomainEvent): AuditLogEntry {
  return {
    eventId: deriveEventId(event),
    ts: new Date(event.ts),
    tenantId: event.tenantId,
    eventType: event.type,
    submissionId: event.submissionId,
    payload: sanitizePayload(event),
    schemaVersion: 1,
  }
}

/**
 * Deterministic event ID: sha256 of "type:tenantId:submissionId:ts".
 * Hex-encoded, truncated to 32 chars (collision probability negligible for
 * the event volumes this system handles).
 */
function deriveEventId(event: DomainEvent): string {
  const raw = `${event.type}:${event.tenantId}:${event.submissionId}:${event.ts}`
  return createHash('sha256').update(raw).digest('hex').slice(0, 32)
}

/**
 * Strict allow-list: only fields known to be definitionally non-PII are
 * persisted. Anything not in the list is dropped silently.
 *
 * Why allow-list instead of deny-list: a future event-type addition could
 * accidentally introduce PII into the payload (e.g. a `customerEmail` for
 * debugging). With a deny-list the field would silently land in audit_log
 * with the 6-year TTL and become an un-erasable HIPAA/GDPR liability. With
 * an allow-list, the new field is dropped by default and an explicit
 * decision is required to mark it audit-safe.
 *
 * To add a new field: append it to AUDIT_SAFE_FIELDS below AND confirm it
 * cannot contain user-supplied free text or identifiers. When in doubt,
 * don't add it — audit log is for "did event X happen for tenant Y", not
 * for event content.
 */
const AUDIT_SAFE_FIELDS: ReadonlySet<string> = new Set([
  // Vendor identifiers (opaque external IDs, not PII)
  'vendor',
  'vendorSessionId',
  'vendorAppointmentId',
  'vendorClientId',
  // Service / pipeline metadata
  'serviceId',
  'stage',
  'errorCode',
  'reason',
  'ageMinutes',
  'fingerprint',
  // Status fields
  'status',
  'vendorStatus',
  // Compensation context
  'originalErrorCode',
  'cancelError',
  // Time fields (already ISO-formatted, no PII)
  'newStartIso',
  'occurredAtIso',
  // Attribution — recursively allow-listed below
  'attribution',
])

/**
 * Attribution is already zod-strict in core/schemas.ts (no PII fields by
 * design), but we re-allow-list at the audit boundary for defense-in-depth:
 * if attribution ever grows a PII field (e.g. captured IP), the audit log
 * stays clean unless explicitly opted in.
 */
const AUDIT_SAFE_ATTRIBUTION_FIELDS: ReadonlySet<string> = new Set([
  'gclid',
  'gbraid',
  'wbraid',
  'fbclid',
  'msclkid',
  'utmSource',
  'utmMedium',
  'utmCampaign',
  'utmTerm',
  'utmContent',
  'referrer',
  'pageUrl',
  'pageTitle',
  'channel',
  'sessionId',
  'visitorId',
  'consentGiven',
  'capturedAt',
  'consent',
])

const AUDIT_SAFE_CONSENT_FIELDS: ReadonlySet<string> = new Set([
  'adStorage',
  'analyticsStorage',
  'adUserData',
  'adPersonalization',
  'capturedAt',
  'source',
])

function sanitizeConsent(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (AUDIT_SAFE_CONSENT_FIELDS.has(k)) out[k] = v
  }
  return out
}

function sanitizeAttribution(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === 'consent') {
      const safe = sanitizeConsent(v)
      if (safe !== undefined) out[k] = safe
      continue
    }
    if (AUDIT_SAFE_ATTRIBUTION_FIELDS.has(k)) out[k] = v
  }
  return out
}

function sanitizePayload(event: DomainEvent): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(event as Record<string, unknown>)) {
    if (!AUDIT_SAFE_FIELDS.has(key)) continue
    if (key === 'attribution') {
      const safe = sanitizeAttribution(val)
      if (safe !== undefined) out[key] = safe
      continue
    }
    out[key] = val
  }
  return out
}
