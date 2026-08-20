// tests/saga/compensation.test.ts — Tier 4 (saga compensation paths)
import { describe, expect, it } from 'vitest'
import { createPipeline } from '../../src/server/pipeline.js'
import { memoryBookingAdapter } from '../../src/adapters/booking/memory/index.js'
import { memoryPersistenceAdapter } from '../../src/adapters/persistence/memory/index.js'
import { memoryNotifier } from '../../src/adapters/notification/memory/index.js'
import { memoryDedupStore } from '../../src/adapters/dedup/memory.js'
import { memoryStateStore } from '../../src/adapters/state/memory.js'
import { inMemoryEventBus } from '../../src/core/events.js'
import { BookingError } from '../../src/core/errors.js'
import type { DomainEvent } from '../../src/core/events.js'
import type { BookingKitConfig } from '../../src/core/schemas.js'
import type { Logger } from '../../src/core/types.js'

const config: BookingKitConfig = {
  projectKey: 'test-saga',
  businessName: 'Saga Clinic',
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
  name: 'Maria Costa',
  phone: '+5511999990002',
})

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

async function flushBus(): Promise<void> {
  await new Promise((r) => setImmediate(r))
}

describe('saga — confirm failure triggers compensation', () => {
  it('calls cancel() exactly once when confirm() rejects', async () => {
    const confirmError = new BookingError('TIME_UNAVAILABLE', 'Slot taken')
    const booking = memoryBookingAdapter({ failConfirmWith: confirmError })
    const stateStore = memoryStateStore()
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
      stateStore,
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

    // Pipeline returned the right error
    expect(result.ok).toBe(false)
    expect(result.status).toBe(409) // TIME_UNAVAILABLE maps to 409
    if (!result.ok) {
      expect(result.body.errorCode).toBe('TIME_UNAVAILABLE')
      expect(result.body.retryable).toBe(false)
    }

    // cancel() was called (compensation)
    expect(booking.calls.cancel).toHaveLength(1)
    expect(booking.calls.cancel[0]!.reason).toBe('confirm failed')

    // State transitioned to 'failed' (count-based check is robust against id format)
    const counts = await stateStore.countByStatus('test-saga')
    expect(counts.failed).toBe(1)
    expect(counts.confirmed).toBe(0)

    // Domain events
    const types = events.map((e) => e.type)
    expect(types).toContain('booking.session.created') // got that far
    expect(types).toContain('booking.cancelled') // compensation triggered
    expect(types).toContain('booking.failed') // pipeline failed event
    expect(types).not.toContain('booking.confirmed') // never reached
  })

  it('state transitions to failed when createSession() rejects (no cancel needed)', async () => {
    const booking = memoryBookingAdapter({
      failCreateSessionWith: new BookingError('DEPENDENCY_UNAVAILABLE', 'BLVD down'),
    })
    const stateStore = memoryStateStore()
    const pipeline = createPipeline({
      config,
      booking,
      persistence: memoryPersistenceAdapter(),
      notification: memoryNotifier(),
      dedup: memoryDedupStore(),
      stateStore,
      logger: silentLogger,
    })
    const result = await pipeline({
      bodyText: validBody,
      cookieHeader: null,
      ip: null,
      userAgent: null,
    })
    expect(result.ok).toBe(false)
    expect(result.status).toBe(503)
    expect(booking.calls.cancel).toHaveLength(0) // no session to cancel
    const counts = await stateStore.countByStatus()
    expect(counts.failed).toBe(1)
  })
})
