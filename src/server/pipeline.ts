// Pipeline — orchestrates the booking flow from validated input to response.
// Pattern 4 (route order) lives here and only here. Consumers don't re-implement.

import type { BookingAdapter } from '../adapters/booking/adapter.js'
import type { PersistenceAdapter } from '../adapters/persistence/adapter.js'
import type { Notifier } from '../adapters/notification/adapter.js'
import type { DedupStore } from '../adapters/dedup/adapter.js'
import type { RateLimitStore } from '../adapters/ratelimit/adapter.js'
import type { BookingStateCreate, BookingStateStore } from '../adapters/state/adapter.js'
import type { OutboundQueue, QueueChannel } from '../queue/adapter.js'
import type { OutboxWriter } from '../queue/outbox.js'
import { BookingError, isBookingError, errMessage} from '../core/errors.js'
import { isBlvdError } from '../adapters/booking/blvd/errors.js'
import {
  bookingRequestInputSchema,
  type BookingKitConfig,
} from '../core/schemas.js'
import {
  fingerprintBookingRequest,
  generateSubmissionId,
} from '../core/ids.js'
import type {
  AdapterContext,
  BookingAttribution,
  BookingRequest,
  Logger,
} from '../core/types.js'
import { boundedStack, withContext } from './logger.js'
import { bookingToRow } from '../core/persistence-row.js'
import { readAttribution } from '../attribution/index.js'
import {
  noopEventBus,
  type DomainEventBus,
} from '../core/events.js'
import {
  type IdempotencyKey,
  type IdempotencyStore,
} from '../core/idempotency.js'

export type PipelineOptions = {
  config: BookingKitConfig
  booking: BookingAdapter
  persistence: PersistenceAdapter
  notification: Notifier
  dedup: DedupStore
  rateLimit?: RateLimitStore
  /**
   * Optional: durable booking state. When wired, the pipeline writes
   * 'pending' before booking adapter calls and transitions to
   * 'confirmed'/'failed' after. Required for sweeper recovery + Tier-3 conv
   * upload. See ADR-006.
   */
  stateStore?: BookingStateStore
  /**
   * Optional: outbound notification queue. When wired, the pipeline enqueues
   * notifications instead of sending inline. The queue worker delivers them
   * with retry. See ADR-006.
   */
  queue?: OutboundQueue
  /**
   * Optional: transactional outbox writer. When BOTH stateStore + queue are
   * wired AND outbox is provided, the pipeline writes state + queue items
   * atomically via the outbox (recommended for prod). See ADR-012.
   */
  outbox?: OutboxWriter
  /**
   * When `queue` is set, the pipeline still calls `notification` directly
   * by default (immediate UX). Set to `true` to skip the inline send and
   * rely entirely on the worker.
   */
  queueOnly?: boolean
  /**
   * Optional: domain event bus for cross-cutting subscribers (audit,
   * conversions, custom). Defaults to noop. See ADR-012.
   */
  eventBus?: DomainEventBus
  /**
   * Optional: idempotency store for client-supplied Idempotency-Key
   * replay caching. See ADR-013.
   */
  idempotencyStore?: IdempotencyStore
  /** TTL in seconds for cached idempotent responses. Default 24h. */
  idempotencyTtlSeconds?: number
  logger: Logger
  /** Dedup TTL in ms. Default 90_000. */
  dedupTtlMs?: number
  now?: () => Date
}

export type PipelineRequest = {
  bodyText: string
  cookieHeader: string | null
  ip: string | null
  userAgent: string | null
  /** Optional client-supplied Idempotency-Key header value. */
  idempotencyKey?: IdempotencyKey
}

export type PipelineSuccess = {
  ok: true
  status: 200
  body: {
    success: true
    submissionId: string
    confirmationCode: string
    vendorAppointmentId: string
  }
}

export type PipelineFailure = {
  ok: false
  status: 400 | 409 | 429 | 500 | 502 | 503
  body: {
    ok: false
    errorCode: string
    message: string
    retryable: boolean
    issues?: ReadonlyArray<{ field: string; message: string }>
  }
}

export type PipelineResult = PipelineSuccess | PipelineFailure

export function createPipeline(opts: PipelineOptions) {
  const dedupTtlMs = opts.dedupTtlMs ?? 90_000
  const now = opts.now ?? (() => new Date())
  const eventBus = opts.eventBus ?? noopEventBus()
  const idempotencyTtl = opts.idempotencyTtlSeconds ?? 24 * 60 * 60

  return async function run(req: PipelineRequest): Promise<PipelineResult> {
    // Sentinel — replaced in stage 2 by generateSubmissionId. Disable
    // the no-useless-assignment rule: the sentinel exists so error-path
    // logs before stage 2 have a stable string to print; the value
    // never actually escapes as 'pending' in normal flow.
    // eslint-disable-next-line no-useless-assignment
    let submissionId = 'pending'
    const baseLogger = opts.logger

    // ── 0. Idempotency replay (ADR-013) ────────────────────────────────────
    if (req.idempotencyKey && opts.idempotencyStore) {
      const cached = await opts.idempotencyStore.get(opts.config.projectKey, req.idempotencyKey)
      if (cached) {
        baseLogger.info({
          evt: 'pipeline.idempotency.replay',
          ctx: {
            tenantId: opts.config.projectKey,
            keyHash: hashKey(req.idempotencyKey),
          },
        })
        return cachedToResult(cached.responseStatus, cached.responseBody)
      }
    }

    // ── 1. Parse + validate ────────────────────────────────────────────────
    let raw: unknown
    try {
      raw = JSON.parse(req.bodyText)
    } catch {
      return fail('INPUT_INVALID', 'Invalid JSON body', 400)
    }

    const parsed = bookingRequestInputSchema.safeParse(raw)
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => ({
        field: i.path.join('.') || 'body',
        message: i.message,
      }))
      return fail('INPUT_INVALID', 'Validation failed', 400, { issues })
    }
    const input = parsed.data

    // ── 2. Honeypot ────────────────────────────────────────────────────────
    if (input.website && input.website.trim() !== '') {
      void eventBus.publish({
        type: 'booking.spam_rejected',
        ts: Date.now(),
        tenantId: opts.config.projectKey,
        submissionId: 'spam',
      })
      // 400 looks like any other validation error — bots don't learn the trap
      // from the response shape (Pattern 3).
      return fail('SPAM_DETECTED', 'Submission rejected', 400)
    }

    // ── 3. Rate limit ──────────────────────────────────────────────────────
    if (opts.rateLimit && req.ip) {
      const rl = await opts.rateLimit.consume(`${opts.config.projectKey}:${req.ip}`)
      if (!rl.allowed) {
        return fail('RATE_LIMITED', 'Too many requests', 429)
      }
    }

    // ── 4. Dedup ───────────────────────────────────────────────────────────
    const fingerprint = fingerprintBookingRequest(input)
    const dedupKey = `apointoo:dedup:${opts.config.projectKey}:${fingerprint}`
    const dedupResult = await opts.dedup.checkAndSet(dedupKey, dedupTtlMs)
    if (dedupResult.duplicate) {
      void eventBus.publish({
        type: 'booking.duplicate_rejected',
        ts: Date.now(),
        tenantId: opts.config.projectKey,
        submissionId: 'dup',
        fingerprint,
      })
      return fail('DUPLICATE_SUBMISSION', 'Duplicate submission', 409)
    }

    // ── 5. Build domain entity ─────────────────────────────────────────────
    submissionId = generateSubmissionId(opts.config.timezone, now())
    const logger = withContext(baseLogger, { submissionId })
    const ctx: AdapterContext = { config: opts.config, logger, now }

    const service = opts.config.services.find((s) => s.id === input.serviceId) ?? null
    // Merge cookie-derived attribution with wire tracking. Wire wins per
    // readAttribution's contract (client may have a fresher gclid in
    // sessionStorage than what's in the cookie).
    const attribution: BookingAttribution = readAttribution(req.cookieHeader, input.tracking)

    const request: BookingRequest = {
      submissionId,
      projectKey: opts.config.projectKey,
      service,
      serviceId: input.serviceId,
      requestedDate: input.requestedDate,
      requestedTime: input.requestedTime,
      name: input.name,
      phone: input.phone,
      email: input.email,
      message: input.message,
      isNewPatient: input.isNewPatient,
      offerCode: input.offerCode,
      attribution,
      metadata: {
        userAgent: input.metadata?.userAgent ?? req.userAgent ?? undefined,
        locale: input.metadata?.locale ?? opts.config.locale,
        timezone: input.metadata?.timezone ?? opts.config.timezone,
        ip: req.ip ?? undefined, // never written to logs
      },
      createdAtIso: now().toISOString(),
      fingerprint,
      configSnapshot: {
        timezone: opts.config.timezone,
        locale: opts.config.locale,
        scheduling: opts.config.scheduling,
      },
    }

    // ── 6a. State store: write 'pending' BEFORE any vendor call (ADR-006) ─
    // Outbox path (ADR-012): if both state + queue + outbox are wired, write
    // them atomically here. Otherwise fall back to two sequential writes.
    void eventBus.publish({
      type: 'booking.requested',
      ts: Date.now(),
      tenantId: opts.config.projectKey,
      submissionId,
      serviceId: input.serviceId,
      attribution,
      idempotencyKey: req.idempotencyKey,
    })
    // P0-4 fix: Don't write outbox at pending state. The previous code wrote
    // `outbox.write({state, queueItems: []})` — a structurally wrong call that
    // never carried any fan-out work to the relay. Outbox writes belong AFTER
    // confirm() succeeds (Phase 2 / §5 design) or as embedded per-consumer
    // arrays on booking_state (Phase 1 / Amendment 1). At pending state we
    // only need the state row.
    if (opts.stateStore) {
      try {
        await opts.stateStore.create(
          buildPendingState(submissionId, opts.config.projectKey, attribution, now()),
        )
      } catch (err) {
        // State-store failure is non-fatal — log and proceed. The booking
        // can still happen; recovery just won't catch this submission.
        logger.warn({
          evt: 'pipeline.state.create_failed',
          message: errMessage(err),
        })
      }
    }

    // ── 6b. Booking adapter (createSession → attachAttribution → confirm) ──
    let session
    try {
      session = await opts.booking.createSession(
        {
          serviceId: request.serviceId,
          name: request.name,
          phone: request.phone,
          email: request.email,
          requestedDate: request.requestedDate,
          requestedTime: request.requestedTime,
          offerCode: request.offerCode,
        },
        ctx,
      )
    } catch (err) {
      const stack = boundedStack(err)
      logger.error({
        evt: 'pipeline.createSession.failed',
        ...(stack !== undefined ? { stack } : {}),
      })
      void eventBus.publish({
        type: 'booking.failed',
        ts: Date.now(),
        tenantId: opts.config.projectKey,
        submissionId,
        errorCode: isBookingError(err) ? err.code : 'CREATE_SESSION_FAILED',
        stage: 'createSession',
      })
      // State transition: pending → failed
      if (opts.stateStore) {
        opts.stateStore
          .transition(submissionId, {
            status: 'failed',
            errorCode: 'CREATE_SESSION_FAILED',
          })
          .catch(() => undefined)
      }
      return mapBookingError(err)
    }

    void eventBus.publish({
      type: 'booking.session.created',
      ts: Date.now(),
      tenantId: opts.config.projectKey,
      submissionId,
      vendor: session.vendor,
      vendorSessionId: session.vendorSessionId,
    })

    // attachAttribution — fire-and-forget (warn on failure, never abort)
    opts.booking
      .attachAttribution(session, attribution, ctx)
      .catch((err) =>
        logger.warn({
          evt: 'pipeline.attachAttribution.swallowed',
          message: errMessage(err),
        }),
      )

    let confirmation
    try {
      confirmation = await opts.booking.confirm(session, request, ctx)
    } catch (err) {
      const originalErrorCode = isBookingError(err) ? err.code : 'CONFIRM_FAILED'
      // P0-3 fix: Await compensation with a bounded timeout. The previous code
      // was fire-and-forget — publishing `booking.cancelled` before the cancel
      // call even completed, lying to subscribers if cancel later failed. Now
      // we wait up to 5s for cancel, and the event we publish reflects reality:
      // `booking.cancelled` only if cancel succeeded; `booking.compensation_failed`
      // if it didn't (timeout OR error). State transition reflects whichever
      // happened (`cancelled` vs `failed` with a compensation marker).
      const COMPENSATION_TIMEOUT_MS = 5000
      let compensationOk = false
      let compensationError: string | undefined
      try {
        await Promise.race([
          opts.booking.cancel(session, 'confirm failed', ctx).then(() => {
            compensationOk = true
          }),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`cancel timeout after ${COMPENSATION_TIMEOUT_MS}ms`)),
              COMPENSATION_TIMEOUT_MS,
            ),
          ),
        ])
      } catch (cancelErr) {
        compensationError =
          cancelErr instanceof Error ? cancelErr.message : String(cancelErr)
        logger.warn({
          evt: 'pipeline.cancel.failed',
          message: compensationError,
        })
      }

      if (compensationOk) {
        void eventBus.publish({
          type: 'booking.cancelled',
          ts: Date.now(),
          tenantId: opts.config.projectKey,
          submissionId,
          reason: 'confirm failed',
        })
      } else {
        void eventBus.publish({
          type: 'booking.compensation_failed',
          ts: Date.now(),
          tenantId: opts.config.projectKey,
          submissionId,
          vendor: session.vendor,
          vendorSessionId: session.vendorSessionId,
          originalErrorCode,
          cancelError: compensationError ?? 'unknown',
        })
      }
      void eventBus.publish({
        type: 'booking.failed',
        ts: Date.now(),
        tenantId: opts.config.projectKey,
        submissionId,
        errorCode: isBookingError(err) ? err.code : 'CONFIRM_FAILED',
        stage: 'confirm',
      })
      // State transition: pending → failed
      if (opts.stateStore) {
        opts.stateStore
          .transition(submissionId, { status: 'failed', errorCode: 'CONFIRM_FAILED' })
          .catch(() => undefined)
      }
      return mapBookingError(err)
    }

    // State transition: pending → confirmed
    if (opts.stateStore) {
      opts.stateStore
        .transition(submissionId, {
          status: 'confirmed',
          vendorAppointmentId: confirmation.vendorAppointmentId,
          ...(confirmation.startTimeIso !== undefined
            ? { appointmentStartIso: confirmation.startTimeIso }
            : {}),
        })
        .catch((err) =>
          logger.warn({
            evt: 'pipeline.state.confirmed_failed',
            message: errMessage(err),
          }),
        )
    }
    void eventBus.publish({
      type: 'booking.confirmed',
      ts: Date.now(),
      tenantId: opts.config.projectKey,
      submissionId,
      vendor: session.vendor,
      vendorAppointmentId: confirmation.vendorAppointmentId,
      vendorClientId: confirmation.vendorClientId,
      attribution,
    })

    // ── 7. Side effects (Promise.allSettled) ───────────────────────────────
    const persistencePromise = opts.persistence.append(
      {
        eventType: 'booking_request',
        request,
        confirmation,
        vendorMetadataJson: JSON.stringify(confirmation.metadata),
      },
      ctx,
    )

    // Do persistence first; if it rejects, the email gets a recovery row.
    const persistenceResult = await settle(persistencePromise)

    let recoveryRow: ReadonlyArray<string> | undefined
    let recoveryReason: string | undefined
    if (persistenceResult.status === 'rejected') {
      recoveryRow = bookingToRow({
        eventType: 'booking_request',
        request,
        confirmation,
      })
      recoveryReason = persistenceResult.message
      logger.error({
        evt: 'pipeline.persistence.failed',
        message: persistenceResult.message,
      })
    }

    // Enqueue durable notification if a queue is wired (ADR-006). The queue
    // is the durable retry path; the inline send below is the immediate-UX path.
    if (opts.queue) {
      const channel: QueueChannel = 'email'
      try {
        await opts.queue.enqueue({
          tenantId: opts.config.projectKey,
          submissionId,
          channel,
          payload: {
            request: {
              submissionId,
              name: request.name,
              phone: request.phone,
              email: request.email,
              service: request.service?.name ?? request.serviceId,
              date: request.requestedDate,
              time: request.requestedTime,
            },
            confirmation: {
              code: confirmation.confirmationCode,
              vendorAppointmentId: confirmation.vendorAppointmentId,
            },
          },
        })
      } catch (err) {
        logger.warn({
          evt: 'pipeline.queue.enqueue_failed',
          message: errMessage(err),
        })
      }
    }

    if (!opts.queueOnly) {
      const notifyResult = await settle(
        opts.notification.sendBookingNotification(
          request,
          confirmation,
          {
            ...(recoveryRow !== undefined ? { recoveryRow } : {}),
            ...(recoveryReason !== undefined ? { recoveryReason } : {}),
          },
          ctx,
        ),
      )
      if (notifyResult.status === 'rejected') {
        logger.error({
          evt: 'pipeline.notification.failed',
          message: notifyResult.message,
        })
      }
    }

    // ── 8. Respond ─────────────────────────────────────────────────────────
    const result: PipelineSuccess = {
      ok: true,
      status: 200,
      body: {
        success: true,
        submissionId,
        confirmationCode: confirmation.confirmationCode,
        vendorAppointmentId: confirmation.vendorAppointmentId,
      },
    }

    // ── 9. Idempotency cache write (ADR-013) ──────────────────────────────
    if (req.idempotencyKey && opts.idempotencyStore) {
      opts.idempotencyStore
        .put(
          {
            key: req.idempotencyKey,
            tenantId: opts.config.projectKey,
            responseStatus: result.status,
            responseBody: JSON.stringify(result.body),
            createdAt: now(),
          },
          idempotencyTtl,
        )
        .catch((err) =>
          logger.warn({
            evt: 'pipeline.idempotency.put_failed',
            message: errMessage(err),
          }),
        )
    }

    return result
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildPendingState(
  submissionId: string,
  tenantId: string,
  attribution: BookingAttribution,
  createdAt: Date,
): BookingStateCreate {
  return {
    submissionId,
    tenantId,
    status: 'pending',
    vendor: 'unknown',
    attribution,
    gclid: attribution.gclid ?? null,
    fbclid: attribution.fbclid ?? null,
    msclkid: attribution.msclkid ?? null,
    rwgToken: null,
    utmSource: attribution.utmSource ?? null,
    utmMedium: attribution.utmMedium ?? null,
    utmCampaign: attribution.utmCampaign ?? null,
    createdAt,
  }
}

function cachedToResult(status: number, body: string): PipelineResult {
  // Replay: status from cache (always 200 in current pipeline) + cached body.
  // Tighten typing on a 200 hit only; non-200 cached responses fall through
  // as PipelineFailure shape.
  if (status === 200) {
    return {
      ok: true,
      status: 200,
      body: JSON.parse(body) as PipelineSuccess['body'],
    }
  }
  return {
    ok: false,
    status: status as PipelineFailure['status'],
    body: JSON.parse(body) as PipelineFailure['body'],
  }
}

function hashKey(key: string): string {
  // Cheap non-crypto hash for log correlation. Avoids logging raw idempotency
  // keys (which may be UUIDs the client uses elsewhere — slight PII concern).
  let h = 0
  for (let i = 0; i < key.length; i++) {
    h = (h * 31 + key.charCodeAt(i)) | 0
  }
  return Math.abs(h).toString(36)
}

function fail(
  errorCode: string,
  message: string,
  status: PipelineFailure['status'],
  extras?: { issues?: ReadonlyArray<{ field: string; message: string }>; retryable?: boolean },
): PipelineFailure {
  return {
    ok: false,
    status,
    body: {
      ok: false,
      errorCode,
      message,
      retryable: extras?.retryable ?? defaultRetryable(errorCode),
      ...(extras?.issues ? { issues: extras.issues } : {}),
    },
  }
}

function defaultRetryable(code: string): boolean {
  return ['BOOKING_FAILED', 'PERSISTENCE_FAILED', 'DEPENDENCY_UNAVAILABLE', 'UNKNOWN_ERROR', 'RATE_LIMITED'].includes(code)
}

function mapBookingError(err: unknown): PipelineFailure {
  if (isBookingError(err)) {
    return fail(err.code, err.message, statusForBookingErrorCode(err.code), {
      retryable: err.retryable,
      ...(err.issues ? { issues: err.issues } : {}),
    })
  }
  if (isBlvdError(err)) {
    if (err.code === 'TIME_UNAVAILABLE') {
      return fail('TIME_UNAVAILABLE', 'Slot no longer available — pick another time.', 409, { retryable: false })
    }
    if (err.code === 'SERVICE_NOT_MAPPED' || err.code === 'LOCATION_MISSING' || err.code === 'AUTH_MISSING') {
      return fail(
        'DEPENDENCY_UNAVAILABLE',
        'Booking system configuration error. Please call us to book.',
        500,
        { retryable: false },
      )
    }
    return fail('BOOKING_FAILED', 'Booking system temporarily unavailable. Please try again.', 502, {
      retryable: true,
    })
  }
  return fail('UNKNOWN_ERROR', 'An unexpected error occurred. Please try again.', 500, {
    retryable: true,
  })
}

function statusForBookingErrorCode(code: string): PipelineFailure['status'] {
  switch (code) {
    case 'INPUT_INVALID':
    case 'CONFIG_INVALID':
    case 'SPAM_DETECTED':
      return 400
    case 'DUPLICATE_SUBMISSION':
    case 'TIME_UNAVAILABLE':
      return 409
    case 'RATE_LIMITED':
      return 429
    case 'DEPENDENCY_UNAVAILABLE':
      return 503
    case 'BOOKING_FAILED':
    case 'PERSISTENCE_FAILED':
    case 'NOTIFICATION_FAILED':
      return 502
    default:
      return 500
  }
}

type Settled = { status: 'fulfilled' } | { status: 'rejected'; message: string }

async function settle(p: Promise<unknown>): Promise<Settled> {
  try {
    await p
    return { status: 'fulfilled' }
  } catch (err) {
    return { status: 'rejected', message: errMessage(err) }
  }
}

export { BookingError }
