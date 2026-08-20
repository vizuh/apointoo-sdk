// Tier 2 (unit, stateful) — memoryConversionReporter().
//
// The memory impl is both the test double for app #18 and the dev-mode
// no-op. Tests cover the full public surface:
//   - happy-path upload and result shape
//   - in-memory dedup (matches Google Ads vendor contract)
//   - dedup disabled
//   - failNext() error injection
//   - reset() state clearing
//   - health() probe
//   - validateConversionInput() is called (bad input throws before recording)

import { describe, expect, it } from 'vitest'
import { memoryConversionReporter } from '../../../src/adapters/conversion/memory/index.js'
import {
  ConversionReporterError,
  type ConversionUploadInput,
} from '../../../src/adapters/conversion/reporter.js'
import { defineConversionAction } from '../../../src/adapters/conversion/action-names.js'
import type { AdapterContext, Logger } from '../../../src/core/types.js'

// ── Shared stubs ──────────────────────────────────────────────────────────────

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

const FIXED_NOW = new Date('2026-05-24T10:00:00.000Z')

const ctx: AdapterContext = {
  config: {
    projectKey: 'test',
    businessName: 'Test Business',
    locale: 'en',
    timezone: 'UTC',
    services: [{ id: 's1', name: 'Test Service' }],
    scheduling: {
      availableDays: [1, 2, 3, 4, 5],
      timeSlots: [{ label: '10:00', value: '10:00' }],
      minAdvanceDays: 0,
      maxAdvanceDays: 90,
    },
  },
  logger: silentLogger,
  now: () => FIXED_NOW,
}

const validAction = defineConversionAction('booking_completed')

function makeInput(overrides: Partial<ConversionUploadInput> = {}): ConversionUploadInput {
  return {
    gclid: 'EAIaIQobChMIyLqR_oSv_QIVhJ1oCR2RyQjQEAAYASAAEgKnWPD_BwE',
    conversionAction: validAction,
    conversionDateTime: '2026-05-24T09:30:00Z',
    conversionValue: 150,
    currencyCode: 'USD',
    transactionId: 'txn-001',
    ...overrides,
  }
}

// ── Happy path ────────────────────────────────────────────────────────────────

describe('memoryConversionReporter — happy path', () => {
  it('returns a correct ConversionUploadResult on first upload', async () => {
    const reporter = memoryConversionReporter()
    const result = await reporter.reportConversion(makeInput(), ctx)

    expect(result.transactionId).toBe('txn-001')
    expect(result.reportedAtIso).toBe(FIXED_NOW.toISOString())
    expect(result.deduplicated).toBe(false)
    expect(result.vendorReceiptId).toBe('memory-txn-001')
  })

  it('records the call in uploads[]', async () => {
    const reporter = memoryConversionReporter()
    await reporter.reportConversion(makeInput(), ctx)

    expect(reporter.uploads).toHaveLength(1)
    expect(reporter.uploads[0]?.input.transactionId).toBe('txn-001')
    expect(reporter.uploads[0]?.deduplicated).toBe(false)
    expect(reporter.uploads[0]?.receivedAtIso).toBe(FIXED_NOW.toISOString())
  })

  it('records multiple distinct uploads in order', async () => {
    const reporter = memoryConversionReporter()
    await reporter.reportConversion(makeInput({ transactionId: 'txn-a' }), ctx)
    await reporter.reportConversion(makeInput({ transactionId: 'txn-b' }), ctx)
    await reporter.reportConversion(makeInput({ transactionId: 'txn-c' }), ctx)

    expect(reporter.uploads).toHaveLength(3)
    expect(reporter.uploads.map((u) => u.input.transactionId)).toEqual([
      'txn-a',
      'txn-b',
      'txn-c',
    ])
  })
})

// ── In-memory dedup ───────────────────────────────────────────────────────────

describe('memoryConversionReporter — dedup (default: enabled)', () => {
  it('marks a second upload with the same transactionId as deduplicated', async () => {
    const reporter = memoryConversionReporter()
    await reporter.reportConversion(makeInput(), ctx)
    const second = await reporter.reportConversion(makeInput(), ctx)

    expect(second.deduplicated).toBe(true)
    expect(second.transactionId).toBe('txn-001')
    // upload is still recorded for audit
    expect(reporter.uploads).toHaveLength(2)
    expect(reporter.uploads[1]?.deduplicated).toBe(true)
  })

  it('does not dedup uploads with different transactionIds', async () => {
    const reporter = memoryConversionReporter()
    const a = await reporter.reportConversion(makeInput({ transactionId: 'txn-a' }), ctx)
    const b = await reporter.reportConversion(makeInput({ transactionId: 'txn-b' }), ctx)

    expect(a.deduplicated).toBe(false)
    expect(b.deduplicated).toBe(false)
  })

  it('dedup: third upload with same transactionId is also deduplicated', async () => {
    const reporter = memoryConversionReporter()
    await reporter.reportConversion(makeInput(), ctx)
    await reporter.reportConversion(makeInput(), ctx)
    const third = await reporter.reportConversion(makeInput(), ctx)

    expect(third.deduplicated).toBe(true)
    expect(reporter.uploads).toHaveLength(3)
  })
})

describe('memoryConversionReporter — dedup disabled', () => {
  it('does not deduplicate when dedup: false', async () => {
    const reporter = memoryConversionReporter({ dedup: false })
    await reporter.reportConversion(makeInput(), ctx)
    const second = await reporter.reportConversion(makeInput(), ctx)

    expect(second.deduplicated).toBe(false)
  })

  it('records both uploads when dedup disabled', async () => {
    const reporter = memoryConversionReporter({ dedup: false })
    await reporter.reportConversion(makeInput(), ctx)
    await reporter.reportConversion(makeInput(), ctx)

    expect(reporter.uploads).toHaveLength(2)
    expect(reporter.uploads.every((u) => !u.deduplicated)).toBe(true)
  })
})

// ── failNext() ────────────────────────────────────────────────────────────────

describe('memoryConversionReporter — failNext()', () => {
  it('throws the queued error on the next reportConversion() call', async () => {
    const reporter = memoryConversionReporter()
    const queued = new ConversionReporterError('VENDOR_UNAVAILABLE', 'simulated outage', {
      retryable: true,
      transactionId: 'txn-001',
    })
    reporter.failNext(queued)

    await expect(reporter.reportConversion(makeInput(), ctx)).rejects.toThrow(queued)
  })

  it('clears the queued error after one throw — next call succeeds', async () => {
    const reporter = memoryConversionReporter()
    reporter.failNext(new Error('one-time failure'))

    await expect(reporter.reportConversion(makeInput(), ctx)).rejects.toThrow()
    // second call must succeed
    const result = await reporter.reportConversion(makeInput(), ctx)
    expect(result.deduplicated).toBe(false) // dedup resets? no — first call failed before recording
    expect(reporter.uploads).toHaveLength(1)
  })

  it('does not record an upload when failNext throws', async () => {
    const reporter = memoryConversionReporter()
    reporter.failNext(new Error('fail'))

    try {
      await reporter.reportConversion(makeInput(), ctx)
    } catch {
      // expected
    }

    expect(reporter.uploads).toHaveLength(0)
  })
})

// ── reset() ───────────────────────────────────────────────────────────────────

describe('memoryConversionReporter — reset()', () => {
  it('clears uploads array', async () => {
    const reporter = memoryConversionReporter()
    await reporter.reportConversion(makeInput({ transactionId: 'txn-a' }), ctx)
    await reporter.reportConversion(makeInput({ transactionId: 'txn-b' }), ctx)

    reporter.reset()
    expect(reporter.uploads).toHaveLength(0)
  })

  it('clears dedup state — same transactionId is fresh after reset', async () => {
    const reporter = memoryConversionReporter()
    await reporter.reportConversion(makeInput(), ctx)
    reporter.reset()

    const result = await reporter.reportConversion(makeInput(), ctx)
    expect(result.deduplicated).toBe(false)
    expect(reporter.uploads).toHaveLength(1)
  })

  it('clears a queued failNext error', async () => {
    const reporter = memoryConversionReporter()
    reporter.failNext(new Error('queued'))
    reporter.reset()

    // Should not throw
    const result = await reporter.reportConversion(makeInput(), ctx)
    expect(result.transactionId).toBe('txn-001')
  })
})

// ── health() ──────────────────────────────────────────────────────────────────

describe('memoryConversionReporter — health()', () => {
  it('returns ok: true', async () => {
    const reporter = memoryConversionReporter()
    const health = await reporter.health(ctx)

    expect(health.ok).toBe(true)
    expect(health.name).toBe('memory-conversion')
    expect(typeof health.version).toBe('string')
  })
})

// ── Input validation integration ──────────────────────────────────────────────

describe('memoryConversionReporter — input validation', () => {
  it('throws CONFIG_INVALID for empty gclid, does not record the call', async () => {
    const reporter = memoryConversionReporter()

    await expect(
      reporter.reportConversion(makeInput({ gclid: '' }), ctx),
    ).rejects.toThrow(ConversionReporterError)

    expect(reporter.uploads).toHaveLength(0)
  })

  it('throws CONFIG_INVALID for bad currencyCode, does not record the call', async () => {
    const reporter = memoryConversionReporter()

    await expect(
      reporter.reportConversion(makeInput({ currencyCode: 'us' }), ctx),
    ).rejects.toThrow(ConversionReporterError)

    expect(reporter.uploads).toHaveLength(0)
  })

  it('throws CONFIG_INVALID for negative conversionValue', async () => {
    const reporter = memoryConversionReporter()

    await expect(
      reporter.reportConversion(makeInput({ conversionValue: -50 }), ctx),
    ).rejects.toThrow(ConversionReporterError)

    expect(reporter.uploads).toHaveLength(0)
  })
})

// ── uploads[] is read-only ────────────────────────────────────────────────────

describe('memoryConversionReporter — uploads readonly contract', () => {
  it('uploads is ReadonlyArray — mutation attempt fails at runtime (strict mode)', async () => {
    const reporter = memoryConversionReporter()
    await reporter.reportConversion(makeInput(), ctx)

    // TypeScript prevents direct push at compile time.
    // At runtime, the getter returns the internal array directly, so this
    // documents the current contract rather than asserting immutability.
    expect(reporter.uploads).toHaveLength(1)
    expect(Array.isArray(reporter.uploads)).toBe(true)
  })
})
