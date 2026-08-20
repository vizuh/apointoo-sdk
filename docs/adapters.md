# Adapter Guide

The kit is built around five adapter interfaces. Each interface has a production implementation, a memory implementation for tests, and optionally more. The consumer wires the implementations they need at startup. The pipeline only depends on the interfaces.

---

## The five interfaces

| Interface | Location | What it abstracts |
|---|---|---|
| `BookingAdapter` | `src/adapters/booking/adapter.ts` | Vendor PMS (BLVD, OpenDental, Square, etc.) |
| `PersistenceAdapter` | `src/adapters/persistence/adapter.ts` | Operator-readable log (Sheets, Supabase, etc.) |
| `Notifier` | `src/adapters/notification/adapter.ts` | Operator notifications (email, WhatsApp, etc.) |
| `DedupStore` | `src/adapters/dedup/adapter.ts` | Short-window dedup (Redis, memory) |
| `RateLimitStore` | `src/adapters/ratelimit/adapter.ts` | Per-IP rate limiting (Upstash, memory) |

Additionally, when using durable state and queuing:

| Interface | Location | What it abstracts |
|---|---|---|
| `BookingStateStore` | `src/adapters/state/adapter.ts` | PHI-free booking lifecycle (Supabase, memory) |
| `OutboundQueue` | `src/queue/adapter.ts` | Notification delivery queue (Supabase, memory) |

---

## BookingAdapter

This is the most important interface. One implementation per PMS.

```typescript
interface BookingAdapter {
  createSession(input, ctx):              Promise<BookingSession>
  attachAttribution(session, attr, ctx):  Promise<void>
  confirm(session, request, ctx):         Promise<BookingConfirmation>
  cancel(session, reason, ctx):           Promise<void>
  health(ctx):                            Promise<AdapterHealth>
  findAvailability(query, ctx):           Promise<AvailabilitySlot[]>
  cancelByAppointment(id, reason, ctx):   Promise<void>
  rescheduleByAppointment(id, date, time, ctx): Promise<RescheduleResult>
}
```

**Method contracts:**

`createSession` — creates a pre-booking handle in the vendor. For BLVD: creates a cart and adds the service item. Does NOT book the slot. The returned `BookingSession.vendorSessionId` is opaque — the pipeline stores and passes it through; only the adapter interprets it.

`attachAttribution` — attaches attribution data (gclid, fbclid, referralSource) to the session record in the vendor. Must be idempotent (attaching the same data twice is a no-op or harmless). The pipeline calls this fire-and-forget — errors are swallowed. Never throw here for attribution failures; log and return.

`confirm` — books the slot. For BLVD: `reserveCartBookableItems` then `checkoutCart`. This is the only method that creates an appointment. If this throws, the pipeline calls `cancel(session)` for compensation.

`cancel` — releases the vendor-side session/reservation. Called by the pipeline when `confirm` fails. Must be idempotent — calling twice should be a no-op. Swallow errors; log them. The pipeline does not re-throw cancel failures.

`health` — lightweight connectivity probe. Used at deploy time and by `/healthz`. Keep it cheap (e.g. a token introspection call or a lightweight ping endpoint, not a full booking flow).

`findAvailability` — returns open slots for a service over a date range. Used by `GET /availability`. Memory implementation generates slots from the config's `weeklySchedule`. BLVD implementation uses an ephemeral cart + `cartBookableTimes` (~3 round trips).

`cancelByAppointment` / `rescheduleByAppointment` — operate on confirmed appointments by vendor appointment ID. Distinct from `cancel(session)` which is the in-flight saga compensation. Both must be idempotent.

### BLVD adapter

**Import:** `@vizuh/apointoo-sdk/adapters/booking/blvd`

```typescript
import { blvdAdapter } from '@vizuh/apointoo-sdk/adapters/booking/blvd'

const booking = blvdAdapter({
  apiKey:            'your-blvd-api-key',
  businessId:        'uuid-of-your-blvd-business',
  apiUrl:            'https://dashboard.boulevard.io/api/2020-01',
  defaultLocationId: 'uuid-of-default-location',
  serviceMap: {
    // Each key is a service.id from your BookingKitConfig.
    // Each value is the BLVD bookable item UUID for that service.
    // Find these by querying listBookableServices against your location.
    'haircut':     'blvd-bookable-item-uuid-1',
    'color':       'blvd-bookable-item-uuid-2',
  },
  // Optional: override the default location per service
  locationMap?: {
    'haircut': 'blvd-location-uuid',
  },
  // Optional: circuit breaker config
  circuitBreaker?: {
    threshold: 5,       // failures before tripping (default 5)
    resetMs:   30_000,  // cooldown period in ms (default 30s)
  },
})
```

**Auth:** Basic authentication with `base64("apiKey:")`. The trailing colon is mandatory — BLVD silently rejects requests without it.

**Cart flow:**
1. `createCart(locationId)` — creates a fresh cart for the session
2. `addCartSelectedBookableItem(serviceItemId)` — maps your serviceId to a BLVD bookable item
3. `updateCart(clientInformation)` — attaches name, phone, email
4. `attachAttribution` → `updateCart(referralSource = gclid)` — fire-and-forget
5. `cartBookableTimes(date, tz)` — fetches available slots for the requested date
6. `reserveCartBookableItems(bookableTimeId)` — holds the slot
7. `checkoutCart()` → returns `{ appointmentId, confirmationCode, clientId }`

**No SDK dependency.** `@boulevard/blvd-book-sdk` v2.0.10 is a client-side UI kit and is not used. The adapter communicates with BLVD's GraphQL API directly via `fetch`.

**Known issue in sandbox:** The BLVD SDK's checkout integration test is marked "TODO broken." The kit's adapter works around this by testing individual steps rather than the full flow. Expect occasional slot availability issues in sandbox (stale data).

#### Bootstrap helpers

The `serviceMap` (apointoo serviceId → BLVD bookable-item UUID) and `defaultLocationId` are hand-curated by the consumer at construction time. Two read-only helpers let onboarding scripts and healthcheck handlers discover those values from a BLVD account directly — no UI walk, no hand-copying UUIDs.

```typescript
import {
  listBlvdLocations,
  listBlvdServices,
} from '@vizuh/apointoo-sdk/adapters/booking/blvd'

const opts = { apiKey: process.env.BLVD_API_KEY!, businessId: process.env.BLVD_BUSINESS_ID! }

const locations = await listBlvdLocations(opts)
// → [{ id: 'loc-A', name: 'Brickell' }, { id: 'loc-B', name: 'Wynwood' }]

const categories = await listBlvdServices(opts, locations[0].id)
// → [{ id: 'cat-1', name: 'Haircuts',
//      services: [{ id: 'svc-1', name: 'Adult Cut' }, ...] }, ...]
```

Both functions throw `BlvdError` on auth or transport failure. `listBlvdServices` creates an ephemeral cart (BLVD's service catalog is reachable only through a cart context), reads the category tree, and cancels the cart in a `finally` block — the cancel is best-effort, BLVD's cart TTL (~10 min) is the safety net if it fails.

These helpers are **not** part of `BookingAdapter` — they're vendor-specific bootstrap, not pipeline calls. Other adapter consumers (Recal, OpenDental) won't see them.

### Memory adapter

**Import:** `@vizuh/apointoo-sdk` (from main barrel)

```typescript
import { memoryBookingAdapter } from '@vizuh/apointoo-sdk'

const booking = memoryBookingAdapter({
  // Optional: override the default confirmation code returned
  confirmationCode?: 'TEST-001',
  // Optional: simulate a failure at a specific stage
  failAt?: 'createSession' | 'confirm',
})
```

Always succeeds with deterministic responses. Safe for unit tests and local development.

### OpenDental adapter (skeleton)

**Import:** `@vizuh/apointoo-sdk/adapters/booking/opendental` (once implemented)

The interface is wired but all methods throw `BookingError('DEPENDENCY_UNAVAILABLE', 'OpenDental adapter not yet implemented')`. It remains a scaffold until its API operations are sandbox-verified.

### Recal adapter

**Import:** `@vizuh/apointoo-sdk/adapters/booking/recal`

Connects to [Recal](https://api.recal.dev) — a calendar-backed booking layer. Implements the full `BookingAdapter` interface via the `recal-sdk`.

---

## PersistenceAdapter

```typescript
interface PersistenceAdapter {
  append(record: PersistenceRecord, ctx: AdapterContext): Promise<void>
  health(ctx: AdapterContext): Promise<AdapterHealth>
}

type PersistenceRecord = {
  eventType:           BookingEventType  // 'booking_request' | 'partial_lead'
  request:             BookingRequest
  confirmation:        BookingConfirmation
  vendorMetadataJson?: string
}
```

The `append` method writes one row per booking. The Sheets implementation writes to Google Sheets API v4. The row schema is defined in `src/core/persistence-row.ts` and includes the kit version in the last column (Pattern 16).

`PersistenceRecord` contains PHI (name, phone, email are in `BookingRequest`). This adapter should not be confused with the `BookingStateStore` which is PHI-free.

### Sheets adapter

**Import:** `@vizuh/apointoo-sdk/adapters/persistence/sheets`

```typescript
import { sheetsAdapter } from '@vizuh/apointoo-sdk/adapters/persistence/sheets'

const persistence = sheetsAdapter({
  spreadsheetId: 'your-spreadsheet-id',
  tabName:       'Bookings',    // default
  clientEmail:   'sa@project.iam.gserviceaccount.com',
  privateKey:    '-----BEGIN RSA PRIVATE KEY-----\n...',
  // Optional: column header list. Defaults to the standard 10-column schema.
  headers?: string[],
})
```

**Service account setup:**
1. Create a service account in Google Cloud IAM.
2. Create and download a JSON key.
3. Share your Google Sheet with the service account email as Editor.
4. Set `GOOGLE_SERVICE_ACCOUNT_EMAIL` and `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` env vars.

**`ensureHeaders`:** On the first write, the adapter reads the first row and writes headers if absent. This is cached per process — subsequent writes skip the check.

**Important:** The `googleapis` package is Node.js only. The Sheets adapter cannot run on Cloudflare Workers or Vercel Edge runtime. Use the Node.js runtime for any route that uses this adapter.

---

## Notifier

```typescript
interface Notifier {
  sendBookingNotification(
    request:      BookingRequest,
    confirmation: BookingConfirmation,
    options:      NotificationOptions,
    ctx:          AdapterContext,
  ): Promise<void>
  health(ctx: AdapterContext): Promise<AdapterHealth>
}

type NotificationOptions = {
  recoveryRow?:    ReadonlyArray<string>  // Pattern 15: embed in email if Sheets failed
  recoveryReason?: string
}
```

### Brevo REST adapter

**Import:** `@vizuh/apointoo-sdk/adapters/notification/brevo-rest`

Uses Brevo's transactional email REST API (not SMTP). REST has no socket overhead — better for serverless cold starts. The email is generated by `src/email/templates.ts` and sent as both HTML and plain text.

```typescript
import { brevoRestAdapter } from '@vizuh/apointoo-sdk/adapters/notification/brevo-rest'

const notification = brevoRestAdapter({
  apiKey:     'your-brevo-rest-api-key',  // from Brevo → SMTP & API → API keys (not SMTP key)
  from:       'bookings@yourdomain.com',
  fromName:   'Your Salon',               // optional
  defaultTo:  ['operator@yourdomain.com'],
  defaultBcc: ['backup@yourdomain.com'],  // optional
  subjectPrefix: '[Booking]',             // optional, prepended to email subject
})
```

### Twilio WhatsApp adapter

**Import:** via `src/adapters/notification/twilio-whatsapp/`

Sends a template-based WhatsApp message to the operator. Requires a Twilio account and an approved WhatsApp Business template.

### Multi-notifier

Fans out to N child notifiers via `Promise.allSettled`. Partial failures log and continue; total failure throws.

```typescript
import { multiNotifier } from '@vizuh/apointoo-sdk'

const notification = multiNotifier([
  brevoRestAdapter({ ... }),
  twilioWhatsappNotifier({ ... }),
])
```

---

## DedupStore

```typescript
interface DedupStore {
  checkAndSet(key: string, ttlMs: number): Promise<{ duplicate: boolean }>
}
```

Simple interface: atomic check-and-set. If the key exists, `duplicate: true`. If not, set it with the TTL and return `duplicate: false`.

### Upstash adapter

Uses Upstash Redis REST API. Safe for serverless — each call is a single HTTP request to the Upstash REST endpoint, no persistent connection.

```typescript
import { upstashDedupStore } from '@vizuh/apointoo-sdk/adapters/dedup/upstash'

const dedup = upstashDedupStore({
  url:       process.env.UPSTASH_REDIS_REST_URL!,
  token:     process.env.UPSTASH_REDIS_REST_TOKEN!,
  keyPrefix: 'my-salon',   // namespaces keys to avoid collision if you share one Redis instance
})
```

### Memory adapter

```typescript
import { memoryDedupStore } from '@vizuh/apointoo-sdk/adapters/dedup/memory'

const dedup = memoryDedupStore()
```

Uses a `Map<string, number>` with a timestamp-based TTL check. Safe for unit tests. **Not safe for serverless production** — each function invocation has its own in-process Map.

---

## Writing a new adapter

To add a new PMS (Square, Mindbody, Jane, etc.):

1. Create `src/adapters/booking/<name>/index.ts`
2. Implement the `BookingAdapter` interface
3. Use `BookingError` for all thrown errors — never throw bare `Error`
4. Use `ctx.logger` for all logging — never `console.*`
5. Never log PII in `ctx` fields
6. Add the implementation to `package.json` `exports` as a subpath
7. Write a test against the memory pipeline (`createPipeline` + your adapter)
8. Document the adapter's env vars in `.env.local.example`

**Error handling pattern:**

```typescript
import { BookingError } from '@vizuh/apointoo-sdk'

async confirm(session, request, ctx) {
  let response: Response
  try {
    response = await fetch(this.apiUrl + '/book', { ... })
  } catch (err) {
    // Network failure — retryable
    throw new BookingError('BOOKING_FAILED', 'Network error reaching vendor', { retryable: true })
  }

  if (!response.ok) {
    if (response.status === 409) {
      // Slot taken — not retryable
      throw new BookingError('TIME_UNAVAILABLE', 'Slot no longer available', { retryable: false })
    }
    if (response.status === 401 || response.status === 403) {
      // Configuration error — not retryable, needs operator action
      throw new BookingError('DEPENDENCY_UNAVAILABLE', 'Booking system authentication failed. Please call us to book.', { retryable: false })
    }
    // All other vendor errors — potentially retryable
    throw new BookingError('BOOKING_FAILED', 'Booking system temporarily unavailable. Please try again.', { retryable: true })
  }

  const data = await response.json()
  return {
    vendorAppointmentId: data.appointmentId,
    vendorClientId:      data.clientId,
    confirmationCode:    data.confirmationCode,
    startTimeIso:        data.startTime,
    metadata:            {},
  }
}
```

**Logging pattern:**

```typescript
// Good — only submissionId, event name, error code
ctx.logger.error({
  evt: 'my-pms.confirm.failed',
  code: 'TIME_UNAVAILABLE',
  message: err.message,
  stack: err.stack?.slice(0, 500),
  ctx: { statusCode: String(response.status) },
})

// Bad — PII in ctx
ctx.logger.error({
  evt: 'confirm.failed',
  ctx: {
    name:  request.name,    // PII — never log this
    phone: request.phone,  // PII — never log this
  },
})
```

---

## Circuit breaker

The `withCircuitBreaker` wrapper can be applied to any `BookingAdapter` to prevent hammering a vendor that is known to be down:

```typescript
import { withCircuitBreaker } from '@vizuh/apointoo-sdk'

const booking = withCircuitBreaker(
  blvdAdapter({ ... }),
  {
    threshold: 5,       // number of failures before the circuit trips
    resetMs:   30_000,  // cooldown period before the circuit resets to half-open
  },
)
```

When the circuit is open (tripped), incoming requests fail immediately with `DEPENDENCY_UNAVAILABLE` without hitting the vendor. After `resetMs`, the circuit enters half-open state and allows one probe request. If that succeeds, the circuit closes.
