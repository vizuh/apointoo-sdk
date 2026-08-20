// tests/live/blvd.test.ts — Tier 5 (live, gated). Run: LIVE=1 npm run test:live
// Requires repo Secrets: BLVD_API_KEY, BLVD_BUSINESS_ID (sandbox).
import { describe, expect, it } from 'vitest'
import type { AdapterContext, Logger } from '../../src/core/types.js'
import type { BookingKitConfig } from '../../src/core/schemas.js'

const LIVE = process.env.LIVE === '1'

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

const probeConfig: BookingKitConfig = {
  projectKey: 'live-test',
  businessName: 'Live Probe',
  locale: 'en-US',
  timezone: 'America/New_York',
  services: [{ id: 'probe', name: 'Probe', isActive: true }],
  scheduling: {
    availableDays: [1, 2, 3, 4, 5],
    timeSlots: [{ label: '10:00', value: '10:00' }],
    minAdvanceDays: 0,
    maxAdvanceDays: 90,
  },
}

describe.skipIf(!LIVE)('BLVD sandbox — live adapter smoke', () => {
  it('adapter.health() returns ok:true on sandbox credentials', async () => {
    const apiKey = process.env['BLVD_API_KEY']
    const businessId = process.env['BLVD_BUSINESS_ID']
    const apiUrl =
      process.env['BLVD_API_URL'] ?? 'https://sandbox.joinblvd.com/api/2020-01'
    const defaultLocationId = process.env['BLVD_DEFAULT_LOCATION_ID'] ?? ''
    if (!apiKey || !businessId) {
      throw new Error('BLVD_API_KEY + BLVD_BUSINESS_ID required for live tests')
    }
    // Dynamic import keeps the live adapter out of gate CI's import graph.
    const { blvdAdapter } = await import('../../src/adapters/booking/blvd/index.js')
    const adapter = blvdAdapter({
      apiKey,
      businessId,
      apiUrl,
      defaultLocationId,
      serviceMap: { probe: 'placeholder' },
    })
    const ctx: AdapterContext = {
      config: probeConfig,
      logger: silentLogger,
      now: () => new Date(),
    }
    const health = await adapter.health(ctx)
    expect(health.ok).toBe(true)
  }, 15_000)
})
