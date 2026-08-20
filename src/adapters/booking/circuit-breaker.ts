// Circuit breaker — wraps any BookingAdapter so a sustained vendor outage
// trips fast-fail instead of letting every request wait for vendor timeouts.
// ADR-013.
//
// State machine: closed → open → half-open → closed.
//   closed:    requests flow; failure counter increments on errors
//   open:      requests immediately reject for `cooldownMs`
//   half-open: ONE probe request flows; success closes the breaker, failure reopens
//
// Stateless across instances by default (memory-state per-process). For
// multi-instance deployments, this is best-effort — a percentage of requests
// in each instance will fail before the breaker trips, but the per-instance
// breaker prevents one instance from hammering a known-down vendor.

import type { BookingAdapter } from './adapter.js'
import type {
  AdapterContext,
  AdapterHealth,
  BookingAttribution,
  BookingConfirmation,
  BookingRequest,
  BookingSession,
} from '../../core/types.js'
import { BookingError } from '../../core/errors.js'

export type CircuitBreakerOptions = {
  /** Failures within `windowMs` before tripping. Default 5. */
  failureThreshold?: number
  /** Window in ms for failure counting. Default 30_000. */
  windowMs?: number
  /** Time in ms the breaker stays open before allowing a probe. Default 30_000. */
  cooldownMs?: number
  /** Methods that count toward the breaker. Default ['createSession', 'confirm']. */
  guardedMethods?: ReadonlyArray<'createSession' | 'attachAttribution' | 'confirm'>
  /** Custom failure predicate. Default: BookingError.code === BOOKING_FAILED | DEPENDENCY_UNAVAILABLE. */
  isFailure?: (err: unknown) => boolean
}

type State = 'closed' | 'open' | 'half-open'

/**
 * Wraps a booking adapter with a circuit breaker. Returns a new adapter that
 * implements the same interface; consumer wires it like any other.
 *
 * @example
 *   const wrapped = withCircuitBreaker(blvdAdapter({ ... }), {
 *     failureThreshold: 5,
 *     cooldownMs: 30_000,
 *   })
 */
export function withCircuitBreaker(
  inner: BookingAdapter,
  opts: CircuitBreakerOptions = {},
): BookingAdapter {
  const failureThreshold = opts.failureThreshold ?? 5
  const windowMs = opts.windowMs ?? 30_000
  const cooldownMs = opts.cooldownMs ?? 30_000
  const guarded = new Set(opts.guardedMethods ?? ['createSession', 'confirm'])
  const isFailure = opts.isFailure ?? defaultIsFailure

  let state: State = 'closed'
  let failures: number[] = [] // timestamps of recent failures
  let openedAt = 0

  function recordFailure(): void {
    const now = Date.now()
    failures = failures.filter((t) => now - t < windowMs)
    failures.push(now)
    if (state === 'closed' && failures.length >= failureThreshold) {
      state = 'open'
      openedAt = now
    } else if (state === 'half-open') {
      state = 'open'
      openedAt = now
    }
  }

  function recordSuccess(): void {
    if (state === 'half-open') {
      state = 'closed'
      failures = []
    }
  }

  function shouldShortCircuit(method: string): boolean {
    if (!guarded.has(method as 'createSession' | 'confirm')) return false
    if (state === 'closed') return false
    const elapsed = Date.now() - openedAt
    if (state === 'open' && elapsed >= cooldownMs) {
      state = 'half-open'
      return false // let a probe through
    }
    return state === 'open'
  }

  function shortCircuitError(method: string): BookingError {
    return new BookingError(
      'DEPENDENCY_UNAVAILABLE',
      `Vendor circuit breaker open (${method}); cooling down`,
      { retryable: true },
    )
  }

  async function guard<T>(method: string, op: () => Promise<T>): Promise<T> {
    if (shouldShortCircuit(method)) throw shortCircuitError(method)
    try {
      const result = await op()
      if (guarded.has(method as 'createSession' | 'confirm')) recordSuccess()
      return result
    } catch (err) {
      if (guarded.has(method as 'createSession' | 'confirm') && isFailure(err)) {
        recordFailure()
      }
      throw err
    }
  }

  return {
    createSession(input, ctx: AdapterContext): Promise<BookingSession> {
      return guard('createSession', () => inner.createSession(input, ctx))
    },
    attachAttribution(
      session: BookingSession,
      attribution: BookingAttribution,
      ctx: AdapterContext,
    ): Promise<void> {
      return guard('attachAttribution', () => inner.attachAttribution(session, attribution, ctx))
    },
    confirm(
      session: BookingSession,
      request: BookingRequest,
      ctx: AdapterContext,
    ): Promise<BookingConfirmation> {
      return guard('confirm', () => inner.confirm(session, request, ctx))
    },
    cancel(session: BookingSession, reason: string, ctx: AdapterContext): Promise<void> {
      // Cancel is compensation — never short-circuit, always attempt.
      return inner.cancel(session, reason, ctx)
    },
    health(ctx: AdapterContext): Promise<AdapterHealth> {
      return inner.health(ctx)
    },
    // Read + post-confirm ops — pass through guard semantics (read short-circuits
    // when breaker is open, write-by-appointment never short-circuits because
    // failure to cancel/reschedule must surface, not be swallowed).
    findAvailability(query, ctx) {
      return guard('findAvailability', () => inner.findAvailability(query, ctx))
    },
    cancelByAppointment(vendorAppointmentId, reason, ctx) {
      return inner.cancelByAppointment(vendorAppointmentId, reason, ctx)
    },
    rescheduleByAppointment(vendorAppointmentId, newDate, newTime, ctx) {
      return inner.rescheduleByAppointment(vendorAppointmentId, newDate, newTime, ctx)
    },
    findStaffVariants(query, ctx) {
      // Read-only; guard like findAvailability so a known-down vendor doesn't
      // get hammered with per-slot variant queries.
      return guard('findStaffVariants', () => inner.findStaffVariants(query, ctx))
    },
  }
}

function defaultIsFailure(err: unknown): boolean {
  if (err instanceof BookingError) {
    return err.code === 'BOOKING_FAILED' || err.code === 'DEPENDENCY_UNAVAILABLE'
  }
  // Network / unknown errors count as failures
  return true
}
