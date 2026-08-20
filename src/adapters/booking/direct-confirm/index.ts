// Direct-confirm BookingAdapter — production adapter for tenants with no PMS.
//
// Behaviour: createSession returns a synthetic session, confirm immediately
// returns a confirmation derived from the BookingRequest's submissionId, all
// cancel / reschedule methods are no-ops (there is no upstream vendor to
// cancel). Persistence is the responsibility of whichever PersistenceAdapter /
// BookingStateStore is wired alongside — this adapter doesn't store anything
// itself.
//
// Suitable for:
//   - Form-only lead capture (consultation request → operator follows up
//     out-of-band)
//   - Operators who maintain their own calendar manually
//   - Solo-dev SDK setups before any PMS integration
//
// NOT suitable for: any flow where a real vendor appointment needs to be
// created. Swap in `blvdAdapter` / `recalAdapter` / `opendentalAdapter` etc.
// when that's required.

import { randomUUID } from 'node:crypto'

import type {
  AvailabilityQuery,
  AvailabilitySlot,
  BookingAdapter,
  RescheduleResult,
  StaffVariant,
  StaffVariantsQuery,
} from '../adapter.js'
import type {
  AdapterContext,
  AdapterHealth,
  BookingAttribution,
  BookingConfirmation,
  BookingRequest,
  BookingSession,
} from '../../../core/types.js'
import { generateSlots, type WeeklySchedule } from '../../../core/scheduling.js'

export type DirectConfirmAdapterOptions = {
  /**
   * Optional weekly schedule used by `findAvailability()`. When absent the
   * adapter returns `[]` and the consumer must compute availability some
   * other way (or skip availability discovery entirely).
   */
  weeklySchedule?: WeeklySchedule

  /** Slot duration in minutes for `findAvailability()`. Default 60. */
  slotDurationMinutes?: number

  /**
   * Override the vendor name reported by `health()` and embedded in the
   * `BookingSession.vendor` field. Defaults to `'direct-confirm'`.
   * Useful when wrapping this adapter in a higher-level brand layer.
   */
  vendorName?: string
}

const ADAPTER_VERSION = '1.0.0'

export function directConfirmAdapter(
  opts: DirectConfirmAdapterOptions = {},
): BookingAdapter {
  const vendor = opts.vendorName ?? 'direct-confirm'
  const slotDuration = opts.slotDurationMinutes ?? 60

  return {
    async createSession(
      _input,
      _ctx: AdapterContext,
    ): Promise<BookingSession> {
      // No upstream PMS — synthesise a session id. UUID (not counter) so it
      // remains unique across instances and restarts; safe for serverless
      // and multi-process deployments.
      return {
        vendorSessionId: `dc_${randomUUID()}`,
        vendor,
        expiresAtIso: undefined,
      }
    },

    async attachAttribution(
      _session: BookingSession,
      _attribution: BookingAttribution,
      _ctx: AdapterContext,
    ): Promise<void> {
      // No-op: there is no vendor to forward attribution to. The pipeline's
      // BookingStateStore (and whichever PersistenceAdapter is wired) still
      // persist the attribution payload normally — this method only governs
      // vendor-side attribution attachment.
    },

    async confirm(
      _session: BookingSession,
      request: BookingRequest,
      _ctx: AdapterContext,
    ): Promise<BookingConfirmation> {
      // Synthesise a confirmation deterministically from the request's
      // submissionId. Same input → same vendorAppointmentId, which keeps
      // dedup retries idempotent at the adapter layer.
      return {
        vendorAppointmentId: `dc_appt_${request.submissionId}`,
        vendorClientId: undefined,
        confirmationCode: `dc_${request.submissionId.slice(-8)}`.toUpperCase(),
        startTimeIso: `${request.requestedDate}T${request.requestedTime}:00`,
        metadata: {},
      }
    },

    async cancel(
      _session: BookingSession,
      _reason: string,
      _ctx: AdapterContext,
    ): Promise<void> {
      // No-op: there is no vendor-side state to cancel. The compensation
      // contract still calls this on the failure path; we accept the call
      // and return cleanly so the pipeline's error handling stays uniform.
    },

    async health(_ctx: AdapterContext): Promise<AdapterHealth> {
      // No external dependency to probe. The adapter is always operational
      // as long as the process is.
      return { ok: true, name: vendor, version: ADAPTER_VERSION }
    },

    async findAvailability(
      query: AvailabilityQuery,
      _ctx: AdapterContext,
    ): Promise<AvailabilitySlot[]> {
      if (!opts.weeklySchedule) return []
      const slots = generateSlots({
        weeklySchedule: opts.weeklySchedule,
        fromDate: query.fromDate,
        toDate: query.toDate,
        slotDurationMinutes: slotDuration,
      })
      return slots.map((s) => ({ date: s.date, time: s.time }))
    },

    async cancelByAppointment(
      _vendorAppointmentId: string,
      _reason: string,
      _ctx: AdapterContext,
    ): Promise<void> {
      // No-op: there is no vendor-side appointment to cancel.
    },

    async rescheduleByAppointment(
      vendorAppointmentId: string,
      newDate: string,
      newTime: string,
      _ctx: AdapterContext,
    ): Promise<RescheduleResult> {
      // Echo the input — same appointment id, new start time. Persistence
      // adapter (or the calling pipeline) is responsible for updating the
      // stored booking record.
      return {
        vendorAppointmentId,
        newStartIso: `${newDate}T${newTime}:00`,
      }
    },

    async findStaffVariants(
      _query: StaffVariantsQuery,
      _ctx: AdapterContext,
    ): Promise<StaffVariant[]> {
      // No staff model at the adapter layer. Tenants that need per-slot
      // staff selection should use the BLVD adapter (or extend the kit
      // when a non-BLVD vendor with staff support appears).
      return []
    },
  }
}
