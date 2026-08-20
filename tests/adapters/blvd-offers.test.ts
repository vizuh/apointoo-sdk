// Tier 4 — BLVD promo-code ops (path 5 of plan-2026-05-14-blvd-expansion.md
// and ADR-017). Covers `addCartOffer` / `removeCartOffer` / `cartOffers` +
// the BLVD adapter's createSession behavior when `offerCode` is provided.
import { describe, expect, it, vi } from 'vitest'
import { blvdAdapter } from '../../src/adapters/booking/blvd/index.js'
import {
  addCartOffer,
  removeCartOffer,
  cartOffers,
} from '../../src/adapters/booking/blvd/operations.js'
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

describe('addCartOffer op', () => {
  it('sends offerCode and returns the applied offer record', async () => {
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        jsonOk({
          data: {
            addCartOffer: {
              cart: { id: 'cart-X', errors: [] },
              offer: { id: 'offer-1', offerCode: 'NEWCLIENT25', name: '25% off' },
            },
          },
        }),
    )
    const client = createBlvdClient({
      apiKey: 'k',
      businessId: 'b',
      fetchImpl: fetchImpl as typeof fetch,
    })

    const result = await addCartOffer(client, 'cart-X', 'NEWCLIENT25')

    expect(result).toEqual({
      id: 'offer-1',
      offerCode: 'NEWCLIENT25',
      name: '25% off',
    })
    const body = bodyOf(fetchImpl.mock.calls[0]!)
    expect(body.variables).toEqual({ input: { id: 'cart-X', offerCode: 'NEWCLIENT25' } })
    expect(body.query).toMatch(/addCartOffer/)
  })

  it('throws OFFER_REJECTED when BLVD returns cart errors', async () => {
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        jsonOk({
          data: {
            addCartOffer: {
              cart: {
                id: 'cart-X',
                errors: [
                  {
                    code: 'OFFER_NOT_VALID',
                    description: 'expired',
                    message: 'Offer EXPIRED25 expired 2026-05-01',
                  },
                ],
              },
              offer: null,
            },
          },
        }),
    )
    const client = createBlvdClient({
      apiKey: 'k',
      businessId: 'b',
      fetchImpl: fetchImpl as typeof fetch,
    })

    await expect(addCartOffer(client, 'cart-X', 'EXPIRED25')).rejects.toSatisfy(
      (e) => isBlvdError(e) && (e as BlvdError).code === 'OFFER_REJECTED',
    )
  })

  it('throws OFFER_REJECTED when BLVD accepts but returns null offer', async () => {
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        jsonOk({
          data: { addCartOffer: { cart: { id: 'cart-X', errors: [] }, offer: null } },
        }),
    )
    const client = createBlvdClient({
      apiKey: 'k',
      businessId: 'b',
      fetchImpl: fetchImpl as typeof fetch,
    })

    await expect(addCartOffer(client, 'cart-X', 'OK25')).rejects.toSatisfy(
      (e) => isBlvdError(e) && (e as BlvdError).code === 'OFFER_REJECTED',
    )
  })
})

describe('removeCartOffer + cartOffers ops', () => {
  it('removeCartOffer sends offerId and resolves on success', async () => {
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        jsonOk({ data: { removeCartOffer: { cart: { id: 'cart-X', errors: [] } } } }),
    )
    const client = createBlvdClient({
      apiKey: 'k',
      businessId: 'b',
      fetchImpl: fetchImpl as typeof fetch,
    })

    await removeCartOffer(client, 'cart-X', 'offer-1')

    const body = bodyOf(fetchImpl.mock.calls[0]!)
    expect(body.variables).toEqual({ input: { id: 'cart-X', offerId: 'offer-1' } })
  })

  it('cartOffers returns the list applied to a cart', async () => {
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        jsonOk({
          data: {
            cartOffers: [
              { id: 'offer-1', offerCode: 'NEWCLIENT25', name: '25% off' },
              { id: 'offer-2', offerCode: 'REFERRAL10', name: '10% referral' },
            ],
          },
        }),
    )
    const client = createBlvdClient({
      apiKey: 'k',
      businessId: 'b',
      fetchImpl: fetchImpl as typeof fetch,
    })

    const result = await cartOffers(client, 'cart-X')
    expect(result).toHaveLength(2)
    expect(result[0]!.offerCode).toBe('NEWCLIENT25')
  })
})

describe('blvdAdapter.createSession — offerCode integration', () => {
  function adapterWith(responses: Response[]) {
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
    return { adapter, ctx, fetchImpl }
  }

  it('applies offerCode after updateCartClientInfo (4 fetch calls)', async () => {
    // Sequence with offerCode:
    //   1. createCart
    //   2. addBookableItem
    //   3. updateCartClientInfo (with name + phone)
    //   4. addCartOffer
    const { adapter, ctx, fetchImpl } = adapterWith([
      jsonOk({
        data: { createCart: { cart: { id: 'cart-X', expiresAt: 'soon', errors: [] } } },
      }),
      jsonOk({
        data: { addCartSelectedBookableItem: { cart: { id: 'cart-X', errors: [] } } },
      }),
      jsonOk({
        data: { updateCart: { cart: { id: 'cart-X', errors: [] } } },
      }),
      jsonOk({
        data: {
          addCartOffer: {
            cart: { id: 'cart-X', errors: [] },
            offer: { id: 'offer-1', offerCode: 'NEWCLIENT25', name: '25% off' },
          },
        },
      }),
    ])

    const session = await adapter.createSession(
      {
        serviceId: 'haircut',
        name: 'Marcia Silva',
        phone: '+15555550001',
        email: undefined,
        requestedDate: '2026-06-01',
        requestedTime: '10:00',
        offerCode: 'NEWCLIENT25',
      },
      ctx,
    )

    expect(session.vendor).toBe('blvd')
    expect(fetchImpl).toHaveBeenCalledTimes(4)
    expect(bodyOf(fetchImpl.mock.calls[3]!).variables).toEqual({
      input: { id: 'cart-X', offerCode: 'NEWCLIENT25' },
    })
  })

  it('skips addCartOffer when offerCode is undefined (3 fetch calls)', async () => {
    const { adapter, ctx, fetchImpl } = adapterWith([
      jsonOk({
        data: { createCart: { cart: { id: 'cart-X', expiresAt: 'soon', errors: [] } } },
      }),
      jsonOk({
        data: { addCartSelectedBookableItem: { cart: { id: 'cart-X', errors: [] } } },
      }),
      jsonOk({
        data: { updateCart: { cart: { id: 'cart-X', errors: [] } } },
      }),
    ])

    await adapter.createSession(
      {
        serviceId: 'haircut',
        name: 'Marcia Silva',
        phone: '+15555550001',
        email: undefined,
        requestedDate: '2026-06-01',
        requestedTime: '10:00',
        offerCode: undefined,
      },
      ctx,
    )

    expect(fetchImpl).toHaveBeenCalledTimes(3)
    const allQueries = fetchImpl.mock.calls.map((c) => bodyOf(c).query)
    expect(allQueries.some((q) => /addCartOffer/.test(q))).toBe(false)
  })

  it('throws OFFER_REJECTED (not generic createSession failure) when offer is invalid', async () => {
    const { adapter, ctx } = adapterWith([
      jsonOk({
        data: { createCart: { cart: { id: 'cart-X', expiresAt: 'soon', errors: [] } } },
      }),
      jsonOk({
        data: { addCartSelectedBookableItem: { cart: { id: 'cart-X', errors: [] } } },
      }),
      jsonOk({
        data: { updateCart: { cart: { id: 'cart-X', errors: [] } } },
      }),
      jsonOk({
        data: {
          addCartOffer: {
            cart: {
              id: 'cart-X',
              errors: [
                { code: 'OFFER_NOT_FOUND', description: 'unknown', message: 'No offer' },
              ],
            },
            offer: null,
          },
        },
      }),
    ])

    await expect(
      adapter.createSession(
        {
          serviceId: 'haircut',
          name: 'Marcia Silva',
          phone: '+15555550001',
          email: undefined,
          requestedDate: '2026-06-01',
          requestedTime: '10:00',
          offerCode: 'NOPE',
        },
        ctx,
      ),
    ).rejects.toSatisfy((e) => isBlvdError(e) && (e as BlvdError).code === 'OFFER_REJECTED')
  })
})
