// Tier 1 (unit, pure function) — defineConversionAction() allowlist validator.
//
// This is the HIPAA load-bearing piece of kit #14: conversion action names
// are logged to Google Ads attached to the gclid. A name like
// `dental_implant_consultation` would expose a health condition even though
// the payload itself carries no PHI. Full coverage required.

import { describe, expect, it } from 'vitest'
import {
  defineConversionAction,
  DEFAULT_CONVERSION_ACTION_ALLOWLIST,
} from '../../../src/adapters/conversion/action-names.js'
import { ConversionReporterError } from '../../../src/adapters/conversion/reporter.js'

// ── Happy-path: default allowlist ────────────────────────────────────────────

describe('defineConversionAction — default allowlist', () => {
  it.each(DEFAULT_CONVERSION_ACTION_ALLOWLIST)(
    'accepts "%s" from the default allowlist',
    (name) => {
      const result = defineConversionAction(name)
      expect(result).toBe(name)
    },
  )

  it('returns a value assignable back to string (branded, but string at runtime)', () => {
    const action = defineConversionAction('booking_completed')
    expect(typeof action).toBe('string')
    expect(action).toBe('booking_completed')
  })
})

// ── Pattern validation ────────────────────────────────────────────────────────

describe('defineConversionAction — pattern rules', () => {
  it('rejects an empty string', () => {
    expect(() => defineConversionAction('')).toThrow(ConversionReporterError)
    expect(() => defineConversionAction('')).toThrow(/non-empty string/)
  })

  it('rejects a name with uppercase letters', () => {
    // Uppercase is a HIPAA pattern risk — easier to slip in a condition label
    expect(() => defineConversionAction('Booking_Completed')).toThrow(
      ConversionReporterError,
    )
    expect(() => defineConversionAction('Booking_Completed')).toThrow(
      /required pattern/,
    )
  })

  it('rejects a name with spaces', () => {
    expect(() => defineConversionAction('booking completed')).toThrow(
      ConversionReporterError,
    )
  })

  it('rejects a name with hyphens (only underscores allowed)', () => {
    expect(() => defineConversionAction('booking-completed')).toThrow(
      ConversionReporterError,
    )
  })

  it('rejects a name starting with a digit', () => {
    expect(() => defineConversionAction('1booking')).toThrow(
      ConversionReporterError,
    )
  })

  it('rejects a name that is too short (< 3 chars)', () => {
    // Even if it were in an allowlist, pattern blocks it
    expect(() =>
      defineConversionAction('ab', { allowlist: ['ab'] }),
    ).toThrow(ConversionReporterError)
    expect(() =>
      defineConversionAction('ab', { allowlist: ['ab'] }),
    ).toThrow(/required pattern/)
  })

  it('rejects a name that is too long (> 50 chars)', () => {
    const long = 'a' + 'b'.repeat(50) // 51 chars
    expect(() =>
      defineConversionAction(long, { allowlist: [long] }),
    ).toThrow(ConversionReporterError)
    expect(() =>
      defineConversionAction(long, { allowlist: [long] }),
    ).toThrow(/required pattern/)
  })

  it('accepts a name at exactly 3 chars', () => {
    const name = 'abc'
    const result = defineConversionAction(name, { allowlist: [name] })
    expect(result).toBe(name)
  })

  it('accepts a name at exactly 50 chars', () => {
    const name = 'a' + 'b'.repeat(49) // 50 chars
    const result = defineConversionAction(name, { allowlist: [name] })
    expect(result).toBe(name)
  })

  it('rejects special chars that could encode service type (e.g. dots, slashes)', () => {
    expect(() => defineConversionAction('booking.completed')).toThrow(
      ConversionReporterError,
    )
    expect(() => defineConversionAction('booking/completed')).toThrow(
      ConversionReporterError,
    )
  })
})

// ── Allowlist membership ──────────────────────────────────────────────────────

describe('defineConversionAction — allowlist membership', () => {
  it('rejects a valid-pattern name not in the default allowlist', () => {
    // This is the primary HIPAA guard: even a well-formed name is blocked if
    // not in the allowlist. A developer must explicitly opt in via `allowlist`.
    expect(() => defineConversionAction('dental_consult')).toThrow(
      ConversionReporterError,
    )
    expect(() => defineConversionAction('dental_consult')).toThrow(
      /not in the allowlist/,
    )
  })

  it('error message lists the default allowlist for discoverability', () => {
    let msg = ''
    try {
      defineConversionAction('unknown_action')
    } catch (e) {
      if (e instanceof ConversionReporterError) msg = e.message
    }
    expect(msg).toContain('booking_completed')
    expect(msg).toContain('appointment_confirmed')
  })

  it('error message mentions the HIPAA rationale', () => {
    let msg = ''
    try {
      defineConversionAction('plastic_surgery_completed')
    } catch (e) {
      if (e instanceof ConversionReporterError) msg = e.message
    }
    expect(msg).toMatch(/HIPAA|gclid/i)
  })

  it('accepts a name when caller supplies an explicit allowlist containing it', () => {
    const customList = ['lead_qualified', 'booking_completed', 'my_custom_action']
    const result = defineConversionAction('my_custom_action', {
      allowlist: customList,
    })
    expect(result).toBe('my_custom_action')
  })

  it('rejects a name not in the caller-supplied allowlist', () => {
    expect(() =>
      defineConversionAction('booking_completed', {
        allowlist: ['only_this_one'],
      }),
    ).toThrow(ConversionReporterError)
    expect(() =>
      defineConversionAction('booking_completed', {
        allowlist: ['only_this_one'],
      }),
    ).toThrow(/not in the allowlist/)
  })

  it('error code is CONFIG_INVALID for all rejection paths', () => {
    const cases = [
      () => defineConversionAction(''),
      () => defineConversionAction('Bad_Name'),
      () => defineConversionAction('not_in_list'),
    ]
    for (const fn of cases) {
      let code: string | undefined
      try {
        fn()
      } catch (e) {
        if (e instanceof ConversionReporterError) code = e.code
      }
      expect(code).toBe('CONFIG_INVALID')
    }
  })

  it('is not retryable — config errors should crash startup, not retry', () => {
    let retryable: boolean | undefined
    try {
      defineConversionAction('dental_consult')
    } catch (e) {
      if (e instanceof ConversionReporterError) retryable = e.retryable
    }
    expect(retryable).toBe(false)
  })
})
