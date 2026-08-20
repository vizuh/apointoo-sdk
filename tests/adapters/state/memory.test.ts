// memoryStateStore — Slice 1: create() spreads the input, so the full
// BookingAttribution survives the round-trip through get().

import { describe, expect, it } from 'vitest'

import { memoryStateStore } from '../../../src/adapters/state/memory.js'
import type { BookingStateCreate } from '../../../src/adapters/state/adapter.js'
import type { BookingAttribution } from '../../../src/core/schemas.js'

const ATTRIBUTION: BookingAttribution = {
  gclid: 'gclid-mem',
  firstTouch: { channel: 'paid_search', gclid: 'gclid-mem', wbraid: 'wbraid-m' },
  browserIds: { fbp: 'fb.9.9.9' },
  visitorId: 'visitor-mem',
}

function makeCreate(): BookingStateCreate {
  return {
    submissionId: 'sub-mem-0001',
    tenantId: 'example-studio',
    status: 'pending',
    vendor: 'unknown',
    gclid: 'gclid-mem',
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

describe('memoryStateStore attribution', () => {
  it('preserves the full attribution from create() through get()', async () => {
    const store = memoryStateStore()
    await store.create(makeCreate())
    const state = await store.get('sub-mem-0001')
    expect(state?.attribution).toEqual(ATTRIBUTION)
  })
})
