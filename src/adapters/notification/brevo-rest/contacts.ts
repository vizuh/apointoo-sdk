// Brevo contact upsert — CRM lifecycle, separate from the transactional-email
// Notifier in `./index.ts`. Same auth (api-key header), same base URL.
//
// Intended call site: a subscriber to the `booking.confirmed` domain event,
// after CONFIRMED state. Not called on form submit / `booking.requested` —
// that would create a contact for spam and abandoned flows.
//
// PII boundary: this helper accepts email + optional phone. The kit's domain
// events (events.ts) never carry PII; the consumer's subscriber is the only
// place where booking PII flows through. Email/phone are never logged.

import { errMessage, BookingError } from '../../../core/errors.js'
import { truncate } from '../../../core/internal/strings.js'
import type { AdapterContext } from '../../../core/types.js'
import type { BookingAttribution } from '../../../core/schemas.js'

/** Stage we mark the contact at. Matches the lead funnel. */
export type ContactLifecycleStage =
  | 'lead' // captured pre-confirm (not used by default — see file header)
  | 'customer' // booking.confirmed
  | 'completed' // appointment.status_changed → completed
  | 'no_show' // appointment.status_changed → no_show
  | 'cancelled' // appointment.status_changed → cancelled

export type BrevoContactUpsertParams = {
  /** Lowercased email — Brevo's contact identity key. Required. */
  email: string
  /** E.164 phone, or undefined if not collected. */
  phone?: string
  /** Lifecycle stage to set on the contact. */
  stage: ContactLifecycleStage
  /**
   * Attribution snapshot. The helper picks gclid / fbclid / msclkid / utm*
   * onto Brevo custom attributes. Other fields are ignored.
   */
  attribution: BookingAttribution
  /**
   * Brevo list IDs to add the contact to. Most deployments use one list per
   * stage (e.g., "customers", "no-show"). Pass `[]` to skip list membership.
   */
  listIds?: ReadonlyArray<number>
  /** Submission id for log correlation only. Never sent to Brevo. */
  submissionId: string
}

export type BrevoContactUpserterOptions = {
  apiKey: string
  /** Override fetch for tests. */
  fetchImpl?: typeof fetch
  /** Override base URL for tests. */
  baseUrl?: string
}

export interface BrevoContactUpserter {
  upsertContact(params: BrevoContactUpsertParams, ctx: AdapterContext): Promise<void>
}

const BREVO_API = 'https://api.brevo.com/v3'

/**
 * Build a Brevo contact upserter. Uses `POST /v3/contacts` with
 * `updateEnabled: true` — Brevo's idempotent create-or-update.
 */
export function brevoContactUpserter(opts: BrevoContactUpserterOptions): BrevoContactUpserter {
  if (!opts.apiKey) {
    throw new BookingError('CONFIG_INVALID', 'brevoContactUpserter: apiKey is required')
  }
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const baseUrl = opts.baseUrl ?? BREVO_API

  return {
    async upsertContact(params, ctx) {
      const t0 = Date.now()
      const attributes = buildAttributes(params)
      const body: Record<string, unknown> = {
        email: params.email.trim().toLowerCase(),
        attributes,
        updateEnabled: true,
      }
      if (params.listIds && params.listIds.length > 0) {
        body.listIds = [...params.listIds]
      }

      let res: Response
      try {
        res = await fetchImpl(`${baseUrl}/contacts`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'api-key': opts.apiKey,
          },
          body: JSON.stringify(body),
        })
      } catch (err) {
        ctx.logger.error({
          evt: 'brevo.contact.network_error',
          submissionId: params.submissionId,
          message: errMessage(err),
          durationMs: Date.now() - t0,
        })
        throw err
      }

      // Brevo returns 201 on create, 204 on update. Both are success.
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        ctx.logger.error({
          evt: 'brevo.contact.http_error',
          submissionId: params.submissionId,
          ctx: { status: String(res.status), body: truncate(text, 200), stage: params.stage },
          durationMs: Date.now() - t0,
        })
        throw new BookingError('NOTIFICATION_FAILED', `Brevo contact upsert returned HTTP ${res.status}`)
      }

      ctx.logger.info({
        evt: 'brevo.contact.ok',
        submissionId: params.submissionId,
        code: params.stage,
        durationMs: Date.now() - t0,
      })
    },
  }
}

function buildAttributes(params: BrevoContactUpsertParams): Record<string, string> {
  const attrs: Record<string, string> = {
    LIFECYCLE_STAGE: params.stage.toUpperCase(),
  }
  if (params.phone) attrs.SMS = params.phone
  const a = params.attribution
  if (a.gclid) attrs.GCLID = a.gclid
  if (a.fbclid) attrs.FBCLID = a.fbclid
  if (a.msclkid) attrs.MSCLKID = a.msclkid
  if (a.utmSource) attrs.UTM_SOURCE = a.utmSource
  if (a.utmMedium) attrs.UTM_MEDIUM = a.utmMedium
  if (a.utmCampaign) attrs.UTM_CAMPAIGN = a.utmCampaign
  if (a.utmTerm) attrs.UTM_TERM = a.utmTerm
  if (a.utmContent) attrs.UTM_CONTENT = a.utmContent
  if (a.channel) attrs.ACQUISITION_CHANNEL = a.channel
  return attrs
}
