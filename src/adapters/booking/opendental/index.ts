// OpenDental BookingAdapter — SKELETON. Throws on every method until impl lands.
// ADR-008. Real impl waits for sandbox creds + first dental client.
//
// API reference: https://www.opendental.com/site/apispec.html
//
// Why this file exists right now:
// - Validates BookingAdapter abstraction with a second vendor (BLVD is the first).
// - Documents the integration plan in code so the work isn't re-discovered later.
// - Keeps the planned provider boundary explicit until sandbox verification.
//
// Auth model: customerKey + developerKey in Authorization header.
// Endpoint: typically self-hosted on the dental practice's network.
//   - Cloud: https://api.opendental.com/api/v1
//   - Self-hosted: https://<practice-host>/api/v1

import type { BookingAdapter } from '../adapter.js'
import type {
  AdapterContext,
  AdapterHealth,
  BookingAttribution,
  BookingConfirmation,
  BookingRequest,
  BookingSession,
} from '../../../core/types.js'
import { BookingError } from '../../../core/errors.js'
import { APOINTOO_HEADLESS_VERSION } from '../../../core/version.js'

export type OpenDentalAdapterOptions = {
  apiUrl: string
  customerKey: string
  developerKey: string
  defaultClinicNum: string
  /** apointoo serviceId → OpenDental ProcedureCode (e.g. 'cleaning' → 'D1110') */
  procedureCodeMap: Readonly<Record<string, string>>
  /** apointoo serviceId → OpenDental Operatory abbreviation/num */
  operatoryMap: Readonly<Record<string, string>>
  fetchImpl?: typeof fetch
}

export type OpenDentalSession = BookingSession & {
  vendor: 'opendental'
  /** Set in createSession; needed for confirm. */
  patNum?: string
  procedureCode?: string
  operatoryNum?: string
  intendedDateTime?: string
}

export function opendentalAdapter(opts: OpenDentalAdapterOptions): BookingAdapter {
  if (!opts.apiUrl || !opts.customerKey || !opts.developerKey) {
    throw new BookingError('CONFIG_INVALID', 'opendentalAdapter: apiUrl, customerKey, developerKey required')
  }
  if (!opts.defaultClinicNum) {
    throw new BookingError('CONFIG_INVALID', 'opendentalAdapter: defaultClinicNum required')
  }
  // Suppress unused for now — when impl lands, fetch + maps come into play.
  void opts.fetchImpl
  void opts.procedureCodeMap
  void opts.operatoryMap

  const notImplemented = (method: string): never => {
    throw new BookingError(
      'CONFIG_INVALID',
      `OpenDental adapter not yet implemented (${method}). See ADR-008.`,
      { retryable: false },
    )
  }

  return {
    async createSession(_input, _ctx: AdapterContext): Promise<BookingSession> {
      // TODO: lookup patient by phone+name → POST /patients if absent → return PatNum
      // TODO: validate procedureCodeMap[serviceId] resolves
      // TODO: validate operatoryMap[serviceId] resolves
      // TODO: build session payload { patNum, intendedDateTime, procedureCode, operatoryNum }
      return notImplemented('createSession')
    },

    async attachAttribution(
      _session: BookingSession,
      _attribution: BookingAttribution,
      _ctx: AdapterContext,
    ): Promise<void> {
      // TODO: PUT /patients/{PatNum} with RefAttachNote = `gclid=...`
      // OpenDental has no first-class referral_source; the note field works.
      notImplemented('attachAttribution')
    },

    async confirm(
      _session: BookingSession,
      _request: BookingRequest,
      _ctx: AdapterContext,
    ): Promise<BookingConfirmation> {
      // TODO: POST /appointments with PatNum + AptDateTime + Op + ProcCodes
      // OpenDental's appointment creation is atomic — no separate reserve step.
      // No slot-leak compensation needed for the same reason BLVD does.
      return notImplemented('confirm')
    },

    async cancel(
      _session: BookingSession,
      _reason: string,
      _ctx: AdapterContext,
    ): Promise<void> {
      // TODO: PUT /appointments/{AptNum} with AptStatus=Broken
      // Idempotent — second call no-ops if already Broken.
      // Best-effort per BookingAdapter contract.
      notImplemented('cancel')
    },

    async health(_ctx): Promise<AdapterHealth> {
      // TODO: GET /version (or similar cheap endpoint) with auth headers
      return {
        ok: false,
        name: 'opendental',
        version: APOINTOO_HEADLESS_VERSION,
        error: 'Not implemented (skeleton). See ADR-008.',
      }
    },

    async findAvailability(_query, _ctx) {
      // TODO: GET /appointments/slots?ProvNum=...&AptDateTime>=...&AptDateTime<=...
      // OpenDental has slot endpoints — wrap them when impl lands.
      return notImplemented('findAvailability')
    },

    async cancelByAppointment(_vendorAppointmentId, _reason, _ctx) {
      // TODO: PUT /appointments/{AptNum} with AptStatus=Broken
      notImplemented('cancelByAppointment')
    },

    async rescheduleByAppointment(_vendorAppointmentId, _newDate, _newTime, _ctx) {
      // TODO: PUT /appointments/{AptNum} with new AptDateTime + status=Scheduled
      return notImplemented('rescheduleByAppointment')
    },

    async findStaffVariants(_query, _ctx) {
      // TODO: OpenDental "providers" + Operatory mapping. Per-slot variant
      // discovery would query the available Provider list for the given
      // ProcedureCode + AptDateTime. Stub for now (ADR-016).
      return notImplemented('findStaffVariants')
    },
  }
}
