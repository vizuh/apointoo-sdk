// TenantResolver — maps a request to a BookingKitConfig.
// Built-in impls: static, path, host, header. ADR-007.

import type { BookingKitConfig } from '../core/schemas.js'

export type ResolvedTenant = {
  tenantId: string
  config: BookingKitConfig
}

export interface TenantResolver {
  resolve(req: Request): Promise<ResolvedTenant>
}

export class TenantNotFoundError extends Error {
  constructor(public readonly attempted: string) {
    super(`Tenant not found: ${attempted}`)
    this.name = 'TenantNotFoundError'
  }
}

// ── Static (single-tenant — back-compat with v0.1.0) ────────────────────────

export function staticTenantResolver(config: BookingKitConfig): TenantResolver {
  const resolved: ResolvedTenant = { tenantId: config.projectKey, config }
  return {
    async resolve(_req) {
      return resolved
    },
  }
}

// ── Path (e.g. /tenant-a/booking, /tenant-b/booking) ────────────────────────

export function pathTenantResolver(
  configsByTenantId: Readonly<Record<string, BookingKitConfig>>,
): TenantResolver {
  return {
    async resolve(req) {
      const url = new URL(req.url)
      // First non-empty path segment is the tenant id
      const segments = url.pathname.split('/').filter(Boolean)
      const tenantId = segments[0] ?? ''
      const config = configsByTenantId[tenantId]
      if (!config) throw new TenantNotFoundError(tenantId || '<empty>')
      return { tenantId, config }
    },
  }
}

// ── Host (e.g. tenant-a.apointoo.com → cfgA) ────────────────────────────────

export function hostTenantResolver(
  configsByHost: Readonly<Record<string, BookingKitConfig>>,
): TenantResolver {
  return {
    async resolve(req) {
      const url = new URL(req.url)
      const host = url.host.toLowerCase()
      const config = configsByHost[host]
      if (!config) throw new TenantNotFoundError(host)
      return { tenantId: config.projectKey, config }
    },
  }
}

// ── Header (e.g. X-Apointoo-Tenant: tenant-a) ───────────────────────────────

export function headerTenantResolver(
  headerName: string,
  configsByTenantId: Readonly<Record<string, BookingKitConfig>>,
): TenantResolver {
  const lowerHeader = headerName.toLowerCase()
  return {
    async resolve(req) {
      const tenantId = req.headers.get(lowerHeader) ?? ''
      const config = configsByTenantId[tenantId]
      if (!config) throw new TenantNotFoundError(tenantId || '<missing>')
      return { tenantId, config }
    },
  }
}

// ── Remote (fetch config from external endpoint) ────────────────────────────

export function remoteTenantResolver(
  fetchConfig: (tenantId: string) => Promise<BookingKitConfig | null>,
  extractTenantId: (req: Request) => string,
): TenantResolver {
  return {
    async resolve(req) {
      const tenantId = extractTenantId(req)
      if (!tenantId) throw new TenantNotFoundError('<missing>')
      const config = await fetchConfig(tenantId)
      if (!config) throw new TenantNotFoundError(tenantId)
      return { tenantId, config }
    },
  }
}
