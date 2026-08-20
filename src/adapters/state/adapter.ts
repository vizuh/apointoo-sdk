// BookingStateStore — durable state for booking lifecycle.
// PHI-minimization: never stores name/phone/email/message. ADR-006.
// Status enum expanded to 11 states per ADR-020.

import type { BookingAttribution } from '../../core/schemas.js'

export type BookingStateStatus =
  | 'draft'              // session started, nothing captured (ADR-020)
  | 'contact_captured'   // name/phone/email saved — real lead regardless of outcome (ADR-020)
  | 'slot_held'          // vendor hold initiated; slot soft-reserved (ADR-020)
  | 'payment_pending'    // payment processor engaged (ADR-020)
  | 'pending'            // legacy alias for slot_held/payment_pending (pre-ADR-020 adapters)
  | 'confirmed'          // vendor confirmed + state written — only "real" booking
  | 'cancelled'          // user (or operator) cancelled; vendor cancel succeeded
  | 'rescheduled'        // this slot was moved; new booking_state created for new slot (ADR-020)
  | 'no_show'            // appointment time passed; client did not appear (ADR-020)
  | 'completed'          // appointment successfully occurred (ADR-020)
  | 'failed'             // unrecoverable system/API error
  | 'expired'            // slot hold or session timed out without progression (ADR-020)
  | 'abandoned'          // sweeper marked stale; user left

/** Terminal states: no further transitions are allowed. */
export const TERMINAL_STATUSES: ReadonlySet<BookingStateStatus> = new Set([
  'cancelled',
  'rescheduled',
  'no_show',
  'completed',
  'failed',
  'expired',
  'abandoned',
])

export type BookingState = {
  submissionId: string
  tenantId: string
  status: BookingStateStatus
  vendor: string
  vendorAppointmentId: string | null
  /** Confirmed appointment start time. Used by cancellation-policy enforcement. */
  appointmentStartIso: string | null
  /** When the slot hold expires. Populated when status = 'slot_held'. ADR-020. */
  heldUntil?: Date
  /** Denormalized slot start for slot-lock queries. ADR-020. */
  slotStart?: Date
  /** When and by whom the booking was cancelled. ADR-020. */
  cancelledAt?: Date
  cancelledBy?: 'user' | 'admin' | 'system'
  cancellationReason?: string
  /** Pointer to the new submissionId when status = 'rescheduled'. ADR-020. */
  rescheduledToSubmissionId?: string
  noShowAt?: Date
  completedAt?: Date
  gclid: string | null
  fbclid: string | null
  msclkid: string | null
  utmSource: string | null
  utmMedium: string | null
  utmCampaign: string | null
  rwgToken: string | null
  /** Full attribution snapshot — persisted alongside the flat columns above for richer downstream use. */
  attribution?: BookingAttribution
  errorCode: string | null
  retryCount: number
  createdAt: Date
  updatedAt: Date
  conversionSentAt: Date | null
}

export type BookingStateCreate = Omit<
  BookingState,
  | 'status'
  | 'updatedAt'
  | 'conversionSentAt'
  | 'vendorAppointmentId'
  | 'appointmentStartIso'
  | 'errorCode'
  | 'retryCount'
> & {
  /**
   * `'draft'` is the correct initial state per ADR-020. `'pending'` is kept
   * for backwards compatibility with pre-ADR-020 adapters.
   */
  status: 'draft' | 'pending'
}

export type BookingStateTransition = {
  status: BookingStateStatus
  vendorAppointmentId?: string
  appointmentStartIso?: string
  errorCode?: string
  /** Populated when transitioning to 'cancelled'. */
  cancelledAt?: Date
  cancelledBy?: 'user' | 'admin' | 'system'
  cancellationReason?: string
  /** Populated when transitioning to 'rescheduled'. */
  rescheduledToSubmissionId?: string
  noShowAt?: Date
  completedAt?: Date
}

export interface BookingStateStore {
  /**
   * Insert a new state row. Idempotent: if `submissionId` already exists,
   * update it to `pending` (rare — only on retry of a failed BLVD createSession).
   */
  create(state: BookingStateCreate): Promise<void>

  /**
   * Move state forward. Throws if the row doesn't exist.
   * Idempotent for same status (allows retried sweeper runs).
   */
  transition(submissionId: string, change: BookingStateTransition): Promise<void>

  get(submissionId: string): Promise<BookingState | null>

  /**
   * Sweeper input: pending rows older than the threshold. Used to mark
   * abandoned + alert operator about likely orphaned vendor sessions.
   */
  findStale(olderThanMinutes: number, tenantId?: string): Promise<BookingState[]>

  /**
   * Conversion uploader input: confirmed rows with attribution and no upload yet.
   */
  findForConversion(tenantId?: string): Promise<BookingState[]>

  /**
   * Mark conversion uploaded. Call after successful Google Ads upload.
   */
  markConversionSent(submissionId: string, sentAt: Date): Promise<void>

  /**
   * Aggregate counts by status for /healthz dashboards.
   */
  countByStatus(tenantId?: string): Promise<Record<BookingStateStatus, number>>

  health(): Promise<{ ok: boolean; name: string; error?: string }>
}
