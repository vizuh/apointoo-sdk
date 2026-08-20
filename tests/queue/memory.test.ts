// tests/queue/memory.test.ts — Tier 2 (adapter, memory impl)
import { describe, expect, it, beforeEach } from 'vitest'
import fc from 'fast-check'
import { memoryQueue } from '../../src/queue/memory.js'
import { computeBackoff } from '../../src/queue/adapter.js'
import type { QueueEnqueue } from '../../src/queue/adapter.js'

function makeEnqueue(overrides: Partial<QueueEnqueue> = {}): QueueEnqueue {
  return {
    tenantId: 'tenant-test',
    submissionId: 'bk_20260601_aabbccdd',
    channel: 'email' as const,
    payload: { subject: 'Test', to: 'a@example.com' },
    ...overrides,
  }
}

describe('memoryQueue', () => {
  let q: ReturnType<typeof memoryQueue>
  beforeEach(() => {
    q = memoryQueue()
  })

  it('enqueue → claim returns the item as in_flight', async () => {
    await q.enqueue(makeEnqueue())
    const items = await q.claim(1, 'worker-1')
    const item = items[0]
    expect(item).toBeDefined()
    expect(item!.status).toBe('in_flight')
    expect(item!.channel).toBe('email')
  })

  it('claim atomicity — two concurrent claims on one item yield only one result', async () => {
    await q.enqueue(makeEnqueue())
    const [r1, r2] = await Promise.all([q.claim(1, 'w1'), q.claim(1, 'w2')])
    const total = r1.length + r2.length
    expect(total).toBe(1) // only one worker gets the item
  })

  it('claimed item is not returned on subsequent claim', async () => {
    await q.enqueue(makeEnqueue())
    await q.claim(1, 'w1')
    const r2 = await q.claim(1, 'w2')
    expect(r2).toHaveLength(0)
  })

  it('markFailed flips item back to pending on first failure (under maxAttempts)', async () => {
    await q.enqueue(makeEnqueue())
    const items = await q.claim(1, 'w1')
    await q.markFailed(items[0]!.id, 'network timeout')
    const counts = await q.countByStatus('tenant-test')
    expect(counts.pending).toBe(1)
    expect(counts.in_flight).toBe(0)
  })

  it('after maxAttempts failures, item flips to dead', async () => {
    const maxAttempts = 3
    q = memoryQueue({ backoff: { maxAttempts, baseMs: 1, maxMs: 10 } })
    await q.enqueue(makeEnqueue())
    for (let i = 0; i < maxAttempts; i++) {
      // Each iteration: claim (item must be ready); but backoff may push next claim time.
      // With baseMs=1, maxMs=10, the item is ready almost immediately — small wait simulates time passing.
      // Easier: increment Date.now in a controllable way. For determinism, just keep claim+fail tight.
      const items = await q.claim(1, 'w')
      if (items.length === 0) {
        // Tiny wait so backoff window elapses
        await new Promise((r) => setTimeout(r, 15))
        const retry = await q.claim(1, 'w')
        expect(retry.length).toBe(1)
        await q.markFailed(retry[0]!.id, 'err')
      } else {
        await q.markFailed(items[0]!.id, 'err')
      }
    }
    const dead = await q.findDead('tenant-test')
    expect(dead).toHaveLength(1)
  })

  it('markDone → item not returned in future claims, status counts as done', async () => {
    await q.enqueue(makeEnqueue())
    const items = await q.claim(1, 'w1')
    await q.markDone(items[0]!.id)
    const counts = await q.countByStatus()
    expect(counts.done).toBe(1)
    expect(counts.pending).toBe(0)
  })
})

describe('computeBackoff — property-based', () => {
  it('never exceeds maxMs', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100 }),
        fc.record({
          baseMs: fc.integer({ min: 1, max: 60_000 }),
          maxMs: fc.integer({ min: 1, max: 3_600_000 }),
        }),
        (attempts, opts) => {
          return computeBackoff(attempts, opts) <= opts.maxMs
        },
      ),
    )
  })

  it('is monotonically non-decreasing with attempts (until cap)', () => {
    const opts = { baseMs: 1000, maxMs: 3_600_000 }
    for (let i = 0; i < 15; i++) {
      expect(computeBackoff(i, opts)).toBeLessThanOrEqual(computeBackoff(i + 1, opts))
    }
  })
})
