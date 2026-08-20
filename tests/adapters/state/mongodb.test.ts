// mongoStateStore — Slice 1: the full BookingAttribution is written into the
// `attribution` field on create() and reconstructed on get()/docToState().
// The Mongo collection is mocked at the driver boundary (an injected `db`),
// mirroring the supabaseStateStore test's fetch stub.

import { describe, expect, it, vi } from 'vitest'

import { mongoStateStore } from '../../../src/adapters/state/mongodb.js'
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
    submissionId: 'sub-mongo-0001',
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

type Call = unknown[]

/**
 * Minimal in-memory collection double. Captures every call and serves findOne()
 * from a seeded doc map so get()/docToState() can be exercised end-to-end.
 */
function makeDb(seed: Record<string, Record<string, unknown>> = {}) {
  const docs = new Map(Object.entries(seed))
  const updateOne = vi.fn(async () => ({ acknowledged: true }))
  const createIndex = vi.fn(async () => 'idx')
  const countDocuments = vi.fn(async () => 0)
  const findOne = vi.fn(async (filter: Record<string, unknown>) => {
    const id = filter.submissionId as string
    return docs.get(id) ?? null
  })
  const find = vi.fn((filter: Record<string, unknown>) => ({
    toArray: async () =>
      [...docs.values()].filter((d) => {
        if (filter.status !== undefined && d.status !== filter.status) return false
        if (filter.tenantId !== undefined && d.tenantId !== filter.tenantId) return false
        return true
      }),
  }))
  const collection = vi.fn(() => ({
    findOne,
    find,
    updateOne,
    countDocuments,
    createIndex,
  }))
  const command = vi.fn(async () => ({ ok: 1 }))
  return {
    db: { collection, command },
    spies: { updateOne, createIndex, countDocuments, findOne, find, collection },
  }
}

function setArg(call: Call): Record<string, unknown> {
  // updateOne(filter, update, options) — pull $set off the update doc.
  const update = call[1] as { $set?: Record<string, unknown> }
  return update.$set ?? {}
}
function filterArg(call: Call): Record<string, unknown> {
  return call[0] as Record<string, unknown>
}

describe('mongoStateStore.create', () => {
  it('writes tenantId + the full attribution and ensures the unique index', async () => {
    const { db, spies } = makeDb()
    const store = mongoStateStore({ db })

    await store.create(makeCreate())

    expect(spies.updateOne).toHaveBeenCalledOnce()
    const call = spies.updateOne.mock.calls[0] as Call
    // Upsert keyed on the globally-unique submissionId (matching Supabase's PK).
    expect(filterArg(call)).toEqual({ submissionId: 'sub-mongo-0001' })
    expect(setArg(call).attribution).toEqual(ATTRIBUTION)

    // unique {submissionId} index is ensured lazily on first use.
    expect(spies.createIndex).toHaveBeenCalledWith({ submissionId: 1 }, { unique: true })
  })

  it('writes null attribution when none is supplied', async () => {
    const { db, spies } = makeDb()
    const store = mongoStateStore({ db })

    const input = makeCreate()
    delete (input as { attribution?: BookingAttribution }).attribution
    await store.create(input)

    const call = spies.updateOne.mock.calls[0] as Call
    expect(setArg(call).attribution).toBeNull()
  })

  it('is idempotent: upserts keyed on {tenantId, submissionId} and bumps retryCount', async () => {
    const { db, spies } = makeDb()
    const store = mongoStateStore({ db })

    await store.create(makeCreate())

    const call = spies.updateOne.mock.calls[0] as Call
    const options = call[2] as Record<string, unknown>
    const update = call[1] as { $inc?: Record<string, unknown>; $setOnInsert?: Record<string, unknown> }
    expect(options.upsert).toBe(true)
    expect(update.$inc).toEqual({ retryCount: 1 })
    // createdAt only set on insert, never overwritten on the idempotent re-drive.
    expect(update.$setOnInsert?.createdAt).toEqual(new Date('2026-05-28T10:00:00.000Z'))
  })
})

describe('mongoStateStore.get (docToState)', () => {
  it('reconstructs attribution from the doc', async () => {
    const { db } = makeDb({
      'sub-mongo-0001': {
        submissionId: 'sub-mongo-0001',
        tenantId: 'example-studio',
        status: 'pending',
        vendor: 'unknown',
        gclid: 'gclid-abc',
        attribution: ATTRIBUTION,
        retryCount: 0,
        createdAt: '2026-05-28T10:00:00.000Z',
        updatedAt: '2026-05-28T10:00:00.000Z',
      },
    })
    const store = mongoStateStore({ db })

    const state = await store.get('sub-mongo-0001')
    expect(state?.tenantId).toBe('example-studio')
    expect(state?.attribution).toEqual(ATTRIBUTION)
  })

  it('omits attribution when the doc has none (exactOptionalPropertyTypes)', async () => {
    const { db } = makeDb({
      'sub-mongo-0002': {
        submissionId: 'sub-mongo-0002',
        tenantId: 'example-studio',
        status: 'pending',
        vendor: 'unknown',
        attribution: null,
        retryCount: 0,
        createdAt: '2026-05-28T10:00:00.000Z',
        updatedAt: '2026-05-28T10:00:00.000Z',
      },
    })
    const store = mongoStateStore({ db })

    const state = await store.get('sub-mongo-0002')
    expect(state).not.toBeNull()
    expect('attribution' in state!).toBe(false)
  })

  it('returns null when the doc is absent', async () => {
    const { db } = makeDb()
    const store = mongoStateStore({ db })
    expect(await store.get('missing')).toBeNull()
  })
})

describe('mongoStateStore.transition', () => {
  it('sets status + updatedAt and only the provided transition fields', async () => {
    const { db, spies } = makeDb()
    const store = mongoStateStore({ db })

    await store.transition('sub-mongo-0001', {
      status: 'confirmed',
      vendorAppointmentId: 'appt-1',
    })

    const call = spies.updateOne.mock.calls[0] as Call
    expect(filterArg(call)).toEqual({ submissionId: 'sub-mongo-0001' })
    const set = setArg(call)
    expect(set.status).toBe('confirmed')
    expect(set.vendorAppointmentId).toBe('appt-1')
    expect(set.updatedAt).toBeInstanceOf(Date)
    // errorCode was not supplied — must not be written.
    expect('errorCode' in set).toBe(false)
    expect('appointmentStartIso' in set).toBe(false)
  })
})

describe('mongoStateStore.findForConversion', () => {
  it('tenant-filters and keeps only rows with a click id', async () => {
    const { db } = makeDb({
      a: {
        submissionId: 'a',
        tenantId: 'example-studio',
        status: 'confirmed',
        vendor: 'unknown',
        gclid: 'g1',
        conversionSentAt: null,
        retryCount: 0,
        createdAt: '2026-05-28T10:00:00.000Z',
        updatedAt: '2026-05-28T10:00:00.000Z',
      },
      b: {
        submissionId: 'b',
        tenantId: 'example-studio',
        status: 'confirmed',
        vendor: 'unknown',
        gclid: null,
        fbclid: null,
        msclkid: null,
        conversionSentAt: null,
        retryCount: 0,
        createdAt: '2026-05-28T10:00:00.000Z',
        updatedAt: '2026-05-28T10:00:00.000Z',
      },
    })
    const store = mongoStateStore({ db })

    const rows = await store.findForConversion('example-studio')
    expect(rows.map((r) => r.submissionId)).toEqual(['a'])
  })

  it('keeps an iOS-path row whose only click id is gbraid/wbraid in attribution', async () => {
    const { db } = makeDb({
      gb: {
        submissionId: 'gb',
        tenantId: 'example-studio',
        status: 'confirmed',
        vendor: 'unknown',
        gclid: null,
        fbclid: null,
        msclkid: null,
        attribution: { gbraid: 'gb1' },
        conversionSentAt: null,
        retryCount: 0,
        createdAt: '2026-05-28T10:00:00.000Z',
        updatedAt: '2026-05-28T10:00:00.000Z',
      },
      wb: {
        submissionId: 'wb',
        tenantId: 'example-studio',
        status: 'confirmed',
        vendor: 'unknown',
        gclid: null,
        fbclid: null,
        msclkid: null,
        attribution: { wbraid: 'wb1' },
        conversionSentAt: null,
        retryCount: 0,
        createdAt: '2026-05-28T10:00:00.000Z',
        updatedAt: '2026-05-28T10:00:00.000Z',
      },
      none: {
        submissionId: 'none',
        tenantId: 'example-studio',
        status: 'confirmed',
        vendor: 'unknown',
        gclid: null,
        fbclid: null,
        msclkid: null,
        attribution: { utmSource: 'google' },
        conversionSentAt: null,
        retryCount: 0,
        createdAt: '2026-05-28T10:00:00.000Z',
        updatedAt: '2026-05-28T10:00:00.000Z',
      },
    })
    const store = mongoStateStore({ db })

    const rows = await store.findForConversion('example-studio')
    expect(rows.map((r) => r.submissionId).sort()).toEqual(['gb', 'wb'])
  })
})
