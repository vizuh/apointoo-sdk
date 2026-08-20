// Tier 1 (unit, pure function) — channel classifier rules.
import { describe, expect, it } from 'vitest'
import { classifyChannel, preferLastTouch } from '../../src/core/attribution-classify.js'
import type { Touch } from '../../src/core/schemas.js'

const empty: Touch = {}

describe('classifyChannel — click IDs (highest priority)', () => {
  it('gclid → paid_search', () => {
    expect(classifyChannel({ gclid: 'CL123' })).toBe('paid_search')
  })
  it('msclkid → paid_search (Microsoft Ads)', () => {
    expect(classifyChannel({ msclkid: 'MS456' })).toBe('paid_search')
  })
  it('wbraid → paid_search (Google iOS app-to-web)', () => {
    expect(classifyChannel({ wbraid: 'WB789' })).toBe('paid_search')
  })
  it('fbclid → paid_social', () => {
    expect(classifyChannel({ fbclid: 'FB123' })).toBe('paid_social')
  })
  it('twclid → paid_social', () => {
    expect(classifyChannel({ twclid: 'TW456' })).toBe('paid_social')
  })
  it('ttclid → paid_social', () => {
    expect(classifyChannel({ ttclid: 'TT789' })).toBe('paid_social')
  })
  it('li_fat_id → paid_social', () => {
    expect(classifyChannel({ li_fat_id: 'LI123' })).toBe('paid_social')
  })
  it('rdt_cid → paid_social', () => {
    expect(classifyChannel({ rdt_cid: 'RD456' })).toBe('paid_social')
  })
  it('dclid → paid_other (Display & Video 360)', () => {
    expect(classifyChannel({ dclid: 'DC789' })).toBe('paid_other')
  })
  it('mc_cid → email (Mailchimp)', () => {
    expect(classifyChannel({ mc_cid: 'MC123' })).toBe('email')
  })
})

describe('classifyChannel — UTM medium', () => {
  it('utm_medium=cpc → paid_search', () => {
    expect(classifyChannel({ utmMedium: 'cpc' })).toBe('paid_search')
  })
  it('utm_medium=ppc → paid_search', () => {
    expect(classifyChannel({ utmMedium: 'ppc' })).toBe('paid_search')
  })
  it('utm_medium=paidsocial → paid_social', () => {
    expect(classifyChannel({ utmMedium: 'paidsocial' })).toBe('paid_social')
  })
  it('utm_medium=paid_social → paid_social', () => {
    expect(classifyChannel({ utmMedium: 'paid_social' })).toBe('paid_social')
  })
  it('utm_medium=affiliate → paid_other', () => {
    expect(classifyChannel({ utmMedium: 'affiliate' })).toBe('paid_other')
  })
  it('utm_medium=email → email', () => {
    expect(classifyChannel({ utmMedium: 'email' })).toBe('email')
  })
  it('utm_medium=referral → referral', () => {
    expect(classifyChannel({ utmMedium: 'referral' })).toBe('referral')
  })
  it('utm_medium=social → organic_social', () => {
    expect(classifyChannel({ utmMedium: 'social' })).toBe('organic_social')
  })
})

describe('classifyChannel — referrer-based (no click ID, no medium)', () => {
  it('google.com referrer → organic_search', () => {
    expect(classifyChannel({ referrer: 'https://www.google.com/search?q=salon' })).toBe(
      'organic_search',
    )
  })
  it('bing.com referrer → organic_search', () => {
    expect(classifyChannel({ referrer: 'https://www.bing.com/search' })).toBe('organic_search')
  })
  it('facebook.com referrer → organic_social', () => {
    expect(classifyChannel({ referrer: 'https://www.facebook.com/page' })).toBe('organic_social')
  })
  it('linkedin.com referrer → organic_social', () => {
    expect(classifyChannel({ referrer: 'https://linkedin.com/feed' })).toBe('organic_social')
  })
  it('tiktok.com referrer → organic_social', () => {
    expect(classifyChannel({ referrer: 'https://tiktok.com/@user' })).toBe('organic_social')
  })
})

describe('classifyChannel — referral / direct / unknown', () => {
  it('any other off-site referrer → referral', () => {
    expect(
      classifyChannel({ referrer: 'https://random-news-site.com', landingPage: 'https://x.com' }),
    ).toBe('referral')
  })
  it('no referrer + no UTM + no click ID → direct', () => {
    expect(classifyChannel(empty)).toBe('direct')
  })
  it('utm_source set but no medium + no referrer → unknown', () => {
    expect(classifyChannel({ utmSource: 'newsletter' })).toBe('unknown')
  })
})

describe('classifyChannel — priority order', () => {
  it('click ID wins over UTM medium', () => {
    // utm_medium=email but gclid present → paid_search wins
    expect(classifyChannel({ gclid: 'CL', utmMedium: 'email' })).toBe('paid_search')
  })
  it('UTM medium wins over referrer', () => {
    // referrer=google but utm_medium=affiliate → paid_other wins
    expect(
      classifyChannel({ utmMedium: 'affiliate', referrer: 'https://google.com' }),
    ).toBe('paid_other')
  })
})

describe('preferLastTouch', () => {
  it('returns lastTouch when both set', () => {
    const ft: Touch = { gclid: 'first' }
    const lt: Touch = { gclid: 'last' }
    expect(preferLastTouch({ firstTouch: ft, lastTouch: lt })).toEqual(lt)
  })
  it('falls back to firstTouch when lastTouch absent', () => {
    const ft: Touch = { gclid: 'first' }
    expect(preferLastTouch({ firstTouch: ft })).toEqual(ft)
  })
  it('returns undefined when neither set', () => {
    expect(preferLastTouch({})).toBeUndefined()
  })
})
