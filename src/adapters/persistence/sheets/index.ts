// Google Sheets persistence — service-account JWT auth, REST v4.
// Header check is cached per-process (one less hot-path call vs old kit).
// Retries appendRow once on transient failure (Pattern 15).

import { errMessage, BookingError } from '../../../core/errors.js'
import { truncate } from '../../../core/internal/strings.js'
import { sleep } from '../../../core/internal/timing.js'
import type { PersistenceAdapter, PersistenceRecord } from '../adapter.js'
import type { AdapterContext, AdapterHealth } from '../../../core/types.js'
import { BOOKING_ROW_HEADERS, bookingToRow } from '../../../core/persistence-row.js'

export type SheetsAdapterOptions = {
  spreadsheetId: string
  /** Tab name. Default: 'Bookings'. */
  tabName?: string
  /** Service-account email. */
  clientEmail: string
  /** PEM private key. Literal `\n` is unescaped automatically. */
  privateKey: string
  /** Override fetch for tests. */
  fetchImpl?: typeof fetch
  /** Skip header check entirely (assume the sheet was set up by hand). */
  skipHeaderCheck?: boolean
}

// 12-column schema lives in core (Clean Architecture: pipeline + adapters
// share the canonical row format without depending on each other).
const HEADERS = BOOKING_ROW_HEADERS

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets'
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets'
const TOKEN_TTL_MS = 55 * 60 * 1000 // 55min — Google issues 60min tokens

type CachedToken = { token: string; expiresAt: number } | null

export function sheetsAdapter(opts: SheetsAdapterOptions): PersistenceAdapter {
  if (!opts.spreadsheetId || !opts.clientEmail || !opts.privateKey) {
    throw new BookingError('CONFIG_INVALID', 'sheetsAdapter: spreadsheetId, clientEmail, privateKey are required')
  }
  const tabName = opts.tabName ?? 'Bookings'
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const privateKey = unescapePem(opts.privateKey)

  let cachedToken: CachedToken = null
  let headersEnsured = opts.skipHeaderCheck === true

  async function getAccessToken(): Promise<string> {
    if (cachedToken && cachedToken.expiresAt > Date.now()) {
      return cachedToken.token
    }
    const jwt = await signServiceAccountJwt(opts.clientEmail, privateKey, SCOPE)
    const res = await fetchImpl(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${encodeURIComponent(jwt)}`,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new BookingError('PERSISTENCE_FAILED', `Google token exchange failed: HTTP ${res.status} ${truncate(text, 200)}`)
    }
    const body = (await res.json()) as { access_token: string; expires_in: number }
    cachedToken = {
      token: body.access_token,
      expiresAt: Date.now() + Math.min(body.expires_in * 1000, TOKEN_TTL_MS),
    }
    return body.access_token
  }

  async function ensureHeaders(): Promise<void> {
    if (headersEnsured) return
    const token = await getAccessToken()
    const range = `${tabName}!A1:${columnLetter(HEADERS.length)}1`
    const url = `${SHEETS_API}/${opts.spreadsheetId}/values/${encodeURIComponent(range)}`
    const res = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) {
      throw new BookingError('PERSISTENCE_FAILED', `Sheets header check failed: HTTP ${res.status}`)
    }
    const body = (await res.json()) as { values?: string[][] }
    const existing = body.values?.[0] ?? []
    const matches =
      existing.length >= HEADERS.length &&
      HEADERS.every((h, i) => existing[i] === h)
    if (!matches) {
      // Write headers
      const writeUrl = `${SHEETS_API}/${opts.spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`
      const writeRes = await fetchImpl(writeUrl, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ values: [HEADERS] }),
      })
      if (!writeRes.ok) {
        throw new BookingError('PERSISTENCE_FAILED', `Sheets header write failed: HTTP ${writeRes.status}`)
      }
    }
    headersEnsured = true
  }

  async function appendOnce(row: ReadonlyArray<string>): Promise<void> {
    const token = await getAccessToken()
    const range = `${tabName}!A:A`
    const url = `${SHEETS_API}/${opts.spreadsheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ values: [row] }),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new BookingError('PERSISTENCE_FAILED', `Sheets append failed: HTTP ${res.status} ${truncate(text, 200)}`)
    }
  }

  return {
    async append(record: PersistenceRecord, ctx: AdapterContext): Promise<void> {
      const t0 = Date.now()
      try {
        await ensureHeaders()
        const row = toRow(record)
        try {
          await appendOnce(row)
        } catch (err) {
          // Pattern 15: one retry with 500ms backoff before giving up.
          await sleep(500)
          await appendOnce(row)
          ctx.logger.warn({
            evt: 'sheets.append.retried',
            submissionId: record.request.submissionId,
            message: errMessage(err),
          })
        }
        ctx.logger.info({
          evt: 'sheets.append.ok',
          submissionId: record.request.submissionId,
          durationMs: Date.now() - t0,
        })
      } catch (err) {
        ctx.logger.error({
          evt: 'sheets.append.failed',
          submissionId: record.request.submissionId,
          message: errMessage(err),
          durationMs: Date.now() - t0,
        })
        throw err
      }
    },

    async health(_ctx): Promise<AdapterHealth> {
      try {
        await getAccessToken()
        const url = `${SHEETS_API}/${opts.spreadsheetId}`
        const res = await fetchImpl(url, {
          headers: { Authorization: `Bearer ${cachedToken?.token ?? ''}` },
        })
        if (!res.ok) {
          return {
            ok: false,
            name: 'sheets',
            version: '0.1.0',
            error: `HTTP ${res.status}`,
          }
        }
        return { ok: true, name: 'sheets', version: '0.1.0' }
      } catch (err) {
        return {
          ok: false,
          name: 'sheets',
          version: '0.1.0',
          error: errMessage(err),
        }
      }
    },
  }
}

// ── Row builder ──────────────────────────────────────────────────────────────
// Re-export of the core canonical row for back-compat with v0.2.0 consumers.
// Pattern 16 — version always last column. Defined in `core/persistence-row.ts`.

export function toRow(record: PersistenceRecord): string[] {
  return bookingToRow(record)
}

// ── JWT signing — RS256 via Web Crypto API (works in Node 20 + Edge) ─────────

async function signServiceAccountJwt(
  email: string,
  privateKey: string,
  scope: string,
): Promise<string> {
  const header = { alg: 'RS256', typ: 'JWT' }
  const now = Math.floor(Date.now() / 1000)
  const payload = {
    iss: email,
    scope,
    aud: GOOGLE_TOKEN_URL,
    iat: now,
    exp: now + 3600,
  }
  const headerB64 = base64url(JSON.stringify(header))
  const payloadB64 = base64url(JSON.stringify(payload))
  const signingInput = `${headerB64}.${payloadB64}`

  const key = await importPemPrivateKey(privateKey)
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(signingInput),
  )
  const sigB64 = base64url(new Uint8Array(signature))
  return `${signingInput}.${sigB64}`
}

async function importPemPrivateKey(pem: string): Promise<CryptoKey> {
  const cleaned = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '')
  const view = base64ToBytes(cleaned)
  // TS 5.6+: Uint8Array<ArrayBufferLike> isn't assignable to BufferSource because
  // ArrayBufferLike accepts SharedArrayBuffer. Slice into a fresh ArrayBuffer.
  const der = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer
  return crypto.subtle.importKey(
    'pkcs8',
    der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  )
}

function unescapePem(s: string): string {
  // Vercel env vars come with literal \n. Convert to real newlines.
  return s.includes('\\n') ? s.replace(/\\n/g, '\n') : s
}

function base64url(input: string | Uint8Array): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i] as number)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function columnLetter(n: number): string {
  let s = ''
  let x = n
  while (x > 0) {
    const r = (x - 1) % 26
    s = String.fromCharCode(65 + r) + s
    x = Math.floor((x - 1) / 26)
  }
  return s
}
