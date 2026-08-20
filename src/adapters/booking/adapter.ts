// BookingAdapter — formal interface vendors implement.
// See ADR-004 (decisions/adr-004-adapter-pattern-formalized.md) for rationale.

import type {
  AdapterContext,
  AdapterHealth,
  BookingAttribution,
  BookingConfirmation,
  BookingRequest,
  BookingSession,
} from '../../core/types.js'

export type AvailabilityQuery = {
  serviceId: string
  /** YYYY-MM-DD inclusive. */
  fromDate: string
  /** YYYY-MM-DD inclusive. */
  toDate: string
}

export type AvailabilitySlot = {
  /** YYYY-MM-DD in the business timezone. */
  date: string
  /** HH:MM 24h. */
  time: string
  /** Optional vendor-specific opaque id (e.g., BLVD bookableTimeId). */
  vendorSlotId?: string
}

export type RescheduleResult = {
  vendorAppointmentId: string
  newStartIso: string
}

export type StaffVariantsQuery = {
  serviceId: string
  /** YYYY-MM-DD in the business timezone. */
  date: string
  /** HH:MM 24h in the business timezone. */
  time: string
}

export type StaffVariant = {
  /** Vendor-specific id — opaque token consumers later pass back to select this staff. */
  id: string
  /** Human-readable name for the picker UI. */
  displayName: string
}

export interface BookingAdapter {
  /**
   * Create a vendor-side session from validated input.
   * Idempotent contract: calling with the same input may produce a new session,
   * but no duplicate appointment is created (because confirm() is the only
   * step that books the slot).
   */
  createSession(
    input: {
      serviceId: string
      name: string
      phone: string
      email: string | undefined
      requestedDate: string
      requestedTime: string
      /**
       * Optional promo code. Vendors with no promo concept ignore.
       * BLVD applies via addCartOffer; rejection surfaces as
       * `BlvdError('OFFER_REJECTED')`. See ADR-017.
       */
      offerCode: string | undefined
    },
    ctx: AdapterContext,
  ): Promise<BookingSession>

  /**
   * Attach attribution data (gclid, fbclid, etc.) to the session.
   * Idempotent: attaching the same data twice is a no-op.
   * Errors are logged by the pipeline and never abort the booking.
   */
  attachAttribution(
    session: BookingSession,
    attribution: BookingAttribution,
    ctx: AdapterContext,
  ): Promise<void>

  /**
   * Confirm the booking — books the slot, creates the appointment.
   * NOT retried automatically by the pipeline (ADR-004).
   * On rejection, the pipeline calls cancel(session) before propagating.
   */
  confirm(
    session: BookingSession,
    request: BookingRequest,
    ctx: AdapterContext,
  ): Promise<BookingConfirmation>

  /**
   * Compensation. Called by the pipeline if confirm() rejects.
   * Best-effort and idempotent — adapters log failures, never re-throw.
   * Vendor cleanup (cart cancel, reservation release) happens here.
   */
  cancel(session: BookingSession, reason: string, ctx: AdapterContext): Promise<void>

  /**
   * Connectivity probe. Used at deploy time and by /healthz.
   * Should be cheap (token validation, ping endpoint, etc.).
   */
  health(ctx: AdapterContext): Promise<AdapterHealth>

  /**
   * Discover available slots for a service over a date range.
   * Used by GET /availability. Implementations:
   *   - Memory: returns slots from config-derived weekly schedule
   *   - BLVD: ephemeral cart + cartBookableTimes (more accurate, ~3 round trips)
   *   - OpenDental: skeleton — throws until impl
   */
  findAvailability(
    query: AvailabilityQuery,
    ctx: AdapterContext,
  ): Promise<AvailabilitySlot[]>

  /**
   * Cancel a previously confirmed appointment by vendor appointment id.
   * Distinct from `cancel(session)` which is in-flight saga compensation.
   * Idempotent: second call is a no-op or returns the same outcome.
   */
  cancelByAppointment(
    vendorAppointmentId: string,
    reason: string,
    ctx: AdapterContext,
  ): Promise<void>

  /**
   * Reschedule a previously confirmed appointment to a new slot.
   * Returns the new vendor appointment id (may equal old id if vendor
   * mutates in place, or new if vendor creates a new appointment).
   */
  rescheduleByAppointment(
    vendorAppointmentId: string,
    newDate: string, // YYYY-MM-DD
    newTime: string, // HH:MM
    ctx: AdapterContext,
  ): Promise<RescheduleResult>

  /**
   * Discover which staff members are available for a given slot. Used by
   * the "book with X" UI affordance. Calendar-only or single-staff vendors
   * return `[]` — caller-visible behavior is "no staff picker shown".
   * Read-only: this method must not mutate vendor-side state.
   * See ADR-016.
   */
  findStaffVariants(
    query: StaffVariantsQuery,
    ctx: AdapterContext,
  ): Promise<StaffVariant[]>
}
