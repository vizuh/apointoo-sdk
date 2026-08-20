// Zod schemas — single source of truth for runtime validation + TS types.
// Keep schemas tight: every field that accepts user input goes through here.

import { z } from 'zod'

// ── Primitives ──────────────────────────────────────────────────────────────

const E164 = /^\+?[1-9]\d{6,14}$/
// RFC-5322-flavoured but pragmatic: rejects most garbage without matching the
// full grammar (which would be ~1KB of regex). Real validation is at the vendor.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/

export const phoneSchema = z
  .string()
  .trim()
  .refine((v) => E164.test(v.replace(/[\s().-]/g, '')), {
    message: 'Phone must be E.164 (digits, optional leading +).',
  })

export const emailSchema = z
  .string()
  .trim()
  .max(254)
  .refine((v) => EMAIL.test(v), { message: 'Invalid email.' })

export const isoDateSchema = z.string().regex(ISO_DATE, 'Date must be YYYY-MM-DD')
export const hhmmSchema = z.string().regex(HH_MM, 'Time must be HH:MM (24h)')

// Time window: one open period in a day, e.g. { start: '09:00', end: '12:30' }.
// Multiple windows in a day implement breaks (e.g. lunch).
export const timeWindowSchema = z
  .object({
    start: hhmmSchema,
    end: hhmmSchema,
  })
  .strict()
  .refine((w) => w.start < w.end, { message: 'window.end must be after window.start' })

export type TimeWindow = z.infer<typeof timeWindowSchema>

// ── Attribution ─────────────────────────────────────────────────────────────
// Channel taxonomy + click IDs used across browser and server attribution
// surfaces.
// Each click ID is the platform's per-click identifier the platform expects
// back at conversion time. Each browser ID is what the platform's pixel sets.

export const bookingChannelSchema = z.enum([
  'paid_search', // gclid present OR utm_medium=cpc/ppc
  'paid_social', // fbclid/twclid/etc OR utm_medium=paidsocial
  'paid_other', // utm_medium=display/affiliate/sponsored
  'organic_search', // referrer is google/bing/yahoo/etc + no click ID
  'organic_social', // referrer is facebook/instagram/etc + no click ID
  'email', // utm_medium=email OR mc_cid/mc_eid present
  'referral', // any other off-site referrer
  'direct', // no referrer + no UTM + no click ID
  'unknown',
])

export type BookingChannel = z.infer<typeof bookingChannelSchema>

// Google Consent Mode v2 snapshot. This shape is shared with the dashboard
// intake contract so consent provenance survives from capture to conversion.
export const consentDimensionSchema = z.enum(['granted', 'denied'])
export const consentSourceSchema = z.enum(['gtm', 'cookieyes', 'denied-fallback', 'api'])
export const consentVectorSchema = z
  .object({
    adStorage: consentDimensionSchema,
    analyticsStorage: consentDimensionSchema,
    adUserData: consentDimensionSchema,
    adPersonalization: consentDimensionSchema,
    capturedAt: z.string().datetime({ offset: true }),
    source: consentSourceSchema,
  })
  .strict()

export type ConsentVector = z.infer<typeof consentVectorSchema>

// Touch — snapshot of attribution at one moment in the visitor's journey.
// Two of these may be stored per booking: first touch (OG attribution) and
// last touch (the click that triggered THIS submission).
export const touchSchema = z
  .object({
    timestampIso: z.string().trim().max(40).optional(),
    landingPage: z.string().trim().max(2048).optional(),
    referrer: z.string().trim().max(2048).optional(),
    channel: bookingChannelSchema.optional(),
    // Click IDs (per-platform)
    gclid: z.string().trim().max(512).optional(),
    wbraid: z.string().trim().max(512).optional(),
    gbraid: z.string().trim().max(512).optional(),
    dclid: z.string().trim().max(512).optional(),
    fbclid: z.string().trim().max(512).optional(),
    msclkid: z.string().trim().max(512).optional(),
    ttclid: z.string().trim().max(512).optional(),
    twclid: z.string().trim().max(512).optional(),
    li_fat_id: z.string().trim().max(512).optional(),
    sccid: z.string().trim().max(512).optional(),
    snap_cid: z.string().trim().max(512).optional(),
    epik: z.string().trim().max(512).optional(),
    pin_cid: z.string().trim().max(512).optional(),
    rdt_cid: z.string().trim().max(512).optional(),
    mc_cid: z.string().trim().max(512).optional(),
    mc_eid: z.string().trim().max(512).optional(),
    // UTM (extended GA4)
    utmSource: z.string().trim().max(255).optional(),
    utmMedium: z.string().trim().max(255).optional(),
    utmCampaign: z.string().trim().max(255).optional(),
    utmTerm: z.string().trim().max(255).optional(),
    utmContent: z.string().trim().max(255).optional(),
    utmId: z.string().trim().max(255).optional(),
    utmSourcePlatform: z.string().trim().max(255).optional(),
    utmCreativeFormat: z.string().trim().max(255).optional(),
    utmMarketingTactic: z.string().trim().max(255).optional(),
  })
  .strict()

export type Touch = z.infer<typeof touchSchema>

// Browser-side identifiers — set by ad pixels, needed for Conversions API
// enhanced match (especially Meta + TikTok).
export const browserIdsSchema = z
  .object({
    fbc: z.string().trim().max(512).optional(),
    fbp: z.string().trim().max(512).optional(),
    ttp: z.string().trim().max(512).optional(),
    ga_client_id: z.string().trim().max(128).optional(),
    ga_session_id: z.string().trim().max(128).optional(),
    ga_session_number: z.string().trim().max(16).optional(),
  })
  .strict()

export const bookingAttributionSchema = z
  .object({
    // Last-touch fields — flat for back-compat with v0.5.0 and earlier.
    // When `lastTouch` is also set, these mirror `lastTouch.*`.
    gclid: z.string().trim().max(512).optional(),
    gbraid: z.string().trim().max(512).optional(),
    wbraid: z.string().trim().max(512).optional(),
    rwgToken: z.string().trim().max(512).optional(),
    fbclid: z.string().trim().max(512).optional(),
    msclkid: z.string().trim().max(512).optional(),
    utmSource: z.string().trim().max(255).optional(),
    utmMedium: z.string().trim().max(255).optional(),
    utmCampaign: z.string().trim().max(255).optional(),
    utmTerm: z.string().trim().max(255).optional(),
    utmContent: z.string().trim().max(255).optional(),
    referrer: z.string().trim().max(2048).optional(),
    pageUrl: z.string().trim().max(2048).optional(),
    pageTitle: z.string().trim().max(512).optional(),

    // Extended attribution (ClickTrail-aligned)
    firstTouch: touchSchema.optional(),
    lastTouch: touchSchema.optional(),
    channel: bookingChannelSchema.optional(),
    browserIds: browserIdsSchema.optional(),
    // Legacy boolean and envelope timestamp remain accepted for dashboard
    // compatibility; new capture surfaces should send the full vector.
    consentGiven: z.boolean().optional(),
    consent: consentVectorSchema.optional(),
    capturedAt: z.string().datetime({ offset: true }).optional(),

    sessionId: z.string().trim().max(128).optional(),
    visitorId: z.string().trim().max(128).optional(),
  })
  .strict()

export type BookingAttribution = z.infer<typeof bookingAttributionSchema>

// ── Input from wire ─────────────────────────────────────────────────────────
// Honeypot disguised as `website` (Pattern 3 — kept verbatim from old kit).
// Tracking carries attribution. Optional `metadata` covers ua/locale/timezone.

export const bookingRequestInputSchema = z
  .object({
    serviceId: z.string().trim().min(1).max(128),
    requestedDate: isoDateSchema,
    requestedTime: hhmmSchema,
    name: z.string().trim().min(1).max(120),
    phone: phoneSchema,
    email: emailSchema.optional(),
    message: z.string().trim().max(2000).optional(),
    isNewPatient: z.enum(['new', 'returning']).optional(),
    // Optional promo code. Validated server-side by the booking adapter at
    // session create — non-BLVD adapters silently ignore. See ADR-017.
    offerCode: z.string().trim().min(1).max(64).optional(),
    website: z.string().trim().max(2000).optional(),
    tracking: bookingAttributionSchema.optional(),
    metadata: z
      .object({
        userAgent: z.string().trim().max(512).optional(),
        locale: z.string().trim().max(32).optional(),
        timezone: z.string().trim().max(64).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()

export type BookingRequestInputWire = z.infer<typeof bookingRequestInputSchema>

// ── Domain entities ─────────────────────────────────────────────────────────

export const bookingServiceSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().optional(),
    durationLabel: z.string().optional(),
    priceLabel: z.string().optional(),
    requiresMessage: z.boolean().optional(),
    isActive: z.boolean().optional(),
  })
  .strict()

export type BookingService = z.infer<typeof bookingServiceSchema>

export const bookingKitConfigSchema = z
  .object({
    projectKey: z.string().min(1).max(64),
    businessName: z.string().min(1),
    locale: z.string().min(2),
    timezone: z.string().min(1),
    location: z
      .object({
        address: z.string().optional(),
        city: z.string().optional(),
        phone: z.string().optional(),
        mapsUrl: z.string().optional(),
      })
      .strict()
      .optional(),
    services: z.array(bookingServiceSchema).min(1),
    scheduling: z
      .object({
        // Legacy: flat list of days the business operates. Kept for back-compat.
        // When `weeklySchedule` is also set, it takes precedence.
        availableDays: z.array(z.number().int().min(0).max(6)),
        timeSlots: z.array(
          z
            .object({
              label: z.string(),
              value: hhmmSchema,
              isActive: z.boolean().optional(),
            })
            .strict(),
        ),
        // Day-by-day windows. When set, supersedes timeSlots+availableDays for
        // slot generation. Each window is one open period; multiple windows
        // implement a lunch break.
        weeklySchedule: z
          .object({
            sun: z.array(timeWindowSchema).optional(),
            mon: z.array(timeWindowSchema).optional(),
            tue: z.array(timeWindowSchema).optional(),
            wed: z.array(timeWindowSchema).optional(),
            thu: z.array(timeWindowSchema).optional(),
            fri: z.array(timeWindowSchema).optional(),
            sat: z.array(timeWindowSchema).optional(),
          })
          .strict()
          .optional(),
        minAdvanceDays: z.number().int().min(0),
        maxAdvanceDays: z.number().int().min(1),
        blackoutDates: z.array(isoDateSchema).optional(),
        // Cancellation policy — enforced by DELETE /booking/:id handler.
        cancellationPolicy: z
          .object({
            minHoursBefore: z.number().int().min(0),
          })
          .strict()
          .optional(),
      })
      .strict(),
    notifications: z
      .object({
        from: z.string(),
        fromName: z.string().optional(),
        to: z.array(z.string()).min(1),
        bcc: z.array(z.string()).optional(),
        subjectPrefix: z.string().optional(),
      })
      .strict()
      .optional(),
    capabilities: z
      .object({
        payments: z.boolean().optional(),
        smsConfirmation: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()

export type BookingKitConfig = z.infer<typeof bookingKitConfigSchema>
