# Attribution

Most booking widgets kill paid advertising attribution. When a user clicks a Google Ad and lands on a page with a Booksy or Vagaro embed, the booking happens inside an iframe on a different domain — the GCLID is lost, the conversion is invisible to Google Ads, and the campaign optimization runs blind.

This kit threads attribution from the ad click through to a structured record that can be uploaded back to Google Ads as an offline conversion.

---

## What gets captured

| Signal                                             | Cookie name                  | Source                          | Expiry        |
| -------------------------------------------------- | ---------------------------- | ------------------------------- | ------------- |
| `gclid` (Google Ads click ID)                      | `_gcl_aw`                    | URL parameter on landing        | 30 days       |
| `gbraid` / `wbraid` (Google privacy-era click IDs) | Apointoo first-party capture | URL parameter on landing        | Tenant policy |
| `fbclid` (Meta Ads click ID)                       | `_fbc`                       | URL parameter on landing        | 30 days       |
| `msclkid` (Microsoft Ads click ID)                 | `_uetmsclkid`                | URL parameter on landing        | 30 days       |
| `rwg_token` (Reserve-with-Google)                  | —                            | URL parameter, no cookie        | Session       |
| UTM parameters                                     | —                            | sessionStorage                  | Session       |
| `referrer`, `pageUrl`, `pageTitle`                 | —                            | Browser, passed in request body | Per-request   |

**Why first-party cookies?** The kit stores click IDs in first-party cookies (same domain as the site) rather than relying on Google Tag Manager's cookies or third-party scripts. This means:

- Attribution survives even if GTM is blocked by an ad blocker
- Attribution works even if GTM hasn't loaded yet (slow connection, script errors)
- Safari ITP does not restrict first-party cookies — a `_gcl_aw` cookie on `yoursalon.com` is not affected by ITP's third-party cookie limits

---

## How to capture attribution on the frontend

Add this script to your landing page (or the booking page). It runs once on load and handles all three major ad platforms.

```javascript
// attribution-capture.js
// Run on page load, before the booking form is shown.

const COOKIE_DAYS = 30

function setCookie(name, value, days) {
  const expires = new Date(Date.now() + days * 864e5).toUTCString()
  document.cookie = `${name}=${encodeURIComponent(value)}; expires=${expires}; path=/; SameSite=Lax`
}

function getCookie(name) {
  const match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'))
  return match ? decodeURIComponent(match[2]) : null
}

function getParam(name) {
  return new URLSearchParams(window.location.search).get(name)
}

// Google Ads (capture each value independently; do not treat one as consent)
const gclid = getParam('gclid')
if (gclid) {
  setCookie('_gcl_aw', gclid, COOKIE_DAYS)
  sessionStorage.setItem('_gcl_aw', gclid)
}

const gbraid = getParam('gbraid')
const wbraid = getParam('wbraid')
if (gbraid) sessionStorage.setItem('gbraid', gbraid)
if (wbraid) sessionStorage.setItem('wbraid', wbraid)

// Meta Ads
const fbclid = getParam('fbclid')
if (fbclid) {
  setCookie('_fbc', fbclid, COOKIE_DAYS)
  sessionStorage.setItem('_fbc', fbclid)
}

// Microsoft Ads
const msclkid = getParam('msclkid')
if (msclkid) {
  setCookie('_uetmsclkid', msclkid, COOKIE_DAYS)
  sessionStorage.setItem('_uetmsclkid', msclkid)
}

// Reserve-with-Google
const rwgToken = getParam('rwg_token')
if (rwgToken) {
  sessionStorage.setItem('rwg_token', rwgToken)
}

// UTM params
const utmKeys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content']
const utms = {}
utmKeys.forEach((key) => {
  const val = getParam(key)
  if (val) {
    sessionStorage.setItem(key, val)
    utms[key] = val
  }
})
```

Then, when building the booking form submission payload, include the `tracking` object:

```javascript
function buildTracking(consent) {
  function fromSessionOrCookie(sessionKey, cookieName) {
    return sessionStorage.getItem(sessionKey) || getCookie(cookieName) || undefined
  }

  return {
    gclid: fromSessionOrCookie('_gcl_aw', '_gcl_aw'),
    gbraid: sessionStorage.getItem('gbraid') || undefined,
    wbraid: sessionStorage.getItem('wbraid') || undefined,
    fbclid: fromSessionOrCookie('_fbc', '_fbc'),
    msclkid: fromSessionOrCookie('_uetmsclkid', '_uetmsclkid'),
    rwgToken: sessionStorage.getItem('rwg_token') || undefined,
    utmSource: sessionStorage.getItem('utm_source') || undefined,
    utmMedium: sessionStorage.getItem('utm_medium') || undefined,
    utmCampaign: sessionStorage.getItem('utm_campaign') || undefined,
    utmTerm: sessionStorage.getItem('utm_term') || undefined,
    utmContent: sessionStorage.getItem('utm_content') || undefined,
    referrer: document.referrer || undefined,
    pageUrl: window.location.href,
    pageTitle: document.title,
    ...(consent ? { consent } : {}), // pass the ConsentVector resolved by your CMP
  }
}

// Include in the POST /booking payload:
const payload = {
  serviceId: '...',
  requestedDate: '...',
  // ...
  // Strict tenants strip ad IDs when no canonical ConsentVector is supplied.
  tracking: buildTracking(),
}
```

---

## How the server handles attribution

`readAttribution(cookieHeader, wirTracking)` in `src/attribution/index.ts` merges two sources:

1. Cookie-derived values: the server reads `cookie` header values for `_gcl_aw`, `_fbc`, `_uetmsclkid`
2. Wire-submitted `tracking`: from the request body

**Wire values win.** If the client passes `tracking.gclid` and the server also finds `_gcl_aw` in the cookie, the wire value is used. The rationale: the client may have captured a fresher GCLID in sessionStorage (e.g., from a same-session ad click after a prior visit) that supersedes an older cookie value.

The merged `BookingAttribution` object is then:

1. Passed to `attachAttribution(session, attribution)` → sent to the vendor as `referralSource`
2. Written to the Sheets persistence row (columns: gclid, fbclid, msclkid, utmSource, etc.)
3. Written to the state store (PHI-free columns only: gclid, fbclid, msclkid, utmSource, utmMedium, utmCampaign)

---

## Production offline conversion ownership

The Apointoo dashboard is the single production owner of Google Ads offline conversion upload. The SDK captures and preserves attribution; it must not start a second uploader for the same tenant event.

The dashboard upload contract is:

- Conversion action: the tenant-created Google Ads action mapped to the Apointoo event (for example `payment_completed`).
- Click identifier: send exactly one, in precedence order `gclid` → `gbraid` → `wbraid`.
- Enhanced matching: the dashboard normalizes and SHA-256 hashes an eligible email and an explicitly valid international phone number. A bare national phone number is not guessed or hashed.
- Consent: under a strict tenant regime, ad identifiers require both `adStorage` and `adUserData` granted; hashed user data requires `adUserData` granted.
- Deduplication and retry: the dashboard conversion ledger owns transaction identity, retries, terminal errors, and Google receipts.

Customer Match audiences are a separate product and consent workflow. Do not repurpose conversion uploads or the SDK's `ConversionReporter` as an audience-membership writer.

The SDK's `ConversionReporter` remains a narrow, PHI-free adapter boundary for headless deployments. It is not the dashboard Data Manager implementation and should not run alongside it for the same conversion source.

---

## Cookie considerations

**SameSite=Lax** is the right setting for first-party attribution cookies. The user arrives via a top-level navigation from the ad click, which is exactly what Lax allows. If your booking form is embedded in an iframe from a different domain, Lax would block the cookie — in that case use `SameSite=None; Secure`, but this is not recommended unless you're building an embedded widget.

**GCLID expiry:** Google's attribution window for GCLIDs is 90 days. The kit's cookies expire in 30 days — this is conservative. You can extend them to 90 days in the `setCookie` call if you want to cover the full attribution window. The state store has no expiry for the gclid column.

**Safari ITP:** ITP restricts third-party cookies and limits some JavaScript-written cookies to 7 days. However, the `_gcl_aw` cookie in this kit is set via a script running on the same domain as the site — it's a first-party cookie from Safari's perspective and is not subject to ITP's third-party restrictions. The 7-day server-side cap in ITP only applies to cookies set via `document.cookie` with certain cross-site referrers; a direct ad click (top-level navigation) is not subject to this cap.
