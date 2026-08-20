# Attribution model

This document defines what attribution data is tracked, why it is needed, and where it lives.

## Click IDs (per-platform)

Each ad platform mints a unique identifier on click. The kit captures it client-side, persists in `BookingState`, and offline-uploads later for conversion attribution.

| Field | Platform | Why we track it |
|---|---|---|
| `gclid` | Google Ads | Required for offline conversions upload. ~90 day attribution window. |
| `wbraid` | Google Ads (iOS app-to-web, post-IDFA) | Privacy-safe iOS click ID; required when no GAID. |
| `gbraid` | Google Ads (iOS web-to-app) | Same family as wbraid, opposite direction. |
| `dclid` | Display & Video 360 | Google's premium display network click ID. |
| `fbclid` | Meta (Facebook + Instagram) | Conversions API. Combined with `_fbc` cookie for enhanced match. |
| `msclkid` | Microsoft Ads (Bing) | Bing's offline conversions API. |
| `ttclid` | TikTok Ads | TikTok Events API. |
| `twclid` | Twitter / X Ads | X Conversions API. |
| `li_fat_id` | LinkedIn Ads | LinkedIn Conversions API. |
| `sccid`, `snap_cid` | Snapchat Ads | Snap Pixel + Conversions API. Both names appear in the wild. |
| `epik`, `pin_cid` | Pinterest Ads | Two variants of Pinterest's click ID. Both stored. |
| `rdt_cid` | Reddit Ads | Reddit Conversions API. |
| `mc_cid` | Mailchimp campaign | Email-channel attribution. |
| `mc_eid` | Mailchimp recipient | Per-user email tracking. |

## Browser identifiers

Set by ad-platform pixels. Required for **enhanced match** in Conversions APIs (Meta especially). Stored in `attribution.browserIds`.

| Field | Platform | Source |
|---|---|---|
| `fbc` | Meta | `_fbc` cookie set by Meta Pixel on click |
| `fbp` | Meta | `_fbp` cookie set by Meta Pixel on first visit |
| `ttp` | TikTok | `_ttp` cookie |
| `ga_client_id` | Google Analytics 4 | `_ga` cookie parse |
| `ga_session_id` | GA4 | `_ga_<MEASUREMENT_ID>` cookie parse |
| `ga_session_number` | GA4 | Same |

## UTM (extended GA4)

Beyond classic 5, GA4 tracks 4 more.

| Field | Source | Why |
|---|---|---|
| `utmSource` | URL `utm_source` | Acquisition channel name |
| `utmMedium` | URL `utm_medium` | cpc, organic, email, social, etc. |
| `utmCampaign` | URL `utm_campaign` | Campaign name |
| `utmTerm` | URL `utm_term` | Paid search keyword |
| `utmContent` | URL `utm_content` | Ad creative variant |
| `utmId` | URL `utm_id` | Campaign ID for cross-platform reporting |
| `utmSourcePlatform` | URL `utm_source_platform` | Manager platform (Google Ads, DV360) |
| `utmCreativeFormat` | URL `utm_creative_format` | Format (video, image, carousel) |
| `utmMarketingTactic` | URL `utm_marketing_tactic` | Strategy (awareness, conversion) |

## First touch vs last touch

Per ClickTrail, two touches stored per booking:

- **First touch (`firstTouch`)** — the OG attribution. Set on the visitor's *first ever* arrival. Survives across sessions (cookie-persisted).
- **Last touch (`lastTouch`)** — the click that triggered THIS booking. Refreshed on every visit with new attribution.

The flat top-level fields (`gclid`, `fbclid`, etc.) mirror `lastTouch.*` for back-compat with v0.5.0 consumers.

For **conversion uploads back to ad platforms**, the convention is: prefer last-touch (each platform wants to claim the conversion that just happened). For **LTV reporting and channel mix**, prefer first-touch.

The `preferLastTouch(attribution)` helper in `core/attribution-classify.ts` returns the right one.

## Channel classification

Computed by `classifyChannel(touch)` (pure function, deterministic). Returns one of:

- `paid_search` — gclid / msclkid / wbraid / gbraid present, OR utm_medium = cpc/ppc
- `paid_social` — fbclid / twclid / ttclid / li_fat_id / sccid / etc., OR utm_medium = paidsocial
- `paid_other` — dclid, OR utm_medium = display/affiliate/sponsored
- `organic_search` — referrer is google/bing/yahoo/etc. + no click ID
- `organic_social` — referrer is facebook/instagram/etc. + no click ID
- `email` — utm_medium = email, OR mc_cid/mc_eid present
- `referral` — any other off-site referrer
- `direct` — no referrer + no UTM + no click ID
- `unknown` — utm fields set but classification ambiguous

Priority order (first match wins): click IDs → utm_medium → referrer → direct → unknown.

## Where each field lives

| Field family | Wire body | State store | Sheets row | Webhooks |
|---|---|---|---|---|
| Click IDs (top-level) | `tracking.gclid`, etc. | `gclid`, `fbclid`, `msclkid` columns | `gclid` column | event payload |
| `firstTouch` / `lastTouch` | `tracking.firstTouch`, `tracking.lastTouch` | NOT YET — extension TBD | NOT YET | event payload |
| `channel` | `tracking.channel` (or computed server-side) | NOT YET | NOT YET | event payload |
| `browserIds` | `tracking.browserIds` | NOT YET — needed for Tier-3 enhanced match | NOT YET | event payload |
| UTM | `tracking.utm*` | utm_source, utm_medium, utm_campaign columns | (mirror) | event payload |

Top-level click IDs are persisted today. The expanded model (firstTouch / lastTouch / channel / browserIds) is captured in the type system but is not yet persisted by every state-store implementation.

## What this kit does NOT do

- Set client-side cookies. The consumer's tracking script does that. Reuse the kit's `attribution/index.ts` for cookie reading on the server side.
- Hash PII for enhanced match. Conversion uploaders should handle this at upload time, not at booking time.
- Persist visitor history across bookings. State is per-submission. Cross-session visitor identity is the consumer's CRM concern.

## Related documentation

- [Attribution capture](./attribution.md)
- [Architecture](./architecture.md)
- [Adapters](./adapters.md)
