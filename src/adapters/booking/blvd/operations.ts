// BLVD Cart-pattern operations. Each function maps to one GraphQL mutation/query
// and asserts cart errors after every mutation.
//
// BLVD's API does not expose idempotency-key headers (verified against
// blvd-api-reference-2026-05-07). The cart ID is the de-facto idempotency
// handle — once issued, the same cart can be progressed but not duplicated.

import { BlvdError } from './errors.js'
import type { BlvdClient } from './client.js'

type CartError = { code: string; description: string; message: string }

// ── Cart-error guard ──────────────────────────────────────────────────────────

function assertNoCartErrors(errors: ReadonlyArray<CartError> | undefined, step: string): void {
  if (!errors?.length) return
  const e = errors[0]
  if (!e) return
  const code = e.code === 'CART_EXPIRED' ? 'CART_EXPIRED' : 'CART_ERROR'
  throw new BlvdError(code, `BLVD cart error at ${step} — ${e.code}: ${e.message}`)
}

// ── Operation 1 — createCart ──────────────────────────────────────────────────

export async function createCart(client: BlvdClient, locationId: string): Promise<string> {
  type R = { createCart: { cart: { id: string; expiresAt: string; errors: CartError[] } } }
  const data = await client.exec<R>(
    'createCart',
    `mutation CreateCart($input: CreateCartInput!) {
      createCart(input: $input) {
        cart { id expiresAt errors { code description message } }
      }
    }`,
    { input: { locationId } },
  )
  assertNoCartErrors(data.createCart.cart.errors, 'createCart')
  return data.createCart.cart.id
}

// ── Operation 2 — addCartSelectedBookableItem ────────────────────────────────

export async function addBookableItem(
  client: BlvdClient,
  cartId: string,
  itemId: string,
): Promise<void> {
  type R = { addCartSelectedBookableItem: { cart: { id: string; errors: CartError[] } } }
  const data = await client.exec<R>(
    'addCartSelectedBookableItem',
    `mutation AddItem($input: AddCartSelectedBookableItemInput!) {
      addCartSelectedBookableItem(input: $input) {
        cart { id errors { code description message } }
      }
    }`,
    { input: { id: cartId, itemId } },
  )
  assertNoCartErrors(data.addCartSelectedBookableItem.cart.errors, 'addCartSelectedBookableItem')
}

// ── Operation 3 — updateCart (clientInformation OR referralSource) ───────────

export async function updateCartClientInfo(
  client: BlvdClient,
  cartId: string,
  info: {
    firstName: string
    lastName?: string
    email?: string
    phoneNumber?: string
  },
): Promise<void> {
  type R = { updateCart: { cart: { id: string; errors: CartError[] } } }
  const clientInformation: Record<string, unknown> = { firstName: info.firstName }
  if (info.lastName) clientInformation.lastName = info.lastName
  if (info.email) clientInformation.email = info.email
  if (info.phoneNumber) clientInformation.phoneNumber = info.phoneNumber

  const data = await client.exec<R>(
    'updateCartClientInfo',
    `mutation UpdateCart($input: UpdateCartInput!) {
      updateCart(input: $input) {
        cart { id errors { code description message } }
      }
    }`,
    { input: { id: cartId, clientInformation } },
  )
  assertNoCartErrors(data.updateCart.cart.errors, 'updateCart/clientInfo')
}

export async function updateCartAttribution(
  client: BlvdClient,
  cartId: string,
  attribution: { referralSource?: string; clientMessage?: string },
): Promise<void> {
  type R = { updateCart: { cart: { id: string; errors: CartError[] } } }
  const input: Record<string, unknown> = { id: cartId }
  if (attribution.referralSource) input.referralSource = attribution.referralSource
  if (attribution.clientMessage) input.clientMessage = attribution.clientMessage
  if (Object.keys(input).length === 1) return // nothing to attach
  const data = await client.exec<R>(
    'updateCartAttribution',
    `mutation UpdateCart($input: UpdateCartInput!) {
      updateCart(input: $input) {
        cart { id errors { code description message } }
      }
    }`,
    { input },
  )
  assertNoCartErrors(data.updateCart.cart.errors, 'updateCart/attribution')
}

// ── Operation 4a — cartBookableDates (range-aware day discovery) ────────────
//
// MANUAL-VERIFY (path 3 of plan-2026-05-14-blvd-expansion.md).
// book-sdk's `Cart.getBookableDates(searchRange, tz, location, limit)` maps
// to `datesQuery`. The flat-arg shape (searchRangeLower / searchRangeUpper)
// is inferred from the sibling `availableRescheduleDatesQuery` on the
// appointment surface. If BLVD uses a nested `DateRange` input instead,
// swap the query string.

export type BookableDate = { date: string; score: number }

export async function cartBookableDates(
  client: BlvdClient,
  cartId: string,
  fromDate: string,
  toDate: string,
  tz: string,
): Promise<BookableDate[]> {
  type R = { cartBookableDates: BookableDate[] }
  const data = await client.exec<R>(
    'cartBookableDates',
    `query CartDates($id: ID!, $searchRangeLower: Date!, $searchRangeUpper: Date!, $tz: Tz) {
      cartBookableDates(id: $id, searchRangeLower: $searchRangeLower, searchRangeUpper: $searchRangeUpper, tz: $tz) {
        date score
      }
    }`,
    { id: cartId, searchRangeLower: fromDate, searchRangeUpper: toDate, tz },
  )
  return data.cartBookableDates
}

// ── Operation 4 — cartBookableTimes ──────────────────────────────────────────

export type BookableSlot = { id: string; score: number; startTime: string }

export async function cartBookableTimes(
  client: BlvdClient,
  cartId: string,
  searchDate: string,
  tz: string,
): Promise<BookableSlot[]> {
  type R = { cartBookableTimes: BookableSlot[] }
  const data = await client.exec<R>(
    'cartBookableTimes',
    `query CartTimes($id: ID!, $searchDate: Date!, $tz: Tz) {
      cartBookableTimes(id: $id, searchDate: $searchDate, tz: $tz) {
        id score startTime
      }
    }`,
    { id: cartId, searchDate, tz },
  )
  return data.cartBookableTimes
}

// ── Operation 5 — reserveCartBookableItems ───────────────────────────────────

export async function reserveBookableTime(
  client: BlvdClient,
  cartId: string,
  bookableTimeId: string,
): Promise<{ startTimeIso: string; expiresAtIso: string }> {
  type R = {
    reserveCartBookableItems: {
      cart: { id: string; startTime: string; expiresAt: string; errors: CartError[] }
    }
  }
  const data = await client.exec<R>(
    'reserveCartBookableItems',
    `mutation Reserve($input: ReserveCartBookableItemsInput!) {
      reserveCartBookableItems(input: $input) {
        cart { id startTime expiresAt errors { code description message } }
      }
    }`,
    { input: { id: cartId, bookableTimeId } },
  )
  assertNoCartErrors(
    data.reserveCartBookableItems.cart.errors,
    'reserveCartBookableItems',
  )
  return {
    startTimeIso: data.reserveCartBookableItems.cart.startTime,
    expiresAtIso: data.reserveCartBookableItems.cart.expiresAt,
  }
}

// ── Operation 6 — checkoutCart ───────────────────────────────────────────────

export type CheckoutResult = {
  appointmentId: string
  clientId: string
  completedAtIso: string
}

export async function checkoutCart(
  client: BlvdClient,
  cartId: string,
): Promise<CheckoutResult> {
  type R = {
    checkoutCart: {
      cart: { id: string; completedAt: string }
      appointments: Array<{
        appointmentId: string
        clientId: string
        forCartOwner: boolean
      }>
    }
  }
  const data = await client.exec<R>(
    'checkoutCart',
    `mutation Checkout($input: CheckoutCartInput!) {
      checkoutCart(input: $input) {
        cart { id completedAt }
        appointments { appointmentId clientId forCartOwner }
      }
    }`,
    { input: { id: cartId } },
  )

  const appt = data.checkoutCart.appointments?.[0]
  if (!appt?.appointmentId) {
    throw new BlvdError(
      'BOOKING_FAILED',
      'checkoutCart returned no appointment. Service may require upfront payment.',
    )
  }

  return {
    appointmentId: appt.appointmentId,
    clientId: appt.clientId,
    completedAtIso: data.checkoutCart.cart.completedAt,
  }
}

// ── Operation 7 — cancelCart (compensation) ──────────────────────────────────
// Best-effort. If BLVD doesn't expose a cancel mutation in the version we hit,
// catch the error at the adapter boundary and let the cart's TTL clear it.

export async function cancelCart(client: BlvdClient, cartId: string): Promise<void> {
  // Attempt the documented mutation; tolerate "Cannot find type cancelCart" by
  // falling back to a reservation-release that mimics the same effect.
  type R = { cancelCart: { cart: { id: string } } | null }
  await client.exec<R>(
    'cancelCart',
    `mutation Cancel($input: CancelCartInput!) {
      cancelCart(input: $input) {
        cart { id }
      }
    }`,
    { input: { id: cartId } },
  )
}

// ── Operations 8–10 — post-confirm appointment lifecycle ─────────────────────
//
// MANUAL-VERIFY.
// These three ops are corrected against `@boulevard/blvd-book-sdk` source on
// GitHub but have NOT been confirmed end-to-end against the BLVD sandbox
// because sandbox credentials were unavailable. What we know from book-sdk:
//   - `Appointment.cancel(notes?)`              → `cancelAppointmentMutation`
//   - `Appointment.rescheduleAvailableTimes()`  → `availableRescheduleTimesQuery`
//   - `Appointment.reschedule(bookableTime, …)` → `appointmentRescheduleMutation`
// What is INFERRED and must be confirmed in sandbox:
//   - The exact GraphQL input type names (`CancelAppointmentInput`,
//     `RescheduleAppointmentInput`) and their field names. We follow BLVD's
//     cart-side convention of `id` as the primary entity field.
//   - `cancel` field is `notes` (was `reason` — wrong per book-sdk).
//   - `reschedule` takes a `bookableTimeId` obtained from
//     `availableRescheduleTimes`, NOT a raw ISO datetime (was the bug).
// If the sandbox returns `GRAPHQL_ERROR: Unknown field` on any of these,
// adjust the field name and re-run. See ADR-014 for the original verification
// debt that this fix discharges.

// ── Operation 8 — cancelAppointment (post-confirm cancellation) ──────────────
// Distinct from cancelCart: that's for in-flight saga compensation. This is
// for cancelling an already-confirmed appointment.

export async function cancelAppointment(
  client: BlvdClient,
  appointmentId: string,
  notes: string,
): Promise<void> {
  type R = { cancelAppointment: { appointment: { id: string } } | null }
  await client.exec<R>(
    'cancelAppointment',
    `mutation CancelAppointment($input: CancelAppointmentInput!) {
      cancelAppointment(input: $input) {
        appointment { id }
      }
    }`,
    { input: { id: appointmentId, notes } },
  )
}

// ── Operation 9 — availableRescheduleTimes (slot discovery before reschedule)
// Required prelude to operation 10 — the reschedule mutation takes a
// bookableTimeId issued by this query, not a raw datetime.

export type RescheduleSlot = { id: string; startTime: string }

export async function availableRescheduleTimes(
  client: BlvdClient,
  appointmentId: string,
  date: string,
): Promise<RescheduleSlot[]> {
  type R = { availableRescheduleTimes: RescheduleSlot[] }
  const data = await client.exec<R>(
    'availableRescheduleTimes',
    `query AvailableRescheduleTimes($id: ID!, $date: Date!) {
      availableRescheduleTimes(id: $id, date: $date) {
        id startTime
      }
    }`,
    { id: appointmentId, date },
  )
  return data.availableRescheduleTimes
}

// ── Operation 10 — rescheduleAppointment (move to a new slot) ────────────────
// Two-step: (a) discover bookable times for the requested date,
// (b) reschedule onto the matching slot id. `newTime` is HH:MM (24h, business tz).

export async function rescheduleAppointment(
  client: BlvdClient,
  appointmentId: string,
  newDate: string,
  newTime: string,
  sendNotification: boolean = false,
): Promise<{ appointmentId: string; startTime: string }> {
  const slots = await availableRescheduleTimes(client, appointmentId, newDate)
  let bookableTimeId: string | null = null
  for (const slot of slots) {
    const hhmm =
      slot.startTime.length > 15 ? slot.startTime.slice(11, 16) : slot.startTime.slice(0, 5)
    if (hhmm === newTime) {
      bookableTimeId = slot.id
      break
    }
  }
  if (!bookableTimeId) {
    throw new BlvdError(
      'TIME_UNAVAILABLE',
      `Reschedule slot ${newDate}T${newTime} not available for appointment.`,
    )
  }

  type R = {
    rescheduleAppointment: {
      appointment: { id: string; startTime: string }
    } | null
  }
  const data = await client.exec<R>(
    'rescheduleAppointment',
    `mutation RescheduleAppointment($input: RescheduleAppointmentInput!) {
      rescheduleAppointment(input: $input) {
        appointment { id startTime }
      }
    }`,
    { input: { id: appointmentId, bookableTimeId, sendNotification } },
  )
  if (!data.rescheduleAppointment) {
    throw new BlvdError(
      'BOOKING_FAILED',
      'rescheduleAppointment returned null. Account may not support direct reschedule.',
    )
  }
  return {
    appointmentId: data.rescheduleAppointment.appointment.id,
    startTime: data.rescheduleAppointment.appointment.startTime,
  }
}

// ── Operation 11 — bookableStaffVariants (per-slot staff picker) ─────────────
//
// MANUAL-VERIFY (path 4 of plan-2026-05-14-blvd-expansion.md).
// book-sdk's `Cart.getBookableStaffVariants(itemId, bookableTimeId, location)`
// maps to `bookableStaffVariantsQuery`. The nested-`staff` shape is inferred
// from book-sdk's Staff data class (firstName, lastName, displayName,
// nickname, role). If BLVD's schema flattens those onto the variant itself,
// adjust the GraphQL fragment.

export type BookableStaffVariant = {
  /** Variant id — opaque token consumers later pass back to apply this staff. */
  id: string
  staff: { id: string; displayName: string }
}

export async function bookableStaffVariants(
  client: BlvdClient,
  cartId: string,
  itemId: string,
  bookableTimeId: string,
): Promise<BookableStaffVariant[]> {
  type R = { bookableStaffVariants: BookableStaffVariant[] }
  const data = await client.exec<R>(
    'bookableStaffVariants',
    `query StaffVariants($id: ID!, $itemId: ID!, $bookableTimeId: ID!) {
      bookableStaffVariants(id: $id, itemId: $itemId, bookableTimeId: $bookableTimeId) {
        id
        staff { id displayName }
      }
    }`,
    { id: cartId, itemId, bookableTimeId },
  )
  return data.bookableStaffVariants
}

// ── Operation 12 — listLocations (catalog discovery) ─────────────────────────
//
// MANUAL-VERIFY (path 2 of plan-2026-05-14-blvd-expansion.md).
// Endpoint is already business-scoped via the URL path (`/{businessId}/client`).
// Field name `business.locations` is inferred from book-sdk's
// `Business.getLocations` → `businessLocationsQuery`. If the server-side
// schema exposes `locations` at the root instead, swap the query string.

export type BlvdLocationSummary = { id: string; name: string }

export async function listLocations(client: BlvdClient): Promise<BlvdLocationSummary[]> {
  type R = { business: { locations: BlvdLocationSummary[] } }
  const data = await client.exec<R>(
    'listLocations',
    `query Locations { business { locations { id name } } }`,
  )
  return data.business.locations
}

// ── Operation 11 — availableCategories (service catalog via cart context) ────
//
// MANUAL-VERIFY (path 2 of plan-2026-05-14-blvd-expansion.md).
// BLVD's `availableCategories` query is reached through a cart context.
// We assume the same root-query + id pattern as `cartBookableTimes`. The
// nested-item field name `availableItems` is inferred from
// `addCartSelectedBookableItem` (BLVD calls services "bookable items" in
// the cart surface). Renamed to `services` at the adapter boundary so
// consumers don't have to learn BLVD terminology.

export type BlvdServiceCategorySummary = {
  id: string
  name: string
  services: ReadonlyArray<{ id: string; name: string }>
}

export async function availableCategories(
  client: BlvdClient,
  cartId: string,
): Promise<BlvdServiceCategorySummary[]> {
  type R = {
    availableCategories: Array<{
      id: string
      name: string
      availableItems: Array<{ id: string; name: string }>
    }>
  }
  const data = await client.exec<R>(
    'availableCategories',
    `query AvailableCategories($id: ID!) {
      availableCategories(id: $id) {
        id
        name
        availableItems { id name }
      }
    }`,
    { id: cartId },
  )
  return data.availableCategories.map((cat) => ({
    id: cat.id,
    name: cat.name,
    services: cat.availableItems,
  }))
}

// ── Operations 13–15 — promo codes (path 5, ADR-017) ─────────────────────────
//
// MANUAL-VERIFY (blocked on #21).
// book-sdk's `Cart.addOffer(offerCode)` maps to `addCartOfferMutation`.
// `Cart.removeOffer(offer)` maps to a remove mutation whose name was
// truncated in the source view — best guess `removeCartOfferMutation` with
// `{ id: cartId, offerId }`. `Cart.getOffers(cartId)` maps to `offersQuery`.
// The `CartOffer` shape (`id, offerCode, name?, discountAmount?`) is inferred
// from book-sdk's TypeScript types. If BLVD's server-side field names diverge,
// adjust the GraphQL fragments.
//
// Error policy: `addCartOffer` uses a dedicated error code (`OFFER_REJECTED`)
// instead of the generic `CART_ERROR` so consumers can show a clean
// "code not accepted" message in the booking form.

export type CartOffer = {
  id: string
  offerCode: string
  name?: string
}

export async function addCartOffer(
  client: BlvdClient,
  cartId: string,
  offerCode: string,
): Promise<CartOffer> {
  type R = {
    addCartOffer: {
      cart: { id: string; errors: CartError[] }
      offer: CartOffer | null
    }
  }
  const data = await client.exec<R>(
    'addCartOffer',
    `mutation AddOffer($input: AddCartOfferInput!) {
      addCartOffer(input: $input) {
        cart { id errors { code description message } }
        offer { id offerCode name }
      }
    }`,
    { input: { id: cartId, offerCode } },
  )
  const errs = data.addCartOffer.cart.errors
  if (errs?.length) {
    const e = errs[0]!
    throw new BlvdError(
      'OFFER_REJECTED',
      `BLVD rejected offer code "${offerCode}" — ${e.code}: ${e.message}`,
    )
  }
  if (!data.addCartOffer.offer) {
    throw new BlvdError(
      'OFFER_REJECTED',
      `BLVD accepted offer code "${offerCode}" but returned no offer record.`,
    )
  }
  return data.addCartOffer.offer
}

export async function removeCartOffer(
  client: BlvdClient,
  cartId: string,
  offerId: string,
): Promise<void> {
  type R = { removeCartOffer: { cart: { id: string; errors: CartError[] } } }
  const data = await client.exec<R>(
    'removeCartOffer',
    `mutation RemoveOffer($input: RemoveCartOfferInput!) {
      removeCartOffer(input: $input) {
        cart { id errors { code description message } }
      }
    }`,
    { input: { id: cartId, offerId } },
  )
  assertNoCartErrors(data.removeCartOffer.cart.errors, 'removeCartOffer')
}

export async function cartOffers(
  client: BlvdClient,
  cartId: string,
): Promise<CartOffer[]> {
  type R = { cartOffers: CartOffer[] }
  const data = await client.exec<R>(
    'cartOffers',
    `query CartOffers($id: ID!) {
      cartOffers(id: $id) { id offerCode name }
    }`,
    { id: cartId },
  )
  return data.cartOffers
}

// ── Slot match ────────────────────────────────────────────────────────────────
// `requestedTime` is HH:MM (24h, business tz). Slot.startTime is ISO 8601.

export function findMatchingSlotId(slots: BookableSlot[], requestedTime: string): string | null {
  for (const slot of slots) {
    const hhmm =
      slot.startTime.length > 15 ? slot.startTime.slice(11, 16) : slot.startTime.slice(0, 5)
    if (hhmm === requestedTime) return slot.id
  }
  return null
}
