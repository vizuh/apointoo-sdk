// In-memory BookingStateStore — for tests and dev. No persistence across restarts.

import type {
  BookingState,
  BookingStateCreate,
  BookingStateStatus,
  BookingStateStore,
  BookingStateTransition,
} from './adapter.js'
import { hasUploadableClickId } from './selectors.js'

export function memoryStateStore(): BookingStateStore {
  const rows = new Map<string, BookingState>()

  return {
    async create(input: BookingStateCreate): Promise<void> {
      const now = new Date()
      const existing = rows.get(input.submissionId)
      const row: BookingState = {
        ...input,
        status: 'pending',
        vendorAppointmentId: existing?.vendorAppointmentId ?? null,
        appointmentStartIso: existing?.appointmentStartIso ?? null,
        errorCode: existing?.errorCode ?? null,
        retryCount: existing ? existing.retryCount + 1 : 0,
        updatedAt: now,
        conversionSentAt: existing?.conversionSentAt ?? null,
      }
      rows.set(input.submissionId, row)
    },

    async transition(submissionId: string, change: BookingStateTransition): Promise<void> {
      const row = rows.get(submissionId)
      if (!row) {
        throw new Error(`memoryStateStore: submissionId ${submissionId} not found`)
      }
      const next: BookingState = {
        ...row,
        status: change.status,
        vendorAppointmentId: change.vendorAppointmentId ?? row.vendorAppointmentId,
        appointmentStartIso:
          change.appointmentStartIso ?? row.appointmentStartIso,
        errorCode: change.errorCode ?? row.errorCode,
        updatedAt: new Date(),
      }
      rows.set(submissionId, next)
    },

    async get(submissionId: string): Promise<BookingState | null> {
      return rows.get(submissionId) ?? null
    },

    async findStale(olderThanMinutes: number, tenantId?: string): Promise<BookingState[]> {
      const cutoff = Date.now() - olderThanMinutes * 60_000
      const out: BookingState[] = []
      for (const row of rows.values()) {
        if (row.status !== 'pending') continue
        if (row.createdAt.getTime() >= cutoff) continue
        if (tenantId !== undefined && row.tenantId !== tenantId) continue
        out.push(row)
      }
      return out
    },

    async findForConversion(tenantId?: string): Promise<BookingState[]> {
      const out: BookingState[] = []
      for (const row of rows.values()) {
        if (row.status !== 'confirmed') continue
        if (row.conversionSentAt !== null) continue
        if (!hasUploadableClickId(row)) continue
        if (tenantId !== undefined && row.tenantId !== tenantId) continue
        out.push(row)
      }
      return out
    },

    async markConversionSent(submissionId: string, sentAt: Date): Promise<void> {
      const row = rows.get(submissionId)
      if (!row) return
      rows.set(submissionId, { ...row, conversionSentAt: sentAt })
    },

    async countByStatus(tenantId?: string): Promise<Record<BookingStateStatus, number>> {
      const counts: Record<BookingStateStatus, number> = {
        draft: 0,
        contact_captured: 0,
        slot_held: 0,
        payment_pending: 0,
        pending: 0,
        confirmed: 0,
        cancelled: 0,
        rescheduled: 0,
        no_show: 0,
        completed: 0,
        failed: 0,
        expired: 0,
        abandoned: 0,
      }
      for (const row of rows.values()) {
        if (tenantId !== undefined && row.tenantId !== tenantId) continue
        counts[row.status] += 1
      }
      return counts
    },

    async health() {
      return { ok: true, name: 'memory-state' }
    },
  }
}
