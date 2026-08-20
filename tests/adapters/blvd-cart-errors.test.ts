// Ponytail-audit finding: assertNoCartErrors()'s CART_EXPIRED-vs-CART_ERROR
// discrimination is called at 6 cart-lifecycle sites but every existing test
// that simulates a failure does so via the top-level GraphQL `errors` array
// (a different code path in client.ts), never via a populated `cart.errors`
// field — so the discriminating branch itself was never exercised.

import { describe, expect, it, vi } from 'vitest'
import { createCart, addBookableItem } from '../../src/adapters/booking/blvd/operations.js'
import { createBlvdClient } from '../../src/adapters/booking/blvd/client.js'
import { isBlvdError } from '../../src/adapters/booking/blvd/errors.js'
import type { BlvdError } from '../../src/adapters/booking/blvd/errors.js'

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function client(fetchImpl: typeof fetch) {
  return createBlvdClient({ apiKey: 'k', businessId: 'b', fetchImpl })
}

describe('assertNoCartErrors — CART_EXPIRED vs CART_ERROR discrimination', () => {
  it('createCart: a cart.errors entry with code CART_EXPIRED throws BlvdError(CART_EXPIRED)', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonOk({
        data: {
          createCart: {
            cart: {
              id: 'cart-X',
              expiresAt: '',
              errors: [{ code: 'CART_EXPIRED', description: 'expired', message: 'Cart expired' }],
            },
          },
        },
      }),
    )

    await expect(createCart(client(fetchImpl as typeof fetch), 'loc-A')).rejects.toSatisfy(
      (e) => isBlvdError(e) && (e as BlvdError).code === 'CART_EXPIRED',
    )
  })

  it('createCart: any other cart.errors code throws the generic BlvdError(CART_ERROR)', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonOk({
        data: {
          createCart: {
            cart: {
              id: 'cart-X',
              expiresAt: '',
              errors: [{ code: 'LOCATION_CLOSED', description: 'closed', message: 'Location closed' }],
            },
          },
        },
      }),
    )

    await expect(createCart(client(fetchImpl as typeof fetch), 'loc-A')).rejects.toSatisfy(
      (e) => isBlvdError(e) && (e as BlvdError).code === 'CART_ERROR',
    )
  })

  it('addBookableItem: an empty cart.errors array does not throw', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonOk({
        data: { addCartSelectedBookableItem: { cart: { id: 'cart-X', errors: [] } } },
      }),
    )

    await expect(
      addBookableItem(client(fetchImpl as typeof fetch), 'cart-X', 'svc-1'),
    ).resolves.toBeUndefined()
  })

  it('addBookableItem: a CART_EXPIRED cart.errors entry throws CART_EXPIRED (not just createCart)', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonOk({
        data: {
          addCartSelectedBookableItem: {
            cart: {
              id: 'cart-X',
              errors: [{ code: 'CART_EXPIRED', description: 'expired', message: 'Cart expired' }],
            },
          },
        },
      }),
    )

    await expect(
      addBookableItem(client(fetchImpl as typeof fetch), 'cart-X', 'svc-1'),
    ).rejects.toSatisfy((e) => isBlvdError(e) && (e as BlvdError).code === 'CART_EXPIRED')
  })
})
