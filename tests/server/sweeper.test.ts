// tests/server/sweeper.test.ts — stale-state recovery + alert + event emission
// covers critical-path behavior for src/server/sweeper.ts
//
// The sweeper marks 'pending' state rows as 'abandoned' if older than the
// staleAfterMinutes threshold. Boundary correctness matters — off-by-one
// would mark in-flight bookings as abandoned.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runSweep } from '../../src/server/sweeper.js'
import { memoryStateStore } from '../../src/adapters/state/memory.js'
import { memoryQueue } from '../../src/queue/memory.js'
import { inMemoryEventBus } from '../../src/core/events.js'
import type { DomainEvent } from '../../src/core/events.js'
import type { Logger } from '../../src/core/types.js'
import type { BookingStateCreate } from '../../src/adapters/state/adapter.js'

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

function makeStateInput(overrides: Partial<BookingStateCreate> = {}): BookingStateCreate {
  return {
    submissionId: 'bk_test',
    tenantId: 'tenant-A',
    vendor: 'memory',
    gclid: null,
    fbclid: null,
    msclkid: null,
    utmSource: null,
    utmMedium: null,
    utmCampaign: null,
    rwgToken: null,
    createdAt: new Date(),
    status: 'pending',
    ...overrides,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('runSweep — staleness boundary', () => {
  it('marks pending items older than threshold as abandoned', async () => {
    const stateStore = memoryStateStore()
    await stateStore.create(makeStateInput({ submissionId: 'bk_old' }))

    // Advance past the threshold
    vi.setSystemTime(new Date('2026-01-01T00:15:00Z')) // +15 min

    const summary = await runSweep({
      stateStore,
      staleAfterMinutes: 10,
      logger: silentLogger,
    })

    expect(summary.scanned).toBe(1)
    expect(summary.marked).toBe(1)
    expect((await stateStore.get('bk_old'))?.status).toBe('abandoned')
    expect((await stateStore.get('bk_old'))?.errorCode).toBe('SWEEPER_STALE_PENDING')
  })

  it('does NOT mark items below threshold (still in-flight)', async () => {
    const stateStore = memoryStateStore()
    await stateStore.create(makeStateInput({ submissionId: 'bk_fresh' }))

    // Advance 5 min — under the 10-min threshold
    vi.setSystemTime(new Date('2026-01-01T00:05:00Z'))

    const summary = await runSweep({
      stateStore,
      staleAfterMinutes: 10,
      logger: silentLogger,
    })

    expect(summary.scanned).toBe(0)
    expect(summary.marked).toBe(0)
    expect((await stateStore.get('bk_fresh'))?.status).toBe('pending')
  })

  it('segregates stale vs fresh in the same sweep', async () => {
    const stateStore = memoryStateStore()
    await stateStore.create(makeStateInput({ submissionId: 'bk_old' }))

    // 20 min later, create a fresh one
    vi.setSystemTime(new Date('2026-01-01T00:20:00Z'))
    await stateStore.create(makeStateInput({ submissionId: 'bk_fresh' }))

    const summary = await runSweep({
      stateStore,
      staleAfterMinutes: 10,
      logger: silentLogger,
    })

    expect(summary.scanned).toBe(1) // only the old one
    expect(summary.marked).toBe(1)
    expect((await stateStore.get('bk_old'))?.status).toBe('abandoned')
    expect((await stateStore.get('bk_fresh'))?.status).toBe('pending')
  })

  it('ignores non-pending items (already abandoned / confirmed / failed)', async () => {
    const stateStore = memoryStateStore()
    await stateStore.create(makeStateInput({ submissionId: 'bk_confirmed' }))
    await stateStore.transition('bk_confirmed', { status: 'confirmed', vendorAppointmentId: 'apt-1' })

    vi.setSystemTime(new Date('2026-01-01T00:15:00Z'))

    const summary = await runSweep({
      stateStore,
      staleAfterMinutes: 10,
      logger: silentLogger,
    })

    expect(summary.scanned).toBe(0)
    expect(summary.marked).toBe(0)
    expect((await stateStore.get('bk_confirmed'))?.status).toBe('confirmed')
  })

  it('uses default 20min threshold (ADR-018 §10) when staleAfterMinutes is omitted', async () => {
    const stateStore = memoryStateStore()
    await stateStore.create(makeStateInput({ submissionId: 'bk_a' }))

    // 21 min later — past default
    vi.setSystemTime(new Date('2026-01-01T00:21:00Z'))

    const summary = await runSweep({
      stateStore,
      logger: silentLogger,
    })

    expect(summary.marked).toBe(1)
  })

  it('respects tenantId filter — does not touch other tenants', async () => {
    const stateStore = memoryStateStore()
    await stateStore.create(makeStateInput({ submissionId: 'bk_a', tenantId: 'tenant-A' }))
    await stateStore.create(makeStateInput({ submissionId: 'bk_b', tenantId: 'tenant-B' }))

    vi.setSystemTime(new Date('2026-01-01T00:15:00Z'))

    const summary = await runSweep({
      stateStore,
      staleAfterMinutes: 10,
      tenantId: 'tenant-A',
      logger: silentLogger,
    })

    expect(summary.marked).toBe(1)
    expect((await stateStore.get('bk_a'))?.status).toBe('abandoned')
    expect((await stateStore.get('bk_b'))?.status).toBe('pending')
  })
})

describe('runSweep — alert side-effects', () => {
  it('enqueues an alert when alertQueue + alertChannel + builder are configured', async () => {
    const stateStore = memoryStateStore()
    const alertQueue = memoryQueue()
    await stateStore.create(makeStateInput({ submissionId: 'bk_old' }))

    vi.setSystemTime(new Date('2026-01-01T00:15:00Z'))

    const summary = await runSweep({
      stateStore,
      staleAfterMinutes: 10,
      alertQueue,
      alertChannel: 'email',
      alertPayloadBuilder: (state) => ({ to: 'ops@example.com', submissionId: state.submissionId }),
      logger: silentLogger,
    })

    expect(summary.alertsEnqueued).toBe(1)
    const claimed = await alertQueue.claim(10, 'worker-1')
    expect(claimed).toHaveLength(1)
    expect(claimed[0]!.channel).toBe('email')
    expect(claimed[0]!.payload.submissionId).toBe('bk_old')
  })

  it('does NOT enqueue when alertQueue is omitted', async () => {
    const stateStore = memoryStateStore()
    await stateStore.create(makeStateInput({ submissionId: 'bk_old' }))

    vi.setSystemTime(new Date('2026-01-01T00:15:00Z'))

    const summary = await runSweep({
      stateStore,
      staleAfterMinutes: 10,
      logger: silentLogger,
    })

    expect(summary.alertsEnqueued).toBe(0)
  })

  it('does NOT enqueue when alertPayloadBuilder is omitted', async () => {
    const stateStore = memoryStateStore()
    const alertQueue = memoryQueue()
    await stateStore.create(makeStateInput({ submissionId: 'bk_old' }))

    vi.setSystemTime(new Date('2026-01-01T00:15:00Z'))

    const summary = await runSweep({
      stateStore,
      staleAfterMinutes: 10,
      alertQueue,
      alertChannel: 'email',
      logger: silentLogger,
    })

    expect(summary.alertsEnqueued).toBe(0)
  })
})

describe('runSweep — event emission', () => {
  it('publishes booking.abandoned to the event bus with correct ageMinutes', async () => {
    const stateStore = memoryStateStore()
    const events: DomainEvent[] = []
    const bus = inMemoryEventBus()
    bus.subscribeAll((e) => {
      events.push(e)
    })

    await stateStore.create(makeStateInput({ submissionId: 'bk_old' }))

    // 17 minutes later
    vi.setSystemTime(new Date('2026-01-01T00:17:00Z'))

    await runSweep({
      stateStore,
      staleAfterMinutes: 10,
      eventBus: bus,
      logger: silentLogger,
    })

    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('booking.abandoned')
    if (events[0]!.type === 'booking.abandoned') {
      expect(events[0]!.ageMinutes).toBe(17)
      expect(events[0]!.submissionId).toBe('bk_old')
      expect(events[0]!.tenantId).toBe('tenant-A')
    }
  })

  it('does not publish when eventBus is absent', async () => {
    const stateStore = memoryStateStore()
    await stateStore.create(makeStateInput({ submissionId: 'bk_old' }))

    vi.setSystemTime(new Date('2026-01-01T00:15:00Z'))

    // No throw, no event bus
    const summary = await runSweep({
      stateStore,
      staleAfterMinutes: 10,
      logger: silentLogger,
    })

    expect(summary.marked).toBe(1)
  })
})

describe('runSweep — resilience', () => {
  it('continues past a transition() failure and surfaces the rest', async () => {
    const stateStore = memoryStateStore()
    await stateStore.create(makeStateInput({ submissionId: 'bk_one' }))
    await stateStore.create(makeStateInput({ submissionId: 'bk_two' }))

    vi.setSystemTime(new Date('2026-01-01T00:15:00Z'))

    // Patch the store to fail on bk_one only
    const original = stateStore.transition.bind(stateStore)
    stateStore.transition = vi.fn(async (id, change) => {
      if (id === 'bk_one') throw new Error('simulated supabase outage')
      return original(id, change)
    })

    const errLogs: unknown[] = []
    const captureLogger: Logger = {
      ...silentLogger,
      error: (evt) => {
        errLogs.push(evt)
      },
    }

    const summary = await runSweep({
      stateStore,
      staleAfterMinutes: 10,
      logger: captureLogger,
    })

    // Both scanned; only one marked successfully
    expect(summary.scanned).toBe(2)
    expect(summary.marked).toBe(1)
    expect(errLogs.length).toBeGreaterThan(0)
  })
})
