// tests/core/ids.test.ts — Tier 1 (unit, pure functions, property-based)
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  fingerprintBookingRequest,
  generateSubmissionId,
  newConversionId,
  newEventId,
  newSessionId,
  newSubjectId,
  newTenantId,
  newVisitorId,
} from '../../src/core/ids.js'
import type { BookingRequestInputWire } from '../../src/core/schemas.js'

const base: BookingRequestInputWire = {
  serviceId: 'svc-1',
  requestedDate: '2026-06-01',
  requestedTime: '10:00',
  name: 'Ana Silva',
  phone: '+5511999990001',
}

describe('generateSubmissionId', () => {
  it('matches bk_YYYYMMDD_<8hex> format', () => {
    const id = generateSubmissionId('America/Sao_Paulo', new Date('2026-06-01T12:00:00Z'))
    expect(id).toMatch(/^bk_\d{8}_[0-9a-f]{8}$/)
  })

  it('uses business timezone — date portion reflects local date not UTC', () => {
    // 23:00 UTC = 2026-06-01 in UTC+12 (Auckland in June)
    const id = generateSubmissionId('Pacific/Auckland', new Date('2026-05-31T23:00:00Z'))
    expect(id.startsWith('bk_20260601_')).toBe(true)
  })

  it('falls back gracefully on invalid timezone (no throw)', () => {
    const id = generateSubmissionId('Not/A/Timezone', new Date('2026-06-01T12:00:00Z'))
    expect(id).toMatch(/^bk_\d{8}_[0-9a-f]{8}$/)
  })
})

describe('neutral id minters', () => {
  const minters = [
    ['newEventId', newEventId, 'evt'],
    ['newVisitorId', newVisitorId, 'vis'],
    ['newSessionId', newSessionId, 'ses'],
    ['newSubjectId', newSubjectId, 'sub'],
    ['newConversionId', newConversionId, 'cnv'],
    ['newTenantId', newTenantId, 'ten'],
  ] as const

  for (const [name, mint, prefix] of minters) {
    it(`${name} mints <${prefix}>_<24hex>`, () => {
      expect(mint()).toMatch(new RegExp(`^${prefix}_[0-9a-f]{24}$`))
    })
  }

  it('mints unique ids across calls', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newEventId()))
    expect(ids.size).toBe(1000)
  })
})

describe('fingerprintBookingRequest — determinism (property-based)', () => {
  it('is stable: same fields always produce the same hash', () => {
    fc.assert(
      fc.property(
        fc.record({
          serviceId: fc.string({ minLength: 1, maxLength: 64 }),
          requestedDate: fc.constant('2026-06-01'),
          requestedTime: fc.constant('09:00'),
          name: fc.string({ minLength: 1, maxLength: 60 }),
          phone: fc.constant('+5511999990001'),
        }),
        (input: BookingRequestInputWire) => {
          return fingerprintBookingRequest(input) === fingerprintBookingRequest({ ...input })
        },
      ),
    )
  })

  it('normalizes phone digits (spaces/dashes stripped before hash)', () => {
    const a = fingerprintBookingRequest({ ...base, phone: '+55 11 99999-0001' })
    const b = fingerprintBookingRequest({ ...base, phone: '+5511999990001' })
    expect(a).toBe(b)
  })

  it('is case-insensitive for name', () => {
    expect(fingerprintBookingRequest({ ...base, name: 'ANA SILVA' })).toBe(
      fingerprintBookingRequest({ ...base, name: 'ana silva' }),
    )
  })

  it('excludes tracking fields from hash (attribution changes do not create new fingerprint)', () => {
    const noTracking = fingerprintBookingRequest(base)
    const withTracking = fingerprintBookingRequest({ ...base, tracking: { gclid: 'CL123' } })
    expect(noTracking).toBe(withTracking)
  })

  it('changes hash when service changes', () => {
    expect(fingerprintBookingRequest({ ...base, serviceId: 'svc-2' })).not.toBe(
      fingerprintBookingRequest(base),
    )
  })
})
