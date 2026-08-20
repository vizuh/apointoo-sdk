// Notifier — sends operator emails on booking events.
// Brevo REST is the default; consumers can implement SendGrid/Mailgun/etc.

import type {
  AdapterContext,
  AdapterHealth,
  BookingConfirmation,
  BookingRequest,
} from '../../core/types.js'

export type NotificationOptions = {
  /** When true, render a Pattern-15 recovery block in the email body. */
  recoveryRow?: ReadonlyArray<string>
  /** Reason text shown in the recovery block (no PII). */
  recoveryReason?: string
}

export interface Notifier {
  sendBookingNotification(
    request: BookingRequest,
    confirmation: BookingConfirmation,
    options: NotificationOptions,
    ctx: AdapterContext,
  ): Promise<void>

  health(ctx: AdapterContext): Promise<AdapterHealth>
}
