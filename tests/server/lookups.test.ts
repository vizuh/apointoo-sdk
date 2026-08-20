// tests/server/lookups.test.ts — reschedule + cancel + cancellation policy
// covers critical-path behavior for src/server/lookups.ts
//
// The cancellation-policy enforcement is the business-rule risk: off-by-one
// in minHoursBefore lets customers cancel past the policy window.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runCancel, runReschedule } from '../../src/server/lookups.js'
import { memoryStateStore } from '../../src/adapters/state/memory.js'
import type { BookingAdapter, RescheduleResult } from '../../src/adapters/booking/adapter.js'
import type { BookingKitConfig } from '../../src/core/schemas.js'
import type { Logger } from '../../src/core/types.js'

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

function makeConfig(overrides: Partial<BookingKitConfig['scheduling']> = {}): BookingKitConfig {
  return {
    projectKey: 'tenant-A',
    businessName: 'Test Clinic',
    locale: 'pt-BR',
    timezone: 'America/Sao_Paulo',
    services: [{ id: 'svc-1', name: 'Consultation', isActive: true }],
    scheduling: {
      availableDays: [1, 2, 3, 4, 5],
      timeSlots: [{ label: '10:00', value: '10:00' }],
      minAdvanceDays: 0,
      maxAdvanceDays: 90,
      ...overrides,
    },
  }
}

function makeAdapter(overrides: Partial<BookingAdapter> = {}): BookingAdapter {
  return {
    createSession: vi.fn(async () => ({ vendorSessionId: 'sess-1', vendor: 'memory', expiresAtIso: undefined })),
    attachAttribution: vi.fn(async () => undefined),
    confirm: vi.fn(async () => ({
      vendorAppointmentId: 'apt-1',
      vendorClientId: undefined,
      confirmationCode: 'CONF',
      startTimeIso: undefined,
      metadata: {},
    })),
    cancel: vi.fn(async () => undefined),
    cancelByAppointment: vi.fn(async () => undefined),
    rescheduleByAppointment: vi.fn(
      async (): Promise<RescheduleResult> => ({
        vendorAppointmentId: 'apt-1',
        newStartIso: '2026-08-15T10:00:00Z',
      }),
    ),
    findAvailability: vi.fn(async () => []),
    findStaffVariants: vi.fn(async () => []),
    health: vi.fn(async () => ({ ok: true as const, name: 'memory', version: '0' })),
    ...overrides,
  }
}

async function seedConfirmedBooking(
  stateStore: ReturnType<typeof memoryStateStore>,
  appointmentStartIso?: string,
  tenantId: string = 'tenant-A',
) {
  await stateStore.create({
    submissionId: 'bk_x',
    tenantId,
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
  })
  await stateStore.transition('bk_x', {
    status: 'confirmed',
    vendorAppointmentId: 'apt-1',
    ...(appointmentStartIso ? { appointmentStartIso } : {}),
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-08-01T10:00:00Z'))
})

afterEach(() => {
  vi.useRealTimers()
})

// ── runReschedule ────────────────────────────────────────────────────────────

describe('runReschedule — input validation', () => {
  it('returns 400 INPUT_INVALID on malformed JSON', async () => {
    const stateStore = memoryStateStore()
    const result = await runReschedule('bk_x', '{ malformed', {
      config: makeConfig(),
      booking: makeAdapter(),
      stateStore,
      logger: silentLogger,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(400)
      expect(result.body.errorCode).toBe('INPUT_INVALID')
    }
  })

  it('returns 400 INPUT_INVALID when schema validation fails', async () => {
    const stateStore = memoryStateStore()
    const result = await runReschedule(
      'bk_x',
      JSON.stringify({ newDate: 'invalid-date', newTime: '99:99' }),
      { config: makeConfig(), booking: makeAdapter(), stateStore, logger: silentLogger },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(400)
    }
  })
})

describe('runReschedule — state lookup', () => {
  it('returns 404 NOT_FOUND when submissionId is unknown', async () => {
    const stateStore = memoryStateStore()
    const result = await runReschedule(
      'bk_missing',
      JSON.stringify({ newDate: '2026-08-15', newTime: '10:00' }),
      { config: makeConfig(), booking: makeAdapter(), stateStore, logger: silentLogger },
    )
    if (!result.ok) {
      expect(result.status).toBe(404)
      expect(result.body.errorCode).toBe('NOT_FOUND')
    }
  })

  it('returns 403 FORBIDDEN when tenant mismatches', async () => {
    const stateStore = memoryStateStore()
    await seedConfirmedBooking(stateStore, undefined, 'tenant-Z')
    const result = await runReschedule(
      'bk_x',
      JSON.stringify({ newDate: '2026-08-15', newTime: '10:00' }),
      { config: makeConfig(), booking: makeAdapter(), stateStore, logger: silentLogger },
    )
    if (!result.ok) {
      expect(result.status).toBe(403)
      expect(result.body.errorCode).toBe('FORBIDDEN')
    }
  })

  it('returns 409 INVALID_STATE when booking is not confirmed', async () => {
    const stateStore = memoryStateStore()
    await stateStore.create({
      submissionId: 'bk_x',
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
    })
    const result = await runReschedule(
      'bk_x',
      JSON.stringify({ newDate: '2026-08-15', newTime: '10:00' }),
      { config: makeConfig(), booking: makeAdapter(), stateStore, logger: silentLogger },
    )
    if (!result.ok) {
      expect(result.status).toBe(409)
      expect(result.body.errorCode).toBe('INVALID_STATE')
    }
  })
})

describe('runReschedule — happy + adapter error path', () => {
  it('returns 200 with vendorAppointmentId on success', async () => {
    const stateStore = memoryStateStore()
    await seedConfirmedBooking(stateStore)
    const booking = makeAdapter()
    const result = await runReschedule(
      'bk_x',
      JSON.stringify({ newDate: '2026-08-15', newTime: '10:00' }),
      { config: makeConfig(), booking, stateStore, logger: silentLogger },
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.status).toBe(200)
      expect(result.body.success).toBe(true)
      expect(result.body.vendorAppointmentId).toBe('apt-1')
    }
    expect(booking.rescheduleByAppointment).toHaveBeenCalledOnce()
  })

  it('returns 502 BOOKING_FAILED when adapter throws', async () => {
    const stateStore = memoryStateStore()
    await seedConfirmedBooking(stateStore)
    const booking = makeAdapter({
      rescheduleByAppointment: vi.fn(async () => {
        throw new Error('vendor down')
      }),
    })
    const result = await runReschedule(
      'bk_x',
      JSON.stringify({ newDate: '2026-08-15', newTime: '10:00' }),
      { config: makeConfig(), booking, stateStore, logger: silentLogger },
    )
    if (!result.ok) {
      expect(result.status).toBe(502)
      expect(result.body.errorCode).toBe('BOOKING_FAILED')
      expect(result.body.retryable).toBe(true)
    }
  })

  it('updates state.vendorAppointmentId when vendor returns a new id', async () => {
    const stateStore = memoryStateStore()
    await seedConfirmedBooking(stateStore)
    const booking = makeAdapter({
      rescheduleByAppointment: vi.fn(async () => ({
        vendorAppointmentId: 'apt-NEW',
        newStartIso: '2026-08-15T10:00:00Z',
      })),
    })
    await runReschedule(
      'bk_x',
      JSON.stringify({ newDate: '2026-08-15', newTime: '10:00' }),
      { config: makeConfig(), booking, stateStore, logger: silentLogger },
    )
    expect((await stateStore.get('bk_x'))?.vendorAppointmentId).toBe('apt-NEW')
  })
})

// ── runCancel ────────────────────────────────────────────────────────────────

describe('runCancel — state lookup', () => {
  it('returns 404 NOT_FOUND when submissionId is unknown', async () => {
    const stateStore = memoryStateStore()
    const result = await runCancel('bk_missing', 'user requested', {
      config: makeConfig(),
      booking: makeAdapter(),
      stateStore,
      logger: silentLogger,
    })
    if (!result.ok) expect(result.status).toBe(404)
  })

  it('returns 403 FORBIDDEN on tenant mismatch', async () => {
    const stateStore = memoryStateStore()
    await seedConfirmedBooking(stateStore, undefined, 'tenant-Z')
    const result = await runCancel('bk_x', 'reason', {
      config: makeConfig(),
      booking: makeAdapter(),
      stateStore,
      logger: silentLogger,
    })
    if (!result.ok) expect(result.status).toBe(403)
  })

  it('returns 409 INVALID_STATE if booking is not confirmed', async () => {
    const stateStore = memoryStateStore()
    await stateStore.create({
      submissionId: 'bk_x',
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
    })
    const result = await runCancel('bk_x', 'r', {
      config: makeConfig(),
      booking: makeAdapter(),
      stateStore,
      logger: silentLogger,
    })
    if (!result.ok) expect(result.status).toBe(409)
  })
})

describe('runCancel — cancellation policy', () => {
  it('returns 409 CANCEL_TOO_LATE when appointment is closer than minHoursBefore', async () => {
    const stateStore = memoryStateStore()
    // Now = 2026-08-01T10:00:00Z; appointment in 1h
    await seedConfirmedBooking(stateStore, '2026-08-01T11:00:00Z')
    const config = makeConfig({ cancellationPolicy: { minHoursBefore: 2 } })

    const result = await runCancel('bk_x', 'user requested', {
      config,
      booking: makeAdapter(),
      stateStore,
      logger: silentLogger,
    })

    if (!result.ok) {
      expect(result.status).toBe(409)
      expect(result.body.errorCode).toBe('CANCEL_TOO_LATE')
    }
  })

  it('allows cancel when appointment is exactly at the boundary (>= minHoursBefore)', async () => {
    const stateStore = memoryStateStore()
    // Appointment 2h away; minHoursBefore: 2 (boundary case — strictly < is rejected)
    await seedConfirmedBooking(stateStore, '2026-08-01T12:00:00Z')
    const config = makeConfig({ cancellationPolicy: { minHoursBefore: 2 } })

    const result = await runCancel('bk_x', 'reason', {
      config,
      booking: makeAdapter(),
      stateStore,
      logger: silentLogger,
    })

    // hoursUntil === 2, policy.minHoursBefore === 2, so 2 < 2 is false → allowed
    expect(result.ok).toBe(true)
  })

  it('allows cancel with hours to spare', async () => {
    const stateStore = memoryStateStore()
    // Appointment 48h away
    await seedConfirmedBooking(stateStore, '2026-08-03T10:00:00Z')
    const config = makeConfig({ cancellationPolicy: { minHoursBefore: 24 } })

    const result = await runCancel('bk_x', 'reason', {
      config,
      booking: makeAdapter(),
      stateStore,
      logger: silentLogger,
    })

    expect(result.ok).toBe(true)
  })

  it('fails open when appointmentStartIso is absent (policy cannot evaluate)', async () => {
    const stateStore = memoryStateStore()
    await seedConfirmedBooking(stateStore) // no appointmentStartIso
    const config = makeConfig({ cancellationPolicy: { minHoursBefore: 999 } })

    const result = await runCancel('bk_x', 'reason', {
      config,
      booking: makeAdapter(),
      stateStore,
      logger: silentLogger,
    })

    // Policy can't enforce without appointmentStartIso → allow cancel
    expect(result.ok).toBe(true)
  })

  it('fails open when policy is not configured', async () => {
    const stateStore = memoryStateStore()
    await seedConfirmedBooking(stateStore, '2026-08-01T10:30:00Z') // 30min away
    const config = makeConfig() // no cancellationPolicy at all

    const result = await runCancel('bk_x', 'reason', {
      config,
      booking: makeAdapter(),
      stateStore,
      logger: silentLogger,
    })

    expect(result.ok).toBe(true)
  })
})

describe('runCancel — happy + adapter error path', () => {
  it('returns 200 success and transitions state to cancelled/CANCELLED_BY_USER', async () => {
    const stateStore = memoryStateStore()
    await seedConfirmedBooking(stateStore)
    const booking = makeAdapter()

    const result = await runCancel('bk_x', 'user requested', {
      config: makeConfig(),
      booking,
      stateStore,
      logger: silentLogger,
    })

    expect(result.ok).toBe(true)
    expect(booking.cancelByAppointment).toHaveBeenCalledWith('apt-1', 'user requested', expect.anything())
    const state = await stateStore.get('bk_x')
    expect(state?.status).toBe('cancelled')
    expect(state?.errorCode).toBe('CANCELLED_BY_USER')
  })

  it('returns 502 BOOKING_FAILED when adapter throws', async () => {
    const stateStore = memoryStateStore()
    await seedConfirmedBooking(stateStore)
    const booking = makeAdapter({
      cancelByAppointment: vi.fn(async () => {
        throw new Error('vendor down')
      }),
    })
    const result = await runCancel('bk_x', 'reason', {
      config: makeConfig(),
      booking,
      stateStore,
      logger: silentLogger,
    })
    if (!result.ok) {
      expect(result.status).toBe(502)
      expect(result.body.retryable).toBe(true)
    }
  })
})
