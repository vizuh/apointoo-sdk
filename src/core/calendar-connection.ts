// CalendarConnection — represents the user's authorized link to a calendar
// provider (Google, Microsoft) via Recal. The OAuth flow is owned by Recal
// server-side; apointoo only stores the resulting `userId` Recal returns
// after a connection completes. We never store OAuth tokens locally.
//
// This type lives in core/ because it's a domain primitive that the Recal
// adapter consumes — adapters depend on core, not the other way around.

export type CalendarProvider = 'google' | 'microsoft'

export type CalendarConnection = {
  /** Recal-issued user id. Apointoo persists this against its own user/tenant. */
  recalUserId: string
  /** Which provider this user authorized. Multi-provider = multiple connections. */
  provider: CalendarProvider
  /** Display label for operator UIs. e.g. 'jane@clinic.com'. */
  displayName?: string
  /** ISO timestamp of when the connection was created/last validated. */
  connectedAtIso: string
}

/**
 * Booking input extension when using a Recal-backed adapter — the request
 * needs to identify which calendar to write to. The pipeline pulls this
 * from a per-tenant config or from the booking input's serviceId mapping.
 */
export type CalendarBookingTarget = {
  recalUserId: string
  provider: CalendarProvider
}
