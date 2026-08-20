// Memory persistence — for tests. Captures every appended record.

import type { PersistenceAdapter, PersistenceRecord } from '../adapter.js'
import type { AdapterContext, AdapterHealth } from '../../../core/types.js'

export type MemoryPersistenceAdapter = PersistenceAdapter & {
  records: ReadonlyArray<PersistenceRecord>
}

export function memoryPersistenceAdapter(failWith?: Error): MemoryPersistenceAdapter {
  const records: PersistenceRecord[] = []
  const adapter: PersistenceAdapter = {
    async append(record, _ctx: AdapterContext): Promise<void> {
      if (failWith) throw failWith
      records.push(record)
    },
    async health(_ctx): Promise<AdapterHealth> {
      return { ok: true, name: 'memory', version: '0.1.0' }
    },
  }
  return Object.assign(adapter, { records })
}
