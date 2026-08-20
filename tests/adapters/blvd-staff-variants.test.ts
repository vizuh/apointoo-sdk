// Tier 4 — BLVD findStaffVariants (path 4 of plan-2026-05-14-blvd-expansion.md
// and ADR-016). Covers the new `bookableStaffVariants` op + the adapter's
// integration flow (cart → addItem → cartBookableTimes → variants → cancel)
// + memory-adapter parity (returns []).
import { describe, expect, it, vi } from 'vitest'
import { blvdAdapter } from '../../src/adapters/booking/blvd/index.js'
import { bookableStaffVariants } from '../../src/adapters/booking/blvd/operations.js'
import { createBlvdClient } from '../../src/adapters/booking/blvd/client.js'
import type { BlvdError} from '../../src/adapters/booking/blvd/errors.js';
import { isBlvdError } from '../../src/adapters/booking/blvd/errors.js'
import { memoryBookingAdapter } from '../../src/adapters/booking/memory/index.js'
import type { AdapterContext, Logger } from '../../src/core/types.js'
import type { BookingKitConfig } from '../../src/core/schemas.js'

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function bodyOf(call: unknown): { query: string; variables?: Record<string, unknown> } {
  const init = (call as readonly [unknown, RequestInit])[1]
  return JSON.parse(init.body as string)
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

describe('bookableStaffVariants op', () => {
  it('sends cart id + item id + bookable time id and returns mapped variants', async () => {
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        jsonOk({
          data: {
            bookableStaffVariants: [
              { id: 'var-1', staff: { id: 'st-1', displayName: 'Marcia Silva' } },
              { id: 'var-2', staff: { id: 'st-2', displayName: 'Pedro Lima' } },
            ],
          },
        }),
    )
    const client = createBlvdClient({
      apiKey: 'k',
      businessId: 'b',
      fetchImpl: fetchImpl as typeof fetch,
    })

    const result = await bookableStaffVariants(
      client,
      'cart-X',
      'item-svc-1',
      'slot-b',
    )

    expect(result).toEqual([
      { id: 'var-1', staff: { id: 'st-1', displayName: 'Marcia Silva' } },
      { id: 'var-2', staff: { id: 'st-2', displayName: 'Pedro Lima' } },
    ])
    const body = bodyOf(fetchImpl.mock.calls[0]!)
    expect(body.variables).toEqual({
      id: 'cart-X',
      itemId: 'item-svc-1',
      bookableTimeId: 'slot-b',
    })
    expect(body.query).toMatch(/bookableStaffVariants/)
  })

  it('propagates BlvdError when BLVD returns a GraphQL error', async () => {
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        jsonOk({ data: null, errors: [{ message: 'Item not in cart' }] }),
    )
    const client = createBlvdClient({
      apiKey: 'k',
      businessId: 'b',
      fetchImpl: fetchImpl as typeof fetch,
    })

    await expect(
      bookableStaffVariants(client, 'cart-X', 'item-x', 'slot-x'),
    ).rejects.toSatisfy((e) => isBlvdError(e) && (e as BlvdError).code === 'GRAPHQL_ERROR')
  })
})

describe('blvdAdapter.findStaffVariants — full integration', () => {
  it('walks cart → addItem → times → variants → cancel and maps to {id, displayName}', async () => {
    // Expected fetch sequence:
    //   1. createCart
    //   2. addCartSelectedBookableItem
    //   3. cartBookableTimes(date)
    //   4. bookableStaffVariants(itemId, slot)
    //   5. cancelCart (best-effort cleanup)
    const responses: Response[] = [
      jsonOk({
        data: { createCart: { cart: { id: 'cart-X', expiresAt: 'soon', errors: [] } } },
      }),
      jsonOk({
        data: {
          addCartSelectedBookableItem: { cart: { id: 'cart-X', errors: [] } },
        },
      }),
      jsonOk({
        data: {
          cartBookableTimes: [
            { id: 'slot-a', score: 1, startTime: '2026-06-01T09:00:00-04:00' },
            { id: 'slot-b', score: 1, startTime: '2026-06-01T10:00:00-04:00' },
          ],
        },
      }),
      jsonOk({
        data: {
          bookableStaffVariants: [
            { id: 'var-1', staff: { id: 'st-1', displayName: 'Marcia Silva' } },
            { id: 'var-2', staff: { id: 'st-2', displayName: 'Pedro Lima' } },
          ],
        },
      }),
      jsonOk({ data: { cancelCart: { cart: { id: 'cart-X' } } } }),
    ]
    let i = 0
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) => {
        const r = responses[i++]
        if (!r) throw new Error(`no response queued for call #${i}`)
        return r
      },
    )
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

    const result = await adapter.findStaffVariants(
      { serviceId: 'haircut', date: '2026-06-01', time: '10:00' },
      ctx,
    )

    expect(result).toEqual([
      { id: 'var-1', displayName: 'Marcia Silva' },
      { id: 'var-2', displayName: 'Pedro Lima' },
    ])
    expect(fetchImpl).toHaveBeenCalledTimes(5)
    // Step 4 must use the slot id matching 10:00, not 09:00.
    expect(bodyOf(fetchImpl.mock.calls[3]!).variables).toMatchObject({
      itemId: 'blvd-svc-1',
      bookableTimeId: 'slot-b',
    })
  })

  it('returns [] (no throw) when no slot matches the requested HH:MM', async () => {
    // Same 5-call layout but cartBookableTimes returns slots that don't
    // match 10:00. Adapter cancels the cart and returns [].
    const responses: Response[] = [
      jsonOk({
        data: { createCart: { cart: { id: 'cart-X', expiresAt: 'soon', errors: [] } } },
      }),
      jsonOk({
        data: {
          addCartSelectedBookableItem: { cart: { id: 'cart-X', errors: [] } },
        },
      }),
      jsonOk({
        data: {
          cartBookableTimes: [
            { id: 'slot-a', score: 1, startTime: '2026-06-01T09:00:00-04:00' },
            { id: 'slot-c', score: 1, startTime: '2026-06-01T11:00:00-04:00' },
          ],
        },
      }),
      jsonOk({ data: { cancelCart: { cart: { id: 'cart-X' } } } }),
    ]
    let i = 0
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) => {
        const r = responses[i++]
        if (!r) throw new Error(`no response queued for call #${i}`)
        return r
      },
    )
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

    const result = await adapter.findStaffVariants(
      { serviceId: 'haircut', date: '2026-06-01', time: '10:00' },
      ctx,
    )

    expect(result).toEqual([])
    // No bookableStaffVariants fetch — we never reached step 4.
    expect(fetchImpl).toHaveBeenCalledTimes(4)
    const allQueries = fetchImpl.mock.calls.map((c) => bodyOf(c).query)
    expect(allQueries.some((q) => /bookableStaffVariants/.test(q))).toBe(false)
  })
})

describe('memoryBookingAdapter.findStaffVariants — parity', () => {
  it('returns [] (no throw) so consumer-visible behavior is no staff picker', async () => {
    const adapter = memoryBookingAdapter()
    const ctx: AdapterContext = {
      config: probeConfig,
      logger: silentLogger,
      now: () => new Date(),
    }
    const result = await adapter.findStaffVariants(
      { serviceId: 'any', date: '2026-06-01', time: '10:00' },
      ctx,
    )
    expect(result).toEqual([])
  })
})
