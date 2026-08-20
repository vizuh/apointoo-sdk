// Sweeper — finds stale 'pending' booking states and reconciles them.
// Run as cron / scheduled function. Marks them 'abandoned' + alerts.

import { errMessage } from '../core/errors.js'
import type { BookingState, BookingStateStore } from '../adapters/state/adapter.js'
import type { OutboundQueue } from '../queue/adapter.js'
import type { AdapterContext, Logger } from '../core/types.js'
import type { DomainEventBus } from '../core/events.js'

export type SweeperOptions = {
  stateStore: BookingStateStore
  /**
   * Items in 'pending' older than this are treated as abandoned. Default 20min
   * per ADR-018 §10. The 10min default produced false positives on Vercel cold
   * starts (vendor confirm 200ms-5s + state-store write + cold-boot tax).
   * Tighten only after measuring typical end-to-end latency in staging.
   */
  staleAfterMinutes?: number
  /** Optional: enqueue an alert message per abandoned item. */
  alertQueue?: OutboundQueue
  alertChannel?: 'email' | 'webhook'
  alertPayloadBuilder?: (state: BookingState) => Record<string, unknown>
  /** Optional: domain event bus to publish `booking.abandoned` events. */
  eventBus?: DomainEventBus
  logger: Logger
  /** Tenant-scoped sweep. Omit to sweep all tenants. */
  tenantId?: string
}

export type SweepSummary = {
  scanned: number
  marked: number
  alertsEnqueued: number
}

export async function runSweep(opts: SweeperOptions): Promise<SweepSummary> {
  const stale = await opts.stateStore.findStale(opts.staleAfterMinutes ?? 20, opts.tenantId)
  const summary: SweepSummary = { scanned: stale.length, marked: 0, alertsEnqueued: 0 }

  for (const state of stale) {
    try {
      await opts.stateStore.transition(state.submissionId, {
        status: 'abandoned',
        errorCode: 'SWEEPER_STALE_PENDING',
      })
      summary.marked += 1

      const ageMinutes = Math.floor((Date.now() - state.createdAt.getTime()) / 60_000)

      // Emit booking.abandoned domain event so subscribers (audit, conversions
      // claw-back, custom integrations) can react. Fire-and-forget per the
      // event-bus contract.
      if (opts.eventBus) {
        void opts.eventBus.publish({
          type: 'booking.abandoned',
          ts: Date.now(),
          tenantId: state.tenantId,
          submissionId: state.submissionId,
          ageMinutes,
        })
      }

      if (opts.alertQueue && opts.alertChannel && opts.alertPayloadBuilder) {
        await opts.alertQueue.enqueue({
          tenantId: state.tenantId,
          submissionId: state.submissionId,
          channel: opts.alertChannel,
          payload: opts.alertPayloadBuilder(state),
        })
        summary.alertsEnqueued += 1
      }

      opts.logger.warn({
        evt: 'sweeper.abandoned',
        submissionId: state.submissionId,
        ctx: {
          tenantId: state.tenantId,
          vendor: state.vendor,
          ageMinutes,
        },
      })
    } catch (err) {
      opts.logger.error({
        evt: 'sweeper.transition_failed',
        submissionId: state.submissionId,
        message: errMessage(err),
      })
    }
  }

  opts.logger.info({
    evt: 'sweeper.run_complete',
    ctx: {
      scanned: summary.scanned,
      marked: summary.marked,
      alertsEnqueued: summary.alertsEnqueued,
    },
  })
  return summary
}

// Re-export ctx type for convenience
export type { AdapterContext }
