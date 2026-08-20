// Tier 2 (unit) — sanitizePayload allow-list regression.
//
// Verifies the audit-log subscriber's allow-list strips any PII-shaped field
// from event payloads BEFORE persistence. The original implementation was a
// deny-list (strip only `idempotencyKey` + bookkeeping fields), which left
// every other event field — including any future PII — to land in the
// 6-year-TTL audit_log as an un-erasable HIPAA/GDPR liability.
//
// Reference: SHIP_PLAN audit Correction B (2026-05-24 synthesis).

import { describe, it, expect } from 'vitest'
import {
  createAuditLogSubscriber,
  type AuditLogEntry,
  type AuditLogWriter,
} from '../../src/adapters/audit/index.js'
import { inMemoryEventBus, type DomainEvent } from '../../src/core/events.js'

function captureWriter(): { writer: AuditLogWriter; entries: AuditLogEntry[] } {
  const entries: AuditLogEntry[] = []
  return {
    writer: {
      write: async (entry) => {
        entries.push(entry)
      },
    },
    entries,
  }
}

async function flush(): Promise<void> {
  // inMemoryEventBus is fire-and-forget; yield to allow subscribers to run.
  await new Promise((r) => setImmediate(r))
}

describe('sanitizePayload — allow-list strips PII', () => {
  it('drops fields not in the allow-list, even when emitted on a known event type', async () => {
    const { writer, entries } = captureWriter()
    const bus = inMemoryEventBus()
    createAuditLogSubscriber(writer, bus)

    // A confirmed-event with rogue PII fields injected (simulating a future
    // event-type change that accidentally introduces customer data).
    const event = {
      type: 'booking.confirmed',
      ts: 1716640000000,
      tenantId: 't-1',
      submissionId: 'sub-1',
      vendor: 'blvd',
      vendorAppointmentId: 'appt-99',
      vendorClientId: 'client-7',
      attribution: { gclid: 'abc', utmSource: 'google' },
      // ↓↓↓ rogue PII fields that should NOT survive sanitisation
      customerEmail: 'jane@example.com',
      customerPhone: '+351911222333',
      customerName: 'Jane Doe',
      medicalNotes: 'Has a peanut allergy',
      ipAddress: '203.0.113.42',
    } as unknown as DomainEvent

    await bus.publish(event)
    await flush()

    expect(entries).toHaveLength(1)
    const entry = entries[0]!
    const payload = entry.payload

    // Allowed fields survive
    expect(payload.vendor).toBe('blvd')
    expect(payload.vendorAppointmentId).toBe('appt-99')
    expect(payload.vendorClientId).toBe('client-7')
    expect(payload.attribution).toEqual({ gclid: 'abc', utmSource: 'google' })

    // PII fields are stripped — this is the load-bearing assertion
    expect(payload).not.toHaveProperty('customerEmail')
    expect(payload).not.toHaveProperty('customerPhone')
    expect(payload).not.toHaveProperty('customerName')
    expect(payload).not.toHaveProperty('medicalNotes')
    expect(payload).not.toHaveProperty('ipAddress')
  })

  it('strips PII fields injected into attribution sub-object', async () => {
    const { writer, entries } = captureWriter()
    const bus = inMemoryEventBus()
    createAuditLogSubscriber(writer, bus)

    const event = {
      type: 'booking.requested',
      ts: 1716640000000,
      tenantId: 't-1',
      submissionId: 'sub-2',
      serviceId: 'svc-1',
      idempotencyKey: 'idk-1',
      attribution: {
        gclid: 'abc',
        utmCampaign: 'spring',
        // ↓↓↓ rogue PII inside attribution
        userEmail: 'jane@example.com',
        userPhone: '+351911222333',
      },
    } as unknown as DomainEvent

    await bus.publish(event)
    await flush()

    expect(entries).toHaveLength(1)
    const attr = entries[0]!.payload.attribution as Record<string, unknown>

    expect(attr.gclid).toBe('abc')
    expect(attr.utmCampaign).toBe('spring')
    expect(attr).not.toHaveProperty('userEmail')
    expect(attr).not.toHaveProperty('userPhone')
  })

  it('preserves Google braid and consent provenance but strips nested rogue fields', async () => {
    const { writer, entries } = captureWriter()
    const bus = inMemoryEventBus()
    createAuditLogSubscriber(writer, bus)

    await bus.publish({
      type: 'booking.requested',
      ts: 1716640000000,
      tenantId: 't-1',
      submissionId: 'sub-consent',
      serviceId: 'svc-1',
      attribution: {
        gbraid: 'gbraid-1',
        wbraid: 'wbraid-1',
        consent: {
          adStorage: 'granted',
          adUserData: 'granted',
          adPersonalization: 'denied',
          analyticsStorage: 'denied',
          capturedAt: '2026-07-15T12:00:00+00:00',
          source: 'api',
          customerEmail: 'must-not-survive@example.com',
        },
      },
    } as unknown as DomainEvent)
    await flush()

    const attr = entries[0]!.payload.attribution as Record<string, unknown>
    expect(attr.gbraid).toBe('gbraid-1')
    expect(attr.wbraid).toBe('wbraid-1')
    expect(attr.consent).toEqual({
      adStorage: 'granted',
      adUserData: 'granted',
      adPersonalization: 'denied',
      analyticsStorage: 'denied',
      capturedAt: '2026-07-15T12:00:00+00:00',
      source: 'api',
    })
  })

  it('still strips bookkeeping + idempotency key from top-level payload', async () => {
    const { writer, entries } = captureWriter()
    const bus = inMemoryEventBus()
    createAuditLogSubscriber(writer, bus)

    const event: DomainEvent = {
      type: 'booking.requested',
      ts: 1716640000000,
      tenantId: 't-1',
      submissionId: 'sub-3',
      serviceId: 'svc-1',
      attribution: {},
      idempotencyKey: 'idk-3',
    }

    await bus.publish(event)
    await flush()

    expect(entries).toHaveLength(1)
    const payload = entries[0]!.payload

    // Bookkeeping promoted to top-level entry fields, not in payload
    expect(payload).not.toHaveProperty('type')
    expect(payload).not.toHaveProperty('ts')
    expect(payload).not.toHaveProperty('tenantId')
    expect(payload).not.toHaveProperty('submissionId')
    // Idempotency key — never in audit log
    expect(payload).not.toHaveProperty('idempotencyKey')
    // serviceId allowed
    expect(payload.serviceId).toBe('svc-1')
  })
})
