# Getting Started

This guide takes you from zero to a working booking endpoint — locally with sandbox BLVD credentials, then ready to deploy.

> **Set up attribution capture from day one.** The whole point of this kit is threading the ad click through to the booking — but that only works if the frontend captures the click ID *before* the form is submitted. Add the [attribution capture snippet](./attribution.md#how-to-capture-attribution-on-the-frontend) to your landing page `<head>` as soon as you wire the form, not as a "later" task. If you skip it, every lead lands as a Direct visit and the offline-conversion pipeline has nothing to upload. It's Step 3.5 below.

---

## Prerequisites

- Node ≥ 18.17
- A BLVD sandbox account (free at [joinblvd.com](https://joinblvd.com)) — or swap in the memory adapter for local-only testing
- An Upstash Redis database (free tier covers development) — or skip and use the memory fallback
- A Google Cloud service account with Sheets API enabled — or skip and use the memory persistence adapter
- A Brevo account with an API key — or skip and use the memory notifier

You can run the kit with all memory adapters first (no external accounts needed) to verify the wiring, then swap in real adapters one at a time.

---

## Step 1 — Install

```bash
# SDK + required peer deps
npm install git+https://github.com/vizuh/apointoo-sdk.git#v0.12.2 hono zod

# Upstash (for distributed dedup + rate limiting in production)
npm install @upstash/redis @upstash/ratelimit

# Google Sheets adapter
npm install googleapis
```

---

## Step 2 — Environment

```bash
cp .env.local.example .env.local
```

For a first local run, you only need to fill in the BLVD sandbox variables. Leave Upstash blank — the kit falls back to in-memory dedup automatically when `UPSTASH_REDIS_REST_URL` is absent.

```env
BLVD_API_URL=https://sandbox.joinblvd.com/api/2020-01
BLVD_API_KEY=your_sandbox_api_key
BLVD_BUSINESS_ID=your_business_uuid
BLVD_DEFAULT_LOCATION_ID=your_location_uuid
```

### Finding your BLVD IDs

BLVD does not expose IDs in a UI. Use the GraphQL API against the sandbox URL to discover them.

**List your locations:**
```graphql
query {
  myBusiness {
    locations(first: 10) {
      edges { node { id name } }
    }
  }
}
```

**List bookable services at a location:**
```graphql
query ListServices($locationId: ID!) {
  location(id: $locationId) {
    bookableServices(first: 50) {
      edges {
        node {
          id
          name
          duration
          staff { id name }
        }
      }
    }
  }
}
```

Copy the service IDs into your `serviceMap` in the adapter config. Each key is a `service.id` from your `BookingKitConfig`; each value is the BLVD bookable service UUID.

---

## Step 3 — Wire the handler

Create `app/api/booking/route.ts` (Next.js App Router) or the equivalent route file for your framework.

**Minimal version with all adapters (production):**

```typescript
import { createBookingHandler } from '@vizuh/apointoo-sdk/server'
import { blvdAdapter }          from '@vizuh/apointoo-sdk/adapters/booking/blvd'
import { sheetsAdapter }        from '@vizuh/apointoo-sdk/adapters/persistence/sheets'
import { brevoRestAdapter }     from '@vizuh/apointoo-sdk/adapters/notification/brevo-rest'
import { upstashDedupStore }    from '@vizuh/apointoo-sdk/adapters/dedup/upstash'
import { upstashRateLimitStore } from '@vizuh/apointoo-sdk/adapters/ratelimit/upstash'
import type { BookingKitConfig } from '@vizuh/apointoo-sdk'

const config: BookingKitConfig = {
  projectKey: 'my-salon',
  businessName: 'My Salon',
  locale: 'en-US',
  timezone: 'America/New_York',
  services: [{ id: 'haircut', name: 'Haircut', isActive: true }],
  scheduling: {
    availableDays: [1, 2, 3, 4, 5, 6],
    timeSlots: [{ label: '10:00', value: '10:00' }, { label: '14:00', value: '14:00' }],
    minAdvanceDays: 1,
    maxAdvanceDays: 60,
  },
}

const app = createBookingHandler({
  config,
  booking: blvdAdapter({
    apiKey:            process.env.BLVD_API_KEY!,
    businessId:        process.env.BLVD_BUSINESS_ID!,
    apiUrl:            process.env.BLVD_API_URL!,
    defaultLocationId: process.env.BLVD_DEFAULT_LOCATION_ID!,
    serviceMap:        { haircut: process.env.BLVD_SERVICE_HAIRCUT! },
  }),
  persistence: sheetsAdapter({
    spreadsheetId: process.env.GOOGLE_SHEETS_SPREADSHEET_ID!,
    tabName:       process.env.GOOGLE_SHEETS_TAB_NAME ?? 'Bookings',
    clientEmail:   process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL!,
    privateKey:    process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY!,
  }),
  notification: brevoRestAdapter({
    apiKey:    process.env.BREVO_API_KEY!,
    from:      process.env.LEAD_FROM_EMAIL!,
    fromName:  process.env.LEAD_FROM_NAME,
    defaultTo: process.env.LEAD_NOTIFICATION_TO!.split(',').map(s => s.trim()),
    defaultBcc: (process.env.LEAD_NOTIFICATION_BCC ?? '').split(',').map(s => s.trim()).filter(Boolean),
  }),
  dedup: upstashDedupStore({
    url:    process.env.UPSTASH_REDIS_REST_URL!,
    token:  process.env.UPSTASH_REDIS_REST_TOKEN!,
    keyPrefix: config.projectKey,
  }),
  rateLimit: upstashRateLimitStore({
    url:      process.env.UPSTASH_REDIS_REST_URL!,
    token:    process.env.UPSTASH_REDIS_REST_TOKEN!,
    limit:    20,
    windowMs: 60_000,
    keyPrefix: config.projectKey,
  }),
})

export const POST = app.fetch
export const GET  = app.fetch   // serves /healthz
```

**Development-only version with all memory adapters (no external accounts needed):**

```typescript
import { createBookingHandler }    from '@vizuh/apointoo-sdk/server'
import { memoryBookingAdapter }    from '@vizuh/apointoo-sdk'
import { memoryPersistenceAdapter } from '@vizuh/apointoo-sdk'
import { memoryNotifier }          from '@vizuh/apointoo-sdk'
import { memoryDedupStore }        from '@vizuh/apointoo-sdk/adapters/dedup/memory'

const app = createBookingHandler({
  config,           // same BookingKitConfig as above
  booking:      memoryBookingAdapter(),
  persistence:  memoryPersistenceAdapter(),
  notification: memoryNotifier(),
  dedup:        memoryDedupStore(),
})

export const POST = app.fetch
export const GET  = app.fetch
```

---

## Step 3.5 — Add attribution capture on the frontend

Before you verify anything, wire the frontend to capture the ad click. The handler can only record what the form sends it — if `tracking.gclid` never arrives, the booking attributes as Direct.

Add the capture snippet to your landing page `<head>` (runs once on load, persists click IDs + UTMs to a first-party cookie), then include the `tracking` object in the POST body. The full snippet and the `buildTracking()` helper are in [`docs/attribution.md`](./attribution.md#how-to-capture-attribution-on-the-frontend).

```javascript
// In your form submit handler:
const payload = {
  serviceId:     '...',
  requestedDate: '...',
  // ...
  tracking: buildTracking(), // from docs/attribution.md
}
```

This is a frontend (consumer-site) step — no kit code changes. Do it now so the test submission in Step 4 actually carries a `gclid`.

---

## Step 4 — Verify locally

Start your dev server, then send a test submission:

```bash
curl -X POST http://localhost:3000/api/booking \
  -H "Content-Type: application/json" \
  -d '{
    "serviceId":     "haircut",
    "requestedDate": "2026-06-15",
    "requestedTime": "10:00",
    "name":          "Jane Smith",
    "phone":         "+12025551234",
    "email":         "jane@example.com",
    "tracking":      { "gclid": "test-gclid-123" }
  }'
```

Expected response:
```json
{
  "success": true,
  "submissionId": "bk_20260507_a1b2c3d4",
  "confirmationCode": "APT-1234",
  "vendorAppointmentId": "..."
}
```

**Test dedup** — send the same payload twice within 90 seconds:
```json
{ "ok": false, "errorCode": "DUPLICATE_SUBMISSION", "message": "Duplicate submission", "retryable": false }
```

**Test honeypot** — add `"website": "http://spam.com"` to the payload:
```json
{ "ok": false, "errorCode": "SPAM_DETECTED", "message": "Submission rejected", "retryable": false }
```

**Health check:**
```bash
curl http://localhost:3000/api/booking
# { "ok": true, "version": "0.6.0", "adapters": { ... } }
```

---

## Step 5 — BLVD sandbox end-to-end test

With real BLVD sandbox credentials set in `.env.local`:

```bash
npm run test:live
```

This runs `tests/live/blvd.test.ts` which:
1. Creates a BLVD cart
2. Adds the service item
3. Attaches client information
4. Fetches available times
5. Reserves a slot
6. Checks out (creates the appointment)
7. Verifies the confirmation code

Expected output: all steps pass, confirmation code returned.

**Known issue:** The BLVD SDK's own integration test suite has a commented-out checkout step marked "TODO broken." This kit's live test goes around the SDK and hits the GraphQL API directly, but budget extra debug time if the checkout step fails in sandbox — BLVD sandbox sometimes has stale slot data.

---

## Step 6 — Deploy to Vercel

1. Push your consumer repo to GitHub.
2. Import the project in Vercel.
3. Add all env vars in Vercel → Project Settings → Environment Variables. The `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` value is a multiline PEM — paste it as-is, Vercel handles newlines correctly.
4. Ensure the API route runs on the **Node.js** runtime (not Edge) — the Sheets adapter uses `googleapis` which requires Node. In your route file add `export const runtime = 'nodejs'` if needed.
5. Deploy.

After deploy, hit `GET https://your-domain.com/api/booking` to verify the health check returns `ok: true` for all adapters.

---

## Next steps

- Configure the frontend: send the booking form payload to `POST /api/booking`. See the request payload shape in the README.
- If you skipped Step 3.5, go back and add attribution capture now — it's the difference between every lead reading as Direct and a working offline-conversion pipeline. See [`docs/attribution.md`](./attribution.md).
- Enable a durable state store such as Supabase for production deployments.
- Read the adapter guide if you need to connect a different PMS: [`docs/adapters.md`](./adapters.md).
