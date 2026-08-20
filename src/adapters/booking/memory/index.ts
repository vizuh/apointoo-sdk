// In-memory booking adapter — for tests and dev.
// Records every call so test assertions can inspect orchestration order.

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

export type MemoryBookingAdapterOptions = {
  /** Force confirm() to reject — for compensation tests. */
  failConfirmWith?: Error
  /** Force createSession() to reject. */
  failCreateSessionWith?: Error
  /** Optional weekly schedule for findAvailability. If absent, returns []. */
  weeklySchedule?: WeeklySchedule
  /** Slot duration for memory availability. Default 60. */
  slotDurationMinutes?: number
}

export type MemoryBookingAdapterCalls = {
  createSession: number
  attachAttribution: number
  confirm: number
  cancel: Array<{ session: BookingSession; reason: string }>
}

export type MemoryBookingAdapter = BookingAdapter & {
  calls: MemoryBookingAdapterCalls
}

export function memoryBookingAdapter(
  opts: MemoryBookingAdapterOptions = {},
): MemoryBookingAdapter {
  let counter = 0
  const calls: MemoryBookingAdapterCalls = {
    createSession: 0,
    attachAttribution: 0,
    confirm: 0,
    cancel: [],
  }

  const adapter: BookingAdapter = {
    async createSession(_input, _ctx: AdapterContext): Promise<BookingSession> {
      calls.createSession += 1
      if (opts.failCreateSessionWith) throw opts.failCreateSessionWith
      counter += 1
      return {
        vendorSessionId: `mem_session_${counter}`,
        vendor: 'memory',
        expiresAtIso: new Date(Date.now() + 600_000).toISOString(),
      }
    },
    async attachAttribution(
      _session: BookingSession,
      _attribution: BookingAttribution,
      _ctx: AdapterContext,
    ): Promise<void> {
      calls.attachAttribution += 1
    },
    async confirm(
      session: BookingSession,
      _request: BookingRequest,
      _ctx: AdapterContext,
    ): Promise<BookingConfirmation> {
      calls.confirm += 1
      if (opts.failConfirmWith) throw opts.failConfirmWith
      return {
        vendorAppointmentId: `mem_appt_${session.vendorSessionId}`,
        vendorClientId: `mem_client_${session.vendorSessionId}`,
        confirmationCode: `mem_conf_${session.vendorSessionId}`,
        startTimeIso: undefined,
        metadata: {},
      }
    },
    async cancel(
      session: BookingSession,
      reason: string,
      _ctx: AdapterContext,
    ): Promise<void> {
      calls.cancel.push({ session, reason })
    },
    async health(_ctx: AdapterContext): Promise<AdapterHealth> {
      return { ok: true, name: 'memory', version: '0.1.0' }
    },

    async findAvailability(query: AvailabilityQuery, _ctx): Promise<AvailabilitySlot[]> {
      if (!opts.weeklySchedule) return []
      const slots = generateSlots({
        weeklySchedule: opts.weeklySchedule,
        fromDate: query.fromDate,
        toDate: query.toDate,
        slotDurationMinutes: opts.slotDurationMinutes ?? 60,
      })
      return slots.map((s) => ({ date: s.date, time: s.time }))
    },

    async cancelByAppointment(
      vendorAppointmentId: string,
      reason: string,
      _ctx,
    ): Promise<void> {
      // Memory adapter doesn't track appointments durably; treat as no-op.
      // Tests assert via state store, not vendor-side.
      void vendorAppointmentId
      void reason
    },

    async rescheduleByAppointment(
      vendorAppointmentId: string,
      newDate: string,
      newTime: string,
      _ctx,
    ): Promise<RescheduleResult> {
      return {
        vendorAppointmentId, // memory: same id, no recreation
        newStartIso: `${newDate}T${newTime}:00`,
      }
    },

    async findStaffVariants(
      _query: StaffVariantsQuery,
      _ctx,
    ): Promise<StaffVariant[]> {
      // Memory adapter has no staff model; return []. Caller-visible
      // behavior: "no staff picker shown". Tests that exercise staff
      // selection should use the BLVD adapter against a fetch stub.
      return []
    },
  }

  return Object.assign(adapter, { calls })
}
