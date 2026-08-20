// BLVD BookingAdapter — implements the formal interface (ADR-004).
// Cart pattern: createSession owns createCart + addItem + updateCart(clientInfo).
// confirm owns cartBookableTimes + reserve + checkout. cancel owns cartCancel.

import { errMessage } from '../../../core/errors.js'
import type { BookingAdapter } from '../adapter.js'
import type {
  AdapterHealth,
  BookingAttribution,
  BookingConfirmation,
  BookingRequest,
  BookingSession,
} from '../../../core/types.js'
import { BlvdError, isBlvdError } from './errors.js'
import { createBlvdClient, type BlvdClient } from './client.js'
import {
  addBookableItem,
  addCartOffer,
  bookableStaffVariants,
  cancelAppointment,
  cancelCart,
  cartBookableDates,
  cartBookableTimes,
  checkoutCart,
  createCart,
  findMatchingSlotId,
  rescheduleAppointment,
  reserveBookableTime,
  updateCartAttribution,
  updateCartClientInfo,
} from './operations.js'
import type {
  AvailabilityQuery,
  AvailabilitySlot,
  RescheduleResult,
  StaffVariant,
  StaffVariantsQuery,
} from '../adapter.js'

export type BlvdAdapterOptions = {
  apiKey: string
  businessId: string
  apiUrl?: string
  /** Default location used when input doesn't specify one. */
  defaultLocationId: string
  /** apointoo serviceId → BLVD bookable item id */
  serviceMap: Readonly<Record<string, string>>
  /** Optional per-service location override. */
  locationMap?: Readonly<Record<string, string>>
  /** Override fetch for tests. */
  fetchImpl?: typeof fetch
}

export type BlvdSession = BookingSession & {
  vendor: 'blvd'
}

export function blvdAdapter(opts: BlvdAdapterOptions): BookingAdapter {
  const client: BlvdClient = createBlvdClient({
    apiKey: opts.apiKey,
    businessId: opts.businessId,
    ...(opts.apiUrl !== undefined ? { apiUrl: opts.apiUrl } : {}),
    ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
  })

  function resolveServiceId(internalId: string): string {
    const blvdId = opts.serviceMap[internalId]
    if (!blvdId) {
      throw new BlvdError(
        'SERVICE_NOT_MAPPED',
        `No BLVD service mapping for "${internalId}". Add to serviceMap.`,
      )
    }
    return blvdId
  }

  function resolveLocationId(internalId: string): string {
    const id = opts.locationMap?.[internalId] ?? opts.defaultLocationId
    if (!id) {
      throw new BlvdError(
        'LOCATION_MISSING',
        'No BLVD locationId resolved. Set defaultLocationId or per-service override.',
      )
    }
    return id
  }

  const adapter: BookingAdapter = {
    async createSession(input, ctx) {
      const t0 = Date.now()
      try {
        const blvdServiceId = resolveServiceId(input.serviceId)
        const locationId = resolveLocationId(input.serviceId)

        const cartId = await createCart(client, locationId)
        await addBookableItem(client, cartId, blvdServiceId)

        const [firstName, ...rest] = input.name.trim().split(/\s+/)
        await updateCartClientInfo(client, cartId, {
          firstName: firstName ?? input.name,
          ...(rest.length > 0 ? { lastName: rest.join(' ') } : {}),
          ...(input.email !== undefined ? { email: input.email } : {}),
          ...(input.phone !== undefined ? { phoneNumber: input.phone } : {}),
        })

        // Apply promo code if provided (path 5, ADR-017). Failure here throws
        // BlvdError('OFFER_REJECTED') so the booking form can show "code not
        // accepted" without conflating with other createSession errors. The
        // cart is not cleaned up — pipeline does not call cancel() on
        // createSession failures (existing kit behavior); BLVD's cart TTL
        // (~10 min) clears the orphan.
        if (input.offerCode) {
          await addCartOffer(client, cartId, input.offerCode)
        }

        ctx.logger.info({
          evt: 'blvd.createSession.ok',
          vendor: 'blvd',
          durationMs: Date.now() - t0,
          ...(input.offerCode ? { ctx: { offerApplied: 'true' } } : {}),
        })

        const session: BlvdSession = {
          vendorSessionId: cartId,
          vendor: 'blvd',
          expiresAtIso: undefined,
        }
        return session
      } catch (err) {
        ctx.logger.error({
          evt: 'blvd.createSession.failed',
          vendor: 'blvd',
          code: isBlvdError(err) ? err.code : 'UNKNOWN',
          message: errMessage(err),
          durationMs: Date.now() - t0,
        })
        throw err
      }
    },

    async attachAttribution(session, attribution: BookingAttribution, ctx) {
      const referralSource = attribution.gclid ?? attribution.fbclid ?? attribution.msclkid
      if (!referralSource) return

      const t0 = Date.now()
      try {
        const clientMessage = referralSource ? `gclid=${referralSource}` : undefined
        await updateCartAttribution(client, session.vendorSessionId, {
          ...(referralSource ? { referralSource } : {}),
          ...(clientMessage ? { clientMessage } : {}),
        })
        ctx.logger.info({
          evt: 'blvd.attachAttribution.ok',
          vendor: 'blvd',
          durationMs: Date.now() - t0,
        })
      } catch (err) {
        ctx.logger.warn({
          evt: 'blvd.attachAttribution.failed',
          vendor: 'blvd',
          code: isBlvdError(err) ? err.code : 'UNKNOWN',
          message: errMessage(err),
          durationMs: Date.now() - t0,
        })
        // Tracking failures never abort booking — re-throwing is the consumer's
        // job to opt into. Pipeline calls attachAttribution in fire-and-forget
        // wrapper anyway.
      }
    },

    async confirm(session, request: BookingRequest, ctx) {
      const t0 = Date.now()
      try {
        const tz = request.configSnapshot.timezone || 'America/New_York'
        const slots = await cartBookableTimes(
          client,
          session.vendorSessionId,
          request.requestedDate,
          tz,
        )
        const slotId = findMatchingSlotId(slots, request.requestedTime)
        if (!slotId) {
          throw new BlvdError(
            'TIME_UNAVAILABLE',
            `Slot ${request.requestedDate}T${request.requestedTime} no longer available.`,
          )
        }

        const reserveInfo = await reserveBookableTime(
          client,
          session.vendorSessionId,
          slotId,
        )

        const checkout = await checkoutCart(client, session.vendorSessionId)

        ctx.logger.info({
          evt: 'blvd.confirm.ok',
          vendor: 'blvd',
          submissionId: request.submissionId,
          durationMs: Date.now() - t0,
        })

        const conf: BookingConfirmation = {
          vendorAppointmentId: checkout.appointmentId,
          vendorClientId: checkout.clientId,
          confirmationCode: checkout.appointmentId,
          startTimeIso: reserveInfo.startTimeIso,
          metadata: {
            cartId: session.vendorSessionId,
            completedAt: checkout.completedAtIso,
          },
        }
        return conf
      } catch (err) {
        ctx.logger.error({
          evt: 'blvd.confirm.failed',
          vendor: 'blvd',
          submissionId: request.submissionId,
          code: isBlvdError(err) ? err.code : 'UNKNOWN',
          message: errMessage(err),
          durationMs: Date.now() - t0,
        })
        throw err
      }
    },

    async cancel(session, reason, ctx) {
      const t0 = Date.now()
      try {
        await cancelCart(client, session.vendorSessionId)
        ctx.logger.info({
          evt: 'blvd.cancel.ok',
          vendor: 'blvd',
          durationMs: Date.now() - t0,
          ctx: { reason },
        })
      } catch (err) {
        // Best-effort. Slot lock will expire on its own. Log and move on.
        ctx.logger.warn({
          evt: 'blvd.cancel.failed',
          vendor: 'blvd',
          code: isBlvdError(err) ? err.code : 'UNKNOWN',
          message: errMessage(err),
          durationMs: Date.now() - t0,
          ctx: { reason },
        })
      }
    },

    async findAvailability(
      query: AvailabilityQuery,
      ctx,
    ): Promise<AvailabilitySlot[]> {
      // Range-aware path (path 3 of plan-2026-05-14-blvd-expansion.md):
      // 1 + 1 + 1 + K calls instead of 1 + 1 + N. cartBookableDates returns
      // only the days with any availability; we then fetch times for those.
      const t0 = Date.now()
      try {
        const blvdServiceId = resolveServiceId(query.serviceId)
        const locationId = resolveLocationId(query.serviceId)
        const cartId = await createCart(client, locationId)
        await addBookableItem(client, cartId, blvdServiceId)

        const tz = ctx.config.timezone || 'America/New_York'
        const bookableDates = await cartBookableDates(
          client,
          cartId,
          query.fromDate,
          query.toDate,
          tz,
        )

        const slots: AvailabilitySlot[] = []
        for (const { date } of bookableDates) {
          const times = await cartBookableTimes(client, cartId, date, tz)
          for (const slot of times) {
            const hhmm =
              slot.startTime.length > 15
                ? slot.startTime.slice(11, 16)
                : slot.startTime.slice(0, 5)
            slots.push({ date, time: hhmm, vendorSlotId: slot.id })
          }
        }

        // Best-effort cleanup of the ephemeral cart
        cancelCart(client, cartId).catch(() => undefined)

        ctx.logger.info({
          evt: 'blvd.findAvailability.ok',
          vendor: 'blvd',
          durationMs: Date.now() - t0,
          ctx: { count: String(slots.length), days: String(bookableDates.length) },
        })
        return slots
      } catch (err) {
        ctx.logger.error({
          evt: 'blvd.findAvailability.failed',
          vendor: 'blvd',
          code: isBlvdError(err) ? err.code : 'UNKNOWN',
          message: errMessage(err),
          durationMs: Date.now() - t0,
        })
        throw err
      }
    },

    async cancelByAppointment(
      vendorAppointmentId: string,
      reason: string,
      ctx,
    ): Promise<void> {
      // MANUAL-VERIFY: `reason` is sent as BLVD's `notes` field
      // (the op-layer rename). Live verification blocked on sandbox creds (#21).
      const t0 = Date.now()
      try {
        await cancelAppointment(client, vendorAppointmentId, reason)
        ctx.logger.info({
          evt: 'blvd.cancelByAppointment.ok',
          vendor: 'blvd',
          durationMs: Date.now() - t0,
          ctx: { reason },
        })
      } catch (err) {
        ctx.logger.error({
          evt: 'blvd.cancelByAppointment.failed',
          vendor: 'blvd',
          code: isBlvdError(err) ? err.code : 'UNKNOWN',
          message: errMessage(err),
          durationMs: Date.now() - t0,
        })
        throw err
      }
    },

    async rescheduleByAppointment(
      vendorAppointmentId: string,
      newDate: string,
      newTime: string,
      ctx,
    ): Promise<RescheduleResult> {
      // MANUAL-VERIFY: op layer corrected per book-sdk shape
      // (bookableTimeId from availableRescheduleTimes, not raw ISO). Live
      // verification blocked on sandbox creds (#21).
      const t0 = Date.now()
      try {
        const result = await rescheduleAppointment(
          client,
          vendorAppointmentId,
          newDate,
          newTime,
        )
        ctx.logger.info({
          evt: 'blvd.rescheduleByAppointment.ok',
          vendor: 'blvd',
          durationMs: Date.now() - t0,
        })
        return {
          vendorAppointmentId: result.appointmentId,
          newStartIso: result.startTime,
        }
      } catch (err) {
        ctx.logger.error({
          evt: 'blvd.rescheduleByAppointment.failed',
          vendor: 'blvd',
          code: isBlvdError(err) ? err.code : 'UNKNOWN',
          message: errMessage(err),
          durationMs: Date.now() - t0,
        })
        throw err
      }
    },

    async findStaffVariants(
      query: StaffVariantsQuery,
      ctx,
    ): Promise<StaffVariant[]> {
      // MANUAL-VERIFY (path 4, ADR-016, pending sandbox verification):
      // BLVD requires a cart context to read staff variants. Strategy:
      // ephemeral cart → addItem → cartBookableTimes(date) → match HH:MM
      // → bookableStaffVariants(itemId, slotId) → cancelCart. 5 round trips
      // per query; not hot-path. Returns [] if no slot matches the requested
      // HH:MM (consumer should not have asked for staff at an unavailable
      // slot — but failing soft is friendlier than throwing).
      const t0 = Date.now()
      try {
        const blvdServiceId = resolveServiceId(query.serviceId)
        const locationId = resolveLocationId(query.serviceId)
        const cartId = await createCart(client, locationId)
        await addBookableItem(client, cartId, blvdServiceId)

        const tz = ctx.config.timezone || 'America/New_York'
        const slots = await cartBookableTimes(client, cartId, query.date, tz)
        const slotId = findMatchingSlotId(slots, query.time)
        if (!slotId) {
          cancelCart(client, cartId).catch(() => undefined)
          ctx.logger.info({
            evt: 'blvd.findStaffVariants.empty',
            vendor: 'blvd',
            durationMs: Date.now() - t0,
            ctx: { reason: 'slot_not_available' },
          })
          return []
        }

        const variants = await bookableStaffVariants(
          client,
          cartId,
          blvdServiceId,
          slotId,
        )

        cancelCart(client, cartId).catch(() => undefined)

        const mapped: StaffVariant[] = variants.map((v) => ({
          id: v.id,
          displayName: v.staff.displayName,
        }))
        ctx.logger.info({
          evt: 'blvd.findStaffVariants.ok',
          vendor: 'blvd',
          durationMs: Date.now() - t0,
          ctx: { count: String(mapped.length) },
        })
        return mapped
      } catch (err) {
        ctx.logger.error({
          evt: 'blvd.findStaffVariants.failed',
          vendor: 'blvd',
          code: isBlvdError(err) ? err.code : 'UNKNOWN',
          message: errMessage(err),
          durationMs: Date.now() - t0,
        })
        throw err
      }
    },

    async health(_ctx): Promise<AdapterHealth> {
      // Cheapest health check: list services on the default location requires a
      // cart. We use a no-op query — a malformed query returns a GraphQL error
      // with a recognizable shape; auth failure returns HTTP_ERROR.
      try {
        // Probe by hitting createCart with an obviously-invalid input.
        // BLVD will return a GraphQL error if auth+endpoint are working.
        await client.exec<unknown>(
          'health',
          `query { __typename }`,
        )
        return { ok: true, name: 'blvd', version: '0.1.0' }
      } catch (err) {
        return {
          ok: false,
          name: 'blvd',
          version: '0.1.0',
          error: errMessage(err),
        }
      }
    },
  }

  return adapter
}

export { BlvdError, isBlvdError } from './errors.js'
export type { BlvdErrorCode } from './errors.js'
export { listBlvdLocations, listBlvdServices } from './bootstrap.js'
export type {
  BlvdBootstrapOptions,
  BlvdLocationSummary,
  BlvdServiceCategorySummary,
} from './bootstrap.js'
