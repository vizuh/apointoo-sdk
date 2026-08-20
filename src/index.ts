// ─── @vizuh/apointoo-sdk ─────────────────────────────────────────
// Barrel — convenient surface for consumers. Subpath imports
// (`@vizuh/apointoo-sdk/server`, `.../adapters/booking/blvd`)
// are also available via package.json `exports`.

// Core (types, schemas, errors, ids, version)
export * from './core/index.js'

// Adapter interfaces (interfaces only — implementations sit at subpaths)
export type {
  BookingAdapter,
  AvailabilityQuery,
  AvailabilitySlot,
  RescheduleResult,
  StaffVariant,
  StaffVariantsQuery,
} from './adapters/booking/adapter.js'
export type {
  PersistenceAdapter,
  PersistenceRecord,
  BookingEventType,
} from './adapters/persistence/adapter.js'
export type { Notifier, NotificationOptions } from './adapters/notification/adapter.js'
export { multiNotifier } from './adapters/notification/multi.js'
export type {
  ConversionReporter,
  ConversionUploadInput,
  ConversionUploadResult,
  ConversionReporterErrorCode,
  ConversionActionName,
  DefaultConversionActionName,
} from './adapters/conversion/index.js'
export {
  ConversionReporterError,
  isConversionReporterError,
  validateConversionInput,
  DEFAULT_CONVERSION_ACTION_ALLOWLIST,
  defineConversionAction,
} from './adapters/conversion/index.js'
export type { DedupStore } from './adapters/dedup/adapter.js'
export type { RateLimitStore, RateLimitDecision } from './adapters/ratelimit/adapter.js'
export type {
  BookingState,
  BookingStateCreate,
  BookingStateStatus,
  BookingStateStore,
  BookingStateTransition,
} from './adapters/state/adapter.js'
export { TERMINAL_STATUSES } from './adapters/state/adapter.js'
export {
  hasUploadableClickId,
  isActiveLead,
  isRealBooking,
  isTerminal,
} from './adapters/state/selectors.js'

// Neutral event ledger (A1-SAFE surface + in-memory impl + booking glue).
// Concrete Mongo impl sits at the './adapters/ledger/mongodb' subpath.
export type { EventLedger, LedgerEvent, IdentityEdge } from './adapters/ledger/adapter.js'
export { memoryEventLedger, type MemoryEventLedger } from './adapters/ledger/memory.js'
export { translateDomainEvent } from './adapters/ledger/translate.js'

// Queue
export type {
  OutboundQueue,
  QueueChannel,
  QueueEnqueue,
  QueueItem,
  QueueItemStatus,
  BackoffOptions,
} from './queue/adapter.js'
export { computeBackoff, shouldFlipToDead } from './queue/adapter.js'
export {
  runQueueBatch,
  runQueueLoop,
  type QueueHandler,
  type QueueWorkerOptions,
  type QueueRunSummary,
} from './queue/worker.js'
export {
  fallbackOutboxWriter,
  supabaseOutboxWriter,
  type OutboxWriter,
  type OutboxWrite,
  type SupabaseOutboxOptions,
} from './queue/outbox.js'

// Resilience wrappers
export {
  withCircuitBreaker,
  type CircuitBreakerOptions,
} from './adapters/booking/circuit-breaker.js'

// Server (handler, pipeline, logger, health, sweeper, admin, tenant)
export * from './server/index.js'

// Attribution helpers
export { readAttribution, parseCookieHeader, COOKIE_NAMES } from './attribution/index.js'

// Email templates
export {
  renderBookingEmail,
  defaultTheme,
  type EmailTheme,
  type RenderOptions,
  type RenderedEmail,
} from './email/templates.js'

// Scheduling — pure slot generator
export {
  generateSlots,
  type WeeklySchedule,
  type DayOfWeek,
  type GeneratedSlot,
  type GenerateSlotsOptions,
} from './core/scheduling.js'

// Calendar connection (Recal-style — server-managed OAuth)
export type {
  CalendarProvider,
  CalendarConnection,
  CalendarBookingTarget,
} from './core/calendar-connection.js'

// Integration: Reserve-with-Google feed publisher
export {
  buildRwgFeeds,
  feedFilenames,
  type RwgMerchant,
  type RwgFiles,
  type BuildOptions,
} from './integration/rwg/feed-builder.js'
export {
  publishRwgFeeds,
  pairFiles,
  type PublishOptions,
  type PublishSummary,
  type SftpConfig,
} from './integration/rwg/publisher.js'
export {
  staticMerchantSource,
  fetchMerchantSource,
  filteredMerchantSource,
  type MerchantSource,
  type StaticMerchantSourceOptions,
  type FetchMerchantSourceOptions,
} from './integration/rwg/merchant-source.js'
export {
  runRwgPublish,
  type RwgRunOptions,
  type RwgRunSummary,
} from './integration/rwg/runner.js'
