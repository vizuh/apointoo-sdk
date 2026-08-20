// multiNotifier — fan-out to N notifiers in parallel via Promise.allSettled.
// One failure doesn't abort the others. The pipeline already wraps notifier
// dispatch in allSettled — but that only sees ONE notifier. With multi, the
// pipeline still sees one but failures fan up as a single combined error.

import { BookingError } from '../../core/errors.js'
import type { Notifier, NotificationOptions } from './adapter.js'
import type {
  AdapterContext,
  AdapterHealth,
  BookingConfirmation,
  BookingRequest,
} from '../../core/types.js'
import { APOINTOO_HEADLESS_VERSION } from '../../core/version.js'

export function multiNotifier(notifiers: ReadonlyArray<Notifier>): Notifier {
  if (notifiers.length === 0) {
    throw new BookingError('CONFIG_INVALID', 'multiNotifier: at least one notifier required')
  }

  return {
    async sendBookingNotification(
      request: BookingRequest,
      confirmation: BookingConfirmation,
      options: NotificationOptions,
      ctx: AdapterContext,
    ): Promise<void> {
      const results = await Promise.allSettled(
        notifiers.map((n) => n.sendBookingNotification(request, confirmation, options, ctx)),
      )
      const failures = results
        .map((r, i) => ({ result: r, idx: i }))
        .filter(({ result }) => result.status === 'rejected')

      if (failures.length === 0) return
      if (failures.length === results.length) {
        throw new BookingError('NOTIFICATION_FAILED',
          `multiNotifier: all ${results.length} notifiers failed: ${failures
            .map((f) => (f.result as PromiseRejectedResult).reason)
            .join('; ')}`,
        )
      }
      // Partial failure: some sent, some didn't. Log via ctx; do not throw —
      // the operator at least got one channel. The queue worker handles retries.
      ctx.logger.warn({
        evt: 'multi_notifier.partial_failure',
        submissionId: request.submissionId,
        ctx: {
          totalNotifiers: notifiers.length,
          failed: failures.length,
          failureReasons: failures
            .map((f) => String((f.result as PromiseRejectedResult).reason))
            .join('|'),
        },
      })
    },

    async health(ctx: AdapterContext): Promise<AdapterHealth> {
      const healths = await Promise.all(notifiers.map((n) => n.health(ctx)))
      const allOk = healths.every((h) => h.ok)
      return {
        ok: allOk,
        name: 'multi',
        version: APOINTOO_HEADLESS_VERSION,
        details: Object.fromEntries(
          healths.map((h, i) => [`notifier_${i}_${h.name}`, h.ok ? 'ok' : (h.error ?? 'down')]),
        ),
      }
    },
  }
}
