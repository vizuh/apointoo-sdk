// tests/email/templates.test.ts — email rendering + HTML escape regression
// covers critical-path behavior for src/email/templates.ts
//
// HTML escape is the only defense against operator-side XSS / template
// injection. If a user puts `<script>` in their name, it MUST be escaped
// in every place the name appears.

import { describe, expect, it } from 'vitest'
import { renderBookingEmail, defaultTheme } from '../../src/email/templates.js'
import { APOINTOO_HEADLESS_VERSION } from '../../src/core/version.js'
import type { BookingRequest, BookingConfirmation } from '../../src/core/types.js'

function makeRequest(overrides: Partial<BookingRequest> = {}): BookingRequest {
  return {
    submissionId: 'bk_20260514_abcd1234' as BookingRequest['submissionId'],
    projectKey: 'test',
    service: { id: 'svc-1', name: 'Consulta', isActive: true },
    serviceId: 'svc-1',
    requestedDate: '2026-08-01',
    requestedTime: '10:00',
    name: 'João Silva',
    phone: '+5511999990001',
    email: 'joao@example.com',
    message: undefined,
    isNewPatient: undefined,
    offerCode: undefined,
    attribution: { lastTouch: { channel: 'direct' } } as BookingRequest['attribution'],
    metadata: { userAgent: undefined, locale: undefined, timezone: undefined, ip: undefined },
    createdAtIso: '2026-05-14T10:00:00Z',
    fingerprint: 'fp_test' as BookingRequest['fingerprint'],
    configSnapshot: {
      timezone: 'America/Sao_Paulo',
      locale: 'pt-BR',
      scheduling: {
        availableDays: [1, 2, 3, 4, 5],
        timeSlots: [{ label: '10:00', value: '10:00' }],
        minAdvanceDays: 0,
        maxAdvanceDays: 90,
      },
    },
    ...overrides,
  }
}

function makeConfirmation(overrides: Partial<BookingConfirmation> = {}): BookingConfirmation {
  return {
    vendorAppointmentId: 'apt-1',
    vendorClientId: 'client-1',
    confirmationCode: 'CONF-XYZ',
    startTimeIso: '2026-08-01T13:00:00Z',
    metadata: {},
    ...overrides,
  }
}

describe('renderBookingEmail — subject', () => {
  it('default brand prefix is [Apointoo]', () => {
    const { subject } = renderBookingEmail(makeRequest(), makeConfirmation())
    expect(subject).toMatch(/^\[Apointoo\] /)
  })

  it('subject contains name + service + date', () => {
    const { subject } = renderBookingEmail(makeRequest(), makeConfirmation())
    expect(subject).toContain('João Silva')
    expect(subject).toContain('Consulta')
    expect(subject).toContain('2026-08-01')
  })

  it('prefix becomes ⚠ when a recoveryRow is supplied', () => {
    const { subject } = renderBookingEmail(makeRequest(), makeConfirmation(), {
      recoveryRow: ['a', 'b', 'c'],
    })
    expect(subject).toMatch(/^⚠ \[Apointoo\]/)
  })

  it('custom brand overrides the default', () => {
    const { subject } = renderBookingEmail(makeRequest(), makeConfirmation(), {
      brand: 'Example Salon',
    })
    expect(subject).toMatch(/^\[Example Salon\]/)
  })

  it('falls back to serviceId in subject when service object is null', () => {
    const { subject } = renderBookingEmail(
      makeRequest({ service: null, serviceId: 'svc-fallback' }),
      makeConfirmation(),
    )
    expect(subject).toContain('svc-fallback')
  })
})

describe('renderBookingEmail — HTML escape', () => {
  it('escapes < > & " \' in customer name', () => {
    const { html } = renderBookingEmail(
      makeRequest({ name: '<script>alert("xss")</script> & \'evil\'' }),
      makeConfirmation(),
    )
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&amp;')
    expect(html).toContain('&quot;')
    expect(html).toContain('&#039;')
  })

  it('escapes < > in message', () => {
    const { html } = renderBookingEmail(
      makeRequest({ message: '<img src=x onerror=alert(1)>' }),
      makeConfirmation(),
    )
    expect(html).not.toContain('<img src=x onerror')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })

  it('escapes phone field', () => {
    const { html } = renderBookingEmail(
      makeRequest({ phone: '+55<script>' }),
      makeConfirmation(),
    )
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('escapes email field when present', () => {
    const { html } = renderBookingEmail(
      makeRequest({ email: 'x@y.z<script>' }),
      makeConfirmation(),
    )
    expect(html).not.toContain('x@y.z<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('escapes recovery row content inside <pre>', () => {
    const { html } = renderBookingEmail(makeRequest(), makeConfirmation(), {
      recoveryRow: ['name with <b>html</b>', 'phone'],
    })
    expect(html).not.toContain('<b>html</b>')
    expect(html).toContain('&lt;b&gt;html&lt;/b&gt;')
  })

  it('escapes recovery reason text', () => {
    const { html } = renderBookingEmail(makeRequest(), makeConfirmation(), {
      recoveryRow: ['a'],
      recoveryReason: 'sheets <down>',
    })
    expect(html).toContain('sheets &lt;down&gt;')
    expect(html).not.toContain('sheets <down>')
  })

  it('escapes submissionId in the technical-data block', () => {
    const { html } = renderBookingEmail(
      makeRequest({ submissionId: 'bk_<evil>' as BookingRequest['submissionId'] }),
      makeConfirmation(),
    )
    expect(html).toContain('bk_&lt;evil&gt;')
  })
})

describe('renderBookingEmail — attribution block', () => {
  it('omits attribution block when no utm/gclid', () => {
    const { html } = renderBookingEmail(makeRequest(), makeConfirmation())
    expect(html).not.toContain('Origem:')
  })

  it('renders utm_source + utm_medium when present', () => {
    const { html } = renderBookingEmail(
      makeRequest({
        attribution: {
          lastTouch: { channel: 'paid_search' },
          utmSource: 'google',
          utmMedium: 'cpc',
          utmCampaign: 'spring',
        } as BookingRequest['attribution'],
      }),
      makeConfirmation(),
    )
    expect(html).toContain('utm_source=google')
    expect(html).toContain('utm_medium=cpc')
    expect(html).toContain('utm_campaign=spring')
  })

  it('truncates gclid display to 24 chars', () => {
    const longGclid = 'gcl_'.padEnd(80, 'A')
    const { html } = renderBookingEmail(
      makeRequest({
        attribution: { lastTouch: { channel: 'paid_search' }, gclid: longGclid } as BookingRequest['attribution'],
      }),
      makeConfirmation(),
    )
    expect(html).toContain('…') // truncation marker
    expect(html).not.toContain(longGclid) // full not present
  })

  it('escapes attribution values', () => {
    const { html } = renderBookingEmail(
      makeRequest({
        attribution: {
          lastTouch: { channel: 'paid_search' },
          utmSource: '<evil>',
        } as BookingRequest['attribution'],
      }),
      makeConfirmation(),
    )
    expect(html).not.toContain('<evil>')
    expect(html).toContain('&lt;evil&gt;')
  })
})

describe('renderBookingEmail — text variant', () => {
  it('has no HTML tags', () => {
    const { text } = renderBookingEmail(makeRequest(), makeConfirmation())
    expect(text).not.toMatch(/<[a-z]+/i)
  })

  it('joins recovery row with tabs', () => {
    const { text } = renderBookingEmail(makeRequest(), makeConfirmation(), {
      recoveryRow: ['a', 'b', 'c'],
    })
    expect(text).toContain('a\tb\tc')
  })

  it('includes version stamp', () => {
    const { text } = renderBookingEmail(makeRequest(), makeConfirmation())
    expect(text).toContain(`apointoo-sdk v${APOINTOO_HEADLESS_VERSION}`)
  })

  it('omits Email line when email is undefined', () => {
    const { text } = renderBookingEmail(
      makeRequest({ email: undefined }),
      makeConfirmation(),
    )
    expect(text).not.toContain('Email:')
  })

  it('does NOT escape (text variant is plain)', () => {
    const { text } = renderBookingEmail(
      makeRequest({ name: '<unscaped>' }),
      makeConfirmation(),
    )
    expect(text).toContain('<unscaped>')
  })
})

describe('renderBookingEmail — HTML structure', () => {
  it('includes version stamp', () => {
    const { html } = renderBookingEmail(makeRequest(), makeConfirmation())
    expect(html).toContain(`v${APOINTOO_HEADLESS_VERSION}`)
  })

  it('omits Email row when email is undefined', () => {
    const { html } = renderBookingEmail(
      makeRequest({ email: undefined }),
      makeConfirmation(),
    )
    expect(html).not.toContain('Email')
  })

  it('uses default theme colors when no theme override', () => {
    const { html } = renderBookingEmail(makeRequest(), makeConfirmation())
    expect(html).toContain(`#${defaultTheme.primary}`)
    expect(html).toContain(`#${defaultTheme.bg}`)
  })

  it('accepts a custom theme', () => {
    const { html } = renderBookingEmail(makeRequest(), makeConfirmation(), {
      theme: { primary: 'FF0000', bg: '000000', text: 'FFFFFF', muted: '888888', accent: 'F2C641' },
    })
    expect(html).toContain('#FF0000')
    expect(html).toContain('#000000')
  })
})
