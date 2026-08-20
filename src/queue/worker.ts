// Queue worker — claims items, dispatches to handlers per channel.
// Consumer chooses how to invoke: cron / Vercel scheduled function / continuous.

import { errMessage } from '../core/errors.js'
import { sleep } from '../core/internal/timing.js'
import type { OutboundQueue, QueueChannel, QueueItem } from './adapter.js'
import type { Logger } from '../core/types.js'

export type QueueHandler = (item: QueueItem) => Promise<void>

export type QueueWorkerOptions = {
  queue: OutboundQueue
  handlers: Partial<Record<QueueChannel, QueueHandler>>
  logger: Logger
  /** Worker identifier (helpful when multiple workers share a queue). */
  workerId?: string
  /** Items per claim batch. Default 10. */
  batchSize?: number
}

export type QueueRunSummary = {
  claimed: number
  done: number
  failed: number
  unhandled: number
}

/**
 * Run one batch — claim, dispatch, ack. Returns summary.
 * Consumer typically calls this from a cron / scheduled function.
 *
 * For continuous-run workers: wrap in a loop with sleep between empty batches.
 */
export async function runQueueBatch(opts: QueueWorkerOptions): Promise<QueueRunSummary> {
  const workerId = opts.workerId ?? `worker_${Math.random().toString(36).slice(2, 10)}`
  const batchSize = opts.batchSize ?? 10
  const summary: QueueRunSummary = { claimed: 0, done: 0, failed: 0, unhandled: 0 }

  const claimed = await opts.queue.claim(batchSize, workerId)
  summary.claimed = claimed.length

  for (const item of claimed) {
    const handler = opts.handlers[item.channel]
    if (!handler) {
      summary.unhandled += 1
      await opts.queue.markFailed(item.id, `No handler for channel ${item.channel}`)
      opts.logger.warn({
        evt: 'queue.unhandled_channel',
        ctx: { channel: item.channel, itemId: item.id },
      })
      continue
    }

    const t0 = Date.now()
    try {
      await handler(item)
      await opts.queue.markDone(item.id)
      summary.done += 1
      opts.logger.info({
        evt: 'queue.item.done',
        submissionId: item.submissionId,
        ctx: { channel: item.channel, itemId: item.id, attempts: item.attempts },
        durationMs: Date.now() - t0,
      })
    } catch (err) {
      const message = errMessage(err)
      await opts.queue.markFailed(item.id, message)
      summary.failed += 1
      opts.logger.warn({
        evt: 'queue.item.failed',
        submissionId: item.submissionId,
        message,
        ctx: { channel: item.channel, itemId: item.id, attempts: item.attempts + 1 },
        durationMs: Date.now() - t0,
      })
    }
  }

  return summary
}

/**
 * Continuous worker — loops until `signal.aborted`. Sleeps between empty batches.
 */
export async function runQueueLoop(
  opts: QueueWorkerOptions & { idleSleepMs?: number; signal?: AbortSignal },
): Promise<void> {
  const idleSleepMs = opts.idleSleepMs ?? 5_000
  while (!opts.signal?.aborted) {
    const summary = await runQueueBatch(opts)
    if (summary.claimed === 0) {
      await sleep(idleSleepMs)
    }
  }
}
