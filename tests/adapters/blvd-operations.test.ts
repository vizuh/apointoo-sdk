// Tier 4 — BLVD operations input-shape regression tests.
// Covers cancelAppointment + availableRescheduleTimes + rescheduleAppointment
// against the corrected book-sdk shape. End-to-end sandbox verification is
// pending sandbox verification; see MANUAL-VERIFY comments in operations.ts.
import { describe, expect, it } from 'vitest'
import {
  cancelAppointment,
  rescheduleAppointment,
} from '../../src/adapters/booking/blvd/operations.js'
import { BlvdError, isBlvdError } from '../../src/adapters/booking/blvd/errors.js'
import type { BlvdClient } from '../../src/adapters/booking/blvd/client.js'

type ExecCall = { operationName: string; variables: Record<string, unknown> | undefined }

function stubClient(
  responses: Array<unknown | (() => unknown | Promise<unknown>)>,
): { client: BlvdClient; calls: ExecCall[] } {
  const calls: ExecCall[] = []
  let i = 0
  const client: BlvdClient = {
    async exec(operationName, _query, variables) {
      calls.push({ operationName, variables })
      const next = responses[i++]
      if (next === undefined) {
        throw new Error(`stubClient: no response queued for call #${i} (${operationName})`)
      }
      const value = typeof next === 'function' ? await (next as () => unknown)() : next
      return value as never
    },
  }
  return { client, calls }
}

describe('cancelAppointment — input shape', () => {
  it('sends BLVD-shaped input { id, notes } and resolves on success', async () => {
    const { client, calls } = stubClient([
      { cancelAppointment: { appointment: { id: 'appt-1' } } },
    ])

    await cancelAppointment(client, 'appt-1', 'client requested')

    expect(calls).toHaveLength(1)
    expect(calls[0]!.operationName).toBe('cancelAppointment')
    expect(calls[0]!.variables).toEqual({
      input: { id: 'appt-1', notes: 'client requested' },
    })
  })

  it('propagates BlvdError when the underlying GraphQL call fails', async () => {
    const { client } = stubClient([
      () => {
        throw new BlvdError('GRAPHQL_ERROR', 'BLVD cancelAppointment: appointment not found')
      },
    ])

    await expect(cancelAppointment(client, 'appt-missing', 'note')).rejects.toSatisfy((e) => {
      return isBlvdError(e) && (e as BlvdError).code === 'GRAPHQL_ERROR'
    })
  })
})

describe('rescheduleAppointment — input shape', () => {
  it('discovers a bookableTimeId and sends it (not a raw ISO)', async () => {
    const { client, calls } = stubClient([
      {
        availableRescheduleTimes: [
          { id: 'slot-a', startTime: '2026-06-01T09:00:00-04:00' },
          { id: 'slot-b', startTime: '2026-06-01T10:00:00-04:00' },
          { id: 'slot-c', startTime: '2026-06-01T11:00:00-04:00' },
        ],
      },
      {
        rescheduleAppointment: {
          appointment: { id: 'appt-1', startTime: '2026-06-01T10:00:00-04:00' },
        },
      },
    ])

    const result = await rescheduleAppointment(client, 'appt-1', '2026-06-01', '10:00')

    expect(result).toEqual({
      appointmentId: 'appt-1',
      startTime: '2026-06-01T10:00:00-04:00',
    })
    expect(calls).toHaveLength(2)
    expect(calls[0]!.operationName).toBe('availableRescheduleTimes')
    expect(calls[0]!.variables).toEqual({ id: 'appt-1', date: '2026-06-01' })
    expect(calls[1]!.operationName).toBe('rescheduleAppointment')
    expect(calls[1]!.variables).toEqual({
      input: { id: 'appt-1', bookableTimeId: 'slot-b', sendNotification: false },
    })
    // Belt-and-suspenders: never send a raw ISO datetime as a slot value.
    const mutationInput = (calls[1]!.variables as { input: Record<string, unknown> }).input
    expect(mutationInput).not.toHaveProperty('startTime')
  })

  it('throws TIME_UNAVAILABLE when no available slot matches the requested HH:MM', async () => {
    const { client, calls } = stubClient([
      {
        availableRescheduleTimes: [
          { id: 'slot-a', startTime: '2026-06-01T09:00:00-04:00' },
          { id: 'slot-c', startTime: '2026-06-01T11:00:00-04:00' },
        ],
      },
    ])

    await expect(
      rescheduleAppointment(client, 'appt-1', '2026-06-01', '10:00'),
    ).rejects.toSatisfy((e) => isBlvdError(e) && (e as BlvdError).code === 'TIME_UNAVAILABLE')

    expect(calls).toHaveLength(1) // mutation never attempted
  })

  it('throws BOOKING_FAILED when BLVD returns null (account lacks direct reschedule)', async () => {
    const { client } = stubClient([
      {
        availableRescheduleTimes: [
          { id: 'slot-b', startTime: '2026-06-01T10:00:00-04:00' },
        ],
      },
      { rescheduleAppointment: null },
    ])

    await expect(
      rescheduleAppointment(client, 'appt-1', '2026-06-01', '10:00'),
    ).rejects.toSatisfy((e) => isBlvdError(e) && (e as BlvdError).code === 'BOOKING_FAILED')
  })
})
