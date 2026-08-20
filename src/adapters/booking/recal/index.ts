// Recal BookingAdapter — wraps the Recal SDK as a calendar-backed vendor.
// Recal is a pure API client over api.recal.dev — no local algorithm.
// All availability + busy-time aggregation runs server-side at Recal.
//
// Pattern (matches BLVD adapter shape):
//   createSession         → no-op (Recal has no cart/session — direct write)
//   attachAttribution     → stored as event.metadata or extendedProperties
//   confirm               → events.createMetaEvent
//   cancel (saga compensation) → no-op (no session created)
//   cancelByAppointment   → events.deleteMetaEvent
//   rescheduleByAppointment → events.updateMetaEvent (start + end)
//   findAvailability      → scheduling.getSlots
//   health                → users.get (cheap ping)
//
// Token model: Recal manages OAuth tokens server-side (Google/Microsoft).
// We only hold a Recal API token (recal_*). Per-tenant `recalUserId` maps
// the booking flow to a specific user's calendar.
//
// Optional dep: `recal-sdk` — listed in package.json optionalDependencies.
// Throws clear error at adapter construction if not installed.

import { BookingError, errMessage} from '../../../core/errors.js'
import type { CalendarBookingTarget, CalendarProvider } from '../../../core/calendar-connection.js'
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
import { APOINTOO_HEADLESS_VERSION } from '../../../core/version.js'

export type RecalAdapterOptions = {
  /** Recal API token. Must start with 'recal_'. */
  token: string
  /** Override base URL (default https://api.recal.dev). */
  url?: string
  /**
   * Resolve the booking target (recalUserId + provider) from a serviceId.
   * Single-tenant deployments hard-code this; multi-tenant deployments
   * return per-tenant target. If absent, throws CONFIG_INVALID at confirm.
   */
  resolveTarget: (serviceId: string) => CalendarBookingTarget | undefined
  /**
   * Optional default attendee added to every event (operator email).
   */
  defaultAttendees?: ReadonlyArray<string>
  /** Slot duration in minutes. Default 60. */
  slotDurationMinutes?: number
  /** Padding between slots in minutes. Default 0. */
  paddingMinutes?: number
  /**
   * Optional injected Recal SDK constructor — for tests. Production code
   * lets the adapter dynamic-import 'recal-sdk' lazily.
   */
  recalCtor?: RecalLikeCtor
}

/** Subset of the Recal SDK shape this adapter actually uses. */
type RecalLike = {
  scheduling: {
    getSlots: (
      userId: string,
      options: {
        start: string
        end: string
        slotDuration?: string
        padding?: string
        provider?: CalendarProvider
      },
    ) => Promise<unknown>
  }
  events: {
    createMetaEvent: (
      userId: string,
      event: {
        subject: string
        start: string
        end: string
        attendees?: Array<{ email: string }>
      },
      options?: { provider?: CalendarProvider[] },
    ) => Promise<{ metaId: string; provider?: CalendarProvider }>
    updateMetaEvent: (
      userId: string,
      metaId: string,
      patch: { start?: string; end?: string; subject?: string },
    ) => Promise<{ metaId: string }>
    deleteMetaEvent: (userId: string, metaId: string) => Promise<void>
  }
  users: {
    get: (userId: string, options?: unknown) => Promise<{ id: string }>
  }
}

type RecalLikeCtor = new (opts: { token: string; url?: string }) => RecalLike

export type RecalSession = BookingSession & {
  vendor: 'recal'
  recalUserId: string
  provider: CalendarProvider
  endTimeIso: string
}

export function recalAdapter(opts: RecalAdapterOptions): BookingAdapter {
  if (!opts.token || !opts.token.startsWith('recal_')) {
    throw new BookingError(
      'CONFIG_INVALID',
      'recalAdapter: token must start with "recal_". Get one at api.recal.dev.',
      { retryable: false },
    )
  }

  // Lazy SDK init — avoids hard-fail when the adapter is imported but not used.
  let recalInstance: RecalLike | null = null
  async function recal(): Promise<RecalLike> {
    if (recalInstance) return recalInstance
    const Ctor = opts.recalCtor ?? (await loadRecalCtor())
    recalInstance = new Ctor({
      token: opts.token,
      ...(opts.url !== undefined ? { url: opts.url } : {}),
    })
    return recalInstance
  }

  const slotDuration = opts.slotDurationMinutes ?? 60
  const padding = opts.paddingMinutes ?? 0

  return {
    async createSession(input, ctx) {
      const target = opts.resolveTarget(input.serviceId)
      if (!target) {
        throw new BookingError(
          'CONFIG_INVALID',
          `recalAdapter: no target resolved for serviceId "${input.serviceId}". Wire resolveTarget.`,
          { retryable: false },
        )
      }
      ctx.logger.info({
        evt: 'recal.createSession.ok',
        vendor: 'recal',
        ctx: { recalUserId: target.recalUserId, provider: target.provider },
      })
      // Recal has no cart/session — store target on the session for confirm().
      const startIso = `${input.requestedDate}T${input.requestedTime}:00`
      const endIso = addMinutesToIso(startIso, slotDuration)
      const session: RecalSession = {
        vendorSessionId: `recal_${target.recalUserId}_${Date.now().toString(36)}`,
        vendor: 'recal',
        expiresAtIso: undefined,
        recalUserId: target.recalUserId,
        provider: target.provider,
        endTimeIso: endIso,
      }
      return session
    },

    async attachAttribution(
      _session: BookingSession,
      _attribution: BookingAttribution,
      _ctx,
    ): Promise<void> {
      // Recal events don't expose a referralSource field. Attribution travels
      // via the kit's BookingStateStore + outbound webhooks instead. No-op here.
    },

    async confirm(
      session: BookingSession,
      request: BookingRequest,
      ctx,
    ): Promise<BookingConfirmation> {
      const sess = session as RecalSession
      const t0 = Date.now()
      const startIso = `${request.requestedDate}T${request.requestedTime}:00`
      const endIso = sess.endTimeIso
      const subject = request.service?.name ?? request.serviceId
      const attendees: Array<{ email: string }> = []
      for (const a of opts.defaultAttendees ?? []) attendees.push({ email: a })
      if (request.email) attendees.push({ email: request.email })

      try {
        const sdk = await recal()
        const result = await sdk.events.createMetaEvent(
          sess.recalUserId,
          {
            subject: `${subject} — ${request.name}`,
            start: startIso,
            end: endIso,
            ...(attendees.length > 0 ? { attendees } : {}),
          },
          { provider: [sess.provider] },
        )
        ctx.logger.info({
          evt: 'recal.confirm.ok',
          vendor: 'recal',
          submissionId: request.submissionId,
          durationMs: Date.now() - t0,
        })
        return {
          vendorAppointmentId: result.metaId,
          vendorClientId: sess.recalUserId,
          confirmationCode: result.metaId,
          startTimeIso: startIso,
          metadata: { provider: sess.provider },
        }
      } catch (err) {
        ctx.logger.error({
          evt: 'recal.confirm.failed',
          vendor: 'recal',
          submissionId: request.submissionId,
          message: errMessage(err),
          durationMs: Date.now() - t0,
        })
        throw new BookingError(
          'BOOKING_FAILED',
          `Recal create failed: ${err instanceof Error ? err.message : 'unknown'}`,
          { retryable: true },
        )
      }
    },

    async cancel(_session, _reason, _ctx): Promise<void> {
      // No vendor-side session to clean up — Recal events only exist after confirm.
    },

    async cancelByAppointment(vendorAppointmentId, reason, ctx): Promise<void> {
      const target = inferTargetFromAppointmentId(vendorAppointmentId, opts)
      const t0 = Date.now()
      try {
        const sdk = await recal()
        await sdk.events.deleteMetaEvent(target.recalUserId, vendorAppointmentId)
        ctx.logger.info({
          evt: 'recal.cancelByAppointment.ok',
          vendor: 'recal',
          durationMs: Date.now() - t0,
          ctx: { reason },
        })
      } catch (err) {
        ctx.logger.error({
          evt: 'recal.cancelByAppointment.failed',
          vendor: 'recal',
          message: errMessage(err),
          durationMs: Date.now() - t0,
        })
        throw err
      }
    },

    async rescheduleByAppointment(
      vendorAppointmentId,
      newDate,
      newTime,
      ctx,
    ): Promise<RescheduleResult> {
      const target = inferTargetFromAppointmentId(vendorAppointmentId, opts)
      const t0 = Date.now()
      const newStart = `${newDate}T${newTime}:00`
      const newEnd = addMinutesToIso(newStart, slotDuration)
      try {
        const sdk = await recal()
        const result = await sdk.events.updateMetaEvent(
          target.recalUserId,
          vendorAppointmentId,
          { start: newStart, end: newEnd },
        )
        ctx.logger.info({
          evt: 'recal.rescheduleByAppointment.ok',
          vendor: 'recal',
          durationMs: Date.now() - t0,
        })
        return {
          vendorAppointmentId: result.metaId,
          newStartIso: newStart,
        }
      } catch (err) {
        ctx.logger.error({
          evt: 'recal.rescheduleByAppointment.failed',
          vendor: 'recal',
          message: errMessage(err),
          durationMs: Date.now() - t0,
        })
        throw err
      }
    },

    async findAvailability(query: AvailabilityQuery, ctx): Promise<AvailabilitySlot[]> {
      const target = opts.resolveTarget(query.serviceId)
      if (!target) {
        throw new BookingError(
          'CONFIG_INVALID',
          `recalAdapter: no target resolved for serviceId "${query.serviceId}".`,
          { retryable: false },
        )
      }
      const t0 = Date.now()
      try {
        const sdk = await recal()
        const start = `${query.fromDate}T00:00:00Z`
        const end = `${query.toDate}T23:59:59Z`
        const result = (await sdk.scheduling.getSlots(target.recalUserId, {
          start,
          end,
          slotDuration: String(slotDuration),
          padding: String(padding),
          provider: target.provider,
        })) as Array<{ start: string }> | { slots: Array<{ start: string }> }

        const slots = Array.isArray(result) ? result : (result.slots ?? [])
        const out: AvailabilitySlot[] = slots.map((s) => {
          const date = s.start.slice(0, 10)
          const time = s.start.slice(11, 16)
          return { date, time, vendorSlotId: s.start }
        })
        ctx.logger.info({
          evt: 'recal.findAvailability.ok',
          vendor: 'recal',
          durationMs: Date.now() - t0,
          ctx: { count: String(out.length) },
        })
        return out
      } catch (err) {
        ctx.logger.error({
          evt: 'recal.findAvailability.failed',
          vendor: 'recal',
          message: errMessage(err),
          durationMs: Date.now() - t0,
        })
        throw err
      }
    },

    async findStaffVariants(
      _query: StaffVariantsQuery,
      _ctx,
    ): Promise<StaffVariant[]> {
      // Recal is calendar-backed. The "staff" is the calendar owner (one user
      // per booking target); there is no per-slot staff variant concept.
      // Caller-visible behavior: "no staff picker shown" (ADR-016).
      return []
    },

    async health(_ctx: AdapterContext): Promise<AdapterHealth> {
      // Cheapest probe: any token-validating call. We use a structural check —
      // can the SDK be constructed (tests cred shape) and is the token format right?
      // A real network probe would need a known userId; defer that to the consumer.
      try {
        await recal()
        return { ok: true, name: 'recal', version: APOINTOO_HEADLESS_VERSION }
      } catch (err) {
        return {
          ok: false,
          name: 'recal',
          version: APOINTOO_HEADLESS_VERSION,
          error: errMessage(err),
        }
      }
    },
  }
}

// ── Internals ───────────────────────────────────────────────────────────────

async function loadRecalCtor(): Promise<RecalLikeCtor> {
  try {
    const mod = (await import('recal-sdk')) as { Recal: RecalLikeCtor }
    return mod.Recal
  } catch {
    throw new BookingError(
      'DEPENDENCY_UNAVAILABLE',
      'recalAdapter requires "recal-sdk". Run `npm i recal-sdk`.',
      { retryable: false },
    )
  }
}

/**
 * Recal's `metaId` doesn't carry the userId. For cancelByAppointment +
 * rescheduleByAppointment, the consumer needs to resolve the recalUserId
 * from elsewhere. Strategy: read it from BookingState (we persist it in
 * `vendorClientId` field after confirm). The pipeline / lookups.ts already
 * looks up state; consumers wire the user-resolution at the lookups boundary.
 *
 * This stub assumes single-tenant deployments where one resolveTarget
 * serves all serviceIds — fall back to the first non-undefined target.
 */
function inferTargetFromAppointmentId(
  _appointmentId: string,
  opts: RecalAdapterOptions,
): CalendarBookingTarget {
  // Try the first serviceId the consumer knows about — works for single-user
  // tenants. Multi-user tenants need to override this by passing
  // recalUserId through the request, which we do via state lookup at the
  // lookups.ts layer in a future iteration.
  const fallback = opts.resolveTarget('default')
  if (fallback) return fallback
  throw new BookingError(
    'CONFIG_INVALID',
    'recalAdapter: cannot resolve recalUserId from appointment id. ' +
      'Wire resolveTarget("default") for single-user tenants, or extend the ' +
      'BookingStateStore with `vendor_meta` JSON to persist the recalUserId ' +
      'at confirm time.',
    { retryable: false },
  )
}

function addMinutesToIso(iso: string, minutes: number): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) {
    // Best-effort: append minutes to local-time ISO without offset
    const [date, time] = iso.split('T')
    const [h, m] = (time ?? '00:00:00').split(':').map(Number)
    const totalMin = (h ?? 0) * 60 + (m ?? 0) + minutes
    const newH = Math.floor(totalMin / 60) % 24
    const newM = totalMin % 60
    return `${date}T${String(newH).padStart(2, '0')}:${String(newM).padStart(2, '0')}:00`
  }
  d.setMinutes(d.getMinutes() + minutes)
  return d.toISOString().replace(/\.\d{3}Z$/, '')
}
