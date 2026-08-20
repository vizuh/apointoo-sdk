// brevoRestAdapter — recipient resolution: tenant config wins over adapter defaults.

import { describe, expect, it } from 'vitest'

import { brevoRestAdapter } from '../../../src/adapters/notification/brevo-rest/index.js'
import { BookingError } from '../../../src/core/errors.js'
import type {
  AdapterContext,
  BookingAttribution,
  BookingConfirmation,
  BookingKitConfig,
  BookingRequest,
  Logger,
} from '../../../src/core/types.js'

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

const FIXED_NOW = new Date('2026-05-28T10:00:00.000Z')

const BASE_CONFIG: BookingKitConfig = {
  projectKey: 'example-studio',
  businessName: 'Example Studio',
  locale: 'pt-PT',
  timezone: 'Europe/Lisbon',
  services: [{ id: 'srv-1', name: 'Consulta' }],
  scheduling: {
    availableDays: [1, 2, 3, 4, 5],
    timeSlots: [{ label: '10:00', value: '10:00' }],
    minAdvanceDays: 0,
    maxAdvanceDays: 60,
  },
}

function makeCtx(configOverrides: Partial<BookingKitConfig> = {}): AdapterContext {
  return {
    config: { ...BASE_CONFIG, ...configOverrides },
    logger: silentLogger,
    now: () => FIXED_NOW,
  }
}

function makeRequest(): BookingRequest {
  return {
    submissionId: 'sub-test-0001',
    projectKey: 'example-studio',
    service: { id: 'srv-1', name: 'Consulta' } as never,
    serviceId: 'srv-1',
    requestedDate: '2026-06-01',
    requestedTime: '14:30',
    name: 'Test Lead',
    phone: '+351900000000',
    email: undefined,
    message: undefined,
    isNewPatient: undefined,
    offerCode: undefined,
    attribution: {
      gclid: null,
      fbclid: null,
      utmSource: null,
      utmMedium: null,
      utmCampaign: null,
      utmTerm: null,
      utmContent: null,
    } as unknown as BookingAttribution,
    metadata: {
      userAgent: undefined,
      locale: 'pt-PT',
      timezone: 'Europe/Lisbon',
      ip: undefined,
    },
    createdAtIso: FIXED_NOW.toISOString(),
    fingerprint: 'fp-test',
    configSnapshot: {
      timezone: 'Europe/Lisbon',
      locale: 'pt-PT',
      scheduling: {
        availableDays: [1, 2, 3, 4, 5],
        timeSlots: [{ label: '10:00', value: '10:00' }],
        minAdvanceDays: 0,
        maxAdvanceDays: 60,
      } as never,
    },
  }
}

const CONFIRMATION: BookingConfirmation = {
  vendorAppointmentId: 'apt-1',
  vendorClientId: undefined,
  confirmationCode: 'CONF-1',
  startTimeIso: '2026-06-01T13:30:00.000Z',
  metadata: {},
}

function makeFetchSpy(): { fetch: typeof fetch; calls: Array<{ url: string; body: unknown }> } {
  const calls: Array<{ url: string; body: unknown }> = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ url, body })
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  return { fetch: fetchImpl, calls }
}

describe('brevoRestAdapter — recipient resolution', () => {
  it('tenant config notifications.to overrides defaultTo, and notifications.bcc overrides defaultBcc', async () => {
    const spy = makeFetchSpy()
    const adapter = brevoRestAdapter({
      apiKey: 'k',
      from: 'noreply@example.com',
      defaultTo: ['fallback@example.com'],
      defaultBcc: ['fallback-bcc@example.com'],
      fetchImpl: spy.fetch,
    })
    const ctx = makeCtx({
      notifications: {
        from: 'noreply@example.com',
        to: ['tenant@example.com'],
        bcc: ['tenant-bcc@example.com'],
      },
    })

    await adapter.sendBookingNotification(makeRequest(), CONFIRMATION, {}, ctx)

    expect(spy.calls).toHaveLength(1)
    const body = spy.calls[0]!.body as { to: Array<{ email: string }>; bcc: Array<{ email: string }> }
    expect(body.to).toEqual([{ email: 'tenant@example.com' }])
    expect(body.bcc).toEqual([{ email: 'tenant-bcc@example.com' }])
  })

  it('falls back to defaultTo / defaultBcc when tenant config has no notifications block', async () => {
    const spy = makeFetchSpy()
    const adapter = brevoRestAdapter({
      apiKey: 'k',
      from: 'noreply@example.com',
      defaultTo: ['fallback@example.com'],
      defaultBcc: ['fallback-bcc@example.com'],
      fetchImpl: spy.fetch,
    })

    await adapter.sendBookingNotification(makeRequest(), CONFIRMATION, {}, makeCtx())

    expect(spy.calls).toHaveLength(1)
    const body = spy.calls[0]!.body as { to: Array<{ email: string }>; bcc: Array<{ email: string }> }
    expect(body.to).toEqual([{ email: 'fallback@example.com' }])
    expect(body.bcc).toEqual([{ email: 'fallback-bcc@example.com' }])
  })

  it('throws BookingError(CONFIG_INVALID) when neither tenant config nor adapter defaults provide recipients', async () => {
    const spy = makeFetchSpy()
    const adapter = brevoRestAdapter({
      apiKey: 'k',
      from: 'noreply@example.com',
      fetchImpl: spy.fetch,
    })

    await expect(
      adapter.sendBookingNotification(makeRequest(), CONFIRMATION, {}, makeCtx()),
    ).rejects.toBeInstanceOf(BookingError)
    expect(spy.calls).toHaveLength(0)
  })
})
