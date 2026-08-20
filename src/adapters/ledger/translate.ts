// Booking → ledger glue. This is the ONLY booking-aware file in the ledger
// adapter family — `adapter.ts` and `memory.ts` stay A1-SAFE. It maps a
// domain-bus event onto the neutral LedgerEvent shape:
//   - mint a fresh evt_ id
//   - copy `type` and `tenantId`
//   - `ts` (unix ms) → `occurredAt`; `receivedAt` = now (ingestion time)
//   - `submissionId` → `subjectKey` (the identity the event is about)
//   - lift `attribution` to its own field when the event carries one
//   - everything else event-specific lands in `properties`

import { newEventId } from '../../core/ids.js'
import type { DomainEvent } from '../../core/events.js'
import type { LedgerEvent } from './adapter.js'

export function translateDomainEvent(e: DomainEvent): LedgerEvent {
  // Strip the fields promoted to first-class columns; the rest is residual.
  const { ts, tenantId, submissionId, type, ...rest } = e as DomainEvent & {
    attribution?: unknown
  }
  const { attribution, ...properties } = rest as {
    attribution?: Record<string, unknown>
    [k: string]: unknown
  }

  return {
    eventId: newEventId(),
    tenantId,
    type,
    subjectKey: submissionId,
    occurredAt: new Date(ts),
    receivedAt: new Date(),
    attribution: attribution ?? null,
    properties: { submissionId, ...properties },
  }
}
