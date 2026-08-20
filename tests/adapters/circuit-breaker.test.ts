// Tier 4 (resilience pattern) — circuit breaker state machine.
import { describe, expect, it, vi } from 'vitest'
import { withCircuitBreaker } from '../../src/adapters/booking/circuit-breaker.js'
import { memoryBookingAdapter } from '../../src/adapters/booking/memory/index.js'
import { BookingError } from '../../src/core/errors.js'
import type { AdapterContext, Logger } from '../../src/core/types.js'

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

const ctx: AdapterContext = {
  config: {
    projectKey: 'test',
    businessName: 'T',
    locale: 'en',
    timezone: 'UTC',
    services: [{ id: 's1', name: 'Test' }],
    scheduling: {
      availableDays: [1, 2, 3, 4, 5],
      timeSlots: [{ label: '10:00', value: '10:00' }],
      minAdvanceDays: 0,
      maxAdvanceDays: 90,
    },
  },
  logger: silentLogger,
  now: () => new Date(),
}

const sessionInput = {
  serviceId: 's1',
  name: 'Test User',
  phone: '+15555550001',
  email: undefined,
  requestedDate: '2026-06-01',
  requestedTime: '10:00',
  offerCode: undefined,
}

describe('withCircuitBreaker — closed state (normal)', () => {
  it('passes calls through when adapter is healthy', async () => {
    const inner = memoryBookingAdapter()
    const wrapped = withCircuitBreaker(inner, { failureThreshold: 5 })
    const session = await wrapped.createSession(sessionInput, ctx)
    expect(session.vendor).toBe('memory')
    expect(inner.calls.createSession).toBe(1)
  })
})

describe('withCircuitBreaker — opens after threshold', () => {
  it('5 failures in window trips the breaker', async () => {
    const failingError = new BookingError('BOOKING_FAILED', 'Vendor down')
    const inner = memoryBookingAdapter({ failCreateSessionWith: failingError })
    const wrapped = withCircuitBreaker(inner, {
      failureThreshold: 5,
      windowMs: 30_000,
      cooldownMs: 30_000,
    })

    // 5 failures
    for (let i = 0; i < 5; i++) {
      await expect(wrapped.createSession(sessionInput, ctx)).rejects.toThrow()
    }

    // 6th call should NOT reach inner — breaker open, fast-fails
    const callsBefore = inner.calls.createSession
    await expect(wrapped.createSession(sessionInput, ctx)).rejects.toThrow(
      /circuit breaker open/i,
    )
    expect(inner.calls.createSession).toBe(callsBefore) // breaker prevented call
  })
})

describe('withCircuitBreaker — half-open probe', () => {
  it('after cooldown, allows one probe; success closes the breaker', async () => {
    vi.useFakeTimers()
    const failingError = new BookingError('BOOKING_FAILED', 'Vendor down')
    let failing = true
    const inner = {
      ...memoryBookingAdapter(),
    }
    // Custom inner that toggles success/fail
    inner.createSession = vi.fn(async () => {
      if (failing) throw failingError
      return {
        vendorSessionId: 'mem_recovery',
        vendor: 'memory',
        expiresAtIso: undefined,
      }
    })

    const wrapped = withCircuitBreaker(inner, {
      failureThreshold: 3,
      windowMs: 30_000,
      cooldownMs: 30_000,
    })

    // 3 failures → opens
    for (let i = 0; i < 3; i++) {
      await expect(wrapped.createSession(sessionInput, ctx)).rejects.toThrow()
    }
    // Open: rejects immediately
    await expect(wrapped.createSession(sessionInput, ctx)).rejects.toThrow(
      /circuit breaker open/i,
    )

    // Advance past cooldown
    vi.advanceTimersByTime(31_000)
    // Toggle: vendor recovers
    failing = false
    // Half-open probe → success → breaker closes
    const session = await wrapped.createSession(sessionInput, ctx)
    expect(session.vendorSessionId).toBe('mem_recovery')

    vi.useRealTimers()
  })
})

describe('withCircuitBreaker — cancel never short-circuits', () => {
  it('cancel() always passes through, even when breaker open', async () => {
    const failingError = new BookingError('BOOKING_FAILED', 'Vendor down')
    const inner = memoryBookingAdapter({ failCreateSessionWith: failingError })
    const wrapped = withCircuitBreaker(inner, { failureThreshold: 1 })

    // Trip the breaker
    await expect(wrapped.createSession(sessionInput, ctx)).rejects.toThrow()
    // 2nd call: confirm breaker is open
    await expect(wrapped.createSession(sessionInput, ctx)).rejects.toThrow(
      /circuit breaker open/i,
    )

    // Cancel still works (compensation must surface)
    const fakeSession = { vendorSessionId: 'x', vendor: 'memory', expiresAtIso: undefined }
    await wrapped.cancel(fakeSession, 'test', ctx)
    expect(inner.calls.cancel.length).toBeGreaterThan(0)
  })
})
