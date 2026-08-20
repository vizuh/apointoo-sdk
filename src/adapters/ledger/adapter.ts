// Neutral event-ledger surface (A1-SAFE). Booking-agnostic by invariant:
// NO booking type may appear in this file. The ledger records arbitrary
// domain events as flat, append-only documents keyed by tenant + subject.
// The only booking-aware glue lives in `./translate.ts`.

/**
 * A single recorded event. `subjectKey` is the stable identity the event is
 * about (visitor/session/subject), or null when not yet resolvable.
 * `attribution` is lifted to a first-class field when present; everything
 * else event-specific lands in `properties`.
 */
export type LedgerEvent = {
  eventId: string
  tenantId: string
  type: string
  subjectKey: string | null
  occurredAt: Date
  receivedAt: Date
  attribution: Record<string, unknown> | null
  properties: Record<string, unknown>
}

/**
 * A directed identity-graph edge (e.g. visitor→subject merge). Append-only:
 * edges accrete, they are never mutated or deleted.
 */
export type IdentityEdge = {
  edgeId: string
  tenantId: string
  fromKey: string
  toKey: string
  kind: string
  strength: number
  createdAt: Date
}

/**
 * Append-only ledger. Implementations INSERT only — never update or delete.
 * Failures are surfaced to the caller (the event-bus subscriber swallows them
 * so a ledger blip never breaks a booking).
 */
export interface EventLedger {
  append(e: LedgerEvent): Promise<void>
  appendEdge(e: IdentityEdge): Promise<void>
  health(): Promise<{ ok: boolean; name: string; error?: string }>
}
