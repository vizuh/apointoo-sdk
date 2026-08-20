// Attribution — server-side cookie reader + client-side helpers.
// Cookie naming follows the old kit (`_gcl_aw` for gclid) and the ad-platform
// pixels: Meta writes `_fbc`/`_fbp`, TikTok `_ttp`, GA4 `_ga`, Microsoft
// `_uetmsclkid`. Click IDs (gclid/fbclid/msclkid) come off the wire; the pixel
// cookies map into `browserIds` for Conversions API enhanced match.

import type { BookingAttribution } from '../core/types.js'

export const COOKIE_NAMES = {
  gclid: '_gcl_aw',
  msclkid: '_uetmsclkid',
  // Browser identifiers (NOT click IDs). `_fbc` is Meta's *formatted* click
  // cookie (`fb.1.<ts>.<fbclid>`), not a bare `fbclid` — it belongs in
  // `browserIds.fbc`, matching the dashboard's readBrowserIdentifiers().
  fbc: '_fbc',
  fbp: '_fbp',
  ttp: '_ttp',
  ga: '_ga',
} as const

/**
 * Parse a Cookie header into a flat record. Empty record on missing/empty header.
 * Robust to weird whitespace; doesn't decode values (callers typically don't need it).
 */
export function parseCookieHeader(header: string | null | undefined): Record<string, string> {
  if (!header) return {}
  const out: Record<string, string> = {}
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const name = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (name) out[name] = value
  }
  return out
}

/**
 * Read attribution from cookies + a wire-supplied tracking object.
 * Wire tracking takes precedence — the client may have a fresher gclid in
 * sessionStorage that the cookie hasn't picked up yet.
 */
export function readAttribution(
  cookieHeader: string | null | undefined,
  wireTracking: BookingAttribution | undefined,
): BookingAttribution {
  const cookies = parseCookieHeader(cookieHeader)
  const fromCookies: BookingAttribution = {}
  const gclid = cookies[COOKIE_NAMES.gclid]
  const msclkid = cookies[COOKIE_NAMES.msclkid]
  if (gclid) fromCookies.gclid = gclid
  if (msclkid) fromCookies.msclkid = msclkid

  // Pixel cookies → browserIds (enhanced match), not click IDs.
  const browserIds: NonNullable<BookingAttribution['browserIds']> = {}
  const fbc = cookies[COOKIE_NAMES.fbc]
  const fbp = cookies[COOKIE_NAMES.fbp]
  const ttp = cookies[COOKIE_NAMES.ttp]
  if (fbc) browserIds.fbc = fbc
  if (fbp) browserIds.fbp = fbp
  if (ttp) browserIds.ttp = ttp
  // GA client ID lives in `_ga` as `GA1.2.<random>.<ts>`; pull the random part.
  const ga = cookies[COOKIE_NAMES.ga]
  if (ga) {
    const match = ga.match(/^GA\d\.\d\.(\d+\.\d+)$/)
    if (match && match[1]) browserIds.ga_client_id = match[1]
  }
  if (Object.keys(browserIds).length > 0) fromCookies.browserIds = browserIds

  // Wire wins where present. browserIds is merged field-by-field so a cookie
  // value fills any slot the wire didn't carry, rather than being clobbered by
  // a shallow spread.
  const merged: BookingAttribution = { ...fromCookies, ...(wireTracking ?? {}) }
  if (fromCookies.browserIds || wireTracking?.browserIds) {
    merged.browserIds = {
      ...fromCookies.browserIds,
      ...(wireTracking?.browserIds ?? {}),
    }
  }
  return merged
}
