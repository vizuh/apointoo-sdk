// Tier 4 — BLVD bootstrap helpers (path 2 of plan-2026-05-14-blvd-expansion.md).
// Covers `listBlvdLocations` + `listBlvdServices`. Stubs `fetch` at the
// network boundary to exercise the full helper path (client construction +
// GraphQL body + response handling).
import { describe, expect, it, vi } from 'vitest'
import {
  listBlvdLocations,
  listBlvdServices,
} from '../../src/adapters/booking/blvd/bootstrap.js'
import type { BlvdError} from '../../src/adapters/booking/blvd/errors.js';
import { isBlvdError } from '../../src/adapters/booking/blvd/errors.js'

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function bodyOf(call: unknown): { query: string; variables?: unknown } {
  const init = (call as readonly [unknown, RequestInit])[1]
  return JSON.parse(init.body as string)
}

describe('listBlvdLocations', () => {
  it('returns id+name pairs and queries `business.locations`', async () => {
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        jsonOk({
          data: {
            business: {
              locations: [
                { id: 'loc-A', name: 'Brickell' },
                { id: 'loc-B', name: 'Wynwood' },
              ],
            },
          },
        }),
    )

    const result = await listBlvdLocations({
      apiKey: 'k',
      businessId: 'biz-123',
      fetchImpl: fetchImpl as typeof fetch,
    })

    expect(result).toEqual([
      { id: 'loc-A', name: 'Brickell' },
      { id: 'loc-B', name: 'Wynwood' },
    ])
    expect(fetchImpl).toHaveBeenCalledOnce()
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(String(url)).toContain('/biz-123/client')
    const body = bodyOf(fetchImpl.mock.calls[0]!)
    expect(body.query).toMatch(/business\s*\{\s*locations/)
    // Trailing-colon auth header is the adapter's silent-failure tripwire.
    const authHeader = (init?.headers as Record<string, string>)['Authorization']
    expect(authHeader).toMatch(/^Basic /)
  })

  it('propagates a BlvdError when BLVD returns a GraphQL error', async () => {
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        jsonOk({
          data: null,
          errors: [{ message: 'Unauthorized' }],
        }),
    )

    await expect(
      listBlvdLocations({
        apiKey: 'k',
        businessId: 'biz-123',
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).rejects.toSatisfy((e) => isBlvdError(e) && (e as BlvdError).code === 'GRAPHQL_ERROR')
  })
})

describe('listBlvdServices', () => {
  it('creates an ephemeral cart, fetches categories, cancels the cart', async () => {
    // Sequence: createCart → availableCategories → cancelCart
    const responses: Response[] = [
      jsonOk({
        data: { createCart: { cart: { id: 'cart-X', expiresAt: 'soon', errors: [] } } },
      }),
      jsonOk({
        data: {
          availableCategories: [
            {
              id: 'cat-1',
              name: 'Haircuts',
              availableItems: [
                { id: 'svc-1', name: 'Adult Cut' },
                { id: 'svc-2', name: "Kid's Cut" },
              ],
            },
            {
              id: 'cat-2',
              name: 'Color',
              availableItems: [{ id: 'svc-3', name: 'Full Color' }],
            },
          ],
        },
      }),
      jsonOk({ data: { cancelCart: { cart: { id: 'cart-X' } } } }),
    ]
    let i = 0
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) => {
        const r = responses[i++]
        if (!r) throw new Error('no response queued')
        return r
      },
    )

    const result = await listBlvdServices(
      { apiKey: 'k', businessId: 'biz-1', fetchImpl: fetchImpl as typeof fetch },
      'loc-A',
    )

    expect(result).toEqual([
      {
        id: 'cat-1',
        name: 'Haircuts',
        services: [
          { id: 'svc-1', name: 'Adult Cut' },
          { id: 'svc-2', name: "Kid's Cut" },
        ],
      },
      {
        id: 'cat-2',
        name: 'Color',
        services: [{ id: 'svc-3', name: 'Full Color' }],
      },
    ])
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(bodyOf(fetchImpl.mock.calls[0]!).query).toMatch(/createCart/i)
    expect(bodyOf(fetchImpl.mock.calls[1]!).query).toMatch(/availableCategories/)
    expect(bodyOf(fetchImpl.mock.calls[2]!).query).toMatch(/cancelCart/i)
  })

  it('still cancels the cart when the categories query fails', async () => {
    // createCart succeeds, availableCategories errors, cancelCart still runs.
    const responses: Response[] = [
      jsonOk({
        data: { createCart: { cart: { id: 'cart-X', expiresAt: 'soon', errors: [] } } },
      }),
      jsonOk({ data: null, errors: [{ message: 'Internal error' }] }),
      jsonOk({ data: { cancelCart: { cart: { id: 'cart-X' } } } }),
    ]
    let i = 0
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) => {
        const r = responses[i++]
        if (!r) throw new Error('no response queued')
        return r
      },
    )

    await expect(
      listBlvdServices(
        { apiKey: 'k', businessId: 'biz-1', fetchImpl: fetchImpl as typeof fetch },
        'loc-A',
      ),
    ).rejects.toSatisfy((e) => isBlvdError(e) && (e as BlvdError).code === 'GRAPHQL_ERROR')

    expect(fetchImpl).toHaveBeenCalledTimes(3) // cleanup attempted
    expect(bodyOf(fetchImpl.mock.calls[2]!).query).toMatch(/cancelCart/i)
  })
})
