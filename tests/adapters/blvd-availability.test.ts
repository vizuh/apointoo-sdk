// Tier 4 — BLVD findAvailability range-aware rewrite (path 3 of
// plan-2026-05-14-blvd-expansion.md). Covers the new `cartBookableDates` op
// and the latency-win behavior in `findAvailability` (skip days with no
// availability instead of querying each day in the range).
import { describe, expect, it, vi } from 'vitest'
import { blvdAdapter } from '../../src/adapters/booking/blvd/index.js'
import { cartBookableDates } from '../../src/adapters/booking/blvd/operations.js'
import { createBlvdClient } from '../../src/adapters/booking/blvd/client.js'
import type { BlvdError} from '../../src/adapters/booking/blvd/errors.js';
import { isBlvdError } from '../../src/adapters/booking/blvd/errors.js'
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

describe('cartBookableDates op', () => {
  it('sends searchRangeLower/Upper + tz and returns date+score pairs', async () => {
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        jsonOk({
          data: {
            cartBookableDates: [
              { date: '2026-06-01', score: 1.0 },
              { date: '2026-06-03', score: 0.6 },
            ],
          },
        }),
    )
    const client = createBlvdClient({
      apiKey: 'k',
      businessId: 'b',
      fetchImpl: fetchImpl as typeof fetch,
    })

    const result = await cartBookableDates(
      client,
      'cart-X',
      '2026-06-01',
      '2026-06-05',
      'America/New_York',
    )

    expect(result).toEqual([
      { date: '2026-06-01', score: 1.0 },
      { date: '2026-06-03', score: 0.6 },
    ])
    const body = bodyOf(fetchImpl.mock.calls[0]!)
    expect(body.variables).toEqual({
      id: 'cart-X',
      searchRangeLower: '2026-06-01',
      searchRangeUpper: '2026-06-05',
      tz: 'America/New_York',
    })
    expect(body.query).toMatch(/cartBookableDates/)
  })

  it('propagates BlvdError on GraphQL failure', async () => {
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        jsonOk({ data: null, errors: [{ message: 'Invalid range' }] }),
    )
    const client = createBlvdClient({
      apiKey: 'k',
      businessId: 'b',
      fetchImpl: fetchImpl as typeof fetch,
    })

    await expect(
      cartBookableDates(client, 'cart-X', '2026-06-01', '2026-06-05', 'America/New_York'),
    ).rejects.toSatisfy((e) => isBlvdError(e) && (e as BlvdError).code === 'GRAPHQL_ERROR')
  })
})

describe('blvdAdapter.findAvailability — range-aware', () => {
  it('queries only days returned by cartBookableDates (skips empty days)', async () => {
    // 5-day range; BLVD says only 2 days have availability.
    // Expected fetch sequence:
    //   1. createCart
    //   2. addCartSelectedBookableItem
    //   3. cartBookableDates → [2026-06-01, 2026-06-03]
    //   4. cartBookableTimes(2026-06-01)
    //   5. cartBookableTimes(2026-06-03)
    //   6. cancelCart (best-effort cleanup)
    // No call for 2026-06-02, 06-04, or 06-05.
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
          cartBookableDates: [
            { date: '2026-06-01', score: 1.0 },
            { date: '2026-06-03', score: 0.6 },
          ],
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
          cartBookableTimes: [
            { id: 'slot-c', score: 1, startTime: '2026-06-03T14:00:00-04:00' },
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

    const result = await adapter.findAvailability(
      { serviceId: 'haircut', fromDate: '2026-06-01', toDate: '2026-06-05' },
      ctx,
    )

    expect(result).toEqual([
      { date: '2026-06-01', time: '09:00', vendorSlotId: 'slot-a' },
      { date: '2026-06-01', time: '10:00', vendorSlotId: 'slot-b' },
      { date: '2026-06-03', time: '14:00', vendorSlotId: 'slot-c' },
    ])
    // 1 cart create + 1 add item + 1 dates + 2 times (only the days BLVD said
    // had availability) + 1 cancel = 6 calls. Old impl would have been 8
    // (5 day queries instead of 2). Latency-win assertion.
    expect(fetchImpl).toHaveBeenCalledTimes(6)
    expect(bodyOf(fetchImpl.mock.calls[2]!).query).toMatch(/cartBookableDates/)
    expect(bodyOf(fetchImpl.mock.calls[3]!).variables).toMatchObject({
      searchDate: '2026-06-01',
    })
    expect(bodyOf(fetchImpl.mock.calls[4]!).variables).toMatchObject({
      searchDate: '2026-06-03',
    })
    // No fetch ever asked for the days BLVD didn't list.
    const datesQueried = fetchImpl.mock.calls
      .map((c) => bodyOf(c).variables as { searchDate?: string } | undefined)
      .map((v) => v?.searchDate)
      .filter((d): d is string => typeof d === 'string')
    expect(datesQueried).toEqual(['2026-06-01', '2026-06-03'])
    expect(datesQueried).not.toContain('2026-06-02')
    expect(datesQueried).not.toContain('2026-06-04')
    expect(datesQueried).not.toContain('2026-06-05')
  })
})
