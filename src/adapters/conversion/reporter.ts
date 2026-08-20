/**
 * ConversionReporter — Google Ads offline conversion upload interface.
 *
 * Forwards a strict 6-field subset of MongoDB booking state to Google Ads
 * when a conversion is detected. The type system enforces the HIPAA boundary:
 *
 *   - `ConversionUploadInput` has exactly 6 fields, no optionals, no PII.
 *   - `conversionAction` is a branded `ConversionActionName` — raw strings
 *     are a compile error at the call site. The only way to mint one is via
 *     `defineConversionAction()` (see ./action-names.ts), which validates
 *     the name against a generic allowlist at config time.
 *
 * Why MongoDB-as-compliance-filter is sufficient for the pilot (no BAA
 * proxy needed): Google won't sign a HIPAA BAA for Google Ads, but the BAA
 * requirement only applies to PHI. The 6 allowlisted fields contain none.
 * `gclid` is Google's own identifier; `conversionAction` is a generic label;
 * the rest are timestamp / value / dedup. Because the pipeline is server-side
 * and MongoDB is the sole upstream of `ConversionReporter`, the discipline
 * a compliance proxy would enforce automatically is enforced in code via
 * the 6-field allowlist on the interface.
 */

import type { AdapterContext, AdapterHealth } from '../../core/types.js'
import type { ConversionActionName } from './action-names.js'

// ── Input ──────────────────────────────────────────────────────────────────

/**
 * The exact 6 fields uploaded to Google Ads. Adding a field here requires
 * a HIPAA review — never add anything that could carry PHI (name, email,
 * phone, IP, service type, provider name, etc.). Service type stays in
 * MongoDB; it never enters the payload.
 */
export type ConversionUploadInput = {
  /** Raw GCLID captured from URL params at booking submit. */
  gclid: string

  /**
   * Tenant-configured action name, validated against the generic allowlist
   * at config time via `defineConversionAction()`. Examples:
   * `booking_completed`, `appointment_confirmed`. Service-type-revealing
   * names like `dental_implant_consultation` are rejected (HIPAA: action
   * name + gclid back-references identity).
   */
  conversionAction: ConversionActionName

  /** ISO 8601 timestamp of when the conversion occurred (UTC or offset). */
  conversionDateTime: string

  /** Non-negative finite number — booking value in `currencyCode`. */
  conversionValue: number

  /** ISO 4217 currency code (3 uppercase letters): USD, EUR, etc. */
  currencyCode: string

  /**
   * Vendor-side dedup key. Conventionally `booking.submissionId`. Google
   * dedups on this — a second upload with the same transactionId is a
   * no-op (the impl reports `deduplicated: true`).
   */
  transactionId: string
}

// ── Result ─────────────────────────────────────────────────────────────────

export type ConversionUploadResult = {
  transactionId: string
  /** ISO 8601 UTC timestamp of successful upload. */
  reportedAtIso: string
  /**
   * True when the vendor dedup-rejected this upload (transactionId already
   * uploaded). False when this was a fresh upload accepted by the vendor.
   * Either way the call succeeded from the caller's perspective — the
   * upload is durable.
   */
  deduplicated: boolean
  /**
   * Vendor-issued receipt or job id for debugging. Not load-bearing for
   * caller logic — log it, don't branch on it.
   */
  vendorReceiptId?: string
}

// ── Interface ──────────────────────────────────────────────────────────────

export interface ConversionReporter {
  /**
   * Upload one conversion to the vendor.
   *
   * Contract:
   *   - Idempotent on `input.transactionId`. Caller should still gate on
   *     `booking.conversionReportedAt` to avoid the network round-trip,
   *     but a duplicate call MUST NOT cause a duplicate vendor-side
   *     conversion.
   *   - Throws `ConversionReporterError` on failure. Caller decides
   *     retry vs dead-letter based on `err.retryable`.
   *   - MUST NOT log any field of `input` other than `transactionId` and
   *     `conversionAction`. The Logger contract (no PII) already enforces
   *     this for strings, but adapter authors should be explicit.
   */
  reportConversion(
    input: ConversionUploadInput,
    ctx: AdapterContext,
  ): Promise<ConversionUploadResult>

  /**
   * Health probe — verifies the impl can reach the vendor and that the
   * configured tenant credentials are valid. No upload performed.
   */
  health(ctx: AdapterContext): Promise<AdapterHealth>
}

// ── Errors ─────────────────────────────────────────────────────────────────

export type ConversionReporterErrorCode =
  | 'CONFIG_INVALID'        // bad input shape, missing creds, bad action name
  | 'VENDOR_UNAVAILABLE'    // transient network or 5xx from vendor
  | 'GCLID_EXPIRED'         // > 90 days old (Google upload window)
  | 'VENDOR_REJECTED'       // permanent (bad gclid format, action mismatch, ...)
  | 'UNKNOWN_ERROR'

export class ConversionReporterError extends Error {
  readonly code: ConversionReporterErrorCode
  readonly retryable: boolean
  readonly transactionId: string | undefined
  readonly vendor: string | undefined

  constructor(
    code: ConversionReporterErrorCode,
    message: string,
    opts?: {
      retryable?: boolean
      transactionId?: string
      vendor?: string
    },
  ) {
    super(message)
    this.name = 'ConversionReporterError'
    this.code = code
    this.retryable = opts?.retryable ?? defaultRetryable(code)
    this.transactionId = opts?.transactionId
    this.vendor = opts?.vendor
  }
}

export function isConversionReporterError(
  e: unknown,
): e is ConversionReporterError {
  return e instanceof ConversionReporterError
}

function defaultRetryable(code: ConversionReporterErrorCode): boolean {
  switch (code) {
    case 'CONFIG_INVALID':
    case 'GCLID_EXPIRED':
    case 'VENDOR_REJECTED':
      return false
    case 'VENDOR_UNAVAILABLE':
    case 'UNKNOWN_ERROR':
      return true
  }
}

// ── Input validator ─────────────────────────────────────────────────────────
// The type system enforces shape at compile time; this enforces value
// ranges and formats at runtime. Impls call this before doing anything
// with `input`. Throws `ConversionReporterError('CONFIG_INVALID', ...)`
// on any failure.

const ISO_8601_REGEX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/
const ISO_4217_REGEX = /^[A-Z]{3}$/

export function validateConversionInput(input: ConversionUploadInput): void {
  const fail = (msg: string): never => {
    const opts: { transactionId?: string } =
      typeof input.transactionId === 'string' && input.transactionId.length > 0
        ? { transactionId: input.transactionId }
        : {}
    throw new ConversionReporterError('CONFIG_INVALID', msg, opts)
  }

  if (typeof input.gclid !== 'string' || input.gclid.length === 0) {
    fail('gclid must be a non-empty string')
  }
  if (
    typeof input.conversionAction !== 'string' ||
    (input.conversionAction as string).length === 0
  ) {
    fail('conversionAction must be a non-empty ConversionActionName')
  }
  if (
    typeof input.conversionDateTime !== 'string' ||
    !ISO_8601_REGEX.test(input.conversionDateTime) ||
    Number.isNaN(Date.parse(input.conversionDateTime))
  ) {
    fail('conversionDateTime must be a valid ISO 8601 timestamp')
  }
  if (
    typeof input.conversionValue !== 'number' ||
    !Number.isFinite(input.conversionValue) ||
    input.conversionValue < 0
  ) {
    fail('conversionValue must be a non-negative finite number')
  }
  if (
    typeof input.currencyCode !== 'string' ||
    !ISO_4217_REGEX.test(input.currencyCode)
  ) {
    fail('currencyCode must be a 3-letter uppercase ISO 4217 code')
  }
  if (typeof input.transactionId !== 'string' || input.transactionId.length === 0) {
    fail('transactionId must be a non-empty string')
  }
}
