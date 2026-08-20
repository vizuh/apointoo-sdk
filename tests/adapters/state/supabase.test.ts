// supabaseStateStore — Slice 1: the full BookingAttribution is written into
// the `attribution` column on create() and reconstructed on get()/rowToState().
// fetch is stubbed at the network boundary (same style as the BLVD tests).

import { describe, expect, it, vi } from 'vitest'

import { supabaseStateStore } from '../../../src/adapters/state/supabase.js'
import type { BookingStateCreate } from '../../../src/adapters/state/adapter.js'
import type { BookingAttribution } from '../../../src/core/schemas.js'

const ATTRIBUTION: BookingAttribution = {
  gclid: 'gclid-abc',
  firstTouch: { channel: 'paid_search', gclid: 'gclid-abc', wbraid: 'wbraid-1' },
  browserIds: { fbp: 'fb.1.2.3' },
  visitorId: 'visitor-1',
}

function makeCreate(): BookingStateCreate {
  return {
    submissionId: 'sub-sb-0001',
    tenantId: 'example-studio',
    status: 'pending',
    vendor: 'unknown',
    gclid: 'gclid-abc',
    fbclid: null,
    msclkid: null,
    rwgToken: null,
    utmSource: null,
    utmMedium: null,
    utmCampaign: null,
    attribution: ATTRIBUTION,
    createdAt: new Date('2026-05-28T10:00:00.000Z'),
  }
}

function bodyOf(call: unknown): unknown[] {
  const init = (call as readonly [unknown, RequestInit])[1]
  return JSON.parse(init.body as string)
}

describe('supabaseStateStore.create', () => {
  it('includes the full attribution in the insert body', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 201 }))
    const store = supabaseStateStore({
      url: 'https://x.supabase.co',
      serviceRoleKey: 'svc-key',
      fetchImpl: fetchImpl as typeof fetch,
    })

    await store.create(makeCreate())

    expect(fetchImpl).toHaveBeenCalledOnce()
    const row = bodyOf(fetchImpl.mock.calls[0]!)[0] as Record<string, unknown>
    expect(row.attribution).toEqual(ATTRIBUTION)
  })

  it('writes null attribution when none is supplied', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 201 }))
    const store = supabaseStateStore({
      url: 'https://x.supabase.co',
      serviceRoleKey: 'svc-key',
      fetchImpl: fetchImpl as typeof fetch,
    })

    const input = makeCreate()
    delete (input as { attribution?: BookingAttribution }).attribution
    await store.create(input)

    const row = bodyOf(fetchImpl.mock.calls[0]!)[0] as Record<string, unknown>
    expect(row.attribution).toBeNull()
  })
})

describe('supabaseStateStore.get (rowToState)', () => {
  it('reconstructs attribution from the row', async () => {
    const dbRow = {
      submission_id: 'sub-sb-0001',
      tenant_id: 'example-studio',
      status: 'pending',
      vendor: 'unknown',
      gclid: 'gclid-abc',
      attribution: ATTRIBUTION,
      retry_count: 0,
      created_at: '2026-05-28T10:00:00.000Z',
      updated_at: '2026-05-28T10:00:00.000Z',
    }
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify([dbRow]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    )
    const store = supabaseStateStore({
      url: 'https://x.supabase.co',
      serviceRoleKey: 'svc-key',
      fetchImpl: fetchImpl as typeof fetch,
    })

    const state = await store.get('sub-sb-0001')
    expect(state?.attribution).toEqual(ATTRIBUTION)
  })

  it('omits attribution when the row has none (exactOptionalPropertyTypes)', async () => {
    const dbRow = {
      submission_id: 'sub-sb-0002',
      tenant_id: 'example-studio',
      status: 'pending',
      vendor: 'unknown',
      attribution: null,
      retry_count: 0,
      created_at: '2026-05-28T10:00:00.000Z',
      updated_at: '2026-05-28T10:00:00.000Z',
    }
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify([dbRow]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    )
    const store = supabaseStateStore({
      url: 'https://x.supabase.co',
      serviceRoleKey: 'svc-key',
      fetchImpl: fetchImpl as typeof fetch,
    })

    const state = await store.get('sub-sb-0002')
    expect(state).not.toBeNull()
    expect('attribution' in state!).toBe(false)
  })
})
