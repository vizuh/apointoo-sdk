// tests/server/webhooks.test.ts — HMAC signing + timing-safe verify + handler
// covers critical-path behavior for src/server/webhooks.ts
import { describe, expect, it, vi } from 'vitest'
import {
  subscribeWebhooks,
  verifyWebhookSignature,
  webhookQueueHandler,
} from '../../src/server/webhooks.js'
import { inMemoryEventBus } from '../../src/core/events.js'
import { memoryQueue } from '../../src/queue/memory.js'
import type { Logger } from '../../src/core/types.js'
import type { QueueItem } from '../../src/queue/adapter.js'

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

function makeItem(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id: 'queue-1',
    tenantId: 'tenant-A',
    submissionId: 'bk_20260514_abcd1234',
    channel: 'webhook',
    payload: {
      url: 'https://example.com/hook',
      event: { type: 'booking.confirmed', submissionId: 'bk_x' },
    },
    status: 'in_flight',
    attempts: 1,
    createdAt: new Date(),
    ...overrides,
  } as QueueItem
}

describe('verifyWebhookSignature', () => {
  const secret = 'shhhh'
  const body = '{"event":{"type":"booking.confirmed"}}'

  it('round-trips: sign and verify the same body+secret returns true', () => {
    // We don't export signHmac, but we can verify a known-correct signature.
    // The handler produces `sha256=<hex>`. To round-trip, run the handler with
    // a captured fetch and pull X-Apointoo-Signature out.
    let capturedSig = ''
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>
      capturedSig = headers['X-Apointoo-Signature'] ?? ''
      return new Response('ok', { status: 200 })
    })
    const handler = webhookQueueHandler({ fetchImpl: fetchImpl as typeof fetch })
    return handler(
      makeItem({
        payload: {
          url: 'https://example.com/hook',
          secret,
          event: { type: 'booking.confirmed' },
        },
      }),
    ).then(() => {
      // Reconstruct the body the handler signed (JSON.stringify({event}))
      const signedBody = JSON.stringify({ event: { type: 'booking.confirmed' } })
      expect(verifyWebhookSignature(signedBody, capturedSig, secret)).toBe(true)
    })
  })

  it('returns false when secret is wrong', () => {
    // valid format, wrong-secret signature
    const wrongSig = 'sha256=' + 'a'.repeat(64)
    expect(verifyWebhookSignature(body, wrongSig, secret)).toBe(false)
  })

  it('returns false when secret is empty', () => {
    expect(verifyWebhookSignature(body, 'sha256=' + 'a'.repeat(64), '')).toBe(false)
  })

  it('returns false when receivedSignature is empty', () => {
    expect(verifyWebhookSignature(body, '', secret)).toBe(false)
  })

  it('returns false when length mismatches (early return)', () => {
    expect(verifyWebhookSignature(body, 'sha256=tooshort', secret)).toBe(false)
  })

  it('returns false when same length but content differs', () => {
    // Build a sig of the right length but wrong bytes — exercises the full-length loop
    const wrongSameLength = 'sha256=' + 'f'.repeat(64)
    expect(verifyWebhookSignature(body, wrongSameLength, secret)).toBe(false)
  })

  it('produces deterministic signatures (same input → same sig)', async () => {
    let sigA = ''
    let sigB = ''
    const captureA = vi.fn(async (_url: string, init?: RequestInit) => {
      sigA = (init?.headers as Record<string, string>)['X-Apointoo-Signature'] ?? ''
      return new Response('ok', { status: 200 })
    })
    const captureB = vi.fn(async (_url: string, init?: RequestInit) => {
      sigB = (init?.headers as Record<string, string>)['X-Apointoo-Signature'] ?? ''
      return new Response('ok', { status: 200 })
    })
    await webhookQueueHandler({ fetchImpl: captureA as typeof fetch })(
      makeItem({ payload: { url: 'https://x', secret, event: { type: 'booking.confirmed' } } }),
    )
    await webhookQueueHandler({ fetchImpl: captureB as typeof fetch })(
      makeItem({ payload: { url: 'https://x', secret, event: { type: 'booking.confirmed' } } }),
    )
    expect(sigA).toBe(sigB)
    expect(sigA).toMatch(/^sha256=[0-9a-f]{64}$/)
  })
})

describe('webhookQueueHandler', () => {
  it('POSTs to the payload url with JSON body', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response('ok', { status: 200 }))
    const handler = webhookQueueHandler({ fetchImpl: fetchImpl as typeof fetch })
    await handler(makeItem())
    expect(fetchImpl).toHaveBeenCalledOnce()
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe('https://example.com/hook')
    expect(init?.method).toBe('POST')
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json')
  })

  it('omits X-Apointoo-Signature when secret is absent', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response('ok', { status: 200 }))
    await webhookQueueHandler({ fetchImpl: fetchImpl as typeof fetch })(makeItem())
    const headers = fetchImpl.mock.calls[0]![1]!.headers as Record<string, string>
    expect(headers['X-Apointoo-Signature']).toBeUndefined()
  })

  it('omits X-Apointoo-Signature when secret is empty string', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response('ok', { status: 200 }))
    await webhookQueueHandler({ fetchImpl: fetchImpl as typeof fetch })(
      makeItem({
        payload: {
          url: 'https://example.com/hook',
          secret: '',
          event: { type: 'booking.confirmed' },
        },
      }),
    )
    const headers = fetchImpl.mock.calls[0]![1]!.headers as Record<string, string>
    expect(headers['X-Apointoo-Signature']).toBeUndefined()
  })

  it('adds standard tracing headers', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response('ok', { status: 200 }))
    await webhookQueueHandler({ fetchImpl: fetchImpl as typeof fetch })(
      makeItem({
        id: 'queue-42',
        tenantId: 'tenant-Z',
        submissionId: 'bk_xyz',
      }),
    )
    const headers = fetchImpl.mock.calls[0]![1]!.headers as Record<string, string>
    expect(headers['X-Apointoo-Submission']).toBe('bk_xyz')
    expect(headers['X-Apointoo-Tenant']).toBe('tenant-Z')
    expect(headers['X-Apointoo-Delivery']).toBe('queue-42')
    expect(headers['User-Agent']).toMatch(/apointoo-sdk-webhooks/)
  })

  it('throws on non-2xx response (retryable failure)', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response('boom', { status: 503 }))
    await expect(
      webhookQueueHandler({ fetchImpl: fetchImpl as typeof fetch })(makeItem()),
    ).rejects.toThrow(/503/)
  })

  it('throws when payload.url is missing', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response('ok', { status: 200 }))
    await expect(
      webhookQueueHandler({ fetchImpl: fetchImpl as typeof fetch })(
        makeItem({ payload: { event: { type: 'booking.confirmed' } } }),
      ),
    ).rejects.toThrow(/url and payload.event required/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('throws when payload.event is missing', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response('ok', { status: 200 }))
    await expect(
      webhookQueueHandler({ fetchImpl: fetchImpl as typeof fetch })(
        makeItem({ payload: { url: 'https://x' } }),
      ),
    ).rejects.toThrow(/url and payload.event required/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('sends the event under {event: ...} envelope', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response('ok', { status: 200 }))
    await webhookQueueHandler({ fetchImpl: fetchImpl as typeof fetch })(
      makeItem({
        payload: {
          url: 'https://x',
          event: { type: 'booking.confirmed', submissionId: 'bk_y', custom: 'value' },
        },
      }),
    )
    const body = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string)
    expect(body).toEqual({
      event: { type: 'booking.confirmed', submissionId: 'bk_y', custom: 'value' },
    })
  })
})

describe('subscribeWebhooks', () => {
  it('enqueues a webhook item when an event matches the subscription filter', async () => {
    const bus = inMemoryEventBus()
    const queue = memoryQueue()
    const unsub = subscribeWebhooks({
      bus,
      queue,
      logger: silentLogger,
      subscriptions: [
        {
          url: 'https://hook.example.com',
          events: ['booking.confirmed'],
          secret: 's',
          label: 'primary',
        },
      ],
    })
    await bus.publish({
      type: 'booking.confirmed',
      tenantId: 'tenant-A',
      submissionId: 'bk_x',
      vendor: 'memory',
      vendorAppointmentId: 'apt-1',
      vendorClientId: undefined,
      attribution: { lastTouch: { channel: 'direct' } },
      ts: Date.now(),
    })
    // Drain the queue
    const claimed = await queue.claim(10, 'worker-1')
    expect(claimed).toHaveLength(1)
    expect(claimed[0]!.channel).toBe('webhook')
    expect(claimed[0]!.payload.url).toBe('https://hook.example.com')
    expect(claimed[0]!.payload.secret).toBe('s')
    expect(claimed[0]!.payload.label).toBe('primary')
    unsub()
  })

  it('does NOT enqueue when event type is not in the filter', async () => {
    const bus = inMemoryEventBus()
    const queue = memoryQueue()
    subscribeWebhooks({
      bus,
      queue,
      logger: silentLogger,
      subscriptions: [{ url: 'https://x', events: ['booking.confirmed'] }],
    })
    await bus.publish({
      type: 'booking.requested',
      tenantId: 'tenant-A',
      submissionId: 'bk_x',
      serviceId: 'svc-1',
      attribution: { lastTouch: { channel: 'direct' } },
      idempotencyKey: undefined,
      ts: Date.now(),
    })
    const claimed = await queue.claim(10, 'worker-1')
    expect(claimed).toHaveLength(0)
  })

  it('enqueues for all events when no filter is set', async () => {
    const bus = inMemoryEventBus()
    const queue = memoryQueue()
    subscribeWebhooks({
      bus,
      queue,
      logger: silentLogger,
      subscriptions: [{ url: 'https://x' }],
    })
    await bus.publish({
      type: 'booking.requested',
      tenantId: 't',
      submissionId: 'bk_x',
      serviceId: 'svc-1',
      attribution: { lastTouch: { channel: 'direct' } },
      idempotencyKey: undefined,
      ts: Date.now(),
    })
    await bus.publish({
      type: 'booking.confirmed',
      tenantId: 't',
      submissionId: 'bk_x',
      vendor: 'memory',
      vendorAppointmentId: 'apt-1',
      vendorClientId: undefined,
      attribution: { lastTouch: { channel: 'direct' } },
      ts: Date.now(),
    })
    expect(await queue.claim(10, 'w')).toHaveLength(2)
  })

  it('empty events array disables the subscription', async () => {
    const bus = inMemoryEventBus()
    const queue = memoryQueue()
    subscribeWebhooks({
      bus,
      queue,
      logger: silentLogger,
      subscriptions: [{ url: 'https://x', events: [] }],
    })
    await bus.publish({
      type: 'booking.confirmed',
      tenantId: 't',
      submissionId: 'bk_x',
      vendor: 'memory',
      vendorAppointmentId: 'apt-1',
      vendorClientId: undefined,
      attribution: { lastTouch: { channel: 'direct' } },
      ts: Date.now(),
    })
    expect(await queue.claim(10, 'w')).toHaveLength(0)
  })
})
