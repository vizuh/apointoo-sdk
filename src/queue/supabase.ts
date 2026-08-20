// Supabase OutboundQueue — Postgres via REST.
// Atomic claim via stored procedure (RPC) using SELECT FOR UPDATE SKIP LOCKED.
//
// Migration SQL (apply once per project):
//
//   create table outbound_queue (
//     id text primary key,
//     tenant_id text not null,
//     submission_id text not null,
//     channel text not null check (channel in ('email','whatsapp','sms','webhook')),
//     payload jsonb not null,
//     status text not null check (status in ('pending','in_flight','done','failed','dead')),
//     attempts int not null default 0,
//     last_error text,
//     next_retry_at timestamptz not null default now(),
//     created_at timestamptz not null default now(),
//     updated_at timestamptz not null default now()
//   );
//   create index outbound_queue_ready_idx on outbound_queue(next_retry_at)
//     where status = 'pending';
//
//   create or replace function claim_queue_items(p_max int, p_worker_id text)
//   returns setof outbound_queue
//   language plpgsql as $$
//   begin
//     return query
//     update outbound_queue q
//     set status = 'in_flight', updated_at = now()
//     where q.id in (
//       select id from outbound_queue
//       where status = 'pending' and next_retry_at <= now()
//       order by next_retry_at
//       for update skip locked
//       limit p_max
//     )
//     returning q.*;
//   end;
//   $$;

import { errMessage, BookingError } from '../core/errors.js'
import { truncate } from '../core/internal/strings.js'
import {
  computeBackoff,
  shouldFlipToDead,
  type BackoffOptions,
  type OutboundQueue,
  type QueueEnqueue,
  type QueueItem,
  type QueueItemStatus,
} from './adapter.js'

export type SupabaseQueueOptions = {
  url: string
  /**
   * Supabase **service-role** key (NOT the anon/publishable key).
   *
   * ⚠ Same wiring caveat as `supabaseStateStore`: never share a
   * service-role client with anything that mounts a user session
   * (RLS gotcha). Construct the kit's queue adapter at module scope
   * and reuse the resulting instance.
   *
   * Schema + claim RPC: see docs/migrations/001-state-and-queue.sql.
   */
  serviceRoleKey: string
  table?: string
  /** RPC function name for atomic claim. Default: 'claim_queue_items'. */
  claimFn?: string
  backoff?: BackoffOptions
  fetchImpl?: typeof fetch
}

const DEFAULT_TABLE = 'outbound_queue'
const DEFAULT_CLAIM_FN = 'claim_queue_items'

export function supabaseQueue(opts: SupabaseQueueOptions): OutboundQueue {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const table = opts.table ?? DEFAULT_TABLE
  const claimFn = opts.claimFn ?? DEFAULT_CLAIM_FN
  const baseUrl = `${opts.url.replace(/\/$/, '')}/rest/v1`
  const headers = (extra: Record<string, string> = {}): Record<string, string> => ({
    apikey: opts.serviceRoleKey,
    Authorization: `Bearer ${opts.serviceRoleKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...extra,
  })

  return {
    async enqueue(input: QueueEnqueue): Promise<string> {
      const id = `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
      const url = `${baseUrl}/${table}`
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: headers({ Prefer: 'return=minimal' }),
        body: JSON.stringify([
          {
            id,
            tenant_id: input.tenantId,
            submission_id: input.submissionId,
            channel: input.channel,
            payload: input.payload,
            status: 'pending',
            attempts: 0,
            next_retry_at: (input.scheduledFor ?? new Date()).toISOString(),
          },
        ]),
      })
      if (!res.ok) throw new BookingError('PERSISTENCE_FAILED', `supabaseQueue.enqueue: HTTP ${res.status}`)
      return id
    },

    async claim(max: number, workerId: string): Promise<QueueItem[]> {
      const url = `${baseUrl}/rpc/${claimFn}`
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ p_max: max, p_worker_id: workerId }),
      })
      if (!res.ok) throw new BookingError('PERSISTENCE_FAILED', `supabaseQueue.claim: HTTP ${res.status}`)
      const rows = (await res.json()) as unknown[]
      return rows.map((r) => rowToItem(r as Record<string, unknown>))
    },

    async markDone(itemId: string): Promise<void> {
      const url = `${baseUrl}/${table}?id=eq.${encodeURIComponent(itemId)}`
      const res = await fetchImpl(url, {
        method: 'PATCH',
        headers: headers({ Prefer: 'return=minimal' }),
        body: JSON.stringify({
          status: 'done',
          updated_at: new Date().toISOString(),
        }),
      })
      if (!res.ok) throw new BookingError('PERSISTENCE_FAILED', `supabaseQueue.markDone: HTTP ${res.status}`)
    },

    async markFailed(itemId: string, error: string): Promise<void> {
      // Read current attempts to compute backoff client-side. Simpler than a
      // stored procedure for now; race-safe because the worker just claimed it.
      const getUrl = `${baseUrl}/${table}?id=eq.${encodeURIComponent(itemId)}&select=attempts&limit=1`
      const getRes = await fetchImpl(getUrl, { headers: headers() })
      if (!getRes.ok) throw new BookingError('PERSISTENCE_FAILED', `supabaseQueue.markFailed.get: HTTP ${getRes.status}`)
      const rows = (await getRes.json()) as Array<{ attempts: number }>
      const current = rows[0]?.attempts ?? 0
      const attempts = current + 1
      const dead = shouldFlipToDead(attempts, opts.backoff)
      const nextRetryAt = dead
        ? new Date()
        : new Date(Date.now() + computeBackoff(attempts, opts.backoff))

      const url = `${baseUrl}/${table}?id=eq.${encodeURIComponent(itemId)}`
      const res = await fetchImpl(url, {
        method: 'PATCH',
        headers: headers({ Prefer: 'return=minimal' }),
        body: JSON.stringify({
          attempts,
          last_error: truncate(error, 1000),
          status: dead ? 'dead' : 'pending',
          next_retry_at: nextRetryAt.toISOString(),
          updated_at: new Date().toISOString(),
        }),
      })
      if (!res.ok) throw new BookingError('PERSISTENCE_FAILED', `supabaseQueue.markFailed: HTTP ${res.status}`)
    },

    async findDead(tenantId?: string, limit = 100): Promise<QueueItem[]> {
      const params = new URLSearchParams()
      params.set('status', 'eq.dead')
      params.set('limit', String(limit))
      params.set('order', 'updated_at.desc')
      if (tenantId) params.set('tenant_id', `eq.${tenantId}`)
      const url = `${baseUrl}/${table}?${params.toString()}`
      const res = await fetchImpl(url, { headers: headers() })
      if (!res.ok) throw new BookingError('PERSISTENCE_FAILED', `supabaseQueue.findDead: HTTP ${res.status}`)
      const rows = (await res.json()) as unknown[]
      return rows.map((r) => rowToItem(r as Record<string, unknown>))
    },

    async countByStatus(tenantId?: string): Promise<Record<QueueItemStatus, number>> {
      const statuses: QueueItemStatus[] = ['pending', 'in_flight', 'done', 'failed', 'dead']
      const results = await Promise.all(
        statuses.map(async (s) => {
          const params = new URLSearchParams()
          params.set('status', `eq.${s}`)
          params.set('select', 'id')
          if (tenantId) params.set('tenant_id', `eq.${tenantId}`)
          const url = `${baseUrl}/${table}?${params.toString()}`
          const res = await fetchImpl(url, { headers: headers({ Prefer: 'count=exact' }) })
          if (!res.ok) return [s, 0] as const
          const range = res.headers.get('content-range') ?? '*/0'
          const total = parseInt(range.split('/')[1] ?? '0', 10)
          return [s, total] as const
        }),
      )
      return Object.fromEntries(results) as Record<QueueItemStatus, number>
    },

    async health() {
      try {
        const res = await fetchImpl(`${baseUrl}/${table}?limit=1&select=id`, {
          headers: headers(),
        })
        return res.ok
          ? { ok: true, name: 'supabase-queue' }
          : { ok: false, name: 'supabase-queue', error: `HTTP ${res.status}` }
      } catch (err) {
        return {
          ok: false,
          name: 'supabase-queue',
          error: errMessage(err),
        }
      }
    },
  }
}

function rowToItem(row: Record<string, unknown>): QueueItem {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    submissionId: String(row.submission_id),
    channel: row.channel as QueueItem['channel'],
    payload: (row.payload as Record<string, unknown>) ?? {},
    status: row.status as QueueItemStatus,
    attempts: Number(row.attempts ?? 0),
    lastError: (row.last_error as string | null) ?? null,
    nextRetryAt: new Date(String(row.next_retry_at)),
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at)),
  }
}
