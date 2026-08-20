// Vendor adapter timing envelope. Replaces the repeated try/catch/log pattern
// that wraps almost every adapter operation:
//
//   const t0 = Date.now()
//   try {
//     const result = await /* op */
//     ctx.logger.info({ evt: 'blvd.confirm.ok', vendor: 'blvd', durationMs: Date.now() - t0 })
//     return result
//   } catch (err) {
//     ctx.logger.error({
//       evt: 'blvd.confirm.failed', vendor: 'blvd',
//       code: isBlvdError(err) ? err.code : 'UNKNOWN',
//       message: errMessage(err),
//       durationMs: Date.now() - t0,
//     })
//     throw err
//   }
//
// This pattern repeated 17× in BLVD and 9× in Recal before extraction.

import { errMessage } from '../../core/errors.js'
import type { AdapterContext } from '../../core/types.js'

export type VendorTimingOptions = {
  /** Vendor name for log context: 'blvd' | 'recal' | 'opendental' | etc. */
  vendor: string
  /** Event base name. The helper appends `.ok` / `.failed`. */
  evt: string
  /** Map an unknown thrown value to a vendor-specific error code. */
  mapErrorCode?: (err: unknown) => string
  /** Extra fields merged into the success log. */
  okCtx?: Record<string, string>
}

/**
 * Wrap an async operation with start/finish/error logging + timing.
 *
 * Rethrows on failure — the caller's error semantics are unchanged.
 */
export async function withVendorTiming<T>(
  ctx: AdapterContext,
  opts: VendorTimingOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const t0 = Date.now()
  try {
    const result = await fn()
    ctx.logger.info({
      evt: `${opts.evt}.ok`,
      vendor: opts.vendor,
      durationMs: Date.now() - t0,
      ...(opts.okCtx ? { ctx: opts.okCtx } : {}),
    })
    return result
  } catch (err) {
    ctx.logger.error({
      evt: `${opts.evt}.failed`,
      vendor: opts.vendor,
      code: opts.mapErrorCode ? opts.mapErrorCode(err) : 'UNKNOWN',
      message: errMessage(err),
      durationMs: Date.now() - t0,
    })
    throw err
  }
}
