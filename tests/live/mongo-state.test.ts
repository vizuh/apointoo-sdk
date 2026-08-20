// tests/live/mongo-state.test.ts — Tier 5 (live, gated).
// Run: LIVE=1 MONGO_URI=mongodb://... npm run test:live
// Skipped entirely without both LIVE=1 and a Mongo URI, so CI never hits it.
import { afterAll, describe, expect, it } from 'vitest'
import { mongoStateStore } from '../../src/adapters/state/mongodb.js'
import { newTenantId } from '../../src/core/ids.js'
import type { BookingAttribution } from '../../src/core/schemas.js'
import type { BookingStateCreate } from '../../src/adapters/state/adapter.js'

const LIVE = process.env.LIVE === '1'
const MONGO_URI = process.env.MONGO_URI
const enabled = LIVE && !!MONGO_URI

const COLLECTION = 'booking_state_livetest'

let client: { close(): Promise<void> } | undefined

describe.skipIf(!enabled)('mongoStateStore — live Mongo smoke', () => {
  afterAll(async () => {
    await client?.close()
  })

  it('creates with attribution, reads it back, transitions, and pings', async () => {
    // Isolate this run's docs under a throwaway tenant.
    const tenantId = newTenantId()
    const store = mongoStateStore({ uri: MONGO_URI!, collection: COLLECTION })

    const attribution: BookingAttribution = {
      gclid: 'CL_live',
      firstTouch: { channel: 'paid_search', gclid: 'CL_live' },
      visitorId: 'visitor-live',
    }
    const create: BookingStateCreate = {
      submissionId: `sub_live_${Date.now()}`,
      tenantId,
      status: 'pending',
      vendor: 'live',
      gclid: 'CL_live',
      fbclid: null,
      msclkid: null,
      rwgToken: null,
      utmSource: null,
      utmMedium: null,
      utmCampaign: null,
      attribution,
      createdAt: new Date(),
    }

    await store.create(create)

    const got = await store.get(create.submissionId)
    expect(got?.tenantId).toBe(tenantId)
    expect(got?.attribution).toEqual(attribution)

    await store.transition(create.submissionId, { status: 'confirmed', vendorAppointmentId: 'appt-live' })
    const confirmed = await store.get(create.submissionId)
    expect(confirmed?.status).toBe('confirmed')
    expect(confirmed?.vendorAppointmentId).toBe('appt-live')

    const health = await store.health()
    expect(health.ok).toBe(true)

    // Read back via a direct driver query to confirm tenantId landed on the doc.
    // Indirect specifier — `mongodb` is an optional dep absent at type-check.
    const moduleName = 'mongodb'
    const { MongoClient } = (await import(moduleName)) as unknown as {
      MongoClient: new (uri: string) => {
        connect(): Promise<unknown>
        db(): { collection(n: string): { findOne(f: Record<string, unknown>): Promise<unknown> } }
        close(): Promise<void>
      }
    }
    const c = new MongoClient(MONGO_URI!)
    await c.connect()
    client = c
    const found = (await c
      .db()
      .collection(COLLECTION)
      .findOne({ submissionId: create.submissionId })) as { tenantId?: string } | null
    expect(found?.tenantId).toBe(tenantId)
  })
})
