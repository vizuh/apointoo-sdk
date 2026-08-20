import { errMessage, BookingError } from '../../core/errors.js'
// Supabase BookingStateStore — Postgres via supabase-js REST.
// Uses snake_case columns as per Postgres convention; mapping handled here.
//
// Migration SQL (apply once per project, in Supabase SQL editor):
//
//   create table booking_state (
//     submission_id text primary key,
//     tenant_id text not null,
//     status text not null check (status in ('pending','confirmed','cancelled','failed','abandoned')),
//     vendor text not null,
//     vendor_appointment_id text,
//     gclid text, fbclid text, msclkid text, rwg_token text,
//     utm_source text, utm_medium text, utm_campaign text,
//     attribution jsonb,
//     error_code text,
//     retry_count int not null default 0,
//     created_at timestamptz not null default now(),
//     updated_at timestamptz not null default now(),
//     conversion_sent_at timestamptz
//   );
//   create index booking_state_pending_idx on booking_state(status, created_at) where status = 'pending';
//   create index booking_state_for_conversion_idx on booking_state(status, conversion_sent_at)
//     where status = 'confirmed' and conversion_sent_at is null;

import type { BookingAttribution } from '../../core/schemas.js'
import type {
  BookingState,
  BookingStateCreate,
  BookingStateStatus,
  BookingStateStore,
  BookingStateTransition,
} from './adapter.js'
import { hasUploadableClickId } from './selectors.js'

export type SupabaseStateStoreOptions = {
  url: string
  /**
   * Supabase **service-role** key (NOT the anon/publishable key).
   *
   * The kit's state store needs to bypass RLS — service-role does that.
   *
   * ⚠ Important wiring caveat (per Supabase docs): a service-role-key
   * client gets RLS errors if a user session leaks into it. In Next.js
   * SSR especially, NEVER share this client with anything that mounts
   * the user's auth cookie. Create a dedicated server-side instance
   * (e.g. import the kit's `supabaseStateStore(...)` once at module
   * scope and reuse it — do NOT wrap it with `createServerClient`
   * from @supabase/ssr or set Authorization headers per request).
   *
   * Schema: see docs/migrations/001-state-and-queue.sql.
   */
  serviceRoleKey: string
  table?: string
  fetchImpl?: typeof fetch
}

const DEFAULT_TABLE = 'booking_state'

/**
 * BookingStateStore backed by Supabase REST.
 *
 * Wiring: see SupabaseStateStoreOptions JSDoc — the service-role key
 * MUST stay isolated from user-session-bearing clients (RLS gotcha).
 *
 * Migration: docs/migrations/001-state-and-queue.sql.
 */
export function supabaseStateStore(opts: SupabaseStateStoreOptions): BookingStateStore {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const table = opts.table ?? DEFAULT_TABLE
  const baseUrl = `${opts.url.replace(/\/$/, '')}/rest/v1/${table}`
  const headers = (extra: Record<string, string> = {}): Record<string, string> => ({
    apikey: opts.serviceRoleKey,
    Authorization: `Bearer ${opts.serviceRoleKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...extra,
  })

  return {
    async create(input: BookingStateCreate): Promise<void> {
      // Upsert keyed on submission_id so retries land cleanly
      const url = `${baseUrl}?on_conflict=submission_id`
      const body = [
        {
          submission_id: input.submissionId,
          tenant_id: input.tenantId,
          status: 'pending',
          vendor: input.vendor,
          gclid: input.gclid,
          fbclid: input.fbclid,
          msclkid: input.msclkid,
          rwg_token: input.rwgToken,
          utm_source: input.utmSource,
          utm_medium: input.utmMedium,
          utm_campaign: input.utmCampaign,
          attribution: input.attribution ?? null,
          retry_count: 0,
          created_at: input.createdAt.toISOString(),
          updated_at: new Date().toISOString(),
        },
      ]
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: headers({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new BookingError('PERSISTENCE_FAILED', `supabaseStateStore.create: HTTP ${res.status}`)
    },

    async transition(submissionId: string, change: BookingStateTransition): Promise<void> {
      const url = `${baseUrl}?submission_id=eq.${encodeURIComponent(submissionId)}`
      const patch: Record<string, unknown> = {
        status: change.status,
        updated_at: new Date().toISOString(),
      }
      if (change.vendorAppointmentId !== undefined) {
        patch.vendor_appointment_id = change.vendorAppointmentId
      }
      if (change.appointmentStartIso !== undefined) {
        patch.appointment_start_iso = change.appointmentStartIso
      }
      if (change.errorCode !== undefined) {
        patch.error_code = change.errorCode
      }
      const res = await fetchImpl(url, {
        method: 'PATCH',
        headers: headers({ Prefer: 'return=minimal' }),
        body: JSON.stringify(patch),
      })
      if (!res.ok) throw new BookingError('PERSISTENCE_FAILED', `supabaseStateStore.transition: HTTP ${res.status}`)
    },

    async get(submissionId: string): Promise<BookingState | null> {
      const url = `${baseUrl}?submission_id=eq.${encodeURIComponent(submissionId)}&limit=1`
      const res = await fetchImpl(url, { headers: headers() })
      if (!res.ok) throw new BookingError('PERSISTENCE_FAILED', `supabaseStateStore.get: HTTP ${res.status}`)
      const rows = (await res.json()) as unknown[]
      const row = rows[0] as Record<string, unknown> | undefined
      return row ? rowToState(row) : null
    },

    async findStale(olderThanMinutes: number, tenantId?: string): Promise<BookingState[]> {
      const cutoff = new Date(Date.now() - olderThanMinutes * 60_000).toISOString()
      const params = new URLSearchParams()
      params.set('status', 'eq.pending')
      params.set('created_at', `lt.${cutoff}`)
      if (tenantId) params.set('tenant_id', `eq.${tenantId}`)
      const url = `${baseUrl}?${params.toString()}`
      const res = await fetchImpl(url, { headers: headers() })
      if (!res.ok) throw new BookingError('PERSISTENCE_FAILED', `supabaseStateStore.findStale: HTTP ${res.status}`)
      const rows = (await res.json()) as unknown[]
      return rows.map((r) => rowToState(r as Record<string, unknown>))
    },

    async findForConversion(tenantId?: string): Promise<BookingState[]> {
      const params = new URLSearchParams()
      params.set('status', 'eq.confirmed')
      params.set('conversion_sent_at', 'is.null')
      if (tenantId) params.set('tenant_id', `eq.${tenantId}`)
      const url = `${baseUrl}?${params.toString()}`
      const res = await fetchImpl(url, { headers: headers() })
      if (!res.ok) throw new BookingError('PERSISTENCE_FAILED', `supabaseStateStore.findForConversion: HTTP ${res.status}`)
      const rows = (await res.json()) as unknown[]
      return rows
        .map((r) => rowToState(r as Record<string, unknown>))
        .filter(hasUploadableClickId)
    },

    async markConversionSent(submissionId: string, sentAt: Date): Promise<void> {
      const url = `${baseUrl}?submission_id=eq.${encodeURIComponent(submissionId)}`
      const res = await fetchImpl(url, {
        method: 'PATCH',
        headers: headers({ Prefer: 'return=minimal' }),
        body: JSON.stringify({ conversion_sent_at: sentAt.toISOString() }),
      })
      if (!res.ok) throw new BookingError('PERSISTENCE_FAILED', `supabaseStateStore.markConversionSent: HTTP ${res.status}`)
    },

    async countByStatus(tenantId?: string): Promise<Record<BookingStateStatus, number>> {
      // Postgrest doesn't have a clean group-by. Run 4 cheap count queries in parallel.
      const statuses: BookingStateStatus[] = ['pending', 'confirmed', 'cancelled', 'failed', 'abandoned']
      const results = await Promise.all(
        statuses.map(async (s) => {
          const params = new URLSearchParams()
          params.set('status', `eq.${s}`)
          if (tenantId) params.set('tenant_id', `eq.${tenantId}`)
          params.set('select', 'submission_id')
          const url = `${baseUrl}?${params.toString()}`
          const res = await fetchImpl(url, {
            headers: headers({ Prefer: 'count=exact' }),
          })
          if (!res.ok) return [s, 0] as const
          // Postgrest returns Content-Range: 0-N/total
          const range = res.headers.get('content-range') ?? '*/0'
          const total = parseInt(range.split('/')[1] ?? '0', 10)
          return [s, total] as const
        }),
      )
      return Object.fromEntries(results) as Record<BookingStateStatus, number>
    },

    async health() {
      try {
        const res = await fetchImpl(`${baseUrl}?limit=1&select=submission_id`, {
          headers: headers(),
        })
        return res.ok
          ? { ok: true, name: 'supabase-state' }
          : { ok: false, name: 'supabase-state', error: `HTTP ${res.status}` }
      } catch (err) {
        return {
          ok: false,
          name: 'supabase-state',
          error: errMessage(err),
        }
      }
    },
  }
}

function rowToState(row: Record<string, unknown>): BookingState {
  return {
    submissionId: String(row.submission_id),
    tenantId: String(row.tenant_id),
    status: row.status as BookingStateStatus,
    vendor: String(row.vendor),
    vendorAppointmentId: (row.vendor_appointment_id as string | null) ?? null,
    appointmentStartIso: (row.appointment_start_iso as string | null) ?? null,
    gclid: (row.gclid as string | null) ?? null,
    fbclid: (row.fbclid as string | null) ?? null,
    msclkid: (row.msclkid as string | null) ?? null,
    rwgToken: (row.rwg_token as string | null) ?? null,
    utmSource: (row.utm_source as string | null) ?? null,
    utmMedium: (row.utm_medium as string | null) ?? null,
    utmCampaign: (row.utm_campaign as string | null) ?? null,
    ...(row.attribution != null ? { attribution: row.attribution as BookingAttribution } : {}),
    errorCode: (row.error_code as string | null) ?? null,
    retryCount: Number(row.retry_count ?? 0),
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at)),
    conversionSentAt: row.conversion_sent_at ? new Date(String(row.conversion_sent_at)) : null,
  }
}
