// ID + fingerprint generation. Pure functions — no IO, no side effects.

import { createHash, randomBytes } from 'node:crypto'
import type { Fingerprint, SubmissionId } from './types.js'
import type { BookingRequestInputWire } from './schemas.js'

/**
 * Generate a submission ID — `bk_YYYYMMDD_<8-char-rand>`.
 * The date portion uses the business timezone via the `sv` locale trick — same
 * approach as old kit Pattern 5. Safe across DST boundaries.
 */
export function generateSubmissionId(timezone: string, now: Date = new Date()): SubmissionId {
  const datePart = formatDateInTimezone(now, timezone).replace(/-/g, '')
  const random = randomBytes(4).toString('hex') // 8 hex chars
  return `bk_${datePart}_${random}`
}

/**
 * Mint a neutral, opaque id — `<prefix>_<24-char-rand>`. Domain-agnostic:
 * used by the ledger surface for events, visitors, sessions, subjects,
 * conversions, and tenants. Not time-encoded (unlike `generateSubmissionId`).
 */
function mintId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString('hex')}` // 24 hex chars
}

export function newEventId(): string {
  return mintId('evt')
}

export function newVisitorId(): string {
  return mintId('vis')
}

export function newSessionId(): string {
  return mintId('ses')
}

export function newSubjectId(): string {
  return mintId('sub')
}

export function newConversionId(): string {
  return mintId('cnv')
}

export function newTenantId(): string {
  return mintId('ten')
}

/**
 * Stable fingerprint of the user-identifying portion of an input.
 * Used for dedup. NOT for security — just to detect double-submits.
 *
 * Includes: name (trimmed, lowercased), phone (digits only), date, time,
 * service. Excludes: tracking, metadata, message, honeypot.
 */
export function fingerprintBookingRequest(input: BookingRequestInputWire): Fingerprint {
  const parts = [
    input.name.trim().toLowerCase(),
    digitsOnly(input.phone),
    input.requestedDate,
    input.requestedTime,
    input.serviceId,
  ]
  return createHash('sha256').update(parts.join('|')).digest('hex')
}

/**
 * Format a Date as YYYY-MM-DD in the given IANA timezone.
 * Uses the 'sv' (Swedish) locale because it returns ISO-8601 dates by default.
 */
export function formatDateInTimezone(d: Date, timezone: string): string {
  try {
    return d.toLocaleDateString('sv', { timeZone: timezone })
  } catch {
    // Invalid timezone — caller's config is broken. Fall back to UTC ISO date.
    return d.toISOString().slice(0, 10)
  }
}

function digitsOnly(s: string): string {
  return s.replace(/\D/g, '')
}
