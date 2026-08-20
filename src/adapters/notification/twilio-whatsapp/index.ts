// Twilio WhatsApp notifier — REST API (not SDK), Content Templates, no SMTP.
// ADR-005. Mirrors the apointoo-direct HelperSend::wpp() pattern.
//
// Endpoint: POST https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json
// Auth: HTTP Basic { sid : authToken }

import { errMessage, BookingError } from '../../../core/errors.js'
import { truncate } from '../../../core/internal/strings.js'
import type { Notifier, NotificationOptions } from '../adapter.js'
import type {
  AdapterContext,
  AdapterHealth,
  BookingConfirmation,
  BookingRequest,
} from '../../../core/types.js'
import { APOINTOO_HEADLESS_VERSION } from '../../../core/version.js'

export type TwilioWhatsAppOptions = {
  accountSid: string
  authToken: string
  /** WhatsApp number Twilio assigned (E.164, no `whatsapp:` prefix). */
  fromWhatsAppNumber: string
  /** Twilio Content Template SID for booking notifications. */
  contentSid: string
  /** Operators that receive notifications. E.164. */
  defaultTo: ReadonlyArray<string>
  /** Override fetch for tests. */
  fetchImpl?: typeof fetch
  baseUrl?: string
}

const TWILIO_API = 'https://api.twilio.com/2010-04-01'

export function twilioWhatsAppAdapter(opts: TwilioWhatsAppOptions): Notifier {
  if (!opts.accountSid || !opts.authToken) {
    throw new BookingError('CONFIG_INVALID', 'twilioWhatsAppAdapter: accountSid + authToken required')
  }
  if (!opts.fromWhatsAppNumber || !opts.contentSid) {
    throw new BookingError('CONFIG_INVALID', 'twilioWhatsAppAdapter: fromWhatsAppNumber + contentSid required')
  }
  if (!opts.defaultTo.length) {
    throw new BookingError('CONFIG_INVALID', 'twilioWhatsAppAdapter: defaultTo must have at least one recipient')
  }
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const baseUrl = opts.baseUrl ?? TWILIO_API
  const auth = `Basic ${Buffer.from(`${opts.accountSid}:${opts.authToken}`).toString('base64')}`

  return {
    async sendBookingNotification(
      request: BookingRequest,
      confirmation: BookingConfirmation,
      _options: NotificationOptions,
      ctx: AdapterContext,
    ): Promise<void> {
      // Variables map for the Twilio template. Numbered keys per Twilio convention.
      const vars: Record<string, string> = {
        '1': request.name,
        '2': request.service?.name ?? request.serviceId,
        '3': request.requestedDate,
        '4': request.requestedTime,
        '5': request.phone,
        '6': request.email ?? '',
        '7': confirmation.confirmationCode,
      }
      const contentVariables = JSON.stringify(vars)

      // Body is the fallback text outside a 24h CS window — never delivered when
      // template is approved + delivered.
      const fallbackBody = [
        `*New booking* — ${request.name}`,
        `${request.service?.name ?? request.serviceId} · ${request.requestedDate} ${request.requestedTime}`,
        `Phone: ${request.phone}`,
        request.email ? `Email: ${request.email}` : '',
        `Conf: ${confirmation.confirmationCode}`,
      ]
        .filter(Boolean)
        .join('\n')

      // One HTTP call per recipient — Twilio doesn't batch WA in a single API call.
      const url = `${baseUrl}/Accounts/${opts.accountSid}/Messages.json`
      const sends = opts.defaultTo.map(async (to) => {
        const t0 = Date.now()
        const form = new URLSearchParams()
        form.set('From', `whatsapp:${opts.fromWhatsAppNumber}`)
        form.set('To', `whatsapp:${to}`)
        form.set('ContentSid', opts.contentSid)
        form.set('ContentVariables', contentVariables)
        form.set('Body', fallbackBody)

        const res = await fetchImpl(url, {
          method: 'POST',
          headers: {
            Authorization: auth,
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
          body: form.toString(),
        })

        if (!res.ok) {
          const text = await res.text().catch(() => '')
          ctx.logger.error({
            evt: 'twilio.whatsapp.http_error',
            submissionId: request.submissionId,
            ctx: { status: res.status, body: truncate(text, 200) },
            durationMs: Date.now() - t0,
          })
          throw new BookingError('NOTIFICATION_FAILED', `Twilio WhatsApp returned HTTP ${res.status}`)
        }
        ctx.logger.info({
          evt: 'twilio.whatsapp.ok',
          submissionId: request.submissionId,
          durationMs: Date.now() - t0,
        })
      })

      // If any single recipient fails, surface as a single error — the queue
      // worker will retry the whole item.
      await Promise.all(sends)
    },

    async health(_ctx): Promise<AdapterHealth> {
      try {
        const res = await fetchImpl(`${baseUrl}/Accounts/${opts.accountSid}.json`, {
          headers: { Authorization: auth, Accept: 'application/json' },
        })
        if (!res.ok) {
          return {
            ok: false,
            name: 'twilio-whatsapp',
            version: APOINTOO_HEADLESS_VERSION,
            error: `HTTP ${res.status}`,
          }
        }
        return { ok: true, name: 'twilio-whatsapp', version: APOINTOO_HEADLESS_VERSION }
      } catch (err) {
        return {
          ok: false,
          name: 'twilio-whatsapp',
          version: APOINTOO_HEADLESS_VERSION,
          error: errMessage(err),
        }
      }
    },
  }
}
