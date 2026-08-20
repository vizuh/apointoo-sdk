// Selectors — answer common questions about a booking without leaking the full
// 11-state enum or attribution snapshot shape into every consumer.

import { TERMINAL_STATUSES, type BookingState, type BookingStateStatus } from './adapter.js'

const REAL_BOOKING_STATUSES: ReadonlySet<BookingStateStatus> = new Set([
  'confirmed',
  'completed',
])

const ACTIVE_LEAD_STATUSES: ReadonlySet<BookingStateStatus> = new Set([
  'contact_captured',
  'slot_held',
  'payment_pending',
  'pending', // legacy alias for slot_held / payment_pending
])

/**
 * True for statuses representing a vendor-confirmed appointment. Use for
 * conversion uploads, attribution, revenue rollups.
 *
 * Notably excludes:
 * - `pending` / `payment_pending` / `slot_held` — still racing to confirmation.
 * - `rescheduled` — that submission is dead; the new slot has a new submissionId
 *   in `rescheduledToSubmissionId`. Trust the pointer, not this status.
 * - `no_show` — booking was real but the customer never appeared. Whether that
 *   counts as a "real booking" is policy-dependent; ask the policy layer.
 */
export function isRealBooking(status: BookingStateStatus): boolean {
  return REAL_BOOKING_STATUSES.has(status)
}

/**
 * True for statuses that allow no further transitions. Mirrors
 * `TERMINAL_STATUSES` as a function — preferred at call sites.
 */
export function isTerminal(status: BookingStateStatus): boolean {
  return TERMINAL_STATUSES.has(status)
}

/**
 * True for in-flight statuses where contact info has been captured but no
 * vendor-confirmed booking exists yet. Use for active-lead lists and
 * partial-conversion recovery.
 *
 * Does NOT cover stale leads (had contact, didn't complete: `failed`,
 * `expired`, `abandoned`). Status alone cannot answer that — the state
 * document's `contactCapturedAt` timestamp is the source of truth. Query
 * `{ status: { $in: ['failed','expired','abandoned'] }, contactCapturedAt: { $exists: true } }`
 * for that segment.
 */
export function isActiveLead(status: BookingStateStatus): boolean {
  return ACTIVE_LEAD_STATUSES.has(status)
}

/**
 * True when a row carries ANY click ID a conversion uploader could send. This
 * is an existence check used to select upload candidates — it does not choose
 * which ID to send, and imposes no ordering.
 *
 * Accepts five sources: `gclid`, `gbraid`, `wbraid`, `fbclid`, `msclkid`.
 * `gbraid` (app-to-app) and `wbraid` (web-to-app) are the iOS-era Google Ads
 * click IDs and have no flat column on `BookingState` — they are persisted
 * only inside the `attribution` snapshot — so a `gclid`-only check silently
 * drops every conversion whose click came through the iOS privacy path.
 *
 * Which Google ID actually goes on the upload, and in what precedence, is a
 * separate concern documented in `docs/attribution.md`; it is not decided here.
 *
 * Uses `||` rather than `??` so a stored empty string falls through to the next
 * candidate, matching the original per-store predicate.
 */
export function hasUploadableClickId(row: BookingState): boolean {
  return Boolean(
    row.gclid || row.attribution?.gbraid || row.attribution?.wbraid || row.fbclid || row.msclkid,
  )
}
