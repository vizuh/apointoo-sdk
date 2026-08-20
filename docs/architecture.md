# Architecture

`@vizuh/apointoo-sdk` is a layered library. One Hono handler at the boundary; named bounded contexts behind it; pluggable adapter contracts so vendors slot in without changing pipeline code.

## Pipeline

1. **Intake** — receive the booking or form submission at the server boundary; create request context.
2. **Validate** — parse JSON, validate against the kit's zod schemas, reject honeypot spam, apply rate-limit and dedup checks when those adapters are wired.
3. **Adapter** — call the configured `BookingAdapter` to create a vendor session, attach attribution, and confirm (or compensate on failure via `cancel`).
4. **State** — write or transition PHI-free booking lifecycle state via the `BookingStateStore` (sweeper + admin reads consume this).
5. **Conversion** — report eligible confirmed bookings through a `ConversionReporter` when configured.
6. **Notification** — send operator notifications through a `Notifier`; fan-out via `multiNotifier`.
7. **Audit** — persist allow-listed audit payload fields through an `AuditLogWriter` (PHI fields stripped at the sanitizer boundary).

## Bounded contexts

| Context | Responsibility | Path |
|---|---|---|
| Core domain | Booking request types, schemas, errors, IDs, scheduling, events, persistence rows, version | `src/core/` |
| Adapter contracts | Provider boundaries: booking, notification, persistence, state, dedup, rate-limit, audit, conversion | `src/adapters/` |
| Server pipeline | Request handling, orchestration, health, logging, tenant resolution, webhooks, admin reads, sweeper, compensation alerting | `src/server/` |
| Queue + outbox | Outbound queue items, workers, memory / Supabase queue stores, outbox writers | `src/queue/` |
| Auth | JWT, password hashing, auth service, refresh-token + users stores | `src/auth/` |
| Attribution | Click ID + UTM + cookie + request attribution helpers | `src/attribution/` |
| Email | Rendered HTML + text templates + theme tokens | `src/email/` |
| Reserve-with-Google integration | Feed building, merchant sources, publishing, runner orchestration | `src/integration/rwg/` |

## Adapter contracts

The methods below are the minimum surface a concrete adapter must implement. Full type definitions live in `src/adapters/*/adapter.ts`.

### `BookingAdapter` — `src/adapters/booking/adapter.ts`

```ts
createSession(input: BookingRequestInput, ctx: AdapterContext): Promise<BookingSession>
attachAttribution(session: BookingSession, attribution: BookingAttribution): Promise<void>
confirm(session: BookingSession, request: BookingRequest): Promise<BookingConfirmation>
cancel(session: BookingSession, reason: string): Promise<void>
findAvailability(query: AvailabilityQuery, ctx: AdapterContext): Promise<AvailabilitySlot[]>
cancelByAppointment(vendorAppointmentId: string, reason: string, ctx: AdapterContext): Promise<void>
rescheduleByAppointment(vendorAppointmentId: string, newDate: string, newTime: string, ctx: AdapterContext): Promise<RescheduleResult>
findStaffVariants(query: StaffVariantsQuery, ctx: AdapterContext): Promise<StaffVariant[]>
health(): Promise<AdapterHealth>
```

### `Notifier` — `src/adapters/notification/adapter.ts`

```ts
sendBookingNotification(
  request: BookingRequest,
  confirmation: BookingConfirmation,
  options?: NotificationOptions,
): Promise<void>
health(): Promise<AdapterHealth>
```

`multiNotifier(notifiers[])` fans out a single send across multiple impls (e.g. Brevo email + Twilio WhatsApp).

### `BookingStateStore` — `src/adapters/state/adapter.ts`

```ts
create(state: BookingStateCreate): Promise<void>
transition(submissionId: string, change: BookingStateTransition): Promise<void>
get(submissionId: string): Promise<BookingState | null>
findStale(olderThanMinutes: number, tenantId?: string): Promise<BookingState[]>
findForConversion(tenantId?: string): Promise<BookingState[]>
markConversionSent(submissionId: string, sentAt: Date): Promise<void>
countByStatus(tenantId?: string): Promise<Record<BookingStateStatus, number>>
health(): Promise<{ ok: boolean; name: string; error?: string }>
```

PHI-free by contract — the state row carries `submissionId`, `status`, `tenantId`, `attribution`, `vendorAppointmentId`, and timestamps. Lead PII lives only in the persistence adapter (Sheets) and the operator notification (Brevo).

### `PersistenceAdapter` — `src/adapters/persistence/adapter.ts`

```ts
appendBooking(request: BookingRequest, confirmation: BookingConfirmation): Promise<void>
health(): Promise<AdapterHealth>
```

### `AuditLogWriter` — `src/adapters/audit/index.ts`

```ts
write(entry: AuditLogEntry): Promise<void>  // must be idempotent on entry.eventId
```

Entries are pre-sanitized — `sanitizePayload` strips PII via an allow-list before reaching the writer. Dashboard ships `mongoAuditLogWriter`; the SDK ships no concrete impl (no hard-wired driver).

## Event flow + queue model

The synchronous booking path records state and enqueues outbound work. Queue workers claim pending items, run handlers with exponential backoff, and mark items dead-letter when the retry policy is exhausted. The exported queue surface:

- `OutboundQueue`, `QueueItem` — interfaces
- `computeBackoff`, `shouldFlipToDead` — retry-policy helpers
- `runQueueBatch`, `runQueueLoop` — worker entry points
- outbox writers — `memoryOutboxWriter`, `supabaseOutboxWriter`

This is what lets a `confirm()` failure be retried without losing the customer's submission, and what powers the conversion-upload worker.

## Multi-tenant resolver

One deploy, N clients. The server layer includes tenant resolution in `src/server/tenant.ts`; admin routes pick the `tenantId` off the context variable. Tenant resolution runs BEFORE the pipeline so adapter keys, state namespace, dedup keys, rate-limit keys, and operator notification routing are all isolated per tenant from the first byte.

## Audit + PHI posture

The audit sanitizer is the load-bearing boundary between the pipeline and any external log destination. Allow-listed fields only — adding a new field requires touching the list explicitly. Any future event-type addition that wants to land in the audit log must extend the allow-list.

## What this doc does NOT cover

- Specific adapter wiring details — see [docs/adapters.md](./adapters.md)
- Pipeline error codes — see [docs/pipeline.md](./pipeline.md)
- Attribution capture / cookie shape — see [docs/attribution.md](./attribution.md)
- Migration history — see [docs/migrations/](./migrations/)
