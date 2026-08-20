/**
 * Memory ConversionReporter — for tests and as a no-op in dev (kit #14).
 *
 * Records every upload call. Optional in-memory dedup by transactionId
 * (matches the vendor-side dedup contract). `failNext()` lets tests assert
 * error paths cleanly without monkey-patching.
 */

import { validateConversionInput } from '../reporter.js'
import type {
  ConversionReporter,
  ConversionUploadInput,
  ConversionUploadResult,
} from '../reporter.js'
import type { AdapterContext, AdapterHealth } from '../../../core/types.js'

export type MemoryConversionReporterCall = {
  input: ConversionUploadInput
  receivedAtIso: string
  /** True when this call was rejected by the in-memory dedup table. */
  deduplicated: boolean
}

export type MemoryConversionReporter = ConversionReporter & {
  /** All calls received, in order. */
  readonly uploads: ReadonlyArray<MemoryConversionReporterCall>
  /** Cause the next reportConversion() call to throw the given error. */
  failNext(err: Error): void
  /** Reset state — useful between tests. */
  reset(): void
}

export type MemoryConversionReporterOptions = {
  /**
   * When true, the reporter remembers transactionIds and reports
   * `deduplicated: true` on repeats. Matches Google Ads' vendor-side
   * dedup contract. Default: true.
   */
  dedup?: boolean
}

export function memoryConversionReporter(
  opts: MemoryConversionReporterOptions = {},
): MemoryConversionReporter {
  const dedup = opts.dedup ?? true
  const uploads: MemoryConversionReporterCall[] = []
  const seenTxIds = new Set<string>()
  let queuedError: Error | null = null

  const reporter: ConversionReporter = {
    async reportConversion(
      input: ConversionUploadInput,
      ctx: AdapterContext,
    ): Promise<ConversionUploadResult> {
      if (queuedError) {
        const err = queuedError
        queuedError = null
        throw err
      }

      validateConversionInput(input)

      const deduplicated = dedup && seenTxIds.has(input.transactionId)
      const receivedAtIso = ctx.now().toISOString()
      uploads.push({ input, receivedAtIso, deduplicated })
      if (!deduplicated) seenTxIds.add(input.transactionId)

      return {
        transactionId: input.transactionId,
        reportedAtIso: receivedAtIso,
        deduplicated,
        vendorReceiptId: `memory-${input.transactionId}`,
      }
    },

    async health(_ctx: AdapterContext): Promise<AdapterHealth> {
      return { ok: true, name: 'memory-conversion', version: '0.1.0' }
    },
  }

  return Object.assign(reporter, {
    get uploads(): ReadonlyArray<MemoryConversionReporterCall> {
      return uploads
    },
    failNext(err: Error): void {
      queuedError = err
    },
    reset(): void {
      uploads.length = 0
      seenTxIds.clear()
      queuedError = null
    },
  })
}
