// tests/adapters/state/selectors.test.ts — Tier 1 (unit) for the status
// selectors. Exhaustive over the 13-value BookingStateStatus enum so a future
// state addition forces a deliberate selector choice.

import { describe, expect, it } from 'vitest'

import type { BookingState, BookingStateStatus } from '../../../src/adapters/state/adapter.js'
import {
  hasUploadableClickId,
  isActiveLead,
  isRealBooking,
  isTerminal,
} from '../../../src/adapters/state/selectors.js'

const ALL_STATUSES: BookingStateStatus[] = [
  'draft',
  'contact_captured',
  'slot_held',
  'payment_pending',
  'pending',
  'confirmed',
  'cancelled',
  'rescheduled',
  'no_show',
  'completed',
  'failed',
  'expired',
  'abandoned',
]

describe('isRealBooking', () => {
  it('returns true only for confirmed and completed', () => {
    const yes = ALL_STATUSES.filter(isRealBooking).sort()
    expect(yes).toEqual(['completed', 'confirmed'])
  })

  it('returns false for rescheduled (a new submissionId carries truth now)', () => {
    expect(isRealBooking('rescheduled')).toBe(false)
  })

  it('returns false for no_show (policy-dependent — ask elsewhere)', () => {
    expect(isRealBooking('no_show')).toBe(false)
  })

  it('returns false for in-flight statuses', () => {
    expect(isRealBooking('slot_held')).toBe(false)
    expect(isRealBooking('payment_pending')).toBe(false)
    expect(isRealBooking('pending')).toBe(false)
  })
})

describe('isTerminal', () => {
  it('matches the ADR-020 terminal set', () => {
    const yes = ALL_STATUSES.filter(isTerminal).sort()
    expect(yes).toEqual([
      'abandoned',
      'cancelled',
      'completed',
      'expired',
      'failed',
      'no_show',
      'rescheduled',
    ])
  })

  it('returns false for in-flight statuses', () => {
    expect(isTerminal('draft')).toBe(false)
    expect(isTerminal('contact_captured')).toBe(false)
    expect(isTerminal('slot_held')).toBe(false)
    expect(isTerminal('payment_pending')).toBe(false)
    expect(isTerminal('pending')).toBe(false)
    expect(isTerminal('confirmed')).toBe(false)
  })
})

describe('isActiveLead', () => {
  it('covers in-flight statuses with contact captured (incl. legacy pending)', () => {
    const yes = ALL_STATUSES.filter(isActiveLead).sort()
    expect(yes).toEqual(['contact_captured', 'payment_pending', 'pending', 'slot_held'])
  })

  it('returns false for draft (no contact captured yet)', () => {
    expect(isActiveLead('draft')).toBe(false)
  })

  it('returns false for confirmed/completed (converted, no longer a lead)', () => {
    expect(isActiveLead('confirmed')).toBe(false)
    expect(isActiveLead('completed')).toBe(false)
  })

  it('returns false for stale terminal statuses (use contactCapturedAt instead)', () => {
    expect(isActiveLead('failed')).toBe(false)
    expect(isActiveLead('expired')).toBe(false)
    expect(isActiveLead('abandoned')).toBe(false)
    expect(isActiveLead('cancelled')).toBe(false)
    expect(isActiveLead('no_show')).toBe(false)
    expect(isActiveLead('rescheduled')).toBe(false)
  })
})

describe('hasUploadableClickId', () => {
  // Only the five click-id fields matter here; the cast keeps the fixture honest
  // about that instead of inventing a full BookingState.
  const row = (over: Partial<BookingState>): BookingState =>
    ({ gclid: null, fbclid: null, msclkid: null, ...over }) as BookingState

  it('accepts a plain gclid row', () => {
    expect(hasUploadableClickId(row({ gclid: 'g1' }))).toBe(true)
  })

  it('accepts fbclid and msclkid rows', () => {
    expect(hasUploadableClickId(row({ fbclid: 'f1' }))).toBe(true)
    expect(hasUploadableClickId(row({ msclkid: 'm1' }))).toBe(true)
  })

  // The regression this selector exists to prevent: gbraid/wbraid have no flat
  // column, so a gclid-only check dropped every iOS-path conversion silently.
  it('accepts gbraid carried only in the attribution snapshot', () => {
    expect(hasUploadableClickId(row({ attribution: { gbraid: 'gb1' } }))).toBe(true)
  })

  it('accepts wbraid carried only in the attribution snapshot', () => {
    expect(hasUploadableClickId(row({ attribution: { wbraid: 'wb1' } }))).toBe(true)
  })

  it('falls through an empty-string gclid to gbraid', () => {
    expect(hasUploadableClickId(row({ gclid: '', attribution: { gbraid: 'gb1' } }))).toBe(true)
  })

  it('rejects a row with no click id anywhere', () => {
    expect(hasUploadableClickId(row({}))).toBe(false)
  })

  it('rejects a row whose attribution carries only utm data', () => {
    expect(hasUploadableClickId(row({ attribution: { utmSource: 'google' } }))).toBe(false)
  })
})
