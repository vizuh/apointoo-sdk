// MongoDB EventLedger (B2) — append-only persistence for the neutral ledger.
//
// Append-only discipline: append/appendEdge INSERT only. This adapter never
// updates or deletes a ledger document. Every document carries `tenantId`.
//
// Required collections + indexes (code-as-source-of-truth — no migration file;
// ensured lazily on first use):
//   events  — { tenantId: 1, receivedAt: 1 }   (tenant timeline scans)
//             { tenantId: 1, subjectKey: 1 }    (per-subject lookups)
//   edges   — { tenantId: 1, fromKey: 1 }       (identity-graph fan-out)
//
// Optional dep: `mongodb`. Pass an already-connected `db`, or a `uri` that
// this adapter connects with via a dynamic import. Importing structurally
// (local minimal types) keeps the module type-checking when the optional dep
// is absent — same guard style as the recal/upstash optional adapters.

import { BookingError, errMessage } from '../../core/errors.js'
import type { EventLedger, IdentityEdge, LedgerEvent } from './adapter.js'

// Minimal structural shapes — avoids a hard `import type` from the optional dep.
type MongoCollectionLike = {
  insertOne(doc: Record<string, unknown>): Promise<unknown>
  createIndex(spec: Record<string, 1 | -1>): Promise<unknown>
}
type MongoDbLike = {
  collection(name: string): MongoCollectionLike
  command(cmd: Record<string, unknown>): Promise<unknown>
}

export type MongoEventLedgerOptions = {
  /** An already-connected db. Mutually exclusive with `uri`. */
  db?: MongoDbLike
  /** Connection string. The adapter connects lazily on first use. */
  uri?: string
  /** Events collection name. Default 'ledger_events'. */
  eventsCollection?: string
  /** Edges collection name. Default 'ledger_edges'. */
  edgesCollection?: string
}

export function mongoEventLedger(opts: MongoEventLedgerOptions): EventLedger {
  if (!opts.db && !opts.uri) {
    throw new BookingError('CONFIG_INVALID', 'mongoEventLedger: either `db` or `uri` is required', {
      retryable: false,
    })
  }
  const eventsName = opts.eventsCollection ?? 'ledger_events'
  const edgesName = opts.edgesCollection ?? 'ledger_edges'

  let dbPromise: Promise<MongoDbLike> | undefined
  let indexesEnsured = false

  async function getDb(): Promise<MongoDbLike> {
    if (opts.db) return opts.db
    if (!dbPromise) {
      dbPromise = (async () => {
        let MongoClientCtor: new (uri: string) => {
          connect(): Promise<unknown>
          db(): MongoDbLike
        }
        try {
          // Indirect specifier: `mongodb` is an optional dep that may be
          // absent at type-check time. A non-literal specifier keeps tsc from
          // trying (and failing) to resolve its types when it isn't installed.
          const moduleName = 'mongodb'
          const mod = (await import(/* @vite-ignore */ moduleName)) as unknown as {
            MongoClient: typeof MongoClientCtor
          }
          MongoClientCtor = mod.MongoClient
        } catch {
          throw new BookingError(
            'DEPENDENCY_UNAVAILABLE',
            'mongoEventLedger requires "mongodb". Run `npm i mongodb`.',
            { retryable: false },
          )
        }
        const client = new MongoClientCtor(opts.uri!)
        await client.connect()
        return client.db()
      })()
    }
    return dbPromise
  }

  async function ensureIndexes(db: MongoDbLike): Promise<void> {
    if (indexesEnsured) return
    const events = db.collection(eventsName)
    const edges = db.collection(edgesName)
    await events.createIndex({ tenantId: 1, receivedAt: 1 })
    await events.createIndex({ tenantId: 1, subjectKey: 1 })
    await edges.createIndex({ tenantId: 1, fromKey: 1 })
    indexesEnsured = true
  }

  return {
    async append(e: LedgerEvent) {
      try {
        const db = await getDb()
        await ensureIndexes(db)
        // INSERT-only — append-only discipline. Never update/delete.
        await db.collection(eventsName).insertOne({ ...e })
      } catch (err) {
        if (err instanceof BookingError) throw err
        throw new BookingError(
          'PERSISTENCE_FAILED',
          `mongoEventLedger.append failed: ${errMessage(err)}`,
        )
      }
    },

    async appendEdge(e: IdentityEdge) {
      try {
        const db = await getDb()
        await ensureIndexes(db)
        // INSERT-only — append-only discipline. Never update/delete.
        await db.collection(edgesName).insertOne({ ...e })
      } catch (err) {
        if (err instanceof BookingError) throw err
        throw new BookingError(
          'PERSISTENCE_FAILED',
          `mongoEventLedger.appendEdge failed: ${errMessage(err)}`,
        )
      }
    },

    async health() {
      try {
        const db = await getDb()
        await db.command({ ping: 1 })
        return { ok: true, name: 'mongodb' }
      } catch (err) {
        return { ok: false, name: 'mongodb', error: errMessage(err) }
      }
    },
  }
}
