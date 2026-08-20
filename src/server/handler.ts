// Hono handler — mounts pipeline + healthz. Consumer mounts the returned `app`
// inside their framework of choice (Next.js, Express, Cloudflare Workers...).

import { errMessage, BookingError } from '../core/errors.js'
import { Hono } from 'hono'
import type { BookingAdapter } from '../adapters/booking/adapter.js'
import type { PersistenceAdapter } from '../adapters/persistence/adapter.js'
import type { Notifier } from '../adapters/notification/adapter.js'
import type { DedupStore } from '../adapters/dedup/adapter.js'
import type { RateLimitStore } from '../adapters/ratelimit/adapter.js'
import type { BookingStateStore } from '../adapters/state/adapter.js'
import type { OutboundQueue } from '../queue/adapter.js'
import type { OutboxWriter } from '../queue/outbox.js'
import type { BookingKitConfig } from '../core/schemas.js'
import type { AdapterContext, Logger } from '../core/types.js'
import type { DomainEventBus } from '../core/events.js'
import type { EventLedger } from '../adapters/ledger/adapter.js'
import { translateDomainEvent } from '../adapters/ledger/translate.js'
import {
  IDEMPOTENCY_HEADER,
  type IdempotencyStore,
} from '../core/idempotency.js'
import { createPipeline } from './pipeline.js'
import { buildHealthReport } from './health.js'
import { consoleLogger } from './logger.js'
import {
  staticTenantResolver,
  TenantNotFoundError,
  type TenantResolver,
} from './tenant.js'
import { runCancel, runReschedule } from './lookups.js'

export type CreateBookingHandlerOptions = {
  /** Single-tenant: pass `config`. Multi-tenant: pass `tenantResolver`. */
  config?: BookingKitConfig
  tenantResolver?: TenantResolver
  booking: BookingAdapter
  persistence: PersistenceAdapter
  notification: Notifier
  dedup: DedupStore
  rateLimit?: RateLimitStore
  /** ADR-006: durable booking state. Recommended for production. */
  stateStore?: BookingStateStore
  /** ADR-006: notification queue. Recommended for production. */
  queue?: OutboundQueue
  /** ADR-012: transactional outbox writer. Atomic state+queue write when wired. */
  outbox?: OutboxWriter
  /** When set, skip inline notification and rely fully on the queue. */
  queueOnly?: boolean
  /** ADR-012: domain event bus for cross-cutting subscribers. */
  eventBus?: DomainEventBus
  /**
   * Append-only event ledger. When both `ledger` and `eventBus` are set, every
   * domain event is translated and appended fire-and-forget — a ledger failure
   * must never break a booking.
   */
  ledger?: EventLedger
  /** ADR-013: idempotency-key cache for client-driven retries. */
  idempotencyStore?: IdempotencyStore
  /** TTL in seconds for cached idempotent responses. Default 24h. */
  idempotencyTtlSeconds?: number
  logger?: Logger
  /** Path prefix mounted on the Hono app. Default: '/'. */
  basePath?: string
  /** Dedup TTL ms. Default 90_000. */
  dedupTtlMs?: number
}

export function createBookingHandler(opts: CreateBookingHandlerOptions): Hono {
  if (!opts.config && !opts.tenantResolver) {
    throw new BookingError('CONFIG_INVALID', 'createBookingHandler: either `config` or `tenantResolver` is required')
  }
  const logger = opts.logger ?? consoleLogger()
  const app = new Hono().basePath(opts.basePath ?? '/')

  const tenantResolver: TenantResolver = opts.tenantResolver ?? staticTenantResolver(opts.config!)

  // Ledger: subscribe to ALL domain events and append append-only. Fire-and-
  // forget — a ledger failure must never break a booking (matches the bus's
  // existing fire-and-forget subscriber contract).
  if (opts.ledger && opts.eventBus) {
    const ledger = opts.ledger
    opts.eventBus.subscribeAll(async (e) => {
      try {
        await ledger.append(translateDomainEvent(e))
      } catch {
        /* fire-and-forget; ledger failure must never break a booking */
      }
    })
  }

  // POST /booking
  app.post('/booking', async (c) => {
    let resolved
    try {
      resolved = await tenantResolver.resolve(c.req.raw)
    } catch (err) {
      if (err instanceof TenantNotFoundError) {
        return c.json(
          { ok: false, errorCode: 'TENANT_NOT_FOUND', message: err.message, retryable: false },
          404,
        )
      }
      throw err
    }

    const pipeline = createPipeline({
      config: resolved.config,
      booking: opts.booking,
      persistence: opts.persistence,
      notification: opts.notification,
      dedup: opts.dedup,
      ...(opts.rateLimit !== undefined ? { rateLimit: opts.rateLimit } : {}),
      ...(opts.stateStore !== undefined ? { stateStore: opts.stateStore } : {}),
      ...(opts.queue !== undefined ? { queue: opts.queue } : {}),
      ...(opts.outbox !== undefined ? { outbox: opts.outbox } : {}),
      ...(opts.queueOnly !== undefined ? { queueOnly: opts.queueOnly } : {}),
      ...(opts.eventBus !== undefined ? { eventBus: opts.eventBus } : {}),
      ...(opts.idempotencyStore !== undefined
        ? { idempotencyStore: opts.idempotencyStore }
        : {}),
      ...(opts.idempotencyTtlSeconds !== undefined
        ? { idempotencyTtlSeconds: opts.idempotencyTtlSeconds }
        : {}),
      logger,
      ...(opts.dedupTtlMs !== undefined ? { dedupTtlMs: opts.dedupTtlMs } : {}),
    })

    const ip =
      c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
      c.req.header('cf-connecting-ip') ??
      null
    const userAgent = c.req.header('user-agent') ?? null
    const cookieHeader = c.req.header('cookie') ?? null
    const idempotencyKey = c.req.header(IDEMPOTENCY_HEADER)?.trim() || undefined
    const bodyText = await c.req.text()

    const result = await pipeline({
      bodyText,
      cookieHeader,
      ip,
      userAgent,
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    })
    return c.json(result.body, result.status)
  })

  // GET /availability?serviceId=X&from=YYYY-MM-DD&to=YYYY-MM-DD
  app.get('/availability', async (c) => {
    let resolved
    try {
      resolved = await tenantResolver.resolve(c.req.raw)
    } catch (err) {
      if (err instanceof TenantNotFoundError) {
        return c.json(
          { ok: false, errorCode: 'TENANT_NOT_FOUND', message: err.message },
          404,
        )
      }
      throw err
    }
    const serviceId = c.req.query('serviceId')
    const fromDate = c.req.query('from')
    if (!serviceId || !fromDate) {
      return c.json(
        {
          ok: false,
          errorCode: 'INPUT_INVALID',
          message: 'serviceId and from are required',
        },
        400,
      )
    }
    const toDate = c.req.query('to') ?? fromDate
    const ctx: AdapterContext = {
      config: resolved.config,
      logger,
      now: () => new Date(),
    }
    try {
      const slots = await opts.booking.findAvailability(
        { serviceId, fromDate, toDate },
        ctx,
      )
      return c.json({ ok: true, slots })
    } catch (err) {
      logger.error({
        evt: 'handler.availability.failed',
        message: errMessage(err),
      })
      return c.json(
        {
          ok: false,
          errorCode: 'BOOKING_FAILED',
          message: 'Availability lookup failed.',
          retryable: true,
        },
        502,
      )
    }
  })

  // PUT /booking/:submissionId — reschedule
  app.put('/booking/:submissionId', async (c) => {
    if (!opts.stateStore) {
      return c.json(
        {
          ok: false,
          errorCode: 'NOT_SUPPORTED',
          message: 'Reschedule requires stateStore to be wired.',
        },
        501,
      )
    }
    let resolved
    try {
      resolved = await tenantResolver.resolve(c.req.raw)
    } catch (err) {
      if (err instanceof TenantNotFoundError) {
        return c.json(
          { ok: false, errorCode: 'TENANT_NOT_FOUND', message: err.message },
          404,
        )
      }
      throw err
    }
    const submissionId = c.req.param('submissionId')
    const bodyText = await c.req.text()
    // Kit #73: read Idempotency-Key header, same pattern as POST booking.
    const rescheduleIdempotencyKey = c.req.header(IDEMPOTENCY_HEADER)?.trim() || undefined
    const result = await runReschedule(submissionId, bodyText, {
      config: resolved.config,
      booking: opts.booking,
      stateStore: opts.stateStore,
      logger,
      ...(opts.eventBus !== undefined ? { eventBus: opts.eventBus } : {}),
      ...(opts.queue !== undefined ? { queue: opts.queue } : {}),
      ...(opts.idempotencyStore !== undefined ? { idempotencyStore: opts.idempotencyStore } : {}),
      ...(opts.idempotencyTtlSeconds !== undefined ? { idempotencyTtlSeconds: opts.idempotencyTtlSeconds } : {}),
      ...(rescheduleIdempotencyKey !== undefined ? { idempotencyKey: rescheduleIdempotencyKey } : {}),
    })
    return c.json(result.body, result.status)
  })

  // DELETE /booking/:submissionId — cancel
  app.delete('/booking/:submissionId', async (c) => {
    if (!opts.stateStore) {
      return c.json(
        {
          ok: false,
          errorCode: 'NOT_SUPPORTED',
          message: 'Cancel requires stateStore to be wired.',
        },
        501,
      )
    }
    let resolved
    try {
      resolved = await tenantResolver.resolve(c.req.raw)
    } catch (err) {
      if (err instanceof TenantNotFoundError) {
        return c.json(
          { ok: false, errorCode: 'TENANT_NOT_FOUND', message: err.message },
          404,
        )
      }
      throw err
    }
    const submissionId = c.req.param('submissionId')
    const reason = c.req.query('reason') ?? 'user-requested'
    // Kit #73: read Idempotency-Key header, same pattern as POST booking.
    const cancelIdempotencyKey = c.req.header(IDEMPOTENCY_HEADER)?.trim() || undefined
    const result = await runCancel(submissionId, reason, {
      config: resolved.config,
      booking: opts.booking,
      stateStore: opts.stateStore,
      logger,
      ...(opts.eventBus !== undefined ? { eventBus: opts.eventBus } : {}),
      ...(opts.queue !== undefined ? { queue: opts.queue } : {}),
      ...(opts.idempotencyStore !== undefined ? { idempotencyStore: opts.idempotencyStore } : {}),
      ...(opts.idempotencyTtlSeconds !== undefined ? { idempotencyTtlSeconds: opts.idempotencyTtlSeconds } : {}),
      ...(cancelIdempotencyKey !== undefined ? { idempotencyKey: cancelIdempotencyKey } : {}),
    })
    return c.json(result.body, result.status)
  })

  // GET /healthz
  app.get('/healthz', async (c) => {
    // For multi-tenant: use the first available config (or pass none — adapter
    // health is tenant-agnostic in the default impls).
    const cfg =
      opts.config ??
      (await tenantResolver.resolve(c.req.raw).then((r) => r.config).catch(() => undefined))
    if (!cfg) {
      return c.json({ ok: false, error: 'No tenant resolvable for healthz' }, 503)
    }
    const ctx: AdapterContext = {
      config: cfg,
      logger,
      now: () => new Date(),
    }
    const report = await buildHealthReport({
      ctx,
      booking: opts.booking,
      persistence: opts.persistence,
      notification: opts.notification,
      dedup: opts.dedup,
      ...(opts.rateLimit !== undefined ? { rateLimit: opts.rateLimit } : {}),
    })
    return c.json(report, report.ok ? 200 : 503)
  })

  return app
}
