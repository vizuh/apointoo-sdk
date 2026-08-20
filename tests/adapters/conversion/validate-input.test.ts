// Tier 1 (unit, pure function) — validateConversionInput() runtime guard.
//
// This validator runs inside every ConversionReporter impl before touching
// the vendor. Bad data here crashes loud — better than a cryptic vendor error
// or, worse, a partial upload with phantom PHI.

import { describe, expect, it } from 'vitest'
import {
  validateConversionInput,
  ConversionReporterError,
  type ConversionUploadInput,
} from '../../../src/adapters/conversion/reporter.js'
import { defineConversionAction } from '../../../src/adapters/conversion/action-names.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

const validAction = defineConversionAction('booking_completed')

function validInput(): ConversionUploadInput {
  return {
    gclid: 'EAIaIQobChMIyLqR_oSv_QIVhJ1oCR2RyQjQEAAYASAAEgKnWPD_BwE',
    conversionAction: validAction,
    conversionDateTime: '2026-05-24T10:30:00Z',
    conversionValue: 150,
    currencyCode: 'USD',
    transactionId: 'txn-abc-001',
  }
}

function expectValidationError(
  input: ConversionUploadInput,
  pattern?: string | RegExp,
): void {
  expect(() => validateConversionInput(input)).toThrow(ConversionReporterError)
  if (pattern !== undefined) {
    expect(() => validateConversionInput(input)).toThrow(pattern)
  }
}

// ── Happy path ────────────────────────────────────────────────────────────────

describe('validateConversionInput — valid input', () => {
  it('passes on a fully populated valid input', () => {
    expect(() => validateConversionInput(validInput())).not.toThrow()
  })

  it('accepts conversionValue of 0 (free booking is valid)', () => {
    expect(() =>
      validateConversionInput({ ...validInput(), conversionValue: 0 }),
    ).not.toThrow()
  })

  it('accepts a fractional conversionValue', () => {
    expect(() =>
      validateConversionInput({ ...validInput(), conversionValue: 99.99 }),
    ).not.toThrow()
  })

  it('accepts ISO 8601 with offset (not just UTC Z)', () => {
    expect(() =>
      validateConversionInput({
        ...validInput(),
        conversionDateTime: '2026-05-24T08:30:00-05:00',
      }),
    ).not.toThrow()
  })

  it('accepts ISO 8601 with milliseconds', () => {
    expect(() =>
      validateConversionInput({
        ...validInput(),
        conversionDateTime: '2026-05-24T10:30:00.000Z',
      }),
    ).not.toThrow()
  })

  it('accepts EUR and BRL as valid currency codes', () => {
    for (const code of ['EUR', 'BRL', 'GBP', 'JPY']) {
      expect(() =>
        validateConversionInput({ ...validInput(), currencyCode: code }),
      ).not.toThrow()
    }
  })
})

// ── gclid ────────────────────────────────────────────────────────────────────

describe('validateConversionInput — gclid', () => {
  it('rejects empty gclid', () => {
    expectValidationError({ ...validInput(), gclid: '' }, /gclid/)
  })
})

// ── conversionDateTime ────────────────────────────────────────────────────────

describe('validateConversionInput — conversionDateTime', () => {
  it('rejects a plain date string (no time component)', () => {
    expectValidationError(
      { ...validInput(), conversionDateTime: '2026-05-24' },
      /conversionDateTime/,
    )
  })

  it('rejects an informal date-time string', () => {
    expectValidationError(
      { ...validInput(), conversionDateTime: 'May 24 2026 10:30am' },
      /conversionDateTime/,
    )
  })

  it('rejects a timestamp without timezone', () => {
    // Google Ads requires UTC or explicit offset
    expectValidationError(
      { ...validInput(), conversionDateTime: '2026-05-24T10:30:00' },
      /conversionDateTime/,
    )
  })

  it('rejects an empty string', () => {
    expectValidationError(
      { ...validInput(), conversionDateTime: '' },
      /conversionDateTime/,
    )
  })

  it('rejects an invalid calendar date that parses to NaN', () => {
    expectValidationError(
      { ...validInput(), conversionDateTime: '9999-99-99T99:99:99Z' },
      /conversionDateTime/,
    )
  })
})

// ── conversionValue ───────────────────────────────────────────────────────────

describe('validateConversionInput — conversionValue', () => {
  it('rejects negative value', () => {
    expectValidationError(
      { ...validInput(), conversionValue: -1 },
      /conversionValue/,
    )
  })

  it('rejects NaN', () => {
    expectValidationError(
      { ...validInput(), conversionValue: NaN },
      /conversionValue/,
    )
  })

  it('rejects Infinity', () => {
    expectValidationError(
      { ...validInput(), conversionValue: Infinity },
      /conversionValue/,
    )
  })

  it('rejects -Infinity', () => {
    expectValidationError(
      { ...validInput(), conversionValue: -Infinity },
      /conversionValue/,
    )
  })
})

// ── currencyCode ──────────────────────────────────────────────────────────────

describe('validateConversionInput — currencyCode', () => {
  it('rejects lowercase currency code', () => {
    expectValidationError(
      { ...validInput(), currencyCode: 'usd' },
      /currencyCode/,
    )
  })

  it('rejects a 2-letter code', () => {
    expectValidationError(
      { ...validInput(), currencyCode: 'US' },
      /currencyCode/,
    )
  })

  it('rejects a 4-letter code', () => {
    expectValidationError(
      { ...validInput(), currencyCode: 'USDD' },
      /currencyCode/,
    )
  })

  it('rejects an empty string', () => {
    expectValidationError(
      { ...validInput(), currencyCode: '' },
      /currencyCode/,
    )
  })

  it('rejects a code with digits', () => {
    expectValidationError(
      { ...validInput(), currencyCode: 'US1' },
      /currencyCode/,
    )
  })
})

// ── transactionId ─────────────────────────────────────────────────────────────

describe('validateConversionInput — transactionId', () => {
  it('rejects an empty transactionId', () => {
    expectValidationError(
      { ...validInput(), transactionId: '' },
      /transactionId/,
    )
  })
})

// ── Error properties ──────────────────────────────────────────────────────────

describe('validateConversionInput — error properties', () => {
  it('throws ConversionReporterError with code CONFIG_INVALID', () => {
    let err: ConversionReporterError | undefined
    try {
      validateConversionInput({ ...validInput(), gclid: '' })
    } catch (e) {
      if (e instanceof ConversionReporterError) err = e
    }
    expect(err).toBeDefined()
    expect(err?.code).toBe('CONFIG_INVALID')
    expect(err?.retryable).toBe(false)
  })

  it('includes transactionId in the error when available', () => {
    let err: ConversionReporterError | undefined
    try {
      validateConversionInput({ ...validInput(), gclid: '' })
    } catch (e) {
      if (e instanceof ConversionReporterError) err = e
    }
    expect(err?.transactionId).toBe('txn-abc-001')
  })
})
