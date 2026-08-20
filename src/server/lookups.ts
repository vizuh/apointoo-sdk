// Post-confirm operations: cancel + reschedule of an existing booking.
// Distinct from the booking pipeline (which creates new bookings).
// Looks up the vendorAppointmentId from BookingStateStore and calls the adapter.

import { errMessage } from '../core/errors.js'
import { z } from 'zod'
import type { BookingAdapter } from '../adapters/booking/adapter.js'
import type { BookingStateStore } from '../adapters/state/adapter.js'
import type { OutboundQueue } from '../queue/adapter.js'
import { hhmmSchema, isoDateSchema, type BookingKitConfig } from '../core/schemas.js'
import type { AdapterContext, Logger } from '../core/types.js'
import type { DomainEventBus } from '../core/events.js'
import { noopEventBus } from '../core/events.js'
import type { IdempotencyStore } from '../core/idempotency.js'

// ── Reschedule ──────────────────────────────────────────────────────────────

export const rescheduleBodySchema = z
  .object({
    newDate: isoDateSchema,
    newTime: hhmmSchema,
  })
  .strict()

export type RescheduleBodyInput = z.infer<typeof rescheduleBodySchema>

export type LookupResult =
  | { ok: true; status: 200; body: Record<string, unknown> }
  | { ok: false; status: 400 | 403 | 404 | 409 | 502; body: LookupErrorBody }

export type LookupErrorBody = {
  ok: false
  errorCode: string
  message: string
  retryable: boolean
}

export type RescheduleOptions = {
  config: BookingKitConfig
  booking: BookingAdapter
  stateStore: BookingStateStore
  logger: Logger
  eventBus?: DomainEventBus
  queue?: OutboundQueue
  now?: () => Date
  /** Kit #73 — Idempotency-Key replay cache (ADR-013). Optional. */
  idempotencyStore?: IdempotencyStore
  /** TTL for cached idempotent responses. Default 24h. */
  idempotencyTtlSeconds?: number
  /** Client-supplied Idempotency-Key header value for this request. */
  idempotencyKey?: string
}

export async function runReschedule(
  submissionId: string,
  bodyText: string,
  opts: RescheduleOptions,
): Promise<LookupResult> {
  const eventBus = opts.eventBus ?? noopEventBus()
  const now = opts.now ?? (() => new Date())
  const idempotencyTtl = opts.idempotencyTtlSeconds ?? 24 * 60 * 60

  // ── Idempotency-Key replay (kit #73) ────────────────────────────────────
  if (opts.idempotencyKey && opts.idempotencyStore) {
    const cached = await opts.idempotencyStore.get(opts.config.projectKey, opts.idempotencyKey)
    if (cached) return cachedToResult(cached.responseStatus, cached.responseBody)
  }

  let raw: unknown
  try {
    raw = JSON.parse(bodyText)
  } catch {
    return fail('INPUT_INVALID', 'Invalid JSON body', 400)
  }
  const parsed = rescheduleBodySchema.safeParse(raw)
  if (!parsed.success) {
    return fail('INPUT_INVALID', 'Validation failed', 400)
  }

  const state = await opts.stateStore.get(submissionId)
  if (!state) return fail('NOT_FOUND', 'Booking not found', 404)
  if (state.tenantId !== opts.config.projectKey) {
    return fail('FORBIDDEN', 'Tenant mismatch', 403)
  }

  // ── State-based idempotency: already rescheduled ─────────────────────────
  // The booking was already moved to a new slot in a prior request. Return a
  // specific code so the client can distinguish "wrong state" from "already done."
  if (state.status === 'rescheduled') {
    return fail('ALREADY_RESCHEDULED', 'Booking was already rescheduled; find the new submissionId.', 409)
  }

  if (state.status !== 'confirmed' || !state.vendorAppointmentId) {
    return fail('INVALID_STATE', `Cannot reschedule a ${state.status} booking`, 409)
  }

  const ctx: AdapterContext = { config: opts.config, logger: opts.logger, now }

  try {
    const result = await opts.booking.rescheduleByAppointment(
      state.vendorAppointmentId,
      parsed.data.newDate,
      parsed.data.newTime,
      ctx,
    )
    // Update state — keep status confirmed, just update vendorAppointmentId if changed
    if (result.vendorAppointmentId !== state.vendorAppointmentId) {
      await opts.stateStore.transition(submissionId, {
        status: 'confirmed',
        vendorAppointmentId: result.vendorAppointmentId,
      })
    }
    void eventBus.publish({
      type: 'booking.rescheduled',
      ts: Date.now(),
      tenantId: state.tenantId,
      submissionId,
      vendor: state.vendor,
      vendorAppointmentId: result.vendorAppointmentId,
      newStartIso: result.newStartIso,
    })
    const successResult: LookupResult = {
      ok: true,
      status: 200,
      body: {
        success: true,
        submissionId,
        vendorAppointmentId: result.vendorAppointmentId,
        newStartIso: result.newStartIso,
      },
    }
    // ── Cache successful reschedule for idempotent replay ──────────────────
    if (opts.idempotencyKey && opts.idempotencyStore) {
      opts.idempotencyStore
        .put(
          {
            key: opts.idempotencyKey,
            tenantId: opts.config.projectKey,
            responseStatus: successResult.status,
            responseBody: JSON.stringify(successResult.body),
            createdAt: now(),
          },
          idempotencyTtl,
        )
        .catch(() => undefined)
    }
    return successResult
  } catch (err) {
    opts.logger.error({
      evt: 'reschedule.failed',
      submissionId,
      message: errMessage(err),
    })
    return fail('BOOKING_FAILED', 'Vendor reschedule failed. Try again.', 502)
  }
}

// ── Cancel ──────────────────────────────────────────────────────────────────

export type CancelOptions = RescheduleOptions

export async function runCancel(
  submissionId: string,
  reason: string,
  opts: CancelOptions,
): Promise<LookupResult> {
  const eventBus = opts.eventBus ?? noopEventBus()
  const now = opts.now ?? (() => new Date())
  const idempotencyTtl = opts.idempotencyTtlSeconds ?? 24 * 60 * 60

  // ── Idempotency-Key replay (kit #73) ────────────────────────────────────
  if (opts.idempotencyKey && opts.idempotencyStore) {
    const cached = await opts.idempotencyStore.get(opts.config.projectKey, opts.idempotencyKey)
    if (cached) return cachedToResult(cached.responseStatus, cached.responseBody)
  }

  const state = await opts.stateStore.get(submissionId)
  if (!state) return fail('NOT_FOUND', 'Booking not found', 404)
  if (state.tenantId !== opts.config.projectKey) {
    return fail('FORBIDDEN', 'Tenant mismatch', 403)
  }

  // ── State-based idempotency: already cancelled ───────────────────────────
  // A duplicate cancel (network retry, double-click) should succeed silently.
  // ADR-020 §6: if already `cancelled`, return 200 without calling vendor again.
  if (state.status === 'cancelled') {
    return { ok: true, status: 200, body: { success: true, submissionId, cancelled: true } }
  }

  if (state.status !== 'confirmed' || !state.vendorAppointmentId) {
    return fail('INVALID_STATE', `Cannot cancel a ${state.status} booking`, 409)
  }

  // Cancellation policy enforcement (ADR-013, item 6).
  // Fires only when state has appointmentStartIso (vendor returned it on confirm).
  // If absent, policy can't be enforced — fail open (allow cancel).
  const policy = opts.config.scheduling.cancellationPolicy
  if (policy?.minHoursBefore !== undefined && state.appointmentStartIso) {
    const startMs = Date.parse(state.appointmentStartIso)
    if (!Number.isNaN(startMs)) {
      const hoursUntil = (startMs - now().getTime()) / 3_600_000
      if (hoursUntil < policy.minHoursBefore) {
        return fail(
          'CANCEL_TOO_LATE',
          `Cancellation requires at least ${policy.minHoursBefore}h notice; ${hoursUntil.toFixed(1)}h remaining.`,
          409,
        )
      }
    }
  }

  const ctx: AdapterContext = { config: opts.config, logger: opts.logger, now }

  try {
    await opts.booking.cancelByAppointment(state.vendorAppointmentId, reason, ctx)
    await opts.stateStore.transition(submissionId, {
      status: 'cancelled',
      errorCode: 'CANCELLED_BY_USER',
    })
    void eventBus.publish({
      type: 'booking.cancelled',
      ts: Date.now(),
      tenantId: state.tenantId,
      submissionId,
      reason,
    })
    const successResult: LookupResult = {
      ok: true,
      status: 200,
      body: { success: true, submissionId, cancelled: true },
    }
    // ── Cache successful cancel for idempotent replay ───────────────────────
    if (opts.idempotencyKey && opts.idempotencyStore) {
      opts.idempotencyStore
        .put(
          {
            key: opts.idempotencyKey,
            tenantId: opts.config.projectKey,
            responseStatus: successResult.status,
            responseBody: JSON.stringify(successResult.body),
            createdAt: now(),
          },
          idempotencyTtl,
        )
        .catch(() => undefined)
    }
    return successResult
  } catch (err) {
    opts.logger.error({
      evt: 'cancel.failed',
      submissionId,
      message: errMessage(err),
    })
    return fail('BOOKING_FAILED', 'Vendor cancel failed. Try again.', 502)
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function cachedToResult(responseStatus: number, responseBody: string): LookupResult {
  try {
    const body = JSON.parse(responseBody) as Record<string, unknown>
    if (responseStatus === 200) return { ok: true, status: 200, body }
    return {
      ok: false,
      status: responseStatus as 400 | 403 | 404 | 409 | 502,
      body: body as LookupErrorBody,
    }
  } catch {
    // Malformed cache entry — treat as miss; caller will re-execute.
    return fail('CACHE_PARSE_ERROR', 'Idempotency cache entry malformed', 502)
  }
}

function fail(
  errorCode: string,
  message: string,
  status: 400 | 403 | 404 | 409 | 502,
): LookupResult {
  return {
    ok: false,
    status,
    body: {
      ok: false,
      errorCode,
      message,
      retryable: status === 502,
    },
  }
}
