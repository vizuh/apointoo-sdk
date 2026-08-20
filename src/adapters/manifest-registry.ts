/**
 * Adapter manifest registry.
 *
 * Exports every known adapter manifest as individual named constants and as
 * a single `ADAPTER_MANIFESTS` array. This file has NO runtime dependencies
 * on any vendor SDK — it is safe to import in dashboard code that doesn't
 * bundle the adapter implementations.
 *
 * Usage:
 *   import { ADAPTER_MANIFESTS } from '@vizuh/apointoo-sdk/adapters/manifests'
 *   const bookingAdapters = ADAPTER_MANIFESTS.filter(m => m.kind === 'booking')
 */

import type { AdapterManifest } from './_shared/manifest.js'

// ─── Booking adapters ────────────────────────────────────────────────────────

export const MANIFEST_BOOKING_BLVD: AdapterManifest = {
  slug: 'blvd',
  kind: 'booking',
  name: 'Boulevard',
  description:
    'Connects to the Boulevard (BLVD) salon & spa platform via its GraphQL API. ' +
    'Uses an ephemeral cart pattern: createSession opens a cart, confirm checks out.',
  requiredEnvVars: ['BLVD_API_KEY', 'BLVD_BUSINESS_ID', 'BLVD_DEFAULT_LOCATION_ID'],
  optionalEnvVars: ['BLVD_API_URL'],
  capabilities: ['availability', 'staffVariants', 'attribution', 'promo', 'reschedule', 'cancel'],
  vendorApiVersion: '2024-01',
  docsUrl: 'https://docs.joinblvd.com/reference/api',
}

export const MANIFEST_BOOKING_RECAL: AdapterManifest = {
  slug: 'recal',
  kind: 'booking',
  name: 'Recal',
  description:
    'Calendar-backed booking via the Recal API (api.recal.dev). Manages Google/Microsoft ' +
    'OAuth server-side. No cart/session concept — confirmation writes directly to the calendar.',
  requiredEnvVars: ['RECAL_API_KEY'],
  capabilities: ['availability', 'attribution', 'reschedule', 'cancel'],
  // staffVariants omitted: Recal is single-calendar-owner; no per-slot staff picker.
  docsUrl: 'https://docs.recal.dev',
}

export const MANIFEST_BOOKING_OPENDENTAL: AdapterManifest = {
  slug: 'opendental',
  kind: 'booking',
  name: 'OpenDental',
  description:
    'Connects to the OpenDental practice management system REST API. ' +
    'SKELETON — all methods throw until a first dental client provides sandbox creds (ADR-008).',
  requiredEnvVars: [
    'OPENDENTAL_CUSTOMER_KEY',
    'OPENDENTAL_DEVELOPER_KEY',
    'OPENDENTAL_API_URL',
  ],
  capabilities: [],
  // No live capabilities until impl lands.
  docsUrl: 'https://www.opendental.com/site/apispec.html',
}

export const MANIFEST_BOOKING_MEMORY: AdapterManifest = {
  slug: 'memory-booking',
  kind: 'booking',
  name: 'In-Memory Booking (test)',
  description:
    'Stateless in-memory booking adapter for unit tests and local dev. ' +
    'Records calls for test assertions. Never use in production.',
  requiredEnvVars: [],
  capabilities: ['availability'],
  testOnly: true,
}

export const MANIFEST_BOOKING_DIRECT_CONFIRM: AdapterManifest = {
  slug: 'direct-confirm',
  kind: 'booking',
  name: 'Direct Confirm (no PMS)',
  description:
    'Production booking adapter for tenants with no PMS. Immediately confirms ' +
    'bookings without contacting a vendor; persistence is handled by whichever ' +
    'PersistenceAdapter / BookingStateStore is wired. Suitable for form-only ' +
    'lead capture (consultation requests, contact-style flows) and operators ' +
    'who manage their own calendar manually.',
  requiredEnvVars: [],
  capabilities: ['availability'],  // availability via kit slot generator only
}

// ─── Notification adapters ───────────────────────────────────────────────────

export const MANIFEST_NOTIFICATION_BREVO: AdapterManifest = {
  slug: 'brevo-rest',
  kind: 'notification',
  name: 'Brevo (transactional email)',
  description:
    'Sends booking notifications via the Brevo transactional email REST API. ' +
    'Used for operator-facing confirmation and recovery emails.',
  requiredEnvVars: ['BREVO_API_KEY'],
  optionalEnvVars: ['BREVO_SENDER_EMAIL', 'BREVO_SENDER_NAME', 'BREVO_TEMPLATE_ID'],
  docsUrl: 'https://developers.brevo.com/reference/sendtransacemail',
}

export const MANIFEST_NOTIFICATION_TWILIO_WHATSAPP: AdapterManifest = {
  slug: 'twilio-whatsapp',
  kind: 'notification',
  name: 'Twilio WhatsApp',
  description:
    'Sends booking notifications via Twilio WhatsApp messaging. ' +
    'Requires an approved WhatsApp sender number in the Twilio console.',
  requiredEnvVars: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER'],
  docsUrl: 'https://www.twilio.com/docs/whatsapp',
}

export const MANIFEST_NOTIFICATION_MEMORY: AdapterManifest = {
  slug: 'memory-notification',
  kind: 'notification',
  name: 'In-Memory Notifier (test)',
  description:
    'No-op notification adapter that records calls for test assertions. ' +
    'Never use in production.',
  requiredEnvVars: [],
  testOnly: true,
}

// ─── Dedup adapters ──────────────────────────────────────────────────────────

export const MANIFEST_DEDUP_UPSTASH: AdapterManifest = {
  slug: 'upstash-dedup',
  kind: 'dedup',
  name: 'Upstash Redis (dedup)',
  description:
    'Distributed fingerprint dedup store backed by Upstash Redis. ' +
    'Atomic check-and-set via INCR + PEXPIRE. Required in production ' +
    'where multiple serverless instances may process concurrent submissions.',
  requiredEnvVars: ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'],
  docsUrl: 'https://upstash.com/docs/redis/overall/getstarted',
}

export const MANIFEST_DEDUP_MEMORY: AdapterManifest = {
  slug: 'memory-dedup',
  kind: 'dedup',
  name: 'In-Memory Dedup (test)',
  description:
    'Single-process in-memory dedup store. Not safe across serverless instances. ' +
    'Use only in dev or single-replica deployments.',
  requiredEnvVars: [],
  testOnly: true,
}

// ─── Persistence adapters ────────────────────────────────────────────────────

export const MANIFEST_PERSISTENCE_SHEETS: AdapterManifest = {
  slug: 'google-sheets',
  kind: 'persistence',
  name: 'Google Sheets',
  description:
    'Appends booking submissions to a Google Sheet via the Sheets API v4. ' +
    'Suitable for small-volume tenants that want a no-database audit trail.',
  requiredEnvVars: [
    'GOOGLE_SHEETS_SPREADSHEET_ID',
    'GOOGLE_SERVICE_ACCOUNT_EMAIL',
    'GOOGLE_PRIVATE_KEY',
  ],
  docsUrl: 'https://developers.google.com/sheets/api/guides/values',
}

export const MANIFEST_PERSISTENCE_MEMORY: AdapterManifest = {
  slug: 'memory-persistence',
  kind: 'persistence',
  name: 'In-Memory Persistence (test)',
  description:
    'Stores submissions in process memory. Data is lost on restart. ' +
    'Use only in tests and local dev.',
  requiredEnvVars: [],
  testOnly: true,
}

// ─── State adapters ──────────────────────────────────────────────────────────

export const MANIFEST_STATE_SUPABASE: AdapterManifest = {
  slug: 'supabase-state',
  kind: 'state',
  name: 'Supabase (booking state)',
  description:
    'Stores booking state records in a Supabase Postgres database. ' +
    'Suitable for tenants with an existing Supabase project.',
  requiredEnvVars: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'],
  docsUrl: 'https://supabase.com/docs/reference/javascript/introduction',
}

export const MANIFEST_STATE_MEMORY: AdapterManifest = {
  slug: 'memory-state',
  kind: 'state',
  name: 'In-Memory State (test)',
  description:
    'Stores booking state in process memory. Data is lost on restart. ' +
    'Use only in tests and local dev.',
  requiredEnvVars: [],
  testOnly: true,
}

// ─── Rate-limit adapters ─────────────────────────────────────────────────────

export const MANIFEST_RATELIMIT_UPSTASH: AdapterManifest = {
  slug: 'upstash-ratelimit',
  kind: 'ratelimit',
  name: 'Upstash Redis (rate limit)',
  description:
    'Sliding-window rate limiter backed by Upstash Redis. ' +
    'Shared across serverless instances — counts are consistent. ' +
    'Uses the same Redis credentials as the dedup adapter (different key prefix).',
  requiredEnvVars: ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'],
  docsUrl: 'https://upstash.com/docs/redis/overall/getstarted',
}

// ─── Conversion adapters (kit #14) ───────────────────────────────────────────

export const MANIFEST_CONVERSION_MEMORY: AdapterManifest = {
  slug: 'memory-conversion',
  kind: 'conversion',
  name: 'In-Memory Conversion Reporter (test)',
  description:
    'No-op conversion reporter that records uploads for test assertions. ' +
    'Supports vendor-style dedup by transactionId. Never use in production.',
  requiredEnvVars: [],
  testOnly: true,
}

// ─── Registry ────────────────────────────────────────────────────────────────

/**
 * All adapter manifests in declaration order.
 * Filter by `kind` to get the adapters relevant to a particular extension point:
 *
 *   ADAPTER_MANIFESTS.filter(m => m.kind === 'booking' && !m.testOnly)
 */
export const ADAPTER_MANIFESTS: readonly AdapterManifest[] = [
  // Booking
  MANIFEST_BOOKING_BLVD,
  MANIFEST_BOOKING_RECAL,
  MANIFEST_BOOKING_OPENDENTAL,
  MANIFEST_BOOKING_MEMORY,
  MANIFEST_BOOKING_DIRECT_CONFIRM,
  // Notification
  MANIFEST_NOTIFICATION_BREVO,
  MANIFEST_NOTIFICATION_TWILIO_WHATSAPP,
  MANIFEST_NOTIFICATION_MEMORY,
  // Dedup
  MANIFEST_DEDUP_UPSTASH,
  MANIFEST_DEDUP_MEMORY,
  // Persistence
  MANIFEST_PERSISTENCE_SHEETS,
  MANIFEST_PERSISTENCE_MEMORY,
  // State
  MANIFEST_STATE_SUPABASE,
  MANIFEST_STATE_MEMORY,
  // Rate limit
  MANIFEST_RATELIMIT_UPSTASH,
  // Conversion (kit #14)
  MANIFEST_CONVERSION_MEMORY,
] as const

export type { AdapterManifest, AdapterKind, BookingCapability } from './_shared/manifest.js'
