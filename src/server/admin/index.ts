// Admin read API — Hono sub-app for dashboards (Apointoo Dash, internal ops, etc.).
// Read-only by design: no mutations from the admin endpoints. Mutations go
// through the booking pipeline or the queue worker.
//
// Auth: Bearer token. The consumer provides a verifier function — kit doesn't
// pick a JWT library or session model.

import { Hono } from 'hono'
import type { BookingStateStore } from '../../adapters/state/adapter.js'
import type { OutboundQueue } from '../../queue/adapter.js'
import { APOINTOO_HEADLESS_VERSION } from '../../core/version.js'

export type AdminAuthVerifier = (token: string) => Promise<{ ok: boolean; tenantId?: string }>

export type AdminApiOptions = {
  stateStore: BookingStateStore
  queue: OutboundQueue
  authVerifier: AdminAuthVerifier
  /** Optional path prefix (default '/admin'). */
  basePath?: string
}

/**
 * Hono sub-app exposing read-only ops endpoints.
 *
 * Routes:
 *   GET /admin/healthz                       — kit version + adapter health
 *   GET /admin/bookings/counts               — counts by status (optionally per tenant)
 *   GET /admin/bookings/:id                  — single booking state
 *   GET /admin/bookings/stale?minutes=10     — list stale 'pending' rows
 *   GET /admin/bookings/for-conversion       — list confirmed without conversion sent
 *   GET /admin/queue/counts                  — queue counts by status
 *   GET /admin/queue/dead?limit=100          — dead-letter items
 */
type AdminEnv = { Variables: { tenantId?: string } }

export function createAdminApi(opts: AdminApiOptions): Hono<AdminEnv> {
  const app = new Hono<AdminEnv>().basePath(opts.basePath ?? '/admin')

  // Auth middleware: every route requires Bearer token
  app.use('*', async (c, next) => {
    const auth = c.req.header('authorization') ?? ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
    if (!token) return c.json({ ok: false, error: 'Missing bearer token' }, 401)
    const result = await opts.authVerifier(token)
    if (!result.ok) return c.json({ ok: false, error: 'Invalid token' }, 401)
    if (result.tenantId !== undefined) {
      c.set('tenantId', result.tenantId)
    }
    await next()
  })

  app.get('/healthz', async (c) => {
    const tenantId = c.get('tenantId') as string | undefined
    const [stateHealth, queueHealth, stateCounts, queueCounts] = await Promise.all([
      opts.stateStore.health(),
      opts.queue.health(),
      opts.stateStore.countByStatus(tenantId),
      opts.queue.countByStatus(tenantId),
    ])
    return c.json({
      ok: stateHealth.ok && queueHealth.ok,
      version: APOINTOO_HEADLESS_VERSION,
      stateStore: stateHealth,
      queue: queueHealth,
      counts: { state: stateCounts, queue: queueCounts },
    })
  })

  app.get('/bookings/counts', async (c) => {
    const tenantId = c.get('tenantId') as string | undefined
    const counts = await opts.stateStore.countByStatus(tenantId)
    return c.json({ counts })
  })

  app.get('/bookings/stale', async (c) => {
    const tenantId = c.get('tenantId') as string | undefined
    const minutes = parseInt(c.req.query('minutes') ?? '10', 10)
    const stale = await opts.stateStore.findStale(minutes, tenantId)
    return c.json({ count: stale.length, items: stale })
  })

  app.get('/bookings/for-conversion', async (c) => {
    const tenantId = c.get('tenantId') as string | undefined
    const items = await opts.stateStore.findForConversion(tenantId)
    return c.json({ count: items.length, items })
  })

  app.get('/bookings/:id', async (c) => {
    const id = c.req.param('id')
    const state = await opts.stateStore.get(id)
    if (!state) return c.json({ ok: false, error: 'Not found' }, 404)
    const tenantId = c.get('tenantId') as string | undefined
    if (tenantId !== undefined && state.tenantId !== tenantId) {
      return c.json({ ok: false, error: 'Forbidden' }, 403)
    }
    return c.json({ state })
  })

  app.get('/queue/counts', async (c) => {
    const tenantId = c.get('tenantId') as string | undefined
    const counts = await opts.queue.countByStatus(tenantId)
    return c.json({ counts })
  })

  app.get('/queue/dead', async (c) => {
    const tenantId = c.get('tenantId') as string | undefined
    const limit = parseInt(c.req.query('limit') ?? '100', 10)
    const items = await opts.queue.findDead(tenantId, limit)
    return c.json({ count: items.length, items })
  })

  return app
}

// ── Built-in auth verifier helpers ──────────────────────────────────────────

/** Static admin token — single shared key. Use for ops-only endpoints. */
export function staticTokenVerifier(expected: string): AdminAuthVerifier {
  return async (token: string) => ({ ok: token === expected })
}

/** Per-tenant static tokens — `Map<token, tenantId>`. */
export function tenantTokenVerifier(
  tokens: ReadonlyMap<string, string>,
): AdminAuthVerifier {
  return async (token: string) => {
    const tenantId = tokens.get(token)
    return tenantId !== undefined ? { ok: true, tenantId } : { ok: false }
  }
}
