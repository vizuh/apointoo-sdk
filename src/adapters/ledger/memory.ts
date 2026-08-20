// In-memory EventLedger — for dev and tests. Append-only arrays; the same
// insert-only discipline as the Mongo impl, so this doubles as a parity target.

import type { EventLedger, IdentityEdge, LedgerEvent } from './adapter.js'

export interface MemoryEventLedger extends EventLedger {
  /** Read-back accessor for tests. Returns a copy. */
  events(): ReadonlyArray<LedgerEvent>
  /** Read-back accessor for tests. Returns a copy. */
  edges(): ReadonlyArray<IdentityEdge>
}

export function memoryEventLedger(): MemoryEventLedger {
  const eventLog: LedgerEvent[] = []
  const edgeLog: IdentityEdge[] = []

  return {
    async append(e) {
      eventLog.push(e)
    },
    async appendEdge(e) {
      edgeLog.push(e)
    },
    async health() {
      return { ok: true, name: 'memory' }
    },
    events() {
      return [...eventLog]
    },
    edges() {
      return [...edgeLog]
    },
  }
}
