/**
 * Adapter manifest — machine-readable descriptor for every adapter implementation.
 *
 * Each adapter implementation exports a manifest so the dashboard can:
 *   - Display available adapters when an operator is configuring a new tenant.
 *   - Validate that all required env vars are present before instantiating.
 *   - Gate UI affordances (e.g., "book with specific staff") on declared capabilities.
 *
 * Manifests are pure data — zero runtime dependencies. Importing the manifest
 * registry never pulls in the adapter implementation or its vendor SDKs.
 *
 * Inspired by Cal.com's per-app `_metadata.ts` (app-store/<slug>/_metadata.ts).
 */

/**
 * Top-level adapter category. Matches the directory structure under `src/adapters/`.
 */
export type AdapterKind =
  | 'booking'
  | 'notification'
  | 'dedup'
  | 'persistence'
  | 'state'
  | 'ratelimit'
  | 'conversion'

/**
 * Optional capabilities that a booking adapter may support beyond the mandatory
 * `createSession / confirm / cancel / health` surface. Presence here signals the
 * UI can render the corresponding affordance.
 */
export type BookingCapability =
  /** findAvailability() is implemented and returns real data. */
  | 'availability'
  /** findStaffVariants() returns non-empty results (vendor supports staff picker). */
  | 'staffVariants'
  /** attachAttribution() does something meaningful (vs. no-op). */
  | 'attribution'
  /** createSession accepts offerCode and the vendor applies it. */
  | 'promo'
  /** rescheduleByAppointment() is implemented. */
  | 'reschedule'
  /** cancelByAppointment() is implemented. */
  | 'cancel'

export interface AdapterManifest {
  /**
   * Machine-readable identifier. Must be unique within the same `kind`.
   * Use kebab-case. Examples: `blvd`, `recal`, `memory-booking`.
   */
  slug: string

  /** Which adapter interface this manifest describes. */
  kind: AdapterKind

  /** Human-readable name shown in the dashboard adapter picker. */
  name: string

  /** One-sentence description of what the adapter connects to. */
  description: string

  /**
   * Environment variables the consumer MUST supply to instantiate this adapter.
   * Used by the dashboard config validator and setup guides.
   * Empty array for in-memory/test adapters that need no credentials.
   */
  requiredEnvVars: readonly string[]

  /**
   * Environment variables that unlock additional behaviour when present.
   * Example: `BLVD_API_URL` overrides the default endpoint.
   */
  optionalEnvVars?: readonly string[]

  /**
   * For booking adapters: which optional capabilities beyond the mandatory
   * surface are supported. Omit for non-booking adapter kinds.
   */
  capabilities?: readonly BookingCapability[]

  /**
   * When true this adapter is only suitable for dev/test workloads.
   * The dashboard config UI should warn (or block) using it on production tenants.
   */
  testOnly?: boolean

  /**
   * Upstream vendor API version or SDK semver this adapter targets.
   * Helps operators detect when a newer API revision has been released.
   */
  vendorApiVersion?: string

  /** URL to upstream vendor or integration documentation. */
  docsUrl?: string
}
