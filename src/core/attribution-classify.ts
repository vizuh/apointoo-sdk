// Channel classification — pure function that takes a touch and returns the
// channel taxonomy it belongs to. Rules are shared by browser and server
// attribution surfaces.
//
// Why pure: testable in isolation, deterministic, no IO. Used by both client
// (when populating tracking) and server (when normalizing input from old kits).

import type { BookingChannel, Touch } from './schemas.js'

const SEARCH_DOMAINS: ReadonlyArray<{ source: string; match: ReadonlyArray<string> }> = [
  { source: 'google', match: ['google.', 'google'] },
  { source: 'bing', match: ['bing.com'] },
  { source: 'yahoo', match: ['yahoo.', 'yahoo'] },
  { source: 'duckduckgo', match: ['duckduckgo.com'] },
  { source: 'ecosia', match: ['ecosia.org'] },
  { source: 'yandex', match: ['yandex.', 'yandex'] },
  { source: 'baidu', match: ['baidu.com'] },
]

const SOCIAL_DOMAINS: ReadonlyArray<{ source: string; match: ReadonlyArray<string> }> = [
  { source: 'facebook', match: ['facebook.com', 'fb.com', 'm.facebook.com'] },
  { source: 'instagram', match: ['instagram.com', 'l.instagram.com'] },
  { source: 'linkedin', match: ['linkedin.com', 'lnkd.in'] },
  { source: 'twitter', match: ['twitter.com', 't.co', 'x.com'] },
  { source: 'reddit', match: ['reddit.com', 'redd.it'] },
  { source: 'pinterest', match: ['pinterest.com', 'pin.it'] },
  { source: 'tiktok', match: ['tiktok.com'] },
  { source: 'youtube', match: ['youtube.com', 'youtu.be'] },
  { source: 'snapchat', match: ['snapchat.com'] },
  { source: 'whatsapp', match: ['whatsapp.com', 'wa.me'] },
  { source: 'threads', match: ['threads.net'] },
]

const PAID_MEDIUMS = new Set([
  'cpc',
  'ppc',
  'paid',
  'paidsearch',
  'paid_search',
  'paid-search',
  'display',
  'banner',
  'cpm',
  'retargeting',
])

const PAID_SOCIAL_MEDIUMS = new Set([
  'paidsocial',
  'paid_social',
  'paid-social',
  'social_paid',
  'social-paid',
])

const PAID_OTHER_MEDIUMS = new Set([
  'affiliate',
  'sponsored',
  'partnership',
  'native',
  'programmatic',
])

const EMAIL_MEDIUMS = new Set(['email', 'newsletter', 'e-mail', 'mailchimp', 'mail'])

/**
 * Classify a touch into a channel using these rules (in priority order):
 *
 * 1. Click IDs explicitly say paid_*: gclid → paid_search; fbclid/twclid/ttclid/etc → paid_social;
 *    dclid → paid_other; mc_cid/mc_eid → email
 * 2. utm_medium says paid_*: cpc/ppc/paidsocial/affiliate/sponsored
 * 3. Referrer matches a search engine + no click ID → organic_search
 * 4. Referrer matches a social platform + no click ID → organic_social
 * 5. utm_medium=email or referrer-host indicates webmail → email
 * 6. Has referrer (off-site) + no above match → referral
 * 7. No referrer + no UTM + no click ID → direct
 * 8. Otherwise → unknown
 *
 * Pure. No IO. Deterministic.
 */
export function classifyChannel(touch: Touch): BookingChannel {
  // 1. Click IDs — strongest signal
  if (touch.gclid || touch.wbraid || touch.gbraid) return 'paid_search'
  if (
    touch.fbclid ||
    touch.twclid ||
    touch.ttclid ||
    touch.li_fat_id ||
    touch.sccid ||
    touch.snap_cid ||
    touch.epik ||
    touch.pin_cid ||
    touch.rdt_cid
  ) {
    return 'paid_social'
  }
  if (touch.msclkid) return 'paid_search' // Microsoft
  if (touch.dclid) return 'paid_other'
  if (touch.mc_cid || touch.mc_eid) return 'email'

  // 2. UTM medium classification
  const medium = (touch.utmMedium ?? '').toLowerCase().trim()
  if (medium) {
    if (PAID_MEDIUMS.has(medium)) return 'paid_search'
    if (PAID_SOCIAL_MEDIUMS.has(medium)) return 'paid_social'
    if (PAID_OTHER_MEDIUMS.has(medium)) return 'paid_other'
    if (EMAIL_MEDIUMS.has(medium)) return 'email'
    if (medium === 'organic') {
      // 'organic' alone needs referrer to disambiguate search vs social
      const fromReferrer = matchesReferrer(touch.referrer)
      if (fromReferrer === 'search') return 'organic_search'
      if (fromReferrer === 'social') return 'organic_social'
      return 'referral'
    }
    if (medium === 'social') {
      return 'organic_social' // assume non-paid if just 'social'
    }
    if (medium === 'referral') return 'referral'
  }

  // 3-4. Referrer-based classification (no click ID, no medium hint)
  const refKind = matchesReferrer(touch.referrer)
  if (refKind === 'search') return 'organic_search'
  if (refKind === 'social') return 'organic_social'

  // 6. Off-site referrer that isn't search/social
  if (touch.referrer && !isSelfReferrer(touch.referrer, touch.landingPage)) {
    return 'referral'
  }

  // 7. No referrer + no UTM + no click ID
  if (!touch.referrer && !touch.utmSource && !touch.utmMedium) {
    return 'direct'
  }

  // 8. Fallback
  return 'unknown'
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function matchesReferrer(referrer: string | undefined): 'search' | 'social' | null {
  if (!referrer) return null
  const lower = referrer.toLowerCase()
  for (const rule of SEARCH_DOMAINS) {
    for (const m of rule.match) {
      if (lower.includes(m)) return 'search'
    }
  }
  for (const rule of SOCIAL_DOMAINS) {
    for (const m of rule.match) {
      if (lower.includes(m)) return 'social'
    }
  }
  return null
}

function isSelfReferrer(referrer: string | undefined, landingPage: string | undefined): boolean {
  if (!referrer || !landingPage) return false
  try {
    const refHost = new URL(referrer).hostname.replace(/^www\./, '')
    const landingHost = new URL(landingPage).hostname.replace(/^www\./, '')
    return refHost === landingHost
  } catch {
    return false
  }
}

/**
 * Convenience: pick the best touch (last-touch preferred, fall back to first-touch).
 * Mirrors ClickTrail's `lt_` over `ft_` preference. Returns undefined if neither set.
 */
export function preferLastTouch(
  attribution: { firstTouch?: Touch; lastTouch?: Touch },
): Touch | undefined {
  return attribution.lastTouch ?? attribution.firstTouch
}

/**
 * Human-readable label for a channel. For dashboards + operator emails.
 * Stable strings — UI can localize via lookup table downstream.
 */
export function channelDisplayName(
  channel: BookingChannel | undefined,
  fallback = 'Unknown',
): string {
  switch (channel) {
    case 'paid_search':
      return 'Paid Search (Google/Bing)'
    case 'paid_social':
      return 'Paid Social'
    case 'paid_other':
      return 'Paid Other (Display/Affiliate)'
    case 'organic_search':
      return 'Organic Search'
    case 'organic_social':
      return 'Organic Social'
    case 'email':
      return 'Email'
    case 'referral':
      return 'Referral'
    case 'direct':
      return 'Direct'
    case 'unknown':
      return 'Unknown'
    default:
      return fallback
  }
}

/**
 * Compact source label — derived from a touch. Examples:
 *   gclid present     → 'Google Ads'
 *   fbclid present    → 'Meta Ads'
 *   utm_source set    → that utm_source value
 *   referrer set      → hostname
 *   else              → 'Direct'
 *
 * Used by admin dashboards for the "Source" column.
 */
export function sourceShortLabel(touch: Touch | undefined): string {
  if (!touch) return 'Direct'
  if (touch.gclid || touch.wbraid || touch.gbraid) return 'Google Ads'
  if (touch.msclkid) return 'Microsoft Ads'
  if (touch.fbclid) return 'Meta Ads'
  if (touch.ttclid) return 'TikTok Ads'
  if (touch.twclid) return 'X Ads'
  if (touch.li_fat_id) return 'LinkedIn Ads'
  if (touch.dclid) return 'DV360'
  if (touch.sccid || touch.snap_cid) return 'Snapchat Ads'
  if (touch.epik || touch.pin_cid) return 'Pinterest Ads'
  if (touch.rdt_cid) return 'Reddit Ads'
  if (touch.mc_cid || touch.mc_eid) return 'Mailchimp'
  if (touch.utmSource) return touch.utmSource
  if (touch.referrer) {
    try {
      return new URL(touch.referrer).hostname.replace(/^www\./, '')
    } catch {
      return touch.referrer.slice(0, 32)
    }
  }
  return 'Direct'
}
