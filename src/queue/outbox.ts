// Outbox pattern. ADR-012.
//
// Problem: pipeline writes the booking state row, then enqueues N notifications.
// If the process dies between the two writes, state is recorded but the
// queue items aren't — the booking happened but no one notified the operator.
//
// Solution: write state + queue items in ONE transaction. For Postgres
// (Supabase), this means a single RPC that does both inserts atomically.
//
// This module ships the helper interface. Backends implement it differently:
//   - Memory: just two sequential writes (no atomicity, only used in tests)
//   - Supabase: one RPC `apointoo_booking_outbox` defined in SQL
//
// Consumers wire the impl into the pipeline via `outbox` option.

import { errMessage, BookingError } from '../core/errors.js'
import { truncate } from '../core/internal/strings.js'
import type { BookingStateCreate, BookingStateStore } from '../adapters/state/adapter.js'
import type { OutboundQueue, QueueEnqueue } from './adapter.js'

export type OutboxWrite = {
  state: BookingStateCreate
  queueItems: ReadonlyArray<QueueEnqueue>
}

export interface OutboxWriter {
  /**
   * Atomically write the state row + all queue items.
   * MUST be all-or-nothing. Implementations that can't guarantee atomicity
   * MUST NOT claim to be an OutboxWriter (use the fallback helper instead).
   */
  write(payload: OutboxWrite): Promise<void>
  /** Connectivity probe. */
  health(): Promise<{ ok: boolean; name: string; error?: string }>
}

/**
 * Fallback implementation: two sequential writes. Used when the consumer
 * doesn't have a transactional outbox impl. Logs a warning at first use.
 *
 * Semantics: state is written first. If queue.enqueue fails, state row
 * still exists (in 'pending' state). Sweeper will eventually mark it
 * 'abandoned' since no notification went out.
 *
 * This is the pre-outbox behavior. Better than nothing; not as good as
 * the supabaseOutboxWriter.
 */
export function fallbackOutboxWriter(
  stateStore: BookingStateStore,
  queue: OutboundQueue,
): OutboxWriter {
  return {
    async write(payload) {
      await stateStore.create(payload.state)
      for (const item of payload.queueItems) {
        await queue.enqueue(item)
      }
    },
    async health() {
      const [s, q] = await Promise.all([stateStore.health(), queue.health()])
      return {
        ok: s.ok && q.ok,
        name: 'fallback-outbox',
        ...(s.ok ? {} : { error: `state: ${s.error ?? 'down'}` }),
      }
    },
  }
}

/**
 * Supabase outbox writer — single RPC call wrapping both inserts in a
 * Postgres transaction.
 *
 * Required SQL (apply to Supabase project):
 *
 *   create or replace function apointoo_booking_outbox(
 *     p_state jsonb,
 *     p_queue_items jsonb
 *   ) returns void
 *   language plpgsql as $$
 *   begin
 *     insert into booking_state(
 *       submission_id, tenant_id, status, vendor,
 *       gclid, fbclid, msclkid, rwg_token,
 *       utm_source, utm_medium, utm_campaign,
 *       attribution,
 *       retry_count, created_at, updated_at
 *     )
 *     values (
 *       p_state->>'submission_id', p_state->>'tenant_id', 'pending', p_state->>'vendor',
 *       p_state->>'gclid', p_state->>'fbclid', p_state->>'msclkid', p_state->>'rwg_token',
 *       p_state->>'utm_source', p_state->>'utm_medium', p_state->>'utm_campaign',
 *       p_state->'attribution',
 *       0, (p_state->>'created_at')::timestamptz, now()
 *     )
 *     on conflict (submission_id) do nothing;
 *
 *     insert into outbound_queue(
 *       id, tenant_id, submission_id, channel, payload,
 *       status, attempts, next_retry_at
 *     )
 *     select
 *       coalesce(item->>'id', 'q_' || encode(gen_random_bytes(8), 'hex')),
 *       item->>'tenant_id', item->>'submission_id', item->>'channel',
 *       (item->'payload')::jsonb,
 *       'pending', 0, now()
 *     from jsonb_array_elements(p_queue_items) as item;
 *   end;
 *   $$;
 */
export type SupabaseOutboxOptions = {
  url: string
  serviceRoleKey: string
  /** RPC function name. Default: 'apointoo_booking_outbox'. */
  rpcFn?: string
  fetchImpl?: typeof fetch
}

const DEFAULT_RPC = 'apointoo_booking_outbox'

export function supabaseOutboxWriter(opts: SupabaseOutboxOptions): OutboxWriter {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const rpcFn = opts.rpcFn ?? DEFAULT_RPC
  const baseUrl = `${opts.url.replace(/\/$/, '')}/rest/v1/rpc/${rpcFn}`
  const headers = (): Record<string, string> => ({
    apikey: opts.serviceRoleKey,
    Authorization: `Bearer ${opts.serviceRoleKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  })

  return {
    async write(payload) {
      const body = {
        p_state: stateToJson(payload.state),
        p_queue_items: payload.queueItems.map(queueItemToJson),
      }
      const res = await fetchImpl(baseUrl, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new BookingError('PERSISTENCE_FAILED', `supabaseOutboxWriter: HTTP ${res.status} ${truncate(text, 200)}`)
      }
    },
    async health() {
      try {
        // Health = call RPC with a no-op payload (empty queue_items + minimal state)
        // Cheaper: just check the RPC endpoint exists by hitting OPTIONS.
        const res = await fetchImpl(baseUrl, {
          method: 'OPTIONS',
          headers: headers(),
        })
        return res.ok || res.status === 204
          ? { ok: true, name: 'supabase-outbox' }
          : { ok: false, name: 'supabase-outbox', error: `HTTP ${res.status}` }
      } catch (err) {
        return {
          ok: false,
          name: 'supabase-outbox',
          error: errMessage(err),
        }
      }
    },
  }
}

function stateToJson(s: BookingStateCreate): Record<string, unknown> {
  return {
    submission_id: s.submissionId,
    tenant_id: s.tenantId,
    vendor: s.vendor,
    gclid: s.gclid,
    fbclid: s.fbclid,
    msclkid: s.msclkid,
    rwg_token: s.rwgToken,
    utm_source: s.utmSource,
    utm_medium: s.utmMedium,
    utm_campaign: s.utmCampaign,
    attribution: s.attribution ?? null,
    created_at: s.createdAt.toISOString(),
  }
}

function queueItemToJson(q: QueueEnqueue): Record<string, unknown> {
  return {
    tenant_id: q.tenantId,
    submission_id: q.submissionId,
    channel: q.channel,
    payload: q.payload,
  }
}
