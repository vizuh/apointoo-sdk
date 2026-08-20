// Tier 1 (unit, pure helpers) — channelDisplayName + sourceShortLabel.
import { describe, expect, it } from 'vitest'
import {
  channelDisplayName,
  sourceShortLabel,
} from '../../src/core/attribution-classify.js'
import type { Touch } from '../../src/core/schemas.js'

describe('channelDisplayName', () => {
  it('maps each enum value to a stable label', () => {
    expect(channelDisplayName('paid_search')).toMatch(/Paid Search/)
    expect(channelDisplayName('paid_social')).toBe('Paid Social')
    expect(channelDisplayName('paid_other')).toMatch(/Paid Other/)
    expect(channelDisplayName('organic_search')).toBe('Organic Search')
    expect(channelDisplayName('organic_social')).toBe('Organic Social')
    expect(channelDisplayName('email')).toBe('Email')
    expect(channelDisplayName('referral')).toBe('Referral')
    expect(channelDisplayName('direct')).toBe('Direct')
    expect(channelDisplayName('unknown')).toBe('Unknown')
  })

  it('uses fallback when channel is undefined', () => {
    expect(channelDisplayName(undefined)).toBe('Unknown')
    expect(channelDisplayName(undefined, 'Custom')).toBe('Custom')
  })
})

describe('sourceShortLabel', () => {
  it('returns "Direct" when touch is empty', () => {
    expect(sourceShortLabel({})).toBe('Direct')
    expect(sourceShortLabel(undefined)).toBe('Direct')
  })

  it('Google Ads on gclid/wbraid/gbraid', () => {
    expect(sourceShortLabel({ gclid: 'CL' } as Touch)).toBe('Google Ads')
    expect(sourceShortLabel({ wbraid: 'WB' } as Touch)).toBe('Google Ads')
    expect(sourceShortLabel({ gbraid: 'GB' } as Touch)).toBe('Google Ads')
  })

  it('platform-specific labels', () => {
    expect(sourceShortLabel({ fbclid: 'FB' } as Touch)).toBe('Meta Ads')
    expect(sourceShortLabel({ msclkid: 'MS' } as Touch)).toBe('Microsoft Ads')
    expect(sourceShortLabel({ ttclid: 'TT' } as Touch)).toBe('TikTok Ads')
    expect(sourceShortLabel({ twclid: 'TW' } as Touch)).toBe('X Ads')
    expect(sourceShortLabel({ li_fat_id: 'LI' } as Touch)).toBe('LinkedIn Ads')
    expect(sourceShortLabel({ rdt_cid: 'RD' } as Touch)).toBe('Reddit Ads')
    expect(sourceShortLabel({ mc_cid: 'MC' } as Touch)).toBe('Mailchimp')
  })

  it('falls back to utm_source when no click ID', () => {
    expect(sourceShortLabel({ utmSource: 'newsletter' } as Touch)).toBe('newsletter')
  })

  it('extracts hostname from referrer when no UTM/click ID', () => {
    expect(
      sourceShortLabel({ referrer: 'https://www.example.com/page' } as Touch),
    ).toBe('example.com')
  })

  it('click ID wins over utm_source', () => {
    expect(
      sourceShortLabel({ gclid: 'CL', utmSource: 'newsletter' } as Touch),
    ).toBe('Google Ads')
  })
})
