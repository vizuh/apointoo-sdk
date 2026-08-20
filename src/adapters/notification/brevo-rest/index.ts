// Brevo REST notifier — no SMTP. ADR-003 has the rationale.
// Endpoint: POST https://api.brevo.com/v3/smtp/email
// Auth: api-key header.

import { errMessage, BookingError } from '../../../core/errors.js'
import { truncate } from '../../../core/internal/strings.js'
import type { Notifier, NotificationOptions } from '../adapter.js'
import type {
  AdapterContext,
  AdapterHealth,
  BookingConfirmation,
  BookingRequest,
} from '../../../core/types.js'
import { renderBookingEmail, type EmailTheme } from '../../../email/templates.js'
import { APOINTOO_HEADLESS_VERSION } from '../../../core/version.js'

export type BrevoRestAdapterOptions = {
  apiKey: string
  /** Sender email (must be verified in Brevo). */
  from: string
  fromName?: string
  /**
   * Fallback recipients used when the per-call tenant config does not set
   * `notifications.to`. Prefer setting `notifications.to` in BookingKitConfig
   * so one adapter instance can serve multiple tenants.
   */
  defaultTo?: ReadonlyArray<string>
  /** Fallback BCC used when `notifications.bcc` is not set on the tenant config. */
  defaultBcc?: ReadonlyArray<string>
  /** Subject prefix override. Defaults to '[Apointoo]'. */
  subjectBrand?: string
  /** Custom theme. */
  theme?: EmailTheme
  /** Override fetch for tests. */
  fetchImpl?: typeof fetch
  /** Override base URL for tests. */
  baseUrl?: string
}

const BREVO_API = 'https://api.brevo.com/v3'

type BrevoSendBody = {
  sender: { email: string; name?: string }
  to: Array<{ email: string }>
  bcc?: Array<{ email: string }>
  subject: string
  htmlContent: string
  textContent: string
  headers?: Record<string, string>
}

export function brevoRestAdapter(opts: BrevoRestAdapterOptions): Notifier {
  if (!opts.apiKey) {
    throw new BookingError('CONFIG_INVALID', 'brevoRestAdapter: apiKey is required')
  }
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const baseUrl = opts.baseUrl ?? BREVO_API

  return {
    async sendBookingNotification(
      request: BookingRequest,
      confirmation: BookingConfirmation,
      options: NotificationOptions,
      ctx: AdapterContext,
    ): Promise<void> {
      const t0 = Date.now()

      // Runtime tenant config wins over adapter defaults so one adapter
      // instance can route to per-tenant inboxes.
      const cfgN = ctx.config.notifications
      const toList = cfgN?.to ?? opts.defaultTo ?? []
      const bccList = cfgN?.bcc ?? opts.defaultBcc ?? []

      if (toList.length === 0) {
        throw new BookingError(
          'CONFIG_INVALID',
          'brevoRestAdapter: no recipients — set config.notifications.to or pass defaultTo',
        )
      }

      const rendered = renderBookingEmail(request, confirmation, {
        ...(opts.theme !== undefined ? { theme: opts.theme } : {}),
        ...(opts.subjectBrand !== undefined ? { brand: opts.subjectBrand } : {}),
        ...(options.recoveryRow !== undefined ? { recoveryRow: options.recoveryRow } : {}),
        ...(options.recoveryReason !== undefined ? { recoveryReason: options.recoveryReason } : {}),
      })

      const body: BrevoSendBody = {
        sender: {
          email: opts.from,
          ...(opts.fromName !== undefined ? { name: opts.fromName } : {}),
        },
        to: toList.map((email) => ({ email })),
        ...(bccList.length > 0
          ? { bcc: bccList.map((email) => ({ email })) }
          : {}),
        subject: rendered.subject,
        htmlContent: rendered.html,
        textContent: rendered.text,
        headers: {
          'X-Apointoo-Version': APOINTOO_HEADLESS_VERSION,
          'X-Apointoo-Submission': request.submissionId,
        },
      }

      let res: Response
      try {
        res = await fetchImpl(`${baseUrl}/smtp/email`, {
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
          evt: 'brevo.send.network_error',
          submissionId: request.submissionId,
          message: errMessage(err),
          durationMs: Date.now() - t0,
        })
        throw err
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '')
        ctx.logger.error({
          evt: 'brevo.send.http_error',
          submissionId: request.submissionId,
          ctx: { status: res.status, body: truncate(text, 200) },
          durationMs: Date.now() - t0,
        })
        throw new BookingError('NOTIFICATION_FAILED', `Brevo returned HTTP ${res.status}`)
      }

      ctx.logger.info({
        evt: 'brevo.send.ok',
        submissionId: request.submissionId,
        durationMs: Date.now() - t0,
      })
    },

    async health(_ctx): Promise<AdapterHealth> {
      try {
        const res = await fetchImpl(`${baseUrl}/account`, {
          method: 'GET',
          headers: { 'api-key': opts.apiKey, Accept: 'application/json' },
        })
        if (!res.ok) {
          return {
            ok: false,
            name: 'brevo-rest',
            version: '0.1.0',
            error: `HTTP ${res.status}`,
          }
        }
        return { ok: true, name: 'brevo-rest', version: '0.1.0' }
      } catch (err) {
        return {
          ok: false,
          name: 'brevo-rest',
          version: '0.1.0',
          error: errMessage(err),
        }
      }
    },
  }
}
