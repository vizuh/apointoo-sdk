// MongoDB BookingStateStore — durable booking-lifecycle state on Mongo.
//
// PHI-minimization: like every BookingStateStore, this never persists
// name/phone/email/message. ADR-006. Documents are stored camelCase (mirroring
// the BookingState shape), unlike the Supabase adapter's snake_case columns.
//
// Slice 1: the WHOLE BookingState — including the full `attribution` snapshot —
// is written on create() and reconstructed on get()/findStale()/findForConversion()
// via docToState(). attribution is spread-conditionally so it stays absent (not
// `undefined`) under exactOptionalPropertyTypes.
//
// Every document carries `tenantId`; every read is tenant-filtered where a tenant
// is supplied. submissionId is the globally-unique key (matching Supabase's
// submission_id PRIMARY KEY contract), so the single-key get/transition/
// markConversionSent filters resolve to exactly one tenant's document — no
// cross-tenant leak. Idempotent create matches the Supabase contract: an existing
// submissionId is re-driven to `pending` with retryCount bumped (rare — only on
// retry of a failed vendor createSession).
//
// Required collection + indexes (code-as-source-of-truth — no migration file;
// ensured lazily on first use):
//   booking_state  — { submissionId: 1 }  unique  (globally-unique PK — idempotent create + get)
//                    { tenantId: 1, status: 1, createdAt: 1 }  (findStale sweeper scan)
//                    { tenantId: 1, status: 1, conversionSentAt: 1 }  (findForConversion)
//
// Optional dep: `mongodb`. Pass an already-connected `db`, or a `uri` that this
// adapter connects with via a dynamic import. Importing structurally (local
// minimal types) keeps the module type-checking when the optional dep is absent —
// same guard style as the mongoEventLedger adapter.

import { BookingError, errMessage } from '../../core/errors.js'
import type { BookingAttribution } from '../../core/schemas.js'
import type {
  BookingState,
  BookingStateCreate,
  BookingStateStatus,
  BookingStateStore,
  BookingStateTransition,
} from './adapter.js'
import { hasUploadableClickId } from './selectors.js'

// Minimal structural shapes — avoids a hard `import type` from the optional dep.
type MongoCursorLike = {
  toArray(): Promise<Record<string, unknown>[]>
}
type MongoCollectionLike = {
  findOne(filter: Record<string, unknown>): Promise<Record<string, unknown> | null>
  find(filter: Record<string, unknown>): MongoCursorLike
  updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<unknown>
  countDocuments(filter: Record<string, unknown>): Promise<number>
  createIndex(spec: Record<string, 1 | -1>, options?: Record<string, unknown>): Promise<unknown>
}
type MongoDbLike = {
  collection(name: string): MongoCollectionLike
  command(cmd: Record<string, unknown>): Promise<unknown>
}

export type MongoStateStoreOptions = {
  /** An already-connected db. Mutually exclusive with `uri`. */
  db?: MongoDbLike
  /** Connection string. The adapter connects lazily on first use. */
  uri?: string
  /** State collection name. Default 'booking_state'. */
  collection?: string
}

const DEFAULT_COLLECTION = 'booking_state'

export function mongoStateStore(opts: MongoStateStoreOptions): BookingStateStore {
  if (!opts.db && !opts.uri) {
    throw new BookingError('CONFIG_INVALID', 'mongoStateStore: either `db` or `uri` is required', {
      retryable: false,
    })
  }
  const collectionName = opts.collection ?? DEFAULT_COLLECTION

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
          // Indirect specifier: `mongodb` is an optional dep that may be absent
          // at type-check time. A non-literal specifier keeps tsc from trying
          // (and failing) to resolve its types when it isn't installed.
          const moduleName = 'mongodb'
          const mod = (await import(/* @vite-ignore */ moduleName)) as unknown as {
            MongoClient: typeof MongoClientCtor
          }
          MongoClientCtor = mod.MongoClient
        } catch {
          throw new BookingError(
            'DEPENDENCY_UNAVAILABLE',
            'mongoStateStore requires "mongodb". Run `npm i mongodb`.',
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
    const coll = db.collection(collectionName)
    await coll.createIndex({ submissionId: 1 }, { unique: true })
    await coll.createIndex({ tenantId: 1, status: 1, createdAt: 1 })
    await coll.createIndex({ tenantId: 1, status: 1, conversionSentAt: 1 })
    indexesEnsured = true
  }

  async function coll(): Promise<MongoCollectionLike> {
    const db = await getDb()
    await ensureIndexes(db)
    return db.collection(collectionName)
  }

  return {
    async create(input: BookingStateCreate): Promise<void> {
      try {
        const c = await coll()
        const now = new Date()
        // Idempotent create matching the Supabase contract: upsert keyed on the
        // globally-unique submissionId. A first insert lands retryCount 0; a retry
        // of an existing row re-drives status to 'pending' and bumps retryCount via
        // $inc, leaving vendor/appointment/conversion fields untouched.
        await c.updateOne(
          { submissionId: input.submissionId },
          {
            $set: {
              status: 'pending' as BookingStateStatus,
              vendor: input.vendor,
              gclid: input.gclid,
              fbclid: input.fbclid,
              msclkid: input.msclkid,
              rwgToken: input.rwgToken,
              utmSource: input.utmSource,
              utmMedium: input.utmMedium,
              utmCampaign: input.utmCampaign,
              attribution: input.attribution ?? null,
              updatedAt: now,
            },
            $setOnInsert: {
              tenantId: input.tenantId,
              submissionId: input.submissionId,
              vendorAppointmentId: null,
              appointmentStartIso: null,
              errorCode: null,
              createdAt: input.createdAt,
              conversionSentAt: null,
            },
            $inc: { retryCount: 1 },
          },
          { upsert: true },
        )
      } catch (err) {
        if (err instanceof BookingError) throw err
        throw new BookingError('PERSISTENCE_FAILED', `mongoStateStore.create failed: ${errMessage(err)}`)
      }
    },

    async transition(submissionId: string, change: BookingStateTransition): Promise<void> {
      try {
        const c = await coll()
        const set: Record<string, unknown> = {
          status: change.status,
          updatedAt: new Date(),
        }
        if (change.vendorAppointmentId !== undefined) {
          set.vendorAppointmentId = change.vendorAppointmentId
        }
        if (change.appointmentStartIso !== undefined) {
          set.appointmentStartIso = change.appointmentStartIso
        }
        if (change.errorCode !== undefined) {
          set.errorCode = change.errorCode
        }
        await c.updateOne({ submissionId }, { $set: set })
      } catch (err) {
        if (err instanceof BookingError) throw err
        throw new BookingError(
          'PERSISTENCE_FAILED',
          `mongoStateStore.transition failed: ${errMessage(err)}`,
        )
      }
    },

    async get(submissionId: string): Promise<BookingState | null> {
      try {
        const c = await coll()
        const doc = await c.findOne({ submissionId })
        return doc ? docToState(doc) : null
      } catch (err) {
        if (err instanceof BookingError) throw err
        throw new BookingError('PERSISTENCE_FAILED', `mongoStateStore.get failed: ${errMessage(err)}`)
      }
    },

    async findStale(olderThanMinutes: number, tenantId?: string): Promise<BookingState[]> {
      try {
        const c = await coll()
        const cutoff = new Date(Date.now() - olderThanMinutes * 60_000)
        const filter: Record<string, unknown> = {
          status: 'pending',
          createdAt: { $lt: cutoff },
        }
        if (tenantId !== undefined) filter.tenantId = tenantId
        const docs = await c.find(filter).toArray()
        return docs.map(docToState)
      } catch (err) {
        if (err instanceof BookingError) throw err
        throw new BookingError(
          'PERSISTENCE_FAILED',
          `mongoStateStore.findStale failed: ${errMessage(err)}`,
        )
      }
    },

    async findForConversion(tenantId?: string): Promise<BookingState[]> {
      try {
        const c = await coll()
        const filter: Record<string, unknown> = {
          status: 'confirmed',
          conversionSentAt: null,
        }
        if (tenantId !== undefined) filter.tenantId = tenantId
        const docs = await c.find(filter).toArray()
        return docs
          .map(docToState)
          .filter(hasUploadableClickId)
      } catch (err) {
        if (err instanceof BookingError) throw err
        throw new BookingError(
          'PERSISTENCE_FAILED',
          `mongoStateStore.findForConversion failed: ${errMessage(err)}`,
        )
      }
    },

    async markConversionSent(submissionId: string, sentAt: Date): Promise<void> {
      try {
        const c = await coll()
        await c.updateOne({ submissionId }, { $set: { conversionSentAt: sentAt } })
      } catch (err) {
        if (err instanceof BookingError) throw err
        throw new BookingError(
          'PERSISTENCE_FAILED',
          `mongoStateStore.markConversionSent failed: ${errMessage(err)}`,
        )
      }
    },

    async countByStatus(tenantId?: string): Promise<Record<BookingStateStatus, number>> {
      try {
        const c = await coll()
        const statuses: BookingStateStatus[] = [
          'draft',
          'contact_captured',
          'slot_held',
          'payment_pending',
          'pending',
          'confirmed',
          'cancelled',
          'rescheduled',
          'no_show',
          'completed',
          'failed',
          'expired',
          'abandoned',
        ]
        const results = await Promise.all(
          statuses.map(async (s) => {
            const filter: Record<string, unknown> = { status: s }
            if (tenantId !== undefined) filter.tenantId = tenantId
            return [s, await c.countDocuments(filter)] as const
          }),
        )
        return Object.fromEntries(results) as Record<BookingStateStatus, number>
      } catch (err) {
        if (err instanceof BookingError) throw err
        throw new BookingError(
          'PERSISTENCE_FAILED',
          `mongoStateStore.countByStatus failed: ${errMessage(err)}`,
        )
      }
    },

    async health() {
      try {
        const db = await getDb()
        await db.command({ ping: 1 })
        return { ok: true, name: 'mongodb-state' }
      } catch (err) {
        return { ok: false, name: 'mongodb-state', error: errMessage(err) }
      }
    },
  }
}

function docToState(doc: Record<string, unknown>): BookingState {
  return {
    submissionId: String(doc.submissionId),
    tenantId: String(doc.tenantId),
    status: doc.status as BookingStateStatus,
    vendor: String(doc.vendor),
    vendorAppointmentId: (doc.vendorAppointmentId as string | null) ?? null,
    appointmentStartIso: (doc.appointmentStartIso as string | null) ?? null,
    gclid: (doc.gclid as string | null) ?? null,
    fbclid: (doc.fbclid as string | null) ?? null,
    msclkid: (doc.msclkid as string | null) ?? null,
    rwgToken: (doc.rwgToken as string | null) ?? null,
    utmSource: (doc.utmSource as string | null) ?? null,
    utmMedium: (doc.utmMedium as string | null) ?? null,
    utmCampaign: (doc.utmCampaign as string | null) ?? null,
    ...(doc.attribution != null ? { attribution: doc.attribution as BookingAttribution } : {}),
    errorCode: (doc.errorCode as string | null) ?? null,
    retryCount: Number(doc.retryCount ?? 0),
    createdAt: new Date(doc.createdAt as string | number | Date),
    updatedAt: new Date(doc.updatedAt as string | number | Date),
    conversionSentAt: doc.conversionSentAt ? new Date(doc.conversionSentAt as string | number | Date) : null,
  }
}
