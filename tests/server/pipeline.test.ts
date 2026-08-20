// tests/server/pipeline.test.ts — Tier 3 (pipeline integration with all-memory adapters)
import { describe, expect, it } from 'vitest'
import { createPipeline } from '../../src/server/pipeline.js'
import { memoryBookingAdapter } from '../../src/adapters/booking/memory/index.js'
import { memoryPersistenceAdapter } from '../../src/adapters/persistence/memory/index.js'
import { memoryNotifier } from '../../src/adapters/notification/memory/index.js'
import { memoryDedupStore } from '../../src/adapters/dedup/memory.js'
import { memoryStateStore } from '../../src/adapters/state/memory.js'
import { memoryIdempotencyStore } from '../../src/core/idempotency.js'
import { inMemoryEventBus } from '../../src/core/events.js'
import type { DomainEvent } from '../../src/core/events.js'
import type { BookingKitConfig } from '../../src/core/schemas.js'
import type { Logger } from '../../src/core/types.js'

const config: BookingKitConfig = {
  projectKey: 'test-tenant',
  businessName: 'Test Clinic',
  locale: 'pt-BR',
  timezone: 'America/Sao_Paulo',
  services: [{ id: 'svc-1', name: 'Consultation', isActive: true }],
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
  name: 'João Silva',
  phone: '+5511999990001',
  email: 'joao@example.com',
})

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

function makeReq(overrides: Partial<{ bodyText: string; idempotencyKey: string }> = {}) {
  return {
    bodyText: validBody,
    cookieHeader: null,
    ip: '1.2.3.4',
    userAgent: 'vitest',
    ...overrides,
  }
}

/** Flush microtasks + I/O queue so fire-and-forget bus handlers have run. */
async function flushBus(): Promise<void> {
  await new Promise((r) => setImmediate(r))
}

describe('pipeline — happy path', () => {
  it('returns 200 with submissionId and vendorAppointmentId', async () => {
    const booking = memoryBookingAdapter()
    const pipeline = createPipeline({
      config,
      booking,
      persistence: memoryPersistenceAdapter(),
      notification: memoryNotifier(),
      dedup: memoryDedupStore(),
      logger: silentLogger,
    })
    const result = await pipeline(makeReq())
    expect(result.ok).toBe(true)
    expect(result.status).toBe(200)
    if (result.ok) {
      expect(result.body.submissionId).toMatch(/^bk_\d{8}_[0-9a-f]{8}$/)
      expect(result.body.vendorAppointmentId).toBeTruthy()
    }
    expect(booking.calls.createSession).toBe(1)
    expect(booking.calls.confirm).toBe(1)
    expect(booking.calls.cancel).toHaveLength(0)
  })

  it('emits booking.requested + booking.confirmed events', async () => {
    const events: DomainEvent[] = []
    const bus = inMemoryEventBus()
    bus.subscribeAll((e) => {
      events.push(e)
    })
    const pipeline = createPipeline({
      config,
      booking: memoryBookingAdapter(),
      persistence: memoryPersistenceAdapter(),
      notification: memoryNotifier(),
      dedup: memoryDedupStore(),
      eventBus: bus,
      logger: silentLogger,
    })
    await pipeline(makeReq())
    await flushBus()
    const types = events.map((e) => e.type)
    expect(types).toContain('booking.requested')
    expect(types).toContain('booking.confirmed')
  })
})

describe('pipeline — spam detection', () => {
  it('returns 400 SPAM_DETECTED when honeypot website field is non-empty', async () => {
    const spamBody = JSON.stringify({
      ...JSON.parse(validBody),
      website: 'http://spam.example.com',
    })
    const pipeline = createPipeline({
      config,
      booking: memoryBookingAdapter(),
      persistence: memoryPersistenceAdapter(),
      notification: memoryNotifier(),
      dedup: memoryDedupStore(),
      logger: silentLogger,
    })
    const result = await pipeline(makeReq({ bodyText: spamBody }))
    expect(result.ok).toBe(false)
    expect(result.status).toBe(400)
    if (!result.ok) expect(result.body.errorCode).toBe('SPAM_DETECTED')
  })
})

describe('pipeline — dedup', () => {
  it('returns 409 DUPLICATE_SUBMISSION on second identical request within TTL', async () => {
    const dedup = memoryDedupStore()
    const pipeline = createPipeline({
      config,
      booking: memoryBookingAdapter(),
      persistence: memoryPersistenceAdapter(),
      notification: memoryNotifier(),
      dedup,
      dedupTtlMs: 60_000,
      logger: silentLogger,
    })
    await pipeline(makeReq()) // first — ok
    const r2 = await pipeline(makeReq()) // second — dup
    expect(r2.ok).toBe(false)
    expect(r2.status).toBe(409)
    if (!r2.ok) expect(r2.body.errorCode).toBe('DUPLICATE_SUBMISSION')
  })
})

describe('pipeline — idempotency replay', () => {
  it('returns cached response on replay without calling booking adapter again', async () => {
    const booking = memoryBookingAdapter()
    const idem = memoryIdempotencyStore()
    const pipeline = createPipeline({
      config,
      booking,
      persistence: memoryPersistenceAdapter(),
      notification: memoryNotifier(),
      dedup: memoryDedupStore(),
      idempotencyStore: idem,
      logger: silentLogger,
    })
    const req = makeReq({ idempotencyKey: 'client-key-abc-123' })
    const r1 = await pipeline(req)
    const r2 = await pipeline(req) // replay
    expect(r1).toEqual(r2)
    // Booking adapter called exactly once — second call is a cache hit
    expect(booking.calls.createSession).toBe(1)
  })
})

describe('pipeline — state store writes', () => {
  it('state transitions pending → confirmed on happy path', async () => {
    const stateStore = memoryStateStore()
    const pipeline = createPipeline({
      config,
      booking: memoryBookingAdapter(),
      persistence: memoryPersistenceAdapter(),
      notification: memoryNotifier(),
      dedup: memoryDedupStore(),
      stateStore,
      logger: silentLogger,
    })
    const result = await pipeline(makeReq())
    if (!result.ok) throw new Error('expected ok')
    const state = await stateStore.get(result.body.submissionId)
    expect(state?.status).toBe('confirmed')
    expect(state?.vendorAppointmentId).toBeTruthy()
  })
})
