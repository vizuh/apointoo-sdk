// directConfirmAdapter — production adapter for tenants with no PMS.

import { describe, expect, it } from 'vitest'

import { directConfirmAdapter } from '../../../src/adapters/booking/direct-confirm/index.js'
import type {
  AdapterContext,
  BookingAttribution,
  BookingRequest,
  Logger,
} from '../../../src/core/types.js'
import type { WeeklySchedule } from '../../../src/core/scheduling.js'

// ── Shared stubs ──────────────────────────────────────────────────────────────

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

const FIXED_NOW = new Date('2026-05-24T10:00:00.000Z')

function makeCtx(): AdapterContext {
  return {
    config: {
      projectKey: 'example-studio',
      businessName: 'Example Studio',
      locale: 'pt-PT',
      timezone: 'Europe/Lisbon',
      services: [{ id: 'srv-1', name: 'Consulta' }],
      scheduling: {
        availableDays: [1, 2, 3, 4, 5],
        timeSlots: [{ label: '10:00', value: '10:00' }],
        minAdvanceDays: 0,
        maxAdvanceDays: 60,
      },
    },
    logger: silentLogger,
    now: () => FIXED_NOW,
  }
}

function makeRequest(overrides: Partial<BookingRequest> = {}): BookingRequest {
  const base: BookingRequest = {
    submissionId: 'sub-abcd1234',
    projectKey: 'example-studio',
    service: { id: 'srv-1', name: 'Consulta' } as never,
    serviceId: 'srv-1',
    requestedDate: '2026-06-01',
    requestedTime: '14:30',
    name: 'Test Lead',
    phone: '+351900000000',
    email: undefined,
    message: undefined,
    isNewPatient: undefined,
    offerCode: undefined,
    attribution: {
      gclid: null,
      fbclid: null,
      utmSource: null,
      utmMedium: null,
      utmCampaign: null,
      utmTerm: null,
      utmContent: null,
    } as unknown as BookingAttribution,
    metadata: {
      userAgent: undefined,
      locale: 'pt-PT',
      timezone: 'Europe/Lisbon',
      ip: undefined,
    },
    createdAtIso: FIXED_NOW.toISOString(),
    fingerprint: 'fp-test',
    configSnapshot: {
      timezone: 'Europe/Lisbon',
      locale: 'pt-PT',
      scheduling: {
        availableDays: [1, 2, 3, 4, 5],
        timeSlots: [{ label: '10:00', value: '10:00' }],
        minAdvanceDays: 0,
        maxAdvanceDays: 60,
      } as never,
    },
    ...overrides,
  }
  return base
}

// ── createSession ─────────────────────────────────────────────────────────────

describe('directConfirmAdapter — createSession', () => {
  it('returns a session with a dc_ prefixed UUID and the default vendor name', async () => {
    const adapter = directConfirmAdapter()
    const session = await adapter.createSession(makeRequest(), makeCtx())

    expect(session.vendorSessionId).toMatch(/^dc_[0-9a-f-]{36}$/)
    expect(session.vendor).toBe('direct-confirm')
    expect(session.expiresAtIso).toBeUndefined()
  })

  it('returns a fresh UUID on every call', async () => {
    const adapter = directConfirmAdapter()
    const a = await adapter.createSession(makeRequest(), makeCtx())
    const b = await adapter.createSession(makeRequest(), makeCtx())
    expect(a.vendorSessionId).not.toBe(b.vendorSessionId)
  })

  it('respects a custom vendorName option', async () => {
    const adapter = directConfirmAdapter({ vendorName: 'example-direct' })
    const session = await adapter.createSession(makeRequest(), makeCtx())
    expect(session.vendor).toBe('example-direct')
  })
})

// ── confirm ───────────────────────────────────────────────────────────────────

describe('directConfirmAdapter — confirm', () => {
  it('derives vendorAppointmentId deterministically from submissionId', async () => {
    const adapter = directConfirmAdapter()
    const session = await adapter.createSession(makeRequest(), makeCtx())
    const conf = await adapter.confirm(session, makeRequest({ submissionId: 'sub-xyz789' }), makeCtx())

    expect(conf.vendorAppointmentId).toBe('dc_appt_sub-xyz789')
  })

  it('returns the same vendorAppointmentId on retry with the same submissionId (idempotency)', async () => {
    const adapter = directConfirmAdapter()
    const session = await adapter.createSession(makeRequest(), makeCtx())
    const req = makeRequest({ submissionId: 'sub-stable' })

    const a = await adapter.confirm(session, req, makeCtx())
    const b = await adapter.confirm(session, req, makeCtx())
    expect(a.vendorAppointmentId).toBe(b.vendorAppointmentId)
  })

  it('builds confirmationCode as uppercase 8-char suffix prefixed with DC_', async () => {
    const adapter = directConfirmAdapter()
    const session = await adapter.createSession(makeRequest(), makeCtx())
    const conf = await adapter.confirm(session, makeRequest({ submissionId: 'sub-abcd1234' }), makeCtx())

    expect(conf.confirmationCode).toBe('DC_ABCD1234')
  })

  it('builds startTimeIso from requestedDate + requestedTime', async () => {
    const adapter = directConfirmAdapter()
    const session = await adapter.createSession(makeRequest(), makeCtx())
    const conf = await adapter.confirm(
      session,
      makeRequest({ requestedDate: '2026-07-15', requestedTime: '09:00' }),
      makeCtx(),
    )

    expect(conf.startTimeIso).toBe('2026-07-15T09:00:00')
  })

  it('returns no vendorClientId and an empty metadata bag', async () => {
    const adapter = directConfirmAdapter()
    const session = await adapter.createSession(makeRequest(), makeCtx())
    const conf = await adapter.confirm(session, makeRequest(), makeCtx())

    expect(conf.vendorClientId).toBeUndefined()
    expect(conf.metadata).toEqual({})
  })
})

// ── No-op methods (cancel, attachAttribution, cancelByAppointment) ───────────

describe('directConfirmAdapter — no-op surface', () => {
  it('attachAttribution resolves without throwing', async () => {
    const adapter = directConfirmAdapter()
    const session = await adapter.createSession(makeRequest(), makeCtx())
    await expect(
      adapter.attachAttribution(session, {} as BookingAttribution, makeCtx()),
    ).resolves.toBeUndefined()
  })

  it('cancel resolves without throwing', async () => {
    const adapter = directConfirmAdapter()
    const session = await adapter.createSession(makeRequest(), makeCtx())
    await expect(adapter.cancel(session, 'test', makeCtx())).resolves.toBeUndefined()
  })

  it('cancelByAppointment resolves without throwing', async () => {
    const adapter = directConfirmAdapter()
    await expect(
      adapter.cancelByAppointment('dc_appt_sub-1', 'test', makeCtx()),
    ).resolves.toBeUndefined()
  })
})

// ── rescheduleByAppointment ───────────────────────────────────────────────────

describe('directConfirmAdapter — rescheduleByAppointment', () => {
  it('echoes the same vendorAppointmentId with a recomputed startIso', async () => {
    const adapter = directConfirmAdapter()
    const result = await adapter.rescheduleByAppointment(
      'dc_appt_sub-xyz',
      '2026-08-01',
      '11:30',
      makeCtx(),
    )

    expect(result.vendorAppointmentId).toBe('dc_appt_sub-xyz')
    expect(result.newStartIso).toBe('2026-08-01T11:30:00')
  })
})

// ── findStaffVariants ─────────────────────────────────────────────────────────

describe('directConfirmAdapter — findStaffVariants', () => {
  it('returns an empty array (no staff model at the adapter layer)', async () => {
    const adapter = directConfirmAdapter()
    const variants = await adapter.findStaffVariants(
      { serviceId: 'srv-1', date: '2026-06-01', time: '10:00' },
      makeCtx(),
    )
    expect(variants).toEqual([])
  })
})

// ── findAvailability ──────────────────────────────────────────────────────────

describe('directConfirmAdapter — findAvailability', () => {
  it('returns [] when no weeklySchedule was supplied at construction', async () => {
    const adapter = directConfirmAdapter()
    const slots = await adapter.findAvailability(
      { serviceId: 'srv-1', fromDate: '2026-06-01', toDate: '2026-06-03' },
      makeCtx(),
    )
    expect(slots).toEqual([])
  })

  it('returns generated slots when a weeklySchedule is supplied', async () => {
    const schedule: WeeklySchedule = {
      mon: [{ start: '09:00', end: '12:00' }],
    }
    const adapter = directConfirmAdapter({
      weeklySchedule: schedule,
      slotDurationMinutes: 60,
    })
    // 2026-06-01 is a Monday — should yield 3 hourly slots (09, 10, 11)
    const slots = await adapter.findAvailability(
      { serviceId: 'srv-1', fromDate: '2026-06-01', toDate: '2026-06-01' },
      makeCtx(),
    )
    expect(slots.length).toBeGreaterThan(0)
    expect(slots.every((s) => s.date === '2026-06-01')).toBe(true)
    expect(slots.map((s) => s.time)).toEqual(['09:00', '10:00', '11:00'])
  })
})

// ── health ────────────────────────────────────────────────────────────────────

describe('directConfirmAdapter — health', () => {
  it('always reports ok with the default vendor name', async () => {
    const adapter = directConfirmAdapter()
    const health = await adapter.health(makeCtx())
    expect(health.ok).toBe(true)
    expect(health.name).toBe('direct-confirm')
    expect(typeof health.version).toBe('string')
  })

  it('reports the configured vendorName override', async () => {
    const adapter = directConfirmAdapter({ vendorName: 'custom-brand' })
    const health = await adapter.health(makeCtx())
    expect(health.name).toBe('custom-brand')
  })
})
