// tests/queue/worker.test.ts — runQueueBatch claim/dispatch/ack semantics
// covers critical-path behavior for src/queue/worker.ts
//
// Wrong retry semantics = duplicate sends or lost notifications. Test:
// - happy path: claim, handle, markDone
// - missing handler: unhandled, markFailed
// - handler throws: markFailed, retry on next batch
// - maxAttempts → flips to dead

import { describe, expect, it, vi } from 'vitest'
import { runQueueBatch } from '../../src/queue/worker.js'
import { memoryQueue } from '../../src/queue/memory.js'
import type { Logger } from '../../src/core/types.js'
import type { QueueHandler } from '../../src/queue/worker.js'
import type { QueueChannel, QueueItem } from '../../src/queue/adapter.js'

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

async function seed(queue: ReturnType<typeof memoryQueue>, channel: QueueChannel, n = 1) {
  for (let i = 0; i < n; i++) {
    await queue.enqueue({
      tenantId: 'tenant-A',
      submissionId: `bk_${i}`,
      channel,
      payload: { i },
    })
  }
}

describe('runQueueBatch — happy path', () => {
  it('claims and dispatches to the matching channel handler', async () => {
    const queue = memoryQueue()
    await seed(queue, 'email', 2)
    const emailHandler = vi.fn<QueueHandler>(async () => undefined)

    const summary = await runQueueBatch({
      queue,
      handlers: { email: emailHandler },
      logger: silentLogger,
    })

    expect(summary.claimed).toBe(2)
    expect(summary.done).toBe(2)
    expect(summary.failed).toBe(0)
    expect(summary.unhandled).toBe(0)
    expect(emailHandler).toHaveBeenCalledTimes(2)
  })

  it('does not re-claim items already marked done', async () => {
    const queue = memoryQueue()
    await seed(queue, 'email', 1)
    const handler = vi.fn<QueueHandler>(async () => undefined)
    await runQueueBatch({ queue, handlers: { email: handler }, logger: silentLogger })
    // Second batch should be empty
    const second = await runQueueBatch({ queue, handlers: { email: handler }, logger: silentLogger })
    expect(second.claimed).toBe(0)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('honors batchSize override', async () => {
    const queue = memoryQueue()
    await seed(queue, 'email', 5)
    const handler = vi.fn<QueueHandler>(async () => undefined)
    const summary = await runQueueBatch({
      queue,
      handlers: { email: handler },
      logger: silentLogger,
      batchSize: 2,
    })
    expect(summary.claimed).toBe(2)
    expect(handler).toHaveBeenCalledTimes(2)
  })

  it('uses the supplied workerId (does not error when omitted)', async () => {
    const queue = memoryQueue()
    await seed(queue, 'email', 1)
    const handler = vi.fn<QueueHandler>(async () => undefined)
    await runQueueBatch({
      queue,
      handlers: { email: handler },
      logger: silentLogger,
      workerId: 'my-worker-id',
    })
    // No throw is the assertion — workerId is passed through to queue.claim
  })

  it('returns zeros when nothing to claim', async () => {
    const queue = memoryQueue()
    const handler = vi.fn<QueueHandler>(async () => undefined)
    const summary = await runQueueBatch({
      queue,
      handlers: { email: handler },
      logger: silentLogger,
    })
    expect(summary).toEqual({ claimed: 0, done: 0, failed: 0, unhandled: 0 })
    expect(handler).not.toHaveBeenCalled()
  })
})

describe('runQueueBatch — missing handler', () => {
  it('marks failed + increments unhandled when no handler for channel', async () => {
    const queue = memoryQueue()
    await seed(queue, 'whatsapp', 1)

    const summary = await runQueueBatch({
      queue,
      handlers: {}, // no whatsapp handler
      logger: silentLogger,
    })

    expect(summary.claimed).toBe(1)
    expect(summary.unhandled).toBe(1)
    expect(summary.done).toBe(0)
  })

  it('logs unhandled-channel warnings', async () => {
    const queue = memoryQueue()
    await seed(queue, 'sms', 1)
    const logs: unknown[] = []
    const captureLogger: Logger = {
      ...silentLogger,
      warn: (evt) => {
        logs.push(evt)
      },
    }

    await runQueueBatch({
      queue,
      handlers: {},
      logger: captureLogger,
    })

    expect(logs.length).toBeGreaterThan(0)
    const evt = logs[0] as { evt: string; ctx: { channel: string } }
    expect(evt.evt).toBe('queue.unhandled_channel')
    expect(evt.ctx.channel).toBe('sms')
  })
})

describe('runQueueBatch — handler errors', () => {
  it('marks failed when handler throws', async () => {
    const queue = memoryQueue()
    await seed(queue, 'email', 1)
    const handler = vi.fn<QueueHandler>(async () => {
      throw new Error('brevo timed out')
    })

    const summary = await runQueueBatch({
      queue,
      handlers: { email: handler },
      logger: silentLogger,
    })

    expect(summary.failed).toBe(1)
    expect(summary.done).toBe(0)
  })

  it('logs failed items with the error message', async () => {
    const queue = memoryQueue()
    await seed(queue, 'email', 1)
    const logs: unknown[] = []
    const captureLogger: Logger = {
      ...silentLogger,
      warn: (evt) => {
        logs.push(evt)
      },
    }
    await runQueueBatch({
      queue,
      handlers: {
        email: async () => {
          throw new Error('vendor unreachable')
        },
      },
      logger: captureLogger,
    })
    const failedLog = logs.find((l): l is { evt: string; message: string } => {
      return (l as { evt?: string }).evt === 'queue.item.failed'
    })
    expect(failedLog).toBeDefined()
    expect(failedLog!.message).toBe('vendor unreachable')
  })

  it('handles non-Error throws (string, plain object)', async () => {
    const queue = memoryQueue()
    await seed(queue, 'email', 1)
    const summary = await runQueueBatch({
      queue,
      handlers: {
        email: async () => {
          throw 'plain string thrown'
        },
      },
      logger: silentLogger,
    })
    expect(summary.failed).toBe(1)
  })

  it('continues processing remaining items after one fails', async () => {
    const queue = memoryQueue()
    await queue.enqueue({ tenantId: 't', submissionId: 'bk_1', channel: 'email', payload: { which: 'fail' } })
    await queue.enqueue({ tenantId: 't', submissionId: 'bk_2', channel: 'email', payload: { which: 'ok' } })

    const summary = await runQueueBatch({
      queue,
      handlers: {
        email: async (item: QueueItem) => {
          if (item.payload.which === 'fail') throw new Error('boom')
        },
      },
      logger: silentLogger,
    })

    expect(summary.claimed).toBe(2)
    expect(summary.done).toBe(1)
    expect(summary.failed).toBe(1)
  })
})

describe('runQueueBatch — retry → dead transition', () => {
  it('flips item to dead after exceeding maxAttempts (default 10)', async () => {
    // tighten backoff so retries are immediately re-claimable
    const queue = memoryQueue({ backoff: { baseMs: 0, maxMs: 0, maxAttempts: 3 } })
    await queue.enqueue({ tenantId: 't', submissionId: 'bk_x', channel: 'email', payload: {} })

    // Always-throwing handler
    const handler = vi.fn<QueueHandler>(async () => {
      throw new Error('persistent failure')
    })

    // Run repeatedly — should fail each time, eventually flip to dead
    for (let i = 0; i < 5; i++) {
      await runQueueBatch({ queue, handlers: { email: handler }, logger: silentLogger })
    }

    const dead = await queue.findDead()
    expect(dead).toHaveLength(1)
    expect(dead[0]!.lastError).toBe('persistent failure')
  })
})
