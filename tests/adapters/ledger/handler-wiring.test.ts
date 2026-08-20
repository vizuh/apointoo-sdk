// tests/adapters/ledger/handler-wiring.test.ts — Tier 2 (wiring).
// createBookingHandler registers a fire-and-forget ledger subscriber on the
// event bus when BOTH ledger and eventBus are passed. Publishing a domain
// event yields exactly one ledger.append; a throwing ledger never propagates.
import { describe, expect, it, vi } from 'vitest'
import { createBookingHandler } from '../../../src/server/handler.js'
import { memoryBookingAdapter } from '../../../src/adapters/booking/memory/index.js'
import { memoryPersistenceAdapter } from '../../../src/adapters/persistence/memory/index.js'
import { memoryNotifier } from '../../../src/adapters/notification/memory/index.js'
import { memoryDedupStore } from '../../../src/adapters/dedup/memory.js'
import { memoryEventLedger } from '../../../src/adapters/ledger/memory.js'
import { inMemoryEventBus } from '../../../src/core/events.js'
import type { BookingConfirmedEvent } from '../../../src/core/events.js'
import type { EventLedger } from '../../../src/adapters/ledger/adapter.js'
import type { BookingKitConfig } from '../../../src/core/schemas.js'

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

const confirmed: BookingConfirmedEvent = {
  type: 'booking.confirmed',
  ts: Date.parse('2026-06-01T10:00:00Z'),
  tenantId: 'test-tenant',
  submissionId: 'bk_20260601_deadbeef',
  vendor: 'memory',
  vendorAppointmentId: 'appt-1',
  vendorClientId: undefined,
  attribution: { gclid: 'CL123' },
}

function baseOpts() {
  return {
    config,
    booking: memoryBookingAdapter(),
    persistence: memoryPersistenceAdapter(),
    notification: memoryNotifier(),
    dedup: memoryDedupStore(),
  }
}

async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r))
}

describe('createBookingHandler — ledger wiring', () => {
  it('appends exactly one ledger event per published domain event', async () => {
    const bus = inMemoryEventBus()
    const ledger = memoryEventLedger()
    createBookingHandler({ ...baseOpts(), eventBus: bus, ledger })

    await bus.publish(confirmed)
    await flush()

    const events = ledger.events()
    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('booking.confirmed')
    expect(events[0]!.subjectKey).toBe('bk_20260601_deadbeef')
    expect(events[0]!.attribution).toEqual({ gclid: 'CL123' })
  })

  it('does not subscribe when ledger is set but eventBus is not', async () => {
    const ledger = memoryEventLedger()
    const appendSpy = vi.spyOn(ledger, 'append')
    createBookingHandler({ ...baseOpts(), ledger })
    await flush()
    expect(appendSpy).not.toHaveBeenCalled()
  })

  it('a throwing ledger never rejects the publish', async () => {
    const bus = inMemoryEventBus()
    const throwingLedger: EventLedger = {
      append: vi.fn().mockRejectedValue(new Error('ledger down')),
      appendEdge: vi.fn(),
      health: vi.fn().mockResolvedValue({ ok: false, name: 'broken' }),
    }
    createBookingHandler({ ...baseOpts(), eventBus: bus, ledger: throwingLedger })

    await expect(bus.publish(confirmed)).resolves.toBeUndefined()
    await flush()
    expect(throwingLedger.append).toHaveBeenCalledTimes(1)
  })
})
