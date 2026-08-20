// tests/attribution/read-attribution.test.ts
//
// Covers the cookie reader's mapping, in particular that `_fbc` lands in
// `browserIds.fbc` (Meta's formatted click cookie is an enhanced-match browser
// identifier, NOT a bare `fbclid`), aligning the SDK with the dashboard's
// readBrowserIdentifiers().

import { describe, expect, it } from 'vitest'
import { readAttribution } from '../../src/attribution/index.js'
import { bookingAttributionSchema } from '../../src/core/schemas.js'

describe('readAttribution', () => {
  it('maps _fbc into browserIds.fbc, never fbclid', () => {
    const attr = readAttribution('_fbc=fb.1.1700000000000.IwAR0abc', undefined)
    expect(attr.browserIds?.fbc).toBe('fb.1.1700000000000.IwAR0abc')
    expect(attr.fbclid).toBeUndefined()
  })

  it('reads gclid, msclkid, and the pixel cookies', () => {
    const header =
      '_gcl_aw=GCL.123; _uetmsclkid=ms123; _fbp=fb.1.1.987; _ttp=tt-1; _ga=GA1.2.1234567890.1700000000'
    const attr = readAttribution(header, undefined)
    expect(attr.gclid).toBe('GCL.123')
    expect(attr.msclkid).toBe('ms123')
    expect(attr.browserIds).toEqual({
      fbp: 'fb.1.1.987',
      ttp: 'tt-1',
      ga_client_id: '1234567890.1700000000',
    })
  })

  it('omits browserIds entirely when no pixel cookies are present', () => {
    const attr = readAttribution('_gcl_aw=GCL.123', undefined)
    expect(attr.browserIds).toBeUndefined()
  })

  it('ignores a malformed _ga cookie', () => {
    const attr = readAttribution('_ga=not-a-ga-value', undefined)
    expect(attr.browserIds).toBeUndefined()
  })

  it('lets the wire win while filling browserIds gaps from cookies', () => {
    const attr = readAttribution('_fbc=cookie-fbc; _fbp=cookie-fbp', {
      gclid: 'wire-gclid',
      browserIds: { fbc: 'wire-fbc' },
    })
    expect(attr.gclid).toBe('wire-gclid')
    // wire fbc wins; cookie fbp fills the gap the wire didn't carry
    expect(attr.browserIds).toEqual({ fbc: 'wire-fbc', fbp: 'cookie-fbp' })
  })

  it('accepts and preserves Google braid IDs with the dashboard consent vector', () => {
    const wire = bookingAttributionSchema.parse({
      gbraid: 'gbraid-1',
      wbraid: 'wbraid-1',
      rwgToken: 'rwg-1',
      consentGiven: true,
      capturedAt: '2026-07-15T12:00:00+00:00',
      consent: {
        adStorage: 'granted',
        analyticsStorage: 'denied',
        adUserData: 'granted',
        adPersonalization: 'granted',
        capturedAt: '2026-07-15T12:00:00+00:00',
        source: 'api',
      },
    })

    expect(readAttribution(undefined, wire)).toEqual(wire)
  })

  it('rejects an incomplete consent vector', () => {
    expect(() =>
      bookingAttributionSchema.parse({
        gclid: 'gclid-1',
        consent: { adStorage: 'granted' },
      }),
    ).toThrow()
  })
})
