# Pipeline — stages, error codes, response shapes

The pipeline is the spine of the kit. It runs in `src/server/pipeline.ts` and is the only place that orchestrates the booking flow. Consumers never re-implement it — they wire adapters and mount the handler.

---

## Stage-by-stage breakdown

### Stage 0 — Idempotency replay

If the request carries an `Idempotency-Key` header and the kit has an `idempotencyStore` wired, the pipeline looks up the key before doing any work. If a cached response exists, it is returned immediately — no adapter calls, no side effects.

This is the Stripe convention for safe client-side retries. It is distinct from dedup (stage 4), which catches accidental double-submits. Idempotency lets a client intentionally retry a request after a network failure; dedup prevents a user from accidentally submitting the same form twice.

TTL for cached idempotent responses defaults to 24 hours and is configurable via `idempotencyTtlSeconds` in `PipelineOptions`.

### Stage 1 — Parse and validate

The raw request body is JSON-parsed and run through the `bookingRequestInputSchema` Zod schema. Any parsing or validation failure returns immediately with `INPUT_INVALID` and a list of field-level issues.

Validation rules of note:
- `phone` must pass E.164 format (digits, optional leading `+`). Whitespace and dashes are stripped before the check.
- `email` is validated with a pragmatic RFC-5322 regex. Real email validation happens at the vendor.
- `requestedDate` must be `YYYY-MM-DD`. `requestedTime` must be `HH:MM` 24h.
- `serviceId` must be non-empty string, max 128 chars.
- `message` is limited to 2000 chars.
- Unknown fields on the input are rejected (Zod `.strict()` mode).

### Stage 2 — Honeypot

The schema accepts a `website` field that is never shown to real users. Any submission with a non-empty `website` value is silently rejected with `SPAM_DETECTED`. The response code is 400, indistinguishable from a validation error — bots can't learn from the shape of the response.

The honeypot event is published to the domain event bus (`booking.spam_rejected`) so subscribers can count it without this stage needing to know what they do with it.

### Stage 3 — Rate limiting

If a `RateLimitStore` is wired, the pipeline consumes one token from the sliding window keyed to `{projectKey}:{ip}`. If the limit is exceeded, the pipeline returns `RATE_LIMITED` immediately.

The default Upstash config is 20 requests per 60-second window per IP per tenant. This is configurable in `upstashRateLimitStore({ limit, windowMs })`.

Rate limiting is skipped if no `RateLimitStore` is wired or if the request has no resolvable IP.

### Stage 4 — Fingerprint dedup

A SHA-256 fingerprint is computed from the lowercased name + digits-only phone + requestedDate + requestedTime + serviceId. The pipeline calls `DedupStore.checkAndSet(key, ttlMs)` — if the key already exists, the submission is a duplicate and `DUPLICATE_SUBMISSION` is returned.

The dedup TTL defaults to 90 seconds (90,000ms), configurable via `dedupTtlMs` in `PipelineOptions` or the `APOINTOO_DEDUP_TTL_MS` env var.

**Critical:** The in-memory dedup store (`memoryDedupStore`) is not safe for serverless production. Serverless functions are independent processes — a second submission that lands on a different cold-start instance won't see the first fingerprint. Use `upstashDedupStore` in any Vercel or Cloudflare Workers deployment.

### Stage 5 — State store: write pending

If a `BookingStateStore` is wired, the pipeline writes a `pending` row before any vendor call. This is the durability record — it exists even if the vendor call fails.

The state row contains only PHI-free fields: `submissionId`, `tenantId`, `status`, `vendor`, `gclid`, `fbclid`, `msclkid`, `utmSource`, `utmMedium`, `utmCampaign`, `createdAt`. No name, phone, or email.

If the state write fails, it is logged as a warning and the pipeline continues. A state write failure does not abort the booking.

**Outbox path:** If both `stateStore` + `queue` + `outbox` are wired, the pipeline writes the state row and any initial queue items atomically via the outbox in a single database transaction. This prevents the race condition where state is written but a queue item is lost.

### Stage 6 — Booking adapter

Three sub-steps:

**6a. createSession** — establishes a pre-booking handle with the vendor. For BLVD this is a cart. The session handle is opaque to the pipeline; only the adapter inspects its contents. Returns a `BookingSession { vendorSessionId, vendor, expiresAtIso }`.

**6b. attachAttribution** — sends the attribution data (gclid, fbclid, etc.) to the vendor as `referralSource`. This is fire-and-forget: errors are logged as warnings and never abort the booking. If attribution can't be attached, the booking still proceeds.

**6c. confirm** — books the slot. For BLVD this is `reserveCartBookableItems` + `checkoutCart`. Returns `BookingConfirmation { vendorAppointmentId, vendorClientId, confirmationCode, startTimeIso, metadata }`.

**Compensation:** If `confirm` throws, the pipeline calls `cancel(session, reason)` as a best-effort cleanup. This releases the vendor-side reservation so the slot doesn't stay blocked. The cancel call itself is fire-and-forget: if it fails, the error is logged and the pipeline returns the confirm error to the caller. It is the vendor's responsibility to expire stale sessions.

### Stage 7 — Side effects

`persistence.append` and `notification.sendBookingNotification` run via `Promise.allSettled`. This means:
- Both run regardless of which one succeeds or fails.
- Neither failure rolls back the booking (the appointment already exists in the vendor system).

**Persistence** appends a row to Google Sheets (or whichever `PersistenceAdapter` is wired). This row contains PHI and is the operator-readable log. It is not the source of truth for booking existence — the vendor system and the state store are.

**Notification** sends an operator email via Brevo REST (or whichever `Notifier` is wired). The email follows the Pattern 13 anatomy: header (name + service + date) → contact fields → attribution data → footer with kit version.

**Queue path:** If an `OutboundQueue` is wired, the pipeline enqueues the notification for durable async delivery. A queue worker delivers it with retry and exponential backoff. If `queueOnly` is false (default), the pipeline also sends the notification inline for immediate delivery — the queue is the retry path.

### Stage 8 — Persistence failure recovery (Pattern 15)

After `Promise.allSettled`, if the persistence result was rejected, the pipeline:
1. Retries `persistence.append` once with a 500ms delay.
2. If the retry also fails, it builds a recovery row (tab-separated, same schema as Sheets) and passes it to the notifier as `options.recoveryRow`.
3. The notifier embeds the recovery row in the operator email with a warning block ("Sheets write failed — paste this row manually").

This means the operator always has the booking data even when Sheets is unavailable.

### Stage 9 — Idempotency cache write

After a successful response is assembled, if an `Idempotency-Key` was present and an `idempotencyStore` is wired, the response is cached. Subsequent requests with the same key return the cached response from Stage 0 without re-running the pipeline.

---

## Error codes

| Code | HTTP Status | Retryable | When it occurs |
|---|---|---|---|
| `INPUT_INVALID` | 400 | No | Zod validation failed. `issues` field lists per-field errors. |
| `SPAM_DETECTED` | 400 | No | Honeypot field was non-empty. |
| `RATE_LIMITED` | 429 | Yes | Too many requests from this IP in the time window. |
| `DUPLICATE_SUBMISSION` | 409 | No | Same fingerprint seen within the dedup TTL window. |
| `TIME_UNAVAILABLE` | 409 | No | The requested slot is no longer available (taken between slot picker and submit). |
| `BOOKING_FAILED` | 502 | Yes | Vendor returned a non-fatal error or a transient failure. |
| `DEPENDENCY_UNAVAILABLE` | 503 | No | Vendor configuration error (service not mapped, missing location ID, auth failure). Operator action required. |
| `PERSISTENCE_FAILED` | 502 | Yes | Sheets write failed and recovery row embed failed too. Booking confirmed; operator email has recovery row. |
| `NOTIFICATION_FAILED` | 502 | Yes | Notification failed. Booking confirmed. |
| `CONFIG_INVALID` | 400 | No | `BookingKitConfig` failed validation at startup (surfaces at first request). |
| `UNKNOWN_ERROR` | 500 | Yes | Unexpected error. Check logs for `submissionId + bounded stack`. |

**The `retryable` field** tells the frontend whether to show a "Try again" button. Non-retryable errors need user action (pick a different time, fix the form). Retryable errors are transient.

---

## Response shapes

### Success

```typescript
// HTTP 200
{
  success:             true,
  submissionId:        string,  // e.g. "bk_20260507_a1b2c3d4"
  confirmationCode:    string,  // vendor-issued, shown to user
  vendorAppointmentId: string,  // vendor's internal appointment ID
}
```

### Failure

```typescript
// HTTP 400 | 409 | 429 | 500 | 502 | 503
{
  ok:        false,
  errorCode: string,    // one of the codes above
  message:   string,    // human-readable, safe to display in UI
  retryable: boolean,
  issues?:   Array<{ field: string; message: string }>  // only on INPUT_INVALID
}
```

---

## PII safety (Pattern 14)

The `Logger` type accepted by the pipeline has a typed signature that does not accept free-form payloads:

```typescript
type LogEvent = {
  level:         LogLevel
  evt:           string           // event name, e.g. 'booking.confirm.failed'
  submissionId?: string
  code?:         string
  durationMs?:   number
  vendor?:       string
  message?:      string
  stack?:        string           // truncated to 500 chars
  ctx?:          Record<string, string | number | boolean>  // non-PII only
}
```

The `ctx` field is a free-form record but is documented as "non-PII." Adapter and pipeline authors are responsible for never putting names, phones, or emails in `ctx`. The pipeline itself never logs request body contents — only `submissionId`, event names, and error codes.

---

## Domain events

The pipeline publishes typed, past-tense events to the `DomainEventBus`. The default bus is a noop (does nothing). Wire a real bus to add cross-cutting behavior without modifying the pipeline.

| Event | When |
|---|---|
| `booking.requested` | After dedup passes, before vendor calls |
| `booking.session.created` | After `createSession` succeeds |
| `booking.confirmed` | After `confirm` succeeds |
| `booking.failed` | After `createSession` or `confirm` throws |
| `booking.cancelled` | After `cancel(session)` is called (compensation) |
| `booking.spam_rejected` | Honeypot fired |
| `booking.duplicate_rejected` | Dedup hit |

Subscribers (conversion uploader, audit logger, custom webhook) react to these events without the pipeline knowing about them.

---

## Sweeper

The `createSweeper` function (in `src/server/sweeper.ts`) is a background job that runs against the state store. It finds rows that have been in `pending` status longer than a threshold (default 10 minutes) and transitions them to `abandoned`.

An `abandoned` row means the process likely died between `createSession` and `confirm` — the vendor session may have leaked. The sweeper logs the `submissionId` for operator review.

Wire the sweeper in a cron job or serverless scheduled function:
```typescript
import { createSweeper } from '@vizuh/apointoo-sdk/server'

const sweeper = createSweeper({ stateStore, logger, thresholdMs: 10 * 60 * 1000 })
// Call sweeper.run() on a schedule (e.g. every 5 minutes)
await sweeper.run()
```
