// Health check builder. Aggregates adapter health into a single response.
// Cheap by design — adapters' health() should not exceed ~200ms each.

import type { BookingAdapter } from '../adapters/booking/adapter.js'
import type { PersistenceAdapter } from '../adapters/persistence/adapter.js'
import type { Notifier } from '../adapters/notification/adapter.js'
import type { DedupStore } from '../adapters/dedup/adapter.js'
import type { RateLimitStore } from '../adapters/ratelimit/adapter.js'
import type { AdapterContext, AdapterHealth } from '../core/types.js'
import { APOINTOO_HEADLESS_VERSION } from '../core/version.js'

export type HealthInputs = {
  ctx: AdapterContext
  booking: BookingAdapter
  persistence: PersistenceAdapter
  notification: Notifier
  dedup: DedupStore
  rateLimit?: RateLimitStore
}

export type HealthReport = {
  ok: boolean
  version: string
  adapters: {
    booking: AdapterHealth
    persistence: AdapterHealth
    notification: AdapterHealth
    dedup: { ok: boolean; name: string; error?: string }
    rateLimit?: { ok: boolean; name: string; error?: string }
  }
}

export async function buildHealthReport(inputs: HealthInputs): Promise<HealthReport> {
  const [bookingHealth, persistenceHealth, notificationHealth, dedupHealth, rateLimitHealth] =
    await Promise.all([
      inputs.booking.health(inputs.ctx),
      inputs.persistence.health(inputs.ctx),
      inputs.notification.health(inputs.ctx),
      inputs.dedup.health(),
      inputs.rateLimit ? inputs.rateLimit.health() : Promise.resolve(undefined),
    ])

  const allOk =
    bookingHealth.ok &&
    persistenceHealth.ok &&
    notificationHealth.ok &&
    dedupHealth.ok &&
    (rateLimitHealth?.ok ?? true)

  return {
    ok: allOk,
    version: APOINTOO_HEADLESS_VERSION,
    adapters: {
      booking: bookingHealth,
      persistence: persistenceHealth,
      notification: notificationHealth,
      dedup: dedupHealth,
      ...(rateLimitHealth ? { rateLimit: rateLimitHealth } : {}),
    },
  }
}
