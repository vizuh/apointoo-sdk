// tests/adapters/ledger/translate.test.ts — Tier 1 (unit).
import { describe, expect, it } from 'vitest'
import { translateDomainEvent } from '../../../src/adapters/ledger/translate.js'
import type { BookingConfirmedEvent } from '../../../src/core/events.js'

const confirmed: BookingConfirmedEvent = {
  type: 'booking.confirmed',
  ts: Date.parse('2026-06-01T10:00:00Z'),
  tenantId: 'ten-1',
  submissionId: 'bk_20260601_deadbeef',
  vendor: 'blvd',
  vendorAppointmentId: 'appt-99',
  vendorClientId: 'client-7',
  attribution: { gclid: 'CL123' },
}

describe('translateDomainEvent', () => {
  it('maps a booking.confirmed event to a neutral LedgerEvent', () => {
    const before = Date.now()
    const led = translateDomainEvent(confirmed)
    const after = Date.now()

    expect(led.eventId).toMatch(/^evt_[0-9a-f]{24}$/)
    expect(led.type).toBe('booking.confirmed')
    expect(led.tenantId).toBe('ten-1')
    expect(led.subjectKey).toBe('bk_20260601_deadbeef')
    expect(led.occurredAt.toISOString()).toBe('2026-06-01T10:00:00.000Z')
    // receivedAt is ingestion time (now), distinct from occurredAt.
    expect(led.receivedAt.getTime()).toBeGreaterThanOrEqual(before)
    expect(led.receivedAt.getTime()).toBeLessThanOrEqual(after)
  })

  it('lifts attribution to its own field', () => {
    expect(translateDomainEvent(confirmed).attribution).toEqual({ gclid: 'CL123' })
  })

  it('puts residual event fields into properties (and not the promoted ones)', () => {
    const { properties } = translateDomainEvent(confirmed)
    expect(properties).toMatchObject({
      vendor: 'blvd',
      vendorAppointmentId: 'appt-99',
      vendorClientId: 'client-7',
      submissionId: 'bk_20260601_deadbeef',
    })
    expect(properties).not.toHaveProperty('ts')
    expect(properties).not.toHaveProperty('tenantId')
    expect(properties).not.toHaveProperty('type')
    expect(properties).not.toHaveProperty('attribution')
  })

  it('sets attribution to null when the event carries none', () => {
    const spam = {
      type: 'booking.spam_rejected' as const,
      ts: Date.parse('2026-06-01T10:00:00Z'),
      tenantId: 'ten-1',
      submissionId: 'bk_20260601_cafef00d',
    }
    expect(translateDomainEvent(spam).attribution).toBeNull()
  })
})
