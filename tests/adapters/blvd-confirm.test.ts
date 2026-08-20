// Ponytail-audit finding: blvdAdapter().confirm() — the core booking-
// confirmation money path (cartBookableTimes → reserveBookableTime →
// checkoutCart), including the TIME_UNAVAILABLE and BOOKING_FAILED error
// branches — had zero test coverage anywhere in the repo.

import { describe, expect, it, vi } from 'vitest'
import { blvdAdapter } from '../../src/adapters/booking/blvd/index.js'
import { isBlvdError } from '../../src/adapters/booking/blvd/errors.js'
import type { BlvdError } from '../../src/adapters/booking/blvd/errors.js'
import type { AdapterContext, BookingRequest, BookingSession, Logger } from '../../src/core/types.js'
import type { BookingKitConfig } from '../../src/core/schemas.js'

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

const probeConfig: BookingKitConfig = {
  projectKey: 'test',
  businessName: 'T',
  locale: 'en-US',
  timezone: 'America/New_York',
  services: [{ id: 'haircut', name: 'Haircut', isActive: true }],
  scheduling: {
    availableDays: [1, 2, 3, 4, 5],
    timeSlots: [{ label: '10:00', value: '10:00' }],
    minAdvanceDays: 0,
    maxAdvanceDays: 90,
  },
}

function makeRequest(overrides: Partial<BookingRequest> = {}): BookingRequest {
  return {
    submissionId: 'sub-abcd1234',
    projectKey: 'test',
    service: { id: 'haircut', name: 'Haircut' } as never,
    serviceId: 'haircut',
    requestedDate: '2026-06-01',
    requestedTime: '10:00',
    name: 'Marcia Silva',
    phone: '+15555550001',
    email: undefined,
    message: undefined,
    isNewPatient: undefined,
    offerCode: undefined,
    attribution: {} as never,
    metadata: { userAgent: undefined, locale: 'en-US', timezone: 'America/New_York', ip: undefined },
    createdAtIso: '2026-05-24T10:00:00.000Z',
    fingerprint: 'fp-test',
    configSnapshot: {
      timezone: 'America/New_York',
      locale: 'en-US',
      scheduling: probeConfig.scheduling,
    },
    ...overrides,
  }
}

function adapterWith(responses: Response[]) {
  let i = 0
  const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    const r = responses[i++]
    if (!r) throw new Error(`no response queued for call #${i}`)
    return r
  })
  const adapter = blvdAdapter({
    apiKey: 'k',
    businessId: 'b',
    defaultLocationId: 'loc-A',
    serviceMap: { haircut: 'blvd-svc-1' },
    fetchImpl: fetchImpl as typeof fetch,
  })
  const ctx: AdapterContext = {
    config: probeConfig,
    logger: silentLogger,
    now: () => new Date(),
  }
  const session: BookingSession = { vendorSessionId: 'cart-X', vendor: 'blvd', expiresAtIso: undefined }
  return { adapter, ctx, fetchImpl, session }
}

describe('blvdAdapter.confirm — booking-confirmation money path', () => {
  it('reserves the matching slot, checks out, and returns a BookingConfirmation', async () => {
    const { adapter, ctx, session, fetchImpl } = adapterWith([
      // cartBookableTimes
      jsonOk({
        data: {
          cartBookableTimes: [{ id: 'slot-1', score: 1, startTime: '2026-06-01T10:00:00Z' }],
        },
      }),
      // reserveCartBookableItems
      jsonOk({
        data: {
          reserveCartBookableItems: {
            cart: {
              id: 'cart-X',
              startTime: '2026-06-01T10:00:00Z',
              expiresAt: '2026-06-01T10:10:00Z',
              errors: [],
            },
          },
        },
      }),
      // checkoutCart
      jsonOk({
        data: {
          checkoutCart: {
            cart: { id: 'cart-X', completedAt: '2026-06-01T10:00:05Z' },
            appointments: [{ appointmentId: 'appt-1', clientId: 'client-1', forCartOwner: true }],
          },
        },
      }),
    ])

    const confirmation = await adapter.confirm(session, makeRequest(), ctx)

    expect(confirmation).toEqual({
      vendorAppointmentId: 'appt-1',
      vendorClientId: 'client-1',
      confirmationCode: 'appt-1',
      startTimeIso: '2026-06-01T10:00:00Z',
      metadata: { cartId: 'cart-X', completedAt: '2026-06-01T10:00:05Z' },
    })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('throws TIME_UNAVAILABLE when no slot matches the requested time', async () => {
    const { adapter, ctx, session } = adapterWith([
      jsonOk({
        data: {
          cartBookableTimes: [{ id: 'slot-1', score: 1, startTime: '2026-06-01T14:00:00Z' }],
        },
      }),
    ])

    await expect(
      adapter.confirm(session, makeRequest({ requestedTime: '10:00' }), ctx),
    ).rejects.toSatisfy((e) => isBlvdError(e) && (e as BlvdError).code === 'TIME_UNAVAILABLE')
  })

  it('throws BOOKING_FAILED when checkoutCart returns no appointment', async () => {
    const { adapter, ctx, session } = adapterWith([
      jsonOk({
        data: {
          cartBookableTimes: [{ id: 'slot-1', score: 1, startTime: '2026-06-01T10:00:00Z' }],
        },
      }),
      jsonOk({
        data: {
          reserveCartBookableItems: {
            cart: {
              id: 'cart-X',
              startTime: '2026-06-01T10:00:00Z',
              expiresAt: '2026-06-01T10:10:00Z',
              errors: [],
            },
          },
        },
      }),
      jsonOk({
        data: {
          checkoutCart: {
            cart: { id: 'cart-X', completedAt: '2026-06-01T10:00:05Z' },
            appointments: [],
          },
        },
      }),
    ])

    await expect(adapter.confirm(session, makeRequest(), ctx)).rejects.toSatisfy(
      (e) => isBlvdError(e) && (e as BlvdError).code === 'BOOKING_FAILED',
    )
  })

  it('throws CART_EXPIRED when reserveCartBookableItems returns a CART_EXPIRED cart error', async () => {
    const { adapter, ctx, session } = adapterWith([
      jsonOk({
        data: {
          cartBookableTimes: [{ id: 'slot-1', score: 1, startTime: '2026-06-01T10:00:00Z' }],
        },
      }),
      jsonOk({
        data: {
          reserveCartBookableItems: {
            cart: {
              id: 'cart-X',
              startTime: '',
              expiresAt: '',
              errors: [{ code: 'CART_EXPIRED', description: 'expired', message: 'Cart expired' }],
            },
          },
        },
      }),
    ])

    await expect(adapter.confirm(session, makeRequest(), ctx)).rejects.toSatisfy(
      (e) => isBlvdError(e) && (e as BlvdError).code === 'CART_EXPIRED',
    )
  })
})
