# Glossary — Ubiquitous Language

DDD discipline: every term below means exactly one thing inside this kit. Drift is a bug. New terms go through ADR review.

## Core domain

**Submission**
A single attempt by a user to create a booking. Each submission has one `submissionId`. The submission may succeed (→ confirmed booking) or fail (→ failed/abandoned). One human + one button click = one submission.

**Submission ID**
Format `bk_YYYYMMDD_<8-char-hex>`. Date in business timezone (Pattern 5). Generated server-side at the moment the request passes validation + dedup. Never client-supplied.

**Fingerprint**
SHA-256 of (lowercased name + digits-only phone + date + time + serviceId). Used for short-window dedup to catch double-clicks. NOT a security measure.

**Booking**
A confirmed appointment in the vendor system. `BookingConfirmation` carries the vendor's appointment ID, the kit's `confirmationCode`, and optional vendor-specific metadata.

**Booking adapter**
The component that talks to a vendor PMS (BLVD, OpenDental, Square…). Implements the `BookingAdapter` interface (createSession / attachAttribution / confirm / cancel / health).

**Vendor session**
The vendor's pre-booking handle. For BLVD it's the cart ID. For OpenDental it's the patient ID + intended slot. Opaque to the pipeline; only the booking adapter inspects it.

**Confirmation code**
Vendor-issued identifier returned to the user after successful booking. Currently equal to `vendorAppointmentId` for all adapters; kept as a separate field for future flexibility (e.g., adapters that issue a human-readable code).

## Lifecycle states

**Pending**
Booking accepted by the pipeline, vendor call in flight or pending. State store row exists. Not yet confirmed.

**Confirmed**
Vendor returned an appointment ID. Source of truth for "the booking exists."

**Failed**
Vendor rejected or the pipeline errored before confirm. Compensation (cancel) was attempted.

**Abandoned**
Sweeper found a `pending` row older than the threshold. Indicates likely vendor session leaked or process died mid-flight. Operator action required.

## Attribution

**Attribution**
The combined record of how a user reached the booking page: gclid (Google Ads), fbclid (Meta), msclkid (Microsoft), utm_*, referrer, page metadata, RwG token. Stored alongside the booking state for downstream conversion uploads.

**Click ID** (gclid / fbclid / msclkid / rwg_token)
Per-platform unique identifier the ad network mints when a user clicks an ad. Required for offline conversion uploads (Tier 3). 90-day attribution window for Google.

**RwG / Reserve-with-Google**
Google's flow that lets users book directly from search/Maps. Two halves: (1) token capture on the booking page, (2) feed publishing so Google knows merchants exist + which URL to deep-link to (`integration/rwg/`).

## Persistence + queue

**State store**
Durable record of booking lifecycle. PHI-minimized — never stores name/phone/email. Source of truth for "did we accept this submission?" Used by sweeper, conversion uploader, admin dashboard. Default impl: Supabase Postgres.

**Outbound queue**
FIFO-ish durable queue for notifications. Workers claim items via SELECT FOR UPDATE SKIP LOCKED, deliver, ack. Failed items get exponential backoff. After max attempts, status flips to `dead` (operator inspection).

**Outbox**
Atomic write of state row + queue items in one DB transaction. Solves the "state written but queue not enqueued" race. Falls back to two sequential writes when no transactional outbox impl is wired.

**Persistence (Sheets)**
Operator-readable log. Best-effort, retry-once, contains PHI. NOT the source of truth for booking existence — that's the state store. Kept for human eyes (the operator opens the sheet to triage).

**Recovery row**
A tab-separated row embedded in the operator email when the Sheets append fails (Pattern 15). Operator can paste manually. Schema lives in `core/persistence-row.ts`.

## Notification

**Notifier**
Component that delivers operator-facing notifications. `Notifier` interface; impls = Brevo REST (email), Twilio WhatsApp, multi (fan-out). Reads from queue items in the production path.

**Multi notifier**
A `Notifier` that fans out to N child notifiers via Promise.allSettled. Partial failures log + continue; total failure throws.

**Recovery block**
A warning section embedded in the email body when Pattern-15 recovery fires. Carries the recovery row + reason text.

## Resilience

**Compensation**
The cancel action invoked when `confirm()` rejects after vendor session creation. Best-effort; idempotent. Releases vendor-side reservations to prevent slot leaks.

**Saga**
The whole booking transaction modeled as a series of steps with compensations. Implicit in the pipeline; not formalized as a saga library yet (would be over-engineering at current scale).

**Circuit breaker**
A wrapper around `BookingAdapter` that trips after N failures in a window, fast-failing requests for a cooldown period. Prevents hammering a known-down vendor.

**Idempotency key**
Client-supplied header value (`Idempotency-Key`). When present + cached, the pipeline returns the cached response instead of re-running. Stripe convention.

**Dedup**
Server-side fingerprint-based check to catch double-submits. Distinct from idempotency: dedup catches accidental duplicates (refresh, double-click); idempotency lets clients deliberately retry.

## Integration

**Tenant**
A single client of the kit. One tenant = one `BookingKitConfig`. Multi-tenant deployments use a `TenantResolver` to map requests to configs.

**Tenant resolver**
Middleware that maps a request → tenant + config. Built-in impls: static, path, host, header, remote.

**Domain event**
A typed, past-tense fact about something that happened (`booking.requested`, `booking.confirmed`, etc.). Pipeline emits via `DomainEventBus`; subscribers (audit, conversions, custom) react asynchronously.

**Sweeper**
Background job that queries the state store for stale `pending` rows, transitions them to `abandoned`, and optionally enqueues an alert.

**Conversion uploader** (planned)
Background job that queries the state store for `confirmed` rows with attribution + no upload yet, posts to Google Ads / Meta / Microsoft conversions APIs, marks `conversion_sent_at`.

## Anti-terms (don't use)

- ~~"Booking request"~~ inside the pipeline — collides with `BookingRequest` (the validated entity). Use "submission" for the user's intent + "booking" for the confirmed outcome.
- ~~"Patient"~~ — unless the tenant is a healthcare provider. Use "user" or "client" generically.
- ~~"Order"~~ — bookings aren't orders.
- ~~"Reservation"~~ — collides with BLVD's intermediate reserve step. Use "booking" for the final state.
