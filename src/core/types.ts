// Domain types not derivable from zod schemas.
// Schemas (src/core/schemas.ts) own input/config shapes; this file owns the
// post-validation entities the pipeline operates on.

import type {
  BookingAttribution,
  BookingKitConfig,
  BookingRequestInputWire,
  BookingService,
} from './schemas.js'

export type SubmissionId = string // bk_YYYYMMDD_<8-char-rand>
export type Fingerprint = string // sha256(name|phone|date|time|service)

// ── Validated request — what the pipeline + adapters consume ────────────────
// `attribution` and `metadata` are normalized to non-null defaults so adapters
// don't pepper the code with `?.`.

export type BookingRequest = {
  submissionId: SubmissionId
  projectKey: string
  service: BookingService | null
  serviceId: string
  requestedDate: string // YYYY-MM-DD (business timezone)
  requestedTime: string // HH:MM (business timezone)
  name: string
  phone: string
  email: string | undefined
  message: string | undefined
  isNewPatient: 'new' | 'returning' | undefined
  offerCode: string | undefined
  attribution: BookingAttribution
  metadata: BookingMetadata
  createdAtIso: string
  fingerprint: Fingerprint
  configSnapshot: BookingConfigSnapshot
}

export type BookingMetadata = {
  userAgent: string | undefined
  locale: string | undefined
  timezone: string | undefined
  ip: string | undefined // populated by pipeline from request, never by client
}

export type BookingConfigSnapshot = {
  timezone: string
  locale: string
  scheduling: BookingKitConfig['scheduling']
}

// ── Confirmation — what the booking adapter returns on success ──────────────

export type BookingConfirmation = {
  vendorAppointmentId: string
  vendorClientId: string | undefined
  confirmationCode: string
  startTimeIso: string | undefined
  metadata: Record<string, string> // free-form vendor extras (printable strings only)
}

// ── Adapter types ──────────────────────────────────────────────────────────

export type BookingSession = {
  vendorSessionId: string // BLVD's cartId, Square's bookingId, etc.
  vendor: string // 'blvd' | 'square' | ...
  expiresAtIso: string | undefined
}

export type AdapterContext = {
  config: BookingKitConfig
  logger: Logger
  now: () => Date
}

export type AdapterHealth = {
  ok: boolean
  name: string
  version: string
  details?: Record<string, string>
  error?: string | undefined
}

// ── Logger contract ────────────────────────────────────────────────────────
// Pattern 14 enforced at the type level. Only safe fields are accepted.
// Adapters and pipeline stages MUST log through this — no `console.*` directly.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export type LogEvent = {
  level: LogLevel
  evt: string // event name, e.g. 'booking.confirm.failed'
  submissionId?: string
  code?: string
  durationMs?: number
  vendor?: string
  message?: string
  // Bounded stack trace, pre-truncated. Adapters / pipeline build this.
  stack?: string
  // Free-form non-PII context. Strings only. Adapter authors are responsible
  // for never putting names/phones/emails here.
  ctx?: Record<string, string | number | boolean>
}

export type Logger = {
  debug(e: Omit<LogEvent, 'level'>): void
  info(e: Omit<LogEvent, 'level'>): void
  warn(e: Omit<LogEvent, 'level'>): void
  error(e: Omit<LogEvent, 'level'>): void
}

// ── Re-exports for ergonomics ──────────────────────────────────────────────

export type {
  BookingAttribution,
  BookingKitConfig,
  BookingRequestInputWire,
  BookingService,
}
