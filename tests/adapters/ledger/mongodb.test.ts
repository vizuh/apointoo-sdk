// tests/adapters/ledger/mongodb.test.ts — Tier 1 (unit, mocked collection).
// Structural test: no live Mongo. Asserts insert-only behavior + tenantId
// carriage + index creation, by injecting a fake `db`.
import { describe, expect, it, vi } from 'vitest'
import {
  mongoEventLedger,
  type MongoEventLedgerOptions,
} from '../../../src/adapters/ledger/mongodb.js'
import { BookingError } from '../../../src/core/errors.js'
import type { IdentityEdge, LedgerEvent } from '../../../src/adapters/ledger/adapter.js'

type FakeDb = NonNullable<MongoEventLedgerOptions['db']>

function fakeDb() {
  const collections = new Map<
    string,
    { insertOne: ReturnType<typeof vi.fn>; createIndex: ReturnType<typeof vi.fn> }
  >()
  const get = (name: string) => {
    let col = collections.get(name)
    if (!col) {
      col = {
        insertOne: vi.fn().mockResolvedValue({}),
        createIndex: vi.fn().mockResolvedValue('idx'),
      }
      collections.set(name, col)
    }
    return col
  }
  const command = vi.fn().mockResolvedValue({ ok: 1 })
  const db = {
    collection: (name: string) => get(name),
    command,
  } as unknown as FakeDb
  return { db, command, collection: get }
}

const sampleEvent: LedgerEvent = {
  eventId: 'evt_aaaaaaaaaaaaaaaaaaaaaaaa',
  tenantId: 'ten-1',
  type: 'booking.confirmed',
  subjectKey: 'bk_1',
  occurredAt: new Date('2026-06-01T10:00:00Z'),
  receivedAt: new Date('2026-06-01T10:00:01Z'),
  attribution: null,
  properties: { vendor: 'blvd' },
}

const sampleEdge: IdentityEdge = {
  edgeId: 'edge-1',
  tenantId: 'ten-1',
  fromKey: 'vis_1',
  toKey: 'sub_1',
  kind: 'merge',
  strength: 1,
  createdAt: new Date('2026-06-01T10:00:02Z'),
}

describe('mongoEventLedger', () => {
  it('requires db or uri', () => {
    expect(() => mongoEventLedger({})).toThrow(BookingError)
  })

  it('append inserts the event carrying tenantId (insert-only)', async () => {
    const { db, collection } = fakeDb()
    const ledger = mongoEventLedger({ db })
    await ledger.append(sampleEvent)

    const events = collection('ledger_events')
    expect(events.insertOne).toHaveBeenCalledTimes(1)
    const doc = events.insertOne.mock.calls[0]![0] as Record<string, unknown>
    expect(doc.tenantId).toBe('ten-1')
    expect(doc.eventId).toBe('evt_aaaaaaaaaaaaaaaaaaaaaaaa')
    // No update/delete surface is ever touched — only insertOne exists on the mock.
  })

  it('appendEdge inserts the edge carrying tenantId', async () => {
    const { db, collection } = fakeDb()
    const ledger = mongoEventLedger({ db })
    await ledger.appendEdge(sampleEdge)

    const edges = collection('ledger_edges')
    expect(edges.insertOne).toHaveBeenCalledTimes(1)
    expect((edges.insertOne.mock.calls[0]![0] as Record<string, unknown>).tenantId).toBe('ten-1')
  })

  it('ensures indexes once on first use', async () => {
    const { db, collection } = fakeDb()
    const ledger = mongoEventLedger({ db })
    await ledger.append(sampleEvent)
    await ledger.append(sampleEvent)

    const events = collection('ledger_events')
    const edges = collection('ledger_edges')
    // Two index specs on events, one on edges — created exactly once.
    expect(events.createIndex).toHaveBeenCalledWith({ tenantId: 1, receivedAt: 1 })
    expect(events.createIndex).toHaveBeenCalledWith({ tenantId: 1, subjectKey: 1 })
    expect(edges.createIndex).toHaveBeenCalledWith({ tenantId: 1, fromKey: 1 })
    expect(events.createIndex).toHaveBeenCalledTimes(2)
  })

  it('respects custom collection names', async () => {
    const { db, collection } = fakeDb()
    const ledger = mongoEventLedger({ db, eventsCollection: 'ev', edgesCollection: 'ed' })
    await ledger.append(sampleEvent)
    expect(collection('ev').insertOne).toHaveBeenCalledTimes(1)
  })

  it('wraps insert failures as PERSISTENCE_FAILED', async () => {
    const { db, collection } = fakeDb()
    collection('ledger_events').insertOne.mockRejectedValueOnce(new Error('boom'))
    const ledger = mongoEventLedger({ db })
    await expect(ledger.append(sampleEvent)).rejects.toMatchObject({
      code: 'PERSISTENCE_FAILED',
    })
  })

  it('health pings the db', async () => {
    const { db, command } = fakeDb()
    const ledger = mongoEventLedger({ db })
    expect(await ledger.health()).toEqual({ ok: true, name: 'mongodb' })
    expect(command).toHaveBeenCalledWith({ ping: 1 })
  })
})
