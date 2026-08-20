// Public error model. Pipeline + adapters never throw bare `Error`.

export type BookingErrorCode =
  | 'CONFIG_INVALID'
  | 'INPUT_INVALID'
  | 'SPAM_DETECTED'
  | 'RATE_LIMITED'
  | 'DUPLICATE_SUBMISSION'
  | 'TIME_UNAVAILABLE'
  | 'BOOKING_FAILED'
  | 'PERSISTENCE_FAILED'
  | 'NOTIFICATION_FAILED'
  | 'DEPENDENCY_UNAVAILABLE'
  | 'UNKNOWN_ERROR'

export class BookingError extends Error {
  readonly code: BookingErrorCode
  readonly retryable: boolean
  readonly issues: ReadonlyArray<{ field: string; message: string }> | undefined

  constructor(
    code: BookingErrorCode,
    message: string,
    opts?: { retryable?: boolean; issues?: ReadonlyArray<{ field: string; message: string }> },
  ) {
    super(message)
    this.name = 'BookingError'
    this.code = code
    this.retryable = opts?.retryable ?? defaultRetryable(code)
    this.issues = opts?.issues
  }
}

function defaultRetryable(code: BookingErrorCode): boolean {
  switch (code) {
    case 'CONFIG_INVALID':
    case 'INPUT_INVALID':
    case 'SPAM_DETECTED':
    case 'DUPLICATE_SUBMISSION':
    case 'TIME_UNAVAILABLE':
      return false
    case 'RATE_LIMITED':
    case 'BOOKING_FAILED':
    case 'PERSISTENCE_FAILED':
    case 'NOTIFICATION_FAILED':
    case 'DEPENDENCY_UNAVAILABLE':
    case 'UNKNOWN_ERROR':
      return true
  }
}

export function isBookingError(e: unknown): e is BookingError {
  return e instanceof BookingError
}

/**
 * Extract a string message from an unknown thrown value. Replaces the
 * `err instanceof Error ? err.message : String(err)` inline pattern that
 * previously repeated ~37× across adapters and the pipeline.
 */
export function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (err === null || err === undefined) return ''
  return String(err)
}
