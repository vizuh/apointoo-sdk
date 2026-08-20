// Minimal Next.js App Router consumer.
// Drop in `app/api/booking/route.ts`. Wire the four adapters; the kit owns the rest.
//
// Environment: see `.env.local.example` at the kit root.
//
// ⚠ Supabase wiring: if you add the state store / outbound queue (supabaseStateStore,
// supabaseQueue) to this file, construct them once at module scope using the
// SERVICE-ROLE key. Do NOT wrap them with @supabase/ssr's createServerClient or
// share them with anything that mounts user-auth cookies — a leaked user session
// will override the service-role auth and you'll get RLS rejections on writes.
// See docs/handoff.md "Consumer wiring — Supabase service-role-key caveat".

import { createBookingHandler } from '../../src/server/index.js'
import { blvdAdapter } from '../../src/adapters/booking/blvd/index.js'
import { sheetsAdapter } from '../../src/adapters/persistence/sheets/index.js'
import { brevoRestAdapter } from '../../src/adapters/notification/brevo-rest/index.js'
import { upstashDedupStore } from '../../src/adapters/dedup/upstash.js'
import { memoryDedupStore } from '../../src/adapters/dedup/memory.js'
import { upstashRateLimitStore } from '../../src/adapters/ratelimit/upstash.js'
import type { BookingKitConfig } from '../../src/core/schemas.js'

// Project-specific config — usually lives in `lib/booking-config.ts`.
const config: BookingKitConfig = {
  projectKey: 'example-salon',
  businessName: 'Example Salon',
  locale: 'en-US',
  timezone: 'America/New_York',
  services: [
    { id: 'haircut', name: 'Haircut', isActive: true },
    { id: 'color', name: 'Color', isActive: true },
  ],
  scheduling: {
    availableDays: [1, 2, 3, 4, 5, 6],
    timeSlots: [
      { label: '10:00', value: '10:00' },
      { label: '11:00', value: '11:00' },
    ],
    minAdvanceDays: 1,
    maxAdvanceDays: 60,
  },
}

const env = process.env

const dedup = env.UPSTASH_REDIS_REST_URL
  ? upstashDedupStore({
      url: env.UPSTASH_REDIS_REST_URL,
      token: env.UPSTASH_REDIS_REST_TOKEN ?? '',
      keyPrefix: config.projectKey,
    })
  : memoryDedupStore()

const rateLimit = env.UPSTASH_REDIS_REST_URL
  ? upstashRateLimitStore({
      url: env.UPSTASH_REDIS_REST_URL,
      token: env.UPSTASH_REDIS_REST_TOKEN ?? '',
      limit: 20,
      windowMs: 60_000,
      keyPrefix: config.projectKey,
    })
  : undefined

const app = createBookingHandler({
  config,
  booking: blvdAdapter({
    apiKey: env.BLVD_API_KEY ?? '',
    businessId: env.BLVD_BUSINESS_ID ?? '',
    apiUrl: env.BLVD_API_URL ?? 'https://dashboard.boulevard.io/api/2020-01',
    defaultLocationId: env.BLVD_DEFAULT_LOCATION_ID ?? '',
    serviceMap: {
      haircut: env.BLVD_SERVICE_HAIRCUT ?? '',
      color: env.BLVD_SERVICE_COLOR ?? '',
    },
  }),
  persistence: sheetsAdapter({
    spreadsheetId: env.GOOGLE_SHEETS_SPREADSHEET_ID ?? '',
    tabName: env.GOOGLE_SHEETS_TAB_NAME ?? 'Bookings',
    clientEmail: env.GOOGLE_SERVICE_ACCOUNT_EMAIL ?? '',
    privateKey: env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY ?? '',
  }),
  notification: brevoRestAdapter({
    apiKey: env.BREVO_API_KEY ?? '',
    from: env.LEAD_FROM_EMAIL ?? '',
    ...(env.LEAD_FROM_NAME !== undefined ? { fromName: env.LEAD_FROM_NAME } : {}),
    defaultTo: (env.LEAD_NOTIFICATION_TO ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    defaultBcc: (env.LEAD_NOTIFICATION_BCC ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  }),
  dedup,
  ...(rateLimit !== undefined ? { rateLimit } : {}),
})

// Next.js App Router export shape — re-export Hono's fetch as the route handler.
export const POST = app.fetch
export const GET = app.fetch
