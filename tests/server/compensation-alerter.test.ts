// tests/server/compensation-alerter.test.ts
//
// Two halves:
//   1. Pipeline-level: confirm() throws AND cancel() throws → the pipeline
//      emits a `booking.compensation_failed` event with the right fields.
//      Cancel-error is still swallowed (no propagation to the caller).
//   2. Alerter-level: subscriber enqueues an alert with the configured
//      channel + builder payload; no-op when alertQueue is omitted (defensive).

import { describe, expect, it } from 'vitest'
import { createPipeline } from '../../src/server/pipeline.js'
import { subscribeCompensationAlerts } from '../../src/server/compensation-alerter.js'
import { memoryBookingAdapter } from '../../src/adapters/booking/memory/index.js'
import { memoryPersistenceAdapter } from '../../src/adapters/persistence/memory/index.js'
import { memoryNotifier } from '../../src/adapters/notification/memory/index.js'
import { memoryDedupStore } from '../../src/adapters/dedup/memory.js'
import { memoryStateStore } from '../../src/adapters/state/memory.js'
import { memoryQueue } from '../../src/queue/memory.js'
import { inMemoryEventBus } from '../../src/core/events.js'
import { BookingError } from '../../src/core/errors.js'
import type {
  BookingCompensationFailedEvent,
  DomainEvent,
} from '../../src/core/events.js'
import type { BookingKitConfig } from '../../src/core/schemas.js'
import type { Logger } from '../../src/core/types.js'
import type { BookingAdapter } from '../../src/adapters/booking/adapter.js'

const config: BookingKitConfig = {
  projectKey: 'test-compensation',
  businessName: 'Compensation Clinic',
  locale: 'pt-BR',
  timezone: 'America/Sao_Paulo',
  services: [{ id: 'svc-1', name: 'Test', isActive: true }],
  scheduling: {
    availableDays: [1, 2, 3, 4, 5],
    timeSlots: [{ label: '10:00', value: '10:00' }],
    minAdvanceDays: 0,
    maxAdvanceDays: 90,
  },
}

const validBody = JSON.stringify({
  serviceId: 'svc-1',
  requestedDate: '2026-08-01',
  requestedTime: '10:00',
  name: 'Ana Santos',
  phone: '+5511999990003',
})

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

/** Flush microtasks + I/O queue so fire-and-forget bus handlers have run. */
async function flushBus(): Promise<void> {
  await new Promise((r) => setImmediate(r))
}

/**
 * Wrap the memory booking adapter so that cancel() rejects — the memory
 * adapter doesn't natively support failing cancel (since it shouldn't, in
 * normal saga tests). We override just the cancel method.
 */
function adapterWithFailingCancel(
  confirmError: Error,
  cancelError: Error,
): BookingAdapter & { calls: { cancel: Array<{ reason: string }> } } {
  const base = memoryBookingAdapter({ failConfirmWith: confirmError })
  const cancelCalls: Array<{ reason: string }> = []
  const wrapped: BookingAdapter = {
    ...base,
    async cancel(_session, reason, _ctx) {
      cancelCalls.push({ reason })
      throw cancelError
    },
  }
  return Object.assign(wrapped, { calls: { cancel: cancelCalls } })
}

describe('pipeline — compensation failure event', () => {
  it('emits booking.compensation_failed when both confirm AND cancel throw', async () => {
    const confirmError = new BookingError('TIME_UNAVAILABLE', 'Slot taken')
    const cancelError = new Error('vendor cart cancel 502')
    const booking = adapterWithFailingCancel(confirmError, cancelError)
    const events: DomainEvent[] = []
    const bus = inMemoryEventBus()
    bus.subscribeAll((e) => {
      events.push(e)
    })

    const pipeline = createPipeline({
      config,
      booking,
      persistence: memoryPersistenceAdapter(),
      notification: memoryNotifier(),
      dedup: memoryDedupStore(),
      stateStore: memoryStateStore(),
      eventBus: bus,
      logger: silentLogger,
    })

    const result = await pipeline({
      bodyText: validBody,
      cookieHeader: null,
      ip: '1.2.3.4',
      userAgent: 'vitest',
    })
    await flushBus()

    // Caller still gets the original confirm-failure response — cancel
    // failure is swallowed (async fire-and-forget).
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.body.errorCode).toBe('TIME_UNAVAILABLE')
    }
    expect(booking.calls.cancel).toHaveLength(1)

    // The compensation-failed event was emitted with the correct fields.
    const compEvents = events.filter(
      (e): e is BookingCompensationFailedEvent =>
        e.type === 'booking.compensation_failed',
    )
    expect(compEvents).toHaveLength(1)
    const ev = compEvents[0]!
    expect(ev.tenantId).toBe('test-compensation')
    expect(ev.vendor).toBe('memory')
    expect(ev.vendorSessionId).toMatch(/^mem_session_\d+$/)
    expect(ev.originalErrorCode).toBe('TIME_UNAVAILABLE')
    expect(ev.cancelError).toBe('vendor cart cancel 502')
    expect(typeof ev.ts).toBe('number')
    expect(ev.submissionId).toMatch(/^bk_\d{8}_[0-9a-f]{8}$/)
  })

  it('does NOT emit booking.compensation_failed when cancel succeeds', async () => {
    const confirmError = new BookingError('TIME_UNAVAILABLE', 'Slot taken')
    // memoryBookingAdapter's default cancel() never throws.
    const booking = memoryBookingAdapter({ failConfirmWith: confirmError })
    const events: DomainEvent[] = []
    const bus = inMemoryEventBus()
    bus.subscribeAll((e) => {
      events.push(e)
    })

    const pipeline = createPipeline({
      config,
      booking,
      persistence: memoryPersistenceAdapter(),
      notification: memoryNotifier(),
      dedup: memoryDedupStore(),
      eventBus: bus,
      logger: silentLogger,
    })

    await pipeline({
      bodyText: validBody,
      cookieHeader: null,
      ip: null,
      userAgent: null,
    })
    await flushBus()

    const types = events.map((e) => e.type)
    expect(types).toContain('booking.cancelled')
    expect(types).not.toContain('booking.compensation_failed')
  })

  it('falls back to CONFIRM_FAILED when confirm rejects with a non-BookingError', async () => {
    const confirmError = new Error('raw network error')
    const cancelError = new Error('cancel also failed')
    const booking = adapterWithFailingCancel(confirmError, cancelError)
    const events: DomainEvent[] = []
    const bus = inMemoryEventBus()
    bus.subscribeAll((e) => {
      events.push(e)
    })

    const pipeline = createPipeline({
      config,
      booking,
      persistence: memoryPersistenceAdapter(),
      notification: memoryNotifier(),
      dedup: memoryDedupStore(),
      eventBus: bus,
      logger: silentLogger,
    })

    await pipeline({
      bodyText: validBody,
      cookieHeader: null,
      ip: null,
      userAgent: null,
    })
    await flushBus()

    const compEvents = events.filter(
      (e): e is BookingCompensationFailedEvent =>
        e.type === 'booking.compensation_failed',
    )
    expect(compEvents).toHaveLength(1)
    expect(compEvents[0]!.originalErrorCode).toBe('CONFIRM_FAILED')
  })
})

describe('subscribeCompensationAlerts — alert enqueue', () => {
  it('enqueues an alert on booking.compensation_failed with channel + builder payload', async () => {
    const bus = inMemoryEventBus()
    const alertQueue = memoryQueue()
    const unsubscribe = subscribeCompensationAlerts({
      bus,
      alertQueue,
      alertChannel: 'email',
      alertPayloadBuilder: (e) => ({
        to: 'ops@example.com',
        submissionId: e.submissionId,
        vendor: e.vendor,
        originalErrorCode: e.originalErrorCode,
      }),
      logger: silentLogger,
    })

    await bus.publish({
      type: 'booking.compensation_failed',
      ts: Date.now(),
      tenantId: 'tenant-A',
      submissionId: 'bk_xyz',
      vendor: 'blvd',
      vendorSessionId: 'cart_123',
      originalErrorCode: 'TIME_UNAVAILABLE',
      cancelError: 'cart cancel 502',
    })
    await flushBus()

    const claimed = await alertQueue.claim(10, 'worker-1')
    expect(claimed).toHaveLength(1)
    const item = claimed[0]!
    expect(item.channel).toBe('email')
    expect(item.tenantId).toBe('tenant-A')
    expect(item.submissionId).toBe('bk_xyz')
    expect(item.payload['to']).toBe('ops@example.com')
    expect(item.payload['vendor']).toBe('blvd')
    expect(item.payload['originalErrorCode']).toBe('TIME_UNAVAILABLE')

    unsubscribe()
  })

  it('uses a sensible default payload when no builder is supplied', async () => {
    const bus = inMemoryEventBus()
    const alertQueue = memoryQueue()
    subscribeCompensationAlerts({
      bus,
      alertQueue,
      alertChannel: 'webhook',
      logger: silentLogger,
    })

    await bus.publish({
      type: 'booking.compensation_failed',
      ts: 1_700_000_000_000,
      tenantId: 'tenant-B',
      submissionId: 'bk_def',
      vendor: 'memory',
      vendorSessionId: 'mem_session_9',
      originalErrorCode: 'CONFIRM_FAILED',
      cancelError: 'boom',
    })
    await flushBus()

    const claimed = await alertQueue.claim(10, 'worker-1')
    expect(claimed).toHaveLength(1)
    const item = claimed[0]!
    expect(item.channel).toBe('webhook')
    expect(item.payload['kind']).toBe('compensation_failed')
    expect(item.payload['submissionId']).toBe('bk_def')
    expect(item.payload['vendor']).toBe('memory')
    expect(item.payload['vendorSessionId']).toBe('mem_session_9')
    expect(item.payload['originalErrorCode']).toBe('CONFIRM_FAILED')
    expect(item.payload['cancelError']).toBe('boom')
    expect(item.payload['ts']).toBe(1_700_000_000_000)
  })

  it('no-ops defensively when alertQueue is omitted', async () => {
    const bus = inMemoryEventBus()
    const warnLogs: unknown[] = []
    const captureLogger: Logger = {
      ...silentLogger,
      warn: (evt) => {
        warnLogs.push(evt)
      },
    }

    subscribeCompensationAlerts({
      bus,
      logger: captureLogger,
    })

    await bus.publish({
      type: 'booking.compensation_failed',
      ts: Date.now(),
      tenantId: 'tenant-C',
      submissionId: 'bk_ghi',
      vendor: 'memory',
      vendorSessionId: 'mem_session_7',
      originalErrorCode: 'CONFIRM_FAILED',
      cancelError: 'silent',
    })
    await flushBus()

    // Skipped log entry surfaces — not entirely silent — but no throws and
    // no enqueue attempts (there's no queue to assert against, and the
    // handler must not crash on the missing queue).
    expect(warnLogs.length).toBeGreaterThan(0)
  })

  it('no-ops when alertChannel is omitted (queue present but no channel)', async () => {
    const bus = inMemoryEventBus()
    const alertQueue = memoryQueue()
    subscribeCompensationAlerts({
      bus,
      alertQueue,
      logger: silentLogger,
    })

    await bus.publish({
      type: 'booking.compensation_failed',
      ts: Date.now(),
      tenantId: 'tenant-D',
      submissionId: 'bk_jkl',
      vendor: 'memory',
      vendorSessionId: 'mem_session_5',
      originalErrorCode: 'CONFIRM_FAILED',
      cancelError: 'still silent',
    })
    await flushBus()

    const counts = await alertQueue.countByStatus()
    expect(counts.pending).toBe(0)
  })

  it('unsubscribe stops further alerts', async () => {
    const bus = inMemoryEventBus()
    const alertQueue = memoryQueue()
    const unsubscribe = subscribeCompensationAlerts({
      bus,
      alertQueue,
      alertChannel: 'email',
      alertPayloadBuilder: () => ({ to: 'ops@example.com' }),
      logger: silentLogger,
    })

    unsubscribe()

    await bus.publish({
      type: 'booking.compensation_failed',
      ts: Date.now(),
      tenantId: 'tenant-E',
      submissionId: 'bk_mno',
      vendor: 'memory',
      vendorSessionId: 'mem_session_3',
      originalErrorCode: 'CONFIRM_FAILED',
      cancelError: 'no listener',
    })
    await flushBus()

    const counts = await alertQueue.countByStatus()
    expect(counts.pending).toBe(0)
  })
})
