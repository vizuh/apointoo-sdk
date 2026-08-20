// Generic recovery-row schema. Lives in core because the pipeline needs it
// for Pattern-15 recovery rendering — and the pipeline must not depend on a
// specific persistence impl (Clean Architecture: dependency direction).
//
// Adapters (Sheets, Supabase, etc.) re-export this row from their own files.

import type { BookingConfirmation, BookingRequest } from './types.js'
import { APOINTOO_HEADLESS_VERSION } from './version.js'

export type BookingRowEventType = 'booking_request' | 'partial_lead'

export type BookingRowInput = {
  eventType: BookingRowEventType
  request: BookingRequest
  confirmation: BookingConfirmation | undefined
}

/**
 * 13-column canonical row. Pattern 16: version always last column.
 * Adapters that store row-shaped data should use this format for Sheets +
 * any tabular log; relational stores keep their own schema.
 *
 * `attribution_json` carries the full BookingAttribution as a JSON string. It
 * holds no name/phone/email, so PHI-minimization (Pattern 14) still holds.
 */
export const BOOKING_ROW_HEADERS = [
  'timestamp',
  'submission_id',
  'event_type',
  'name',
  'phone',
  'email',
  'service',
  'date',
  'time',
  'gclid',
  'vendor_appointment_id',
  'attribution_json',
  'apointoo_version',
] as const

export function bookingToRow(input: BookingRowInput): string[] {
  const r = input.request
  const c = input.confirmation
  return [
    r.createdAtIso,
    r.submissionId,
    input.eventType,
    r.name,
    r.phone,
    r.email ?? '',
    r.service?.name ?? r.serviceId,
    r.requestedDate,
    r.requestedTime,
    r.attribution.gclid ?? '',
    c?.vendorAppointmentId ?? '',
    JSON.stringify(r.attribution ?? {}),
    APOINTOO_HEADLESS_VERSION,
  ]
}

// ── CRM operator-managed columns ────────────────────────────────────────────
// These 4 columns sit AFTER the booking row's apointoo_version column. The
// booking pipeline never writes them — they're reserved for an admin/CRM
// surface. Booking pipeline appends 12 cols; admin manages
// these 4 separately via Sheet update mutations.
//
// Status taxonomy intentionally tight — operator picks one. Empty = treat as
// 'lead' default. Free-text alternatives belong in `crm_notes`.
//
// Booking pipeline appends the 13 BOOKING_ROW_HEADERS cols; admin manages
// these 4 CRM cols separately via Sheet update mutations.

export const CRM_COLUMN_HEADERS = [
  'crm_status', // 'lead' | 'contacted' | 'converted' | 'no_show' | 'cancelled'
  'crm_value', // number — confirmed/realized booking value in account currency
  'crm_notes', // free text
  'crm_updated_at', // ISO 8601 — last operator edit
] as const

export type CrmStatus = 'lead' | 'contacted' | 'converted' | 'no_show' | 'cancelled'

/** Full schema (booking row + CRM columns) for ensure-headers in admin dashboard. */
export const FULL_SHEET_HEADERS = [...BOOKING_ROW_HEADERS, ...CRM_COLUMN_HEADERS] as const
