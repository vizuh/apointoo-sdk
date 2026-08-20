// Persistence — append-only log of booking events.
// Sheets is the default impl; Supabase / DB impls are future.

import type {
  AdapterContext,
  AdapterHealth,
  BookingConfirmation,
  BookingRequest,
} from '../../core/types.js'

export type BookingEventType = 'booking_request' | 'partial_lead'

export type PersistenceRecord = {
  eventType: BookingEventType
  request: BookingRequest
  // confirmation may be undefined for partial leads or persistence-after-cancel
  confirmation: BookingConfirmation | undefined
  // serialized JSON for vendor-specific extras the adapter wants to store
  vendorMetadataJson: string | undefined
}

export interface PersistenceAdapter {
  /**
   * Append a record. Must be safe to call concurrently.
   * Implementations should retry transient errors internally (small budget,
   * e.g. 1 retry / 500ms — same shape as old kit Pattern 15) before propagating.
   */
  append(record: PersistenceRecord, ctx: AdapterContext): Promise<void>

  /**
   * Connectivity probe. For Sheets: try `spreadsheets.get` for the configured ID.
   * For DB: cheap read or `SELECT 1`.
   */
  health(ctx: AdapterContext): Promise<AdapterHealth>
}
