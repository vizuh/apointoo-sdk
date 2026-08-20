// MerchantSource — pluggable origin of RwG merchants for the publisher.
// Single-tenant: static config. Multi-tenant SaaS: pull from a DB via
// consumer-supplied fetch fn. Tests: in-memory.

import { errMessage } from '../../core/errors.js'
import type { RwgMerchant } from './feed-builder.js'

export interface MerchantSource {
  /** Return ALL active merchants this source knows about. */
  list(): Promise<ReadonlyArray<RwgMerchant>>

  /**
   * Optional incremental — return merchants modified since `timestamp`.
   * Used by incremental publish runs. Default impl returns list() (full).
   */
  listSince?(timestamp: Date): Promise<ReadonlyArray<RwgMerchant>>

  /** Connectivity probe — returns true if source is reachable. */
  health(): Promise<{ ok: boolean; name: string; error?: string }>
}

// ── Static (single-tenant / tests) ──────────────────────────────────────────

export type StaticMerchantSourceOptions = {
  merchants: ReadonlyArray<RwgMerchant>
}

export function staticMerchantSource(
  opts: StaticMerchantSourceOptions,
): MerchantSource {
  return {
    async list() {
      return opts.merchants
    },
    async listSince(_t) {
      return opts.merchants
    },
    async health() {
      return { ok: true, name: 'static' }
    },
  }
}

// ── Fetch-based (SaaS — pull from consumer's DB) ────────────────────────────
// Multi-tenant deployments: consumer wires a fn that queries their tenants +
// merchants table, returns the flat list. Vizuh-side: this fetches from
// Supabase `merchants` joined with `tenants` where `is_active = true`.

export type FetchMerchantSourceOptions = {
  /** Async fn returning the current merchant list. Called once per publish run. */
  fetch: () => Promise<ReadonlyArray<RwgMerchant>>
  /** Optional incremental fetch — same shape as fetch but accepts a since timestamp. */
  fetchSince?: (timestamp: Date) => Promise<ReadonlyArray<RwgMerchant>>
  /** Optional name for logs/health. */
  name?: string
}

export function fetchMerchantSource(opts: FetchMerchantSourceOptions): MerchantSource {
  const name = opts.name ?? 'fetch'
  return {
    async list() {
      return opts.fetch()
    },
    ...(opts.fetchSince
      ? { listSince: async (t: Date) => opts.fetchSince!(t) }
      : {}),
    async health() {
      try {
        await opts.fetch()
        return { ok: true, name }
      } catch (err) {
        return {
          ok: false,
          name,
          error: errMessage(err),
        }
      }
    },
  }
}

// ── Filtering wrapper ───────────────────────────────────────────────────────
// Compose a source with a predicate. Useful for SaaS to filter by tier
// (only `pro` / `enterprise` tenants get RwG publish), or by subscription
// status (skip merchants whose payment lapsed).

export function filteredMerchantSource(
  inner: MerchantSource,
  predicate: (m: RwgMerchant) => boolean,
  name = 'filtered',
): MerchantSource {
  return {
    async list() {
      const all = await inner.list()
      return all.filter(predicate)
    },
    ...(inner.listSince
      ? {
          listSince: async (t: Date) => {
            const since = await inner.listSince!(t)
            return since.filter(predicate)
          },
        }
      : {}),
    async health() {
      const innerHealth = await inner.health()
      return { ...innerHealth, name }
    },
  }
}
