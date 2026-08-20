// Outbound webhooks. Subscribes to DomainEventBus + enqueues queue items
// with channel='webhook'. Worker delivers via HTTP POST with HMAC signature.
// ADR-012 (event bus) + ADR-006 (queue retry).
//
// Why through the queue: webhooks need at-least-once delivery with retries.
// We already have a queue worker with exponential backoff + dead-letter.
// Subscribing directly to the bus would lose deliveries on subscriber error.

import { errMessage, BookingError } from '../core/errors.js'
import { createHmac } from 'node:crypto'
import { truncate } from '../core/internal/strings.js'
import type {
  AppointmentStatusChangedEvent,
  DomainEvent,
  DomainEventBus,
  DomainEventType,
} from '../core/events.js'
import type { OutboundQueue, QueueItem } from '../queue/adapter.js'
import type { Logger } from '../core/types.js'
import type { QueueHandler } from '../queue/worker.js'
import { BlvdError } from '../adapters/booking/blvd/errors.js'

export type WebhookSubscription = {
  /** Endpoint to POST to. */
  url: string
  /** HMAC-SHA256 secret. The receiver verifies via X-Apointoo-Signature header. */
  secret?: string
  /**
   * Event types this webhook receives. Default: all booking.* events.
   * Pass an empty array to disable.
   */
  events?: ReadonlyArray<DomainEventType>
  /** Optional label for logs. */
  label?: string
}

export type WebhookSubscriberOptions = {
  bus: DomainEventBus
  queue: OutboundQueue
  subscriptions: ReadonlyArray<WebhookSubscription>
  logger: Logger
}

/**
 * Wire webhook subscriptions. Returns an unsubscribe function.
 *
 * Each event matched by a subscription's `events` filter (or all if absent)
 * is enqueued as a queue item. The worker (with the webhook handler from
 * `webhookQueueHandler()`) does the actual HTTP POST.
 */
export function subscribeWebhooks(opts: WebhookSubscriberOptions): () => void {
  const unsubscribers: Array<() => void> = []
  for (const sub of opts.subscriptions) {
    const wantedTypes = sub.events
    const unsub = opts.bus.subscribeAll(async (event) => {
      if (wantedTypes) {
        // Empty array = explicit disable (per JSDoc).
        if (wantedTypes.length === 0) return
        if (!wantedTypes.includes(event.type)) return
      }
      try {
        await opts.queue.enqueue({
          tenantId: event.tenantId,
          submissionId: event.submissionId,
          channel: 'webhook',
          payload: {
            url: sub.url,
            ...(sub.secret !== undefined ? { secret: sub.secret } : {}),
            ...(sub.label !== undefined ? { label: sub.label } : {}),
            event,
          },
        })
      } catch (err) {
        opts.logger.warn({
          evt: 'webhook.enqueue_failed',
          submissionId: event.submissionId,
          message: errMessage(err),
        })
      }
    })
    unsubscribers.push(unsub)
  }
  return () => {
    for (const u of unsubscribers) u()
  }
}

// ── Queue handler — actual HTTP delivery ────────────────────────────────────

export type WebhookHandlerOptions = {
  /** Override fetch for tests. */
  fetchImpl?: typeof fetch
  /** Per-request timeout in ms. Default 10_000. */
  timeoutMs?: number
}

/**
 * Register this with the queue worker for `channel: 'webhook'`.
 *
 * @example
 *   runQueueLoop({
 *     queue, logger,
 *     handlers: { webhook: webhookQueueHandler({}) }
 *   })
 */
export function webhookQueueHandler(opts: WebhookHandlerOptions = {}): QueueHandler {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const timeoutMs = opts.timeoutMs ?? 10_000

  return async (item: QueueItem): Promise<void> => {
    const url = item.payload.url
    const secret = item.payload.secret
    const event = item.payload.event
    if (typeof url !== 'string' || !event) {
      throw new BookingError('INPUT_INVALID', 'webhookQueueHandler: payload.url and payload.event required')
    }
    const body = JSON.stringify({ event })
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'apointoo-sdk-webhooks/1.0',
      'X-Apointoo-Submission': item.submissionId,
      'X-Apointoo-Tenant': item.tenantId,
      'X-Apointoo-Delivery': item.id,
    }
    if (typeof secret === 'string' && secret.length > 0) {
      headers['X-Apointoo-Signature'] = signHmac(body, secret)
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let res: Response
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }

    // 2xx = success. Anything else is a retryable failure.
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new BookingError('NOTIFICATION_FAILED', `Webhook ${url} returned HTTP ${res.status}: ${truncate(text, 200)}`)
    }
  }
}

// ── Verification helper for receivers ───────────────────────────────────────

/**
 * Receivers verify the X-Apointoo-Signature header by computing the same HMAC
 * over the raw request body and comparing.
 *
 * Exported so consumers building webhook receivers can import it.
 */
export function verifyWebhookSignature(
  rawBody: string,
  receivedSignature: string,
  secret: string,
): boolean {
  if (!receivedSignature || !secret) return false
  const expected = signHmac(rawBody, secret)
  // Timing-safe compare via length-prefixed string comparison
  if (expected.length !== receivedSignature.length) return false
  let mismatch = 0
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ receivedSignature.charCodeAt(i)
  }
  return mismatch === 0
}

// ── Inbound BLVD appointment webhook ────────────────────────────────────────
//
// BLVD pushes appointment lifecycle events (cancel, complete, no-show) to a
// URL we expose. The kit verifies the HMAC, parses the payload, and publishes
// `appointment.status_changed` to the event bus. Outbound webhook subscribers
// (above) then re-broadcast to consumer URLs, and Brevo lifecycle subscribers
// (see notification/brevo-rest/contacts.ts) update CRM segments.
//
// BLVD's exact header / signature convention is not yet documented for this
// kit. The handler is structured so `signatureHeader`, `signaturePrefix`, and
// the parser are injection points — consumers can adapt as the spec firms up.
// Defaults follow the same HMAC-SHA256 hex convention used outbound.

export type BlvdAppointmentWebhookPayload = {
  /** Raw POST body (string). Required for HMAC verification. */
  rawBody: string
  /** Parsed headers, lowercased keys. */
  headers: Record<string, string>
}

export type BlvdAppointmentWebhookOptions = {
  bus: DomainEventBus
  logger: Logger
  /** Shared secret for HMAC verification. Required. */
  secret: string
  /** Tenant id to stamp on the emitted event. Single-tenant deployments pass `config.projectKey`. */
  tenantId: string
  /**
   * Header name carrying the signature, lowercased. Default: `x-blvd-signature`.
   * The kit's outbound webhooks use `x-apointoo-signature`; this is the inbound mirror.
   */
  signatureHeader?: string
  /**
   * Prefix on the signature value (matches `signHmac()`). Default: `sha256=`.
   * Pass an empty string for raw hex.
   */
  signaturePrefix?: string
  /**
   * Override the body parser. Default: JSON.parse with a permissive shape that
   * picks out `appointmentId`, `status`, `occurredAt` from common BLVD shapes.
   * Returning `null` from the parser is treated as a payload-shape error.
   */
  parsePayload?: (rawBody: string) => ParsedBlvdAppointment | null
}

export type ParsedBlvdAppointment = {
  vendorAppointmentId: string
  /** Raw vendor status string (e.g. 'CANCELLED', 'COMPLETED', 'NO_SHOW'). */
  vendorStatus: string
  /** ISO 8601 timestamp the vendor reports for the event. */
  occurredAtIso: string | undefined
  /** Optional: the kit's submission id if the consumer can map vendor→kit. */
  submissionId?: string
}

/**
 * Build an inbound handler for BLVD appointment-status webhooks.
 *
 * Returns a function the consumer wires into their HTTP route. The function
 * verifies the signature, parses the payload, and publishes
 * `appointment.status_changed` to the bus.
 *
 * Throws `BlvdError` on any failure path (missing signature, bad signature,
 * unparseable body, missing fields). The consumer's route handler maps these
 * to the appropriate HTTP status (typically 401 for signature failures, 400
 * for shape errors).
 *
 * @example
 *   const handler = blvdAppointmentWebhookHandler({ bus, logger, secret, tenantId })
 *   app.post('/webhooks/blvd/appointments', async (c) => {
 *     const rawBody = await c.req.text()
 *     try {
 *       await handler({ rawBody, headers: Object.fromEntries(c.req.raw.headers) })
 *       return c.body(null, 204)
 *     } catch (err) {
 *       if (isBlvdError(err) && err.code === 'AUTH_MISSING') return c.body(null, 401)
 *       throw err
 *     }
 *   })
 */
export function blvdAppointmentWebhookHandler(
  opts: BlvdAppointmentWebhookOptions,
): (input: BlvdAppointmentWebhookPayload) => Promise<void> {
  if (!opts.secret) {
    throw new BlvdError('AUTH_MISSING', 'blvdAppointmentWebhookHandler: secret is required')
  }
  const sigHeader = (opts.signatureHeader ?? 'x-blvd-signature').toLowerCase()
  const sigPrefix = opts.signaturePrefix ?? 'sha256='
  const parse = opts.parsePayload ?? defaultBlvdAppointmentParser

  return async ({ rawBody, headers }) => {
    const received = headers[sigHeader] ?? ''
    if (!received) {
      throw new BlvdError('AUTH_MISSING', `Missing ${sigHeader} header`)
    }
    const expected = `${sigPrefix}${createHmac('sha256', opts.secret).update(rawBody).digest('hex')}`
    if (!timingSafeEqualStr(expected, received)) {
      // Don't log either signature — they're auth material.
      opts.logger.warn({
        evt: 'blvd.webhook.signature_mismatch',
        message: 'inbound BLVD webhook signature did not verify',
      })
      throw new BlvdError('HTTP_ERROR', 'Signature verification failed')
    }

    let parsed: ParsedBlvdAppointment | null
    try {
      parsed = parse(rawBody)
    } catch (err) {
      throw new BlvdError(
        'GRAPHQL_ERROR',
        `Failed to parse BLVD webhook body: ${errMessage(err)}`,
      )
    }
    if (!parsed || !parsed.vendorAppointmentId || !parsed.vendorStatus) {
      throw new BlvdError(
        'GRAPHQL_ERROR',
        'BLVD webhook payload missing required fields (vendorAppointmentId, vendorStatus)',
      )
    }

    const submissionId = parsed.submissionId ?? `blvd:${parsed.vendorAppointmentId}`
    await opts.bus.publish({
      type: 'appointment.status_changed',
      ts: Date.now(),
      tenantId: opts.tenantId,
      submissionId,
      vendor: 'blvd',
      vendorAppointmentId: parsed.vendorAppointmentId,
      status: normalizeBlvdStatus(parsed.vendorStatus),
      vendorStatus: parsed.vendorStatus,
      occurredAtIso: parsed.occurredAtIso,
    })

    opts.logger.info({
      evt: 'blvd.webhook.appointment_status_changed',
      submissionId,
      vendor: 'blvd',
      code: parsed.vendorStatus,
    })
  }
}

function defaultBlvdAppointmentParser(rawBody: string): ParsedBlvdAppointment | null {
  const json = JSON.parse(rawBody) as unknown
  if (!json || typeof json !== 'object') return null
  const obj = json as Record<string, unknown>
  // Common BLVD shapes: { type, data: { id, state, occurredAt } } or flat.
  const data = (typeof obj.data === 'object' && obj.data !== null
    ? (obj.data as Record<string, unknown>)
    : obj)
  const vendorAppointmentId =
    pickString(data.appointmentId) ?? pickString(data.id) ?? pickString(obj.appointmentId)
  const vendorStatus =
    pickString(data.status) ?? pickString(data.state) ?? pickString(obj.status) ?? pickString(obj.event)
  const occurredAtIso =
    pickString(data.occurredAt) ?? pickString(data.updatedAt) ?? pickString(obj.occurredAt)
  if (!vendorAppointmentId || !vendorStatus) return null
  return {
    vendorAppointmentId,
    vendorStatus,
    occurredAtIso,
  }
}

function pickString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function normalizeBlvdStatus(raw: string): AppointmentStatusChangedEvent['status'] {
  const s = raw.toUpperCase()
  if (s === 'CONFIRMED' || s === 'BOOKED' || s === 'APPOINTMENT.BOOKED') return 'confirmed'
  if (s === 'COMPLETED' || s === 'CHECKED_OUT' || s === 'APPOINTMENT.COMPLETED') return 'completed'
  if (s === 'CANCELLED' || s === 'CANCELED' || s === 'APPOINTMENT.CANCELED') return 'cancelled'
  if (s === 'NO_SHOW' || s === 'NOSHOW' || s === 'APPOINTMENT.NO_SHOW') return 'no_show'
  if (s === 'RESCHEDULED' || s === 'APPOINTMENT.UPDATED') return 'rescheduled'
  return 'unknown'
}

function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

// ── Internals ───────────────────────────────────────────────────────────────

function signHmac(body: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
}

// Type-safe re-export to silence unused-warning if a consumer pattern-matches
// on the event type.
export type { DomainEvent }
