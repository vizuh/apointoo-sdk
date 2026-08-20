/**
 * Conversion action name allowlist + branded type (kit #14 HIPAA boundary).
 *
 * Conversion action names get logged to Google Ads attached to the gclid.
 * Google can join gclid back to identity. So a name like
 * `dental_implant_consultation` effectively transmits a health condition
 * even though the payload itself carries no PHI.
 *
 * Enforcement runs at two layers:
 *
 *   1. **Type layer (compile-time).** `ConversionUploadInput.conversionAction`
 *      is typed `ConversionActionName`, a branded string. Raw string literals
 *      are a type error at the `reportConversion()` call site.
 *
 *   2. **Validator layer (config-time).** The only way to construct a
 *      `ConversionActionName` is via `defineConversionAction()`, which
 *      checks the name against an allowlist and a strict pattern. By
 *      convention this runs once at startup — never in the request path —
 *      so a bad name fails the boot, not a live request.
 *
 * To use a name not in `DEFAULT_CONVERSION_ACTION_ALLOWLIST`, pass an
 * explicit `allowlist` option after a deliberate review.
 */

import { ConversionReporterError } from './reporter.js'

// ── Default allowlist ──────────────────────────────────────────────────────
// Generic action labels. No condition, no service, no body part. Tenants
// can extend via the `allowlist` option but each addition is a deliberate
// decision (and should pass through code review).

export const DEFAULT_CONVERSION_ACTION_ALLOWLIST = [
  'booking_completed',
  'booking_confirmed',
  'appointment_completed',
  'appointment_confirmed',
  'appointment_scheduled',
  'reservation_completed',
  'reservation_confirmed',
  'consultation_scheduled',
  'lead_qualified',
  'lead_converted',
] as const

export type DefaultConversionActionName =
  (typeof DEFAULT_CONVERSION_ACTION_ALLOWLIST)[number]

// ── Branded type ───────────────────────────────────────────────────────────

declare const __conversionActionBrand: unique symbol

/**
 * A conversion action name that has been validated against an allowlist.
 * The only way to construct a value of this type is via
 * `defineConversionAction()` — raw strings are a compile error at the
 * `ConversionUploadInput.conversionAction` call site.
 */
export type ConversionActionName = string & {
  readonly [__conversionActionBrand]: true
}

// ── Validator ──────────────────────────────────────────────────────────────

const VALID_NAME_PATTERN = /^[a-z][a-z0-9_]{2,49}$/

/**
 * Validate a conversion action name at config time and return a branded
 * `ConversionActionName`. Throws `ConversionReporterError('CONFIG_INVALID')`
 * on rejection — design intent is that this runs once at startup, never
 * in the request path.
 *
 * Rules:
 *   1. Pattern: lowercase letters, digits, underscores; starts with a
 *      letter; length 3-50. Defense-in-depth against punctuation tricks.
 *   2. Allowlist membership: either the default allowlist or a
 *      caller-supplied one.
 */
export function defineConversionAction(
  name: string,
  opts?: { allowlist?: readonly string[] },
): ConversionActionName {
  const allowlist = opts?.allowlist ?? DEFAULT_CONVERSION_ACTION_ALLOWLIST

  if (typeof name !== 'string' || name.length === 0) {
    throw new ConversionReporterError(
      'CONFIG_INVALID',
      'conversion action name must be a non-empty string',
    )
  }

  if (!VALID_NAME_PATTERN.test(name)) {
    throw new ConversionReporterError(
      'CONFIG_INVALID',
      `conversion action name '${name}' does not match the required pattern ` +
        `(lowercase letters, digits, underscores; 3-50 chars; starts with a letter)`,
    )
  }

  if (!allowlist.includes(name)) {
    throw new ConversionReporterError(
      'CONFIG_INVALID',
      `conversion action name '${name}' is not in the allowlist. ` +
        `Default allowlist: ${DEFAULT_CONVERSION_ACTION_ALLOWLIST.join(', ')}. ` +
        `Reason: action names get logged to Google Ads attached to the gclid; ` +
        `service-type or condition-revealing names create a HIPAA exposure ` +
        `even though the payload itself carries no PHI. To use a different ` +
        `name, pass it explicitly via the \`allowlist\` option after a ` +
        `deliberate review.`,
    )
  }

  return name as ConversionActionName
}
