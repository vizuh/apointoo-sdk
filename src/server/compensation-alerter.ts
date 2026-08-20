// Compensation alerter — subscribes to `booking.compensation_failed` events
// and enqueues an operator alert when best-effort compensation fails.
//
// Shape mirrors the sweeper's alert option triplet (alertQueue +
// alertChannel + alertPayloadBuilder) so consumers wire alerting the same
// way for both stale-pending sweep and compensation-failure paths.

import { errMessage } from '../core/errors.js'
import type { OutboundQueue, QueueChannel } from '../queue/adapter.js'
import type {
  BookingCompensationFailedEvent,
  DomainEventBus,
} from '../core/events.js'
import type { Logger } from '../core/types.js'

export type CompensationAlerterOptions = {
  bus: DomainEventBus
  /** Optional: when omitted, the subscriber is a no-op (defensive). */
  alertQueue?: OutboundQueue
  alertChannel?: QueueChannel
  /**
   * Optional payload shaper. If omitted (and alertQueue+alertChannel are set),
   * a sensible default payload is enqueued.
   */
  alertPayloadBuilder?: (event: BookingCompensationFailedEvent) => Record<string, unknown>
  logger: Logger
}

/**
 * Subscribe to `booking.compensation_failed`. Returns an unsubscribe function.
 *
 * Wiring example:
 *
 *   const unsubscribe = subscribeCompensationAlerts({
 *     bus,
 *     alertQueue: queue,
 *     alertChannel: 'email',
 *     alertPayloadBuilder: (e) => ({ to: 'ops@example.com', ... }),
 *     logger,
 *   })
 */
export function subscribeCompensationAlerts(
  opts: CompensationAlerterOptions,
): () => void {
  return opts.bus.subscribe('booking.compensation_failed', async (event) => {
    if (!opts.alertQueue || !opts.alertChannel) {
      // Defensive no-op — consumer didn't wire alerting. Still log so the
      // failure isn't entirely silent.
      opts.logger.warn({
        evt: 'compensation_alerter.skipped',
        submissionId: event.submissionId,
        ctx: {
          tenantId: event.tenantId,
          vendor: event.vendor,
          reason: 'no_alert_queue_or_channel',
        },
      })
      return
    }

    const payload = opts.alertPayloadBuilder
      ? opts.alertPayloadBuilder(event)
      : defaultPayload(event)

    try {
      await opts.alertQueue.enqueue({
        tenantId: event.tenantId,
        submissionId: event.submissionId,
        channel: opts.alertChannel,
        payload,
      })
      opts.logger.warn({
        evt: 'compensation_alerter.enqueued',
        submissionId: event.submissionId,
        ctx: {
          tenantId: event.tenantId,
          vendor: event.vendor,
          vendorSessionId: event.vendorSessionId,
          originalErrorCode: event.originalErrorCode,
        },
      })
    } catch (err) {
      opts.logger.error({
        evt: 'compensation_alerter.enqueue_failed',
        submissionId: event.submissionId,
        message: errMessage(err),
      })
    }
  })
}

function defaultPayload(
  event: BookingCompensationFailedEvent,
): Record<string, unknown> {
  return {
    kind: 'compensation_failed',
    submissionId: event.submissionId,
    tenantId: event.tenantId,
    vendor: event.vendor,
    vendorSessionId: event.vendorSessionId,
    originalErrorCode: event.originalErrorCode,
    cancelError: event.cancelError,
    ts: event.ts,
  }
}
