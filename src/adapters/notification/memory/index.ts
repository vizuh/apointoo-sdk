// Memory notifier — for tests. Records every send so assertions can inspect.

import type { Notifier, NotificationOptions } from '../adapter.js'
import type {
  AdapterContext,
  AdapterHealth,
  BookingConfirmation,
  BookingRequest,
} from '../../../core/types.js'

export type MemoryNotifierCall = {
  request: BookingRequest
  confirmation: BookingConfirmation
  options: NotificationOptions
}

export type MemoryNotifier = Notifier & {
  sent: ReadonlyArray<MemoryNotifierCall>
}

export function memoryNotifier(failWith?: Error): MemoryNotifier {
  const sent: MemoryNotifierCall[] = []
  const adapter: Notifier = {
    async sendBookingNotification(
      request: BookingRequest,
      confirmation: BookingConfirmation,
      options: NotificationOptions,
      _ctx: AdapterContext,
    ): Promise<void> {
      if (failWith) throw failWith
      sent.push({ request, confirmation, options })
    },
    async health(_ctx): Promise<AdapterHealth> {
      return { ok: true, name: 'memory', version: '0.1.0' }
    },
  }
  return Object.assign(adapter, { sent })
}
