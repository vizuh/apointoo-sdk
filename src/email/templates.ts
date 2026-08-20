// Email rendering — pure functions, no IO.
// Pattern 13 (anatomy) + Pattern 16 (version stamp) preserved from old kit.
// Pattern 15 (recovery row) embedded when the pipeline asks for it.

import { truncate } from '../core/internal/strings.js'
import type { BookingConfirmation, BookingRequest } from '../core/types.js'
import { APOINTOO_HEADLESS_VERSION } from '../core/version.js'

export type EmailTheme = {
  /** Hex without # */
  primary: string
  bg: string
  text: string
  muted: string
  accent: string
}

export const defaultTheme: EmailTheme = {
  primary: '391BA6', // matches apointoo-site-main
  bg: 'F8F8F7',
  text: '0E0726',
  muted: '8A8A8A',
  accent: 'F2C641',
}

export type RenderOptions = {
  theme?: EmailTheme
  /** Tab-separated row to embed for Pattern-15 recovery, when present. */
  recoveryRow?: ReadonlyArray<string>
  /** Reason text for the recovery block. */
  recoveryReason?: string
  /** Override for the brand label in the footer. */
  brand?: string
}

export type RenderedEmail = {
  subject: string
  html: string
  text: string
}

export function renderBookingEmail(
  request: BookingRequest,
  confirmation: BookingConfirmation,
  options: RenderOptions = {},
): RenderedEmail {
  const theme = options.theme ?? defaultTheme
  const brand = options.brand ?? 'Apointoo'
  const subjectPrefix = options.recoveryRow?.length
    ? `⚠ [${brand}]`
    : `[${brand}]`

  const subject = `${subjectPrefix} ${request.name} — ${request.service?.name ?? request.serviceId} ${request.requestedDate}`

  const html = renderHtml(request, confirmation, theme, options)
  const text = renderText(request, confirmation, options)

  return { subject, html, text }
}

// ── HTML ────────────────────────────────────────────────────────────────────

function renderHtml(
  request: BookingRequest,
  confirmation: BookingConfirmation,
  theme: EmailTheme,
  options: RenderOptions,
): string {
  const recoveryBlock = options.recoveryRow?.length
    ? renderRecoveryBlock(options.recoveryRow, options.recoveryReason)
    : ''

  const message = request.message
    ? `<div style="margin:24px 0;padding:16px 20px;border-left:3px solid #${theme.primary};background:#fff;">
         <div style="color:#${theme.muted};font-size:12px;margin-bottom:6px;">Mensagem do cliente</div>
         <div style="color:#${theme.text};font-size:14px;line-height:1.5;">${escape(request.message)}</div>
       </div>`
    : ''

  const attribution = renderAttributionBlock(request)
  const serviceName = request.service?.name ?? request.serviceId

  return `<!doctype html>
<html><body style="margin:0;background:#${theme.bg};font-family:-apple-system,Segoe UI,Roboto,sans-serif;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#${theme.bg};">
  <tr><td align="center" style="padding:24px 16px;">
    <table role="presentation" width="600" cellspacing="0" cellpadding="0" style="max-width:600px;width:100%;background:#fff;border-radius:6px;overflow:hidden;">
      <tr><td style="background:#${theme.primary};color:#fff;padding:24px;">
        <div style="font-size:22px;font-weight:600;">${escape(request.name)}</div>
        <div style="font-size:14px;opacity:.85;margin-top:4px;">${escape(serviceName)} · ${escape(request.requestedDate)} · ${escape(request.requestedTime)}</div>
      </td></tr>
      <tr><td style="padding:24px;color:#${theme.text};">
        ${recoveryBlock}
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
          <tr><td style="padding:6px 0;color:#${theme.muted};font-size:12px;">Serviço</td><td style="padding:6px 0;">${escape(serviceName)}</td></tr>
          <tr><td style="padding:6px 0;color:#${theme.muted};font-size:12px;">Data</td><td style="padding:6px 0;">${escape(request.requestedDate)}</td></tr>
          <tr><td style="padding:6px 0;color:#${theme.muted};font-size:12px;">Hora</td><td style="padding:6px 0;">${escape(request.requestedTime)}</td></tr>
          <tr><td colspan="2" style="border-top:1px solid #eee;padding:12px 0;"></td></tr>
          <tr><td style="padding:6px 0;color:#${theme.muted};font-size:12px;">Nome</td><td style="padding:6px 0;">${escape(request.name)}</td></tr>
          <tr><td style="padding:6px 0;color:#${theme.muted};font-size:12px;">Telefone</td><td style="padding:6px 0;">${escape(request.phone)}</td></tr>
          ${request.email ? `<tr><td style="padding:6px 0;color:#${theme.muted};font-size:12px;">Email</td><td style="padding:6px 0;">${escape(request.email)}</td></tr>` : ''}
        </table>
        ${message}
        ${attribution}
        <details style="margin-top:24px;">
          <summary style="color:#${theme.muted};font-size:12px;cursor:pointer;">Dados técnicos</summary>
          <div style="font-family:monospace;font-size:11px;color:#${theme.muted};margin-top:8px;line-height:1.6;">
            submission_id: ${escape(request.submissionId)}<br>
            confirmation_code: ${escape(confirmation.confirmationCode)}<br>
            vendor_appointment_id: ${escape(confirmation.vendorAppointmentId)}<br>
            ${confirmation.vendorClientId ? `vendor_client_id: ${escape(confirmation.vendorClientId)}<br>` : ''}
          </div>
        </details>
      </td></tr>
      <tr><td style="padding:16px 24px;color:#${theme.muted};font-size:11px;border-top:1px solid #eee;">
        Enviado em ${escape(new Date().toISOString())}<br>
        apointoo-sdk v${APOINTOO_HEADLESS_VERSION}
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`
}

// ── Text ────────────────────────────────────────────────────────────────────

function renderText(
  request: BookingRequest,
  confirmation: BookingConfirmation,
  options: RenderOptions,
): string {
  const lines = [
    `${request.name} — ${request.service?.name ?? request.serviceId}`,
    `${request.requestedDate} ${request.requestedTime}`,
    '',
    `Telefone: ${request.phone}`,
    request.email ? `Email: ${request.email}` : '',
    '',
  ]

  if (request.message) {
    lines.push('Mensagem:', request.message, '')
  }

  if (options.recoveryRow?.length) {
    lines.push('⚠ RECOVERY ROW — paste in Sheets:')
    lines.push(options.recoveryRow.join('\t'))
    if (options.recoveryReason) lines.push(`Reason: ${options.recoveryReason}`)
    lines.push('')
  }

  lines.push(
    '---',
    `submission_id: ${request.submissionId}`,
    `confirmation_code: ${confirmation.confirmationCode}`,
    `apointoo-sdk v${APOINTOO_HEADLESS_VERSION}`,
  )
  return lines.filter(Boolean).join('\n')
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function renderAttributionBlock(request: BookingRequest): string {
  const a = request.attribution
  const visible: string[] = []
  if (a.utmSource) visible.push(`utm_source=${a.utmSource}`)
  if (a.utmMedium) visible.push(`utm_medium=${a.utmMedium}`)
  if (a.utmCampaign) visible.push(`utm_campaign=${a.utmCampaign}`)
  if (a.gclid) visible.push('gclid=' + truncate(a.gclid, 24))
  if (visible.length === 0) return ''
  return `<div style="margin-top:24px;color:#888;font-size:12px;">Origem: ${escape(visible.join(' · '))}</div>`
}

function renderRecoveryBlock(
  row: ReadonlyArray<string>,
  reason: string | undefined,
): string {
  return `<div style="margin-bottom:20px;padding:16px;background:#FFF8E1;border:1px solid #F2C641;border-radius:4px;">
    <div style="font-weight:600;color:#8A6D00;margin-bottom:8px;">⚠ Sheets row not saved — paste manually</div>
    ${reason ? `<div style="color:#8A6D00;font-size:12px;margin-bottom:8px;">${escape(reason)}</div>` : ''}
    <pre style="white-space:pre-wrap;font-family:monospace;font-size:11px;color:#5C4A00;background:#fff;padding:8px;border-radius:3px;margin:0;">${escape(row.join('\t'))}</pre>
  </div>`
}

function escape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}
