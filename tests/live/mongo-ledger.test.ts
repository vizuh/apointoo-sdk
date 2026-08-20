// tests/live/mongo-ledger.test.ts — Tier 5 (live, gated).
// Run: LIVE=1 MONGO_URI=mongodb://... npm run test:live
// Skipped entirely without both LIVE=1 and a Mongo URI, so CI never hits it.
import { afterAll, describe, expect, it } from 'vitest'
import { mongoEventLedger } from '../../src/adapters/ledger/mongodb.js'
import { newEventId, newTenantId } from '../../src/core/ids.js'
import type { LedgerEvent } from '../../src/adapters/ledger/adapter.js'

const LIVE = process.env.LIVE === '1'
const MONGO_URI = process.env.MONGO_URI
const enabled = LIVE && !!MONGO_URI

let client: { close(): Promise<void> } | undefined

describe.skipIf(!enabled)('mongoEventLedger — live Mongo smoke', () => {
  afterAll(async () => {
    await client?.close()
  })

  it('connects, appends, and pings', async () => {
    // Isolate this run's docs under a throwaway tenant.
    const tenantId = newTenantId()
    const ledger = mongoEventLedger({
      uri: MONGO_URI!,
      eventsCollection: 'ledger_events_livetest',
      edgesCollection: 'ledger_edges_livetest',
    })

    const event: LedgerEvent = {
      eventId: newEventId(),
      tenantId,
      type: 'booking.confirmed',
      subjectKey: 'bk_live_smoke',
      occurredAt: new Date(),
      receivedAt: new Date(),
      attribution: { gclid: 'CL_live' },
      properties: { vendor: 'live' },
    }

    await ledger.append(event)
    const health = await ledger.health()
    expect(health.ok).toBe(true)

    // Read back via a direct driver query to confirm the insert landed.
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
      .collection('ledger_events_livetest')
      .findOne({ eventId: event.eventId })) as { tenantId?: string } | null
    expect(found?.tenantId).toBe(tenantId)
  })
})
