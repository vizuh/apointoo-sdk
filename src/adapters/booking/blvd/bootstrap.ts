// Bootstrap helpers — read-only catalog discovery for BLVD adapter consumers.
// Not part of `BookingAdapter`. These are one-shot calls used by onboarding
// scripts / healthcheck handlers to discover the `defaultLocationId` and
// `serviceMap` values that `blvdAdapter()` requires at construction time.
//
// They construct their own `BlvdClient` rather than borrowing the adapter's
// because callers (onboarding scripts) typically don't have an `AdapterContext`
// available — they live above the pipeline, not inside it.
//
// MANUAL-VERIFY: see notes in `operations.ts` for inferred GraphQL field
// names that still require sandbox confirmation.

import { createBlvdClient } from './client.js'
import {
  availableCategories as opAvailableCategories,
  cancelCart,
  createCart,
  listLocations as opListLocations,
  type BlvdLocationSummary,
  type BlvdServiceCategorySummary,
} from './operations.js'

export type BlvdBootstrapOptions = {
  apiKey: string
  businessId: string
  /** Defaults to live: https://dashboard.boulevard.io/api/2020-01 */
  apiUrl?: string
  /** Override fetch (for tests). */
  fetchImpl?: typeof fetch
}

export type { BlvdLocationSummary, BlvdServiceCategorySummary }

/**
 * List the BLVD locations available to this business. Use the returned `id`
 * to populate `defaultLocationId` (and optional `locationMap` entries) in
 * the `blvdAdapter()` options.
 *
 * @example
 *   const locations = await listBlvdLocations({ apiKey, businessId })
 *   // → [{ id: 'loc-A', name: 'Brickell' }, ...]
 */
export async function listBlvdLocations(
  opts: BlvdBootstrapOptions,
): Promise<BlvdLocationSummary[]> {
  const client = createBlvdClient({
    apiKey: opts.apiKey,
    businessId: opts.businessId,
    ...(opts.apiUrl !== undefined ? { apiUrl: opts.apiUrl } : {}),
    ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
  })
  return opListLocations(client)
}

/**
 * List the BLVD service categories + bookable services for a location.
 * Use the returned service `id` values to populate `serviceMap` entries in
 * the `blvdAdapter()` options. BLVD requires a cart context to read the
 * service catalog, so this creates an ephemeral cart and cancels it after.
 *
 * @example
 *   const cats = await listBlvdServices({ apiKey, businessId }, 'loc-A')
 *   // → [{ id: 'cat-1', name: 'Haircuts', services: [{ id: 'svc-1', name: 'Adult Cut' }] }]
 */
export async function listBlvdServices(
  opts: BlvdBootstrapOptions,
  locationId: string,
): Promise<BlvdServiceCategorySummary[]> {
  const client = createBlvdClient({
    apiKey: opts.apiKey,
    businessId: opts.businessId,
    ...(opts.apiUrl !== undefined ? { apiUrl: opts.apiUrl } : {}),
    ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
  })
  const cartId = await createCart(client, locationId)
  try {
    return await opAvailableCategories(client, cartId)
  } finally {
    cancelCart(client, cartId).catch(() => undefined)
  }
}
