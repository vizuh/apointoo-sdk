// In-memory OutboundQueue — for tests and dev. No persistence across restarts.

import {
  computeBackoff,
  shouldFlipToDead,
  type BackoffOptions,
  type OutboundQueue,
  type QueueEnqueue,
  type QueueItem,
  type QueueItemStatus,
} from './adapter.js'

export type MemoryQueueOptions = {
  backoff?: BackoffOptions
}

export function memoryQueue(opts: MemoryQueueOptions = {}): OutboundQueue {
  const items = new Map<string, QueueItem>()
  let counter = 0

  return {
    async enqueue(input: QueueEnqueue): Promise<string> {
      const id = `q_${++counter}_${Date.now().toString(36)}`
      const now = new Date()
      items.set(id, {
        id,
        tenantId: input.tenantId,
        submissionId: input.submissionId,
        channel: input.channel,
        payload: input.payload,
        status: 'pending',
        attempts: 0,
        lastError: null,
        nextRetryAt: input.scheduledFor ?? now,
        createdAt: now,
        updatedAt: now,
      })
      return id
    },

    async claim(max: number, _workerId: string): Promise<QueueItem[]> {
      const now = Date.now()
      const claimed: QueueItem[] = []
      for (const item of items.values()) {
        if (item.status !== 'pending') continue
        if (item.nextRetryAt.getTime() > now) continue
        // Build the updated item once — store it and return it.
        const updated: QueueItem = { ...item, status: 'in_flight', updatedAt: new Date() }
        items.set(item.id, updated)
        claimed.push(updated)
        if (claimed.length >= max) break
      }
      return claimed
    },

    async markDone(itemId: string): Promise<void> {
      const item = items.get(itemId)
      if (!item) return
      items.set(itemId, { ...item, status: 'done', updatedAt: new Date() })
    },

    async markFailed(itemId: string, error: string): Promise<void> {
      const item = items.get(itemId)
      if (!item) return
      const attempts = item.attempts + 1
      const dead = shouldFlipToDead(attempts, opts.backoff)
      const next: QueueItem = {
        ...item,
        attempts,
        lastError: error,
        status: dead ? 'dead' : 'pending',
        nextRetryAt: dead
          ? item.nextRetryAt
          : new Date(Date.now() + computeBackoff(attempts, opts.backoff)),
        updatedAt: new Date(),
      }
      items.set(itemId, next)
    },

    async findDead(tenantId?: string, limit = 100): Promise<QueueItem[]> {
      const out: QueueItem[] = []
      for (const item of items.values()) {
        if (item.status !== 'dead') continue
        if (tenantId !== undefined && item.tenantId !== tenantId) continue
        out.push(item)
        if (out.length >= limit) break
      }
      return out
    },

    async countByStatus(tenantId?: string): Promise<Record<QueueItemStatus, number>> {
      const counts: Record<QueueItemStatus, number> = {
        pending: 0,
        in_flight: 0,
        done: 0,
        failed: 0,
        dead: 0,
      }
      for (const item of items.values()) {
        if (tenantId !== undefined && item.tenantId !== tenantId) continue
        counts[item.status] += 1
      }
      return counts
    },

    async health() {
      return { ok: true, name: 'memory-queue' }
    },
  }
}
