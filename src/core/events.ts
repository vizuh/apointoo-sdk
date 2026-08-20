// Domain events — pipeline emits, subscribers handle. Decouples cross-cutting
// concerns (audit, conversions, custom integrations) from the orchestration.
// ADR-012.
//
// Pragmatic event-driven (not strict): the pipeline still does the work
// inline AND emits events. Subscribers add behavior without modifying the
// pipeline. Strict event sourcing would mean ONLY emitting events and
// having subscribers do the work — that refactor is deferred.

import type { BookingAttribution } from './schemas.js'

export type DomainEvent =
  | BookingRequestedEvent
  | BookingSessionCreatedEvent
  | BookingConfirmedEvent
  | BookingRescheduledEvent
  | BookingFailedEvent
  | BookingCancelledEvent
  | BookingAbandonedEvent
  | BookingDuplicateRejectedEvent
  | BookingSpamRejectedEvent
  | BookingCompensationFailedEvent
  | AppointmentStatusChangedEvent

export type DomainEventBase = {
  /** Unix ms timestamp the event was emitted. */
  ts: number
  /** Tenant id (single-tenant deployments use config.projectKey). */
  tenantId: string
  /** Submission ID this event is about. */
  submissionId: string
}

export type BookingRequestedEvent = DomainEventBase & {
  type: 'booking.requested'
  serviceId: string
  attribution: BookingAttribution
  /** Optional client-supplied idempotency key (Idempotency-Key header). */
  idempotencyKey: string | undefined
}

export type BookingSessionCreatedEvent = DomainEventBase & {
  type: 'booking.session.created'
  vendor: string
  vendorSessionId: string
}

export type BookingConfirmedEvent = DomainEventBase & {
  type: 'booking.confirmed'
  vendor: string
  vendorAppointmentId: string
  vendorClientId: string | undefined
  attribution: BookingAttribution
}

export type BookingRescheduledEvent = DomainEventBase & {
  type: 'booking.rescheduled'
  vendor: string
  vendorAppointmentId: string
  newStartIso: string
}

export type BookingFailedEvent = DomainEventBase & {
  type: 'booking.failed'
  errorCode: string
  /** Where in the pipeline it failed. */
  stage: 'createSession' | 'confirm' | 'compensation'
}

export type BookingCancelledEvent = DomainEventBase & {
  type: 'booking.cancelled'
  reason: string
}

export type BookingAbandonedEvent = DomainEventBase & {
  type: 'booking.abandoned'
  /** Minutes between createdAt and the sweep that marked abandoned. */
  ageMinutes: number
}

export type BookingDuplicateRejectedEvent = DomainEventBase & {
  type: 'booking.duplicate_rejected'
  fingerprint: string
}

export type BookingSpamRejectedEvent = DomainEventBase & {
  type: 'booking.spam_rejected'
}

export type BookingCompensationFailedEvent = DomainEventBase & {
  type: 'booking.compensation_failed'
  vendor: string
  /** The vendor session id that could not be cancelled. */
  vendorSessionId: string
  /** The confirm-step error code that triggered compensation. */
  originalErrorCode: string
  /** The cancel-step error message (best-effort cleanup failed). */
  cancelError: string
}

/**
 * Emitted when an inbound vendor webhook (e.g., BLVD) tells us an appointment
 * changed status post-confirmation. Subscribers update CRM lifecycle (Brevo
 * segments for no-show / completed) and propagate to consumer webhooks.
 *
 * Note: `submissionId` may be the kit's submission id when we can map the
 * vendor appointment back, or a synthetic id (`vendor:<vendorAppointmentId>`)
 * when the inbound payload is the only source.
 */
export type AppointmentStatusChangedEvent = DomainEventBase & {
  type: 'appointment.status_changed'
  vendor: string
  vendorAppointmentId: string
  /** Normalized status. `unknown` when the vendor reports a status we don't model. */
  status: 'confirmed' | 'completed' | 'cancelled' | 'no_show' | 'rescheduled' | 'unknown'
  /** Raw vendor status string, for debugging / future mapping. */
  vendorStatus: string
  /** Vendor-supplied event timestamp in ISO 8601, if present. */
  occurredAtIso: string | undefined
}

// ── Bus ─────────────────────────────────────────────────────────────────────

export type DomainEventType = DomainEvent['type']

export type SubscriberHandler<T extends DomainEventType> = (
  event: Extract<DomainEvent, { type: T }>,
) => Promise<void> | void

export interface DomainEventBus {
  publish(event: DomainEvent): Promise<void>
  subscribe<T extends DomainEventType>(type: T, handler: SubscriberHandler<T>): () => void
  /** Subscribe to ALL events. Useful for audit logger. */
  subscribeAll(handler: (event: DomainEvent) => Promise<void> | void): () => void
}

// ── In-memory bus ──────────────────────────────────────────────────────────
// Synchronous publish: subscribers run via Promise.allSettled. One subscriber
// failing doesn't abort the others. The publisher (pipeline) doesn't await
// individual subscribers — slow subscribers shouldn't block the booking.

export type InMemoryEventBusOptions = {
  /** Optional sink for subscriber errors. Default: swallowed. */
  onSubscriberError?: (event: DomainEvent, err: unknown) => void
}

export function inMemoryEventBus(opts: InMemoryEventBusOptions = {}): DomainEventBus {
  const subs = new Map<DomainEventType, Set<(e: DomainEvent) => Promise<void> | void>>()
  const wildcardSubs = new Set<(e: DomainEvent) => Promise<void> | void>()

  return {
    async publish(event: DomainEvent) {
      const handlers = subs.get(event.type)
      const promises: Array<Promise<unknown>> = []
      if (handlers) {
        for (const h of handlers) {
          promises.push(
            Promise.resolve()
              .then(() => h(event))
              .catch((err) => opts.onSubscriberError?.(event, err)),
          )
        }
      }
      for (const h of wildcardSubs) {
        promises.push(
          Promise.resolve()
            .then(() => h(event))
            .catch((err) => opts.onSubscriberError?.(event, err)),
        )
      }
      // Don't await — fire-and-forget for pipeline non-blocking.
      // Tests can flush via a dedicated `await Promise.all(promises)` if exposed.
      void Promise.allSettled(promises)
    },
    subscribe<T extends DomainEventType>(type: T, handler: SubscriberHandler<T>) {
      let set = subs.get(type)
      if (!set) {
        set = new Set()
        subs.set(type, set)
      }
      const erased = handler as (e: DomainEvent) => Promise<void> | void
      set.add(erased)
      return () => {
        set?.delete(erased)
      }
    },
    subscribeAll(handler) {
      wildcardSubs.add(handler)
      return () => {
        wildcardSubs.delete(handler)
      }
    },
  }
}

// No-op bus for consumers that haven't wired one — publish swallows everything.
export function noopEventBus(): DomainEventBus {
  return {
    async publish() {},
    subscribe() {
      return () => undefined
    },
    subscribeAll() {
      return () => undefined
    },
  }
}
