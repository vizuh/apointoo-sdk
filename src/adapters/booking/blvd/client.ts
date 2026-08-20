// blvdFetch — single HTTP transport for BLVD GraphQL.
// Retry with backoff for transient errors (HTTP 5xx + network).
// Auth: Basic base64("apiKey:") — trailing colon REQUIRED (silent fail otherwise).

import { errMessage } from '../../../core/errors.js'
import { sleep } from '../../../core/internal/timing.js'
import { BlvdError } from './errors.js'

export type BlvdClientOptions = {
  apiKey: string
  businessId: string
  /** Defaults to live: https://dashboard.boulevard.io/api/2020-01 */
  apiUrl?: string
  /** Retry budget for transient errors. Default: 1 retry, 200ms delay. */
  retry?: { attempts: number; baseDelayMs: number }
  /** Override fetch (e.g. for tests). Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch
}

export type BlvdGqlResponse<T> = {
  data: T
  errors?: Array<{ message: string; extensions?: Record<string, unknown> }>
}

const DEFAULT_API_URL = 'https://dashboard.boulevard.io/api/2020-01'

export type BlvdClient = {
  /**
   * Run a GraphQL operation. Throws BlvdError on transport, GraphQL, or auth failure.
   * Retries transient HTTP 5xx + network errors per the configured budget.
   * Operation name is logged in error messages — pass a stable string.
   */
  exec<T>(operationName: string, query: string, variables?: Record<string, unknown>): Promise<T>
}

export function createBlvdClient(opts: BlvdClientOptions): BlvdClient {
  if (!opts.apiKey || !opts.businessId) {
    throw new BlvdError('AUTH_MISSING', 'BLVD client requires apiKey + businessId')
  }
  const apiUrl = opts.apiUrl ?? DEFAULT_API_URL
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const retry = opts.retry ?? { attempts: 1, baseDelayMs: 200 }

  // Pre-compute auth header once. Trailing colon is mandatory (BLVD spec).
  const credentials = Buffer.from(`${opts.apiKey}:`).toString('base64')
  const authHeader = `Basic ${credentials}`
  const endpoint = `${apiUrl}/${opts.businessId}/client`

  async function exec<T>(
    operationName: string,
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<T> {
    let lastErr: unknown
    for (let attempt = 0; attempt <= retry.attempts; attempt++) {
      try {
        return await once<T>({
          endpoint,
          authHeader,
          fetchImpl,
          query,
          operationName,
          ...(variables !== undefined ? { variables } : {}),
        })
      } catch (err) {
        lastErr = err
        // Only retry on transient (HTTP_ERROR with 5xx, network)
        if (!isTransient(err)) throw err
        if (attempt === retry.attempts) break
        await sleep(retry.baseDelayMs * Math.pow(2, attempt))
      }
    }
    throw lastErr
  }

  return { exec }
}

async function once<T>(args: {
  endpoint: string
  authHeader: string
  fetchImpl: typeof fetch
  query: string
  variables?: Record<string, unknown>
  operationName: string
}): Promise<T> {
  let res: Response
  try {
    res = await args.fetchImpl(args.endpoint, {
      method: 'POST',
      headers: {
        Authorization: args.authHeader,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        // Intentionally NOT sending `Book-SDK-Version` (kit #43): we do not
        // depend on `@boulevard/blvd-book-sdk` as a runtime package, so any
        // value we send is fabricated. If BLVD starts validating that header
        // (min-version enforcement, deprecation gating), a stale spoofed
        // value silently breaks the adapter. Omitting is the honest choice.
      },
      body: JSON.stringify({ query: args.query, variables: args.variables }),
    })
  } catch (err) {
    throw new BlvdError(
      'HTTP_ERROR',
      `BLVD network error during ${args.operationName}: ${errMessage(err)}`,
    )
  }

  if (!res.ok) {
    throw new BlvdError(
      'HTTP_ERROR',
      `BLVD ${args.operationName} returned HTTP ${res.status}`,
    )
  }

  const body = (await res.json()) as BlvdGqlResponse<T>

  if (body.errors?.length) {
    const first = body.errors[0]
    if (!first) {
      throw new BlvdError('GRAPHQL_ERROR', `BLVD ${args.operationName} returned empty error array`)
    }
    // Never include `extensions` — may carry business data
    throw new BlvdError(
      'GRAPHQL_ERROR',
      `BLVD ${args.operationName}: ${first.message}`,
    )
  }

  return body.data
}

function isTransient(err: unknown): boolean {
  if (!(err instanceof BlvdError)) return false
  if (err.code !== 'HTTP_ERROR') return false
  // HTTP 5xx + raw network errors are transient
  return /HTTP 5\d\d/.test(err.message) || /network error/i.test(err.message)
}
