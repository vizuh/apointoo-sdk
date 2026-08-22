import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { supabaseQueue } from '../../src/queue/supabase.js'

describe('supabaseQueue claim leases', () => {
  it('claims for one worker and clears the lease after success', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    const queue = supabaseQueue({
      url: 'https://example.supabase.co',
      serviceRoleKey: 'test-key',
      fetchImpl,
    })

    await queue.claim(5, 'worker-a')
    await queue.markDone('q_1')

    expect(JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string)).toEqual({
      p_max: 5,
      p_worker_id: 'worker-a',
    })
    expect(JSON.parse(fetchImpl.mock.calls[1]![1]!.body as string)).toMatchObject({
      status: 'done',
      claimed_by: null,
      lease_expires_at: null,
    })
  })

  it('ships a migration that reclaims expired in-flight rows', async () => {
    const sql = await readFile(
      new URL('../../docs/migrations/002-queue-claim-leases.sql', import.meta.url),
      'utf8',
    )

    expect(sql).toContain("status = 'in_flight'")
    expect(sql).toContain('lease_expires_at <= now()')
    expect(sql).toContain('claimed_by = p_worker_id')
  })
})
