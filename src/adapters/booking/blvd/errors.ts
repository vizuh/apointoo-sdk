export type BlvdErrorCode =
  | 'AUTH_MISSING'
  | 'HTTP_ERROR'
  | 'GRAPHQL_ERROR'
  | 'CART_ERROR'
  | 'CART_EXPIRED'
  | 'TIME_UNAVAILABLE'
  | 'SERVICE_NOT_MAPPED'
  | 'LOCATION_MISSING'
  | 'BOOKING_FAILED'
  | 'CANCEL_FAILED'
  | 'OFFER_REJECTED'
  | 'UNKNOWN'

export class BlvdError extends Error {
  readonly code: BlvdErrorCode

  constructor(code: BlvdErrorCode, message: string) {
    super(message)
    this.name = 'BlvdError'
    this.code = code
  }
}

export function isBlvdError(e: unknown): e is BlvdError {
  return e instanceof BlvdError
}
