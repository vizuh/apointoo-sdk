// bookingToRow — canonical tabular row builder. Slice 1: full attribution is
// persisted as `attribution_json`, sitting immediately before the version
// column (Pattern 16: version stays last in the booking block).

import { describe, expect, it } from 'vitest'

import { BOOKING_ROW_HEADERS, bookingToRow } from '../../src/core/persistence-row.js'
import { APOINTOO_HEADLESS_VERSION } from '../../src/core/version.js'
import type { BookingAttribution, BookingRequest } from '../../src/core/types.js'

const ATTRIBUTION: BookingAttribution = {
  gclid: 'gclid-123',
  firstTouch: {
    channel: 'paid_search',
    gclid: 'gclid-123',
    wbraid: 'wbraid-456',
  },
  browserIds: {
    fbp: 'fb.1.234.567',
    ga_client_id: 'GA1.2.111.222',
  },
  visitorId: 'visitor-789',
}

function makeRequest(attribution: BookingAttribution): BookingRequest {
  return {
    submissionId: 'sub-row-0001',
    projectKey: 'example-studio',
    service: { id: 'srv-1', name: 'Consulta' } as never,
    serviceId: 'srv-1',
    requestedDate: '2026-06-01',
    requestedTime: '14:30',
    name: 'Test Lead',
    phone: '+351900000000',
    email: undefined,
    message: undefined,
    isNewPatient: undefined,
    offerCode: undefined,
    attribution,
    metadata: {
      userAgent: undefined,
      locale: 'pt-PT',
      timezone: 'Europe/Lisbon',
      ip: undefined,
    },
    createdAtIso: '2026-05-28T10:00:00.000Z',
    fingerprint: 'fp-row' as never,
    configSnapshot: {
      timezone: 'Europe/Lisbon',
      locale: 'pt-PT',
      scheduling: {
        availableDays: [1, 2, 3, 4, 5],
        timeSlots: [{ label: '10:00', value: '10:00' }],
        minAdvanceDays: 0,
        maxAdvanceDays: 60,
      } as never,
    },
  }
}

describe('bookingToRow attribution column', () => {
  it('places attribution_json immediately before apointoo_version', () => {
    const attrIdx = BOOKING_ROW_HEADERS.indexOf('attribution_json')
    const versionIdx = BOOKING_ROW_HEADERS.indexOf('apointoo_version')
    expect(attrIdx).toBeGreaterThanOrEqual(0)
    expect(versionIdx).toBe(attrIdx + 1)
    // Version is still the last column of the booking block.
    expect(versionIdx).toBe(BOOKING_ROW_HEADERS.length - 1)
  })

  it('emits a row matching the (now wider) header width', () => {
    const row = bookingToRow({
      eventType: 'booking_request',
      request: makeRequest(ATTRIBUTION),
      confirmation: undefined,
    })
    expect(row.length).toBe(BOOKING_ROW_HEADERS.length)
    // Last column is still the version stamp (Pattern 16).
    expect(row[row.length - 1]).toBe(APOINTOO_HEADLESS_VERSION)
  })

  it('round-trips a populated attribution through the attribution_json cell', () => {
    const row = bookingToRow({
      eventType: 'booking_request',
      request: makeRequest(ATTRIBUTION),
      confirmation: undefined,
    })
    const cell = row[BOOKING_ROW_HEADERS.indexOf('attribution_json')]!
    const parsed = JSON.parse(cell) as BookingAttribution
    expect(parsed.firstTouch?.gclid).toBe('gclid-123')
    expect(parsed.firstTouch?.wbraid).toBe('wbraid-456')
    expect(parsed.browserIds?.fbp).toBe('fb.1.234.567')
    expect(parsed.browserIds?.ga_client_id).toBe('GA1.2.111.222')
    expect(parsed.visitorId).toBe('visitor-789')
  })
})
