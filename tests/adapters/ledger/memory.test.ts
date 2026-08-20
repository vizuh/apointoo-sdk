// tests/adapters/ledger/memory.test.ts — Tier 1 (unit).
import { describe, expect, it } from 'vitest'
import { memoryEventLedger } from '../../../src/adapters/ledger/memory.js'
import type { IdentityEdge, LedgerEvent } from '../../../src/adapters/ledger/adapter.js'

const sampleEvent: LedgerEvent = {
  eventId: 'evt_aaaaaaaaaaaaaaaaaaaaaaaa',
  tenantId: 'ten-1',
  type: 'booking.confirmed',
  subjectKey: 'bk_20260601_deadbeef',
  occurredAt: new Date('2026-06-01T10:00:00Z'),
  receivedAt: new Date('2026-06-01T10:00:01Z'),
  attribution: { gclid: 'CL123' },
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

describe('memoryEventLedger', () => {
  it('appends events and reads them back', async () => {
    const ledger = memoryEventLedger()
    await ledger.append(sampleEvent)
    expect(ledger.events()).toEqual([sampleEvent])
  })

  it('appends edges and reads them back', async () => {
    const ledger = memoryEventLedger()
    await ledger.appendEdge(sampleEdge)
    expect(ledger.edges()).toEqual([sampleEdge])
  })

  it('is append-only: read-back is a copy, not the live array', async () => {
    const ledger = memoryEventLedger()
    await ledger.append(sampleEvent)
    const snapshot = ledger.events() as LedgerEvent[]
    snapshot.push(sampleEvent)
    expect(ledger.events()).toHaveLength(1)
  })

  it('reports healthy', async () => {
    expect(await memoryEventLedger().health()).toEqual({ ok: true, name: 'memory' })
  })
})
