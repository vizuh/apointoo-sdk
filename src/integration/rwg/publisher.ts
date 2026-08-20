// RwG SFTP publisher. Uploads built feeds to Google's partner endpoint.
// Node-only — uses SFTP via optional `ssh2-sftp-client` dep at runtime.
// Consumer wires this in their cron job.

import { errMessage, BookingError } from '../../core/errors.js'
import type { RwgFiles } from './feed-builder.js'
import { feedFilenames } from './feed-builder.js'
import type { Logger } from '../../core/types.js'

export type SftpConfig = {
  /** Default 'partnerupload.google.com'. */
  host?: string
  /** Default 19321 (Google's RwG SFTP port). */
  port?: number
  username: string
  /** PEM-encoded private key. Read by the consumer; never the kit. */
  privateKey: string
  /** Optional passphrase. */
  passphrase?: string
}

export type PublishOptions = {
  files: RwgFiles
  /** Generation timestamp matching the descriptor file names. */
  timestamp: number
  sftp: SftpConfig
  logger: Logger
  /** Skip the upload — write to a local directory instead. For testing. */
  dryRunDir?: string
}

export type PublishSummary = {
  uploaded: string[]
  skipped: string[]
  errors: Array<{ file: string; error: string }>
}

/**
 * Thrown when an SFTP upload fails mid-batch. Carries the partial summary
 * (files uploaded before the failure) so the runner preserves that evidence
 * instead of reporting an empty uploaded[] (F11c).
 */
export class RwgPublishError extends BookingError {
  readonly summary: PublishSummary
  constructor(message: string, summary: PublishSummary) {
    super('PERSISTENCE_FAILED', message)
    this.name = 'RwgPublishError'
    this.summary = summary
  }
}

const DEFAULT_HOST = 'partnerupload.google.com'
const DEFAULT_PORT = 19321

/**
 * Build a list of (filename, JSON content) pairs ready to upload.
 * Pure — no IO. Useful for tests + dry runs.
 */
export function pairFiles(
  files: RwgFiles,
  ts: number,
): Array<{ filename: string; content: string }> {
  const names = feedFilenames(ts)
  // Data file BEFORE its descriptor: a descriptor only ever reaches Google once
  // the file it points at is already uploaded (F11b).
  return [
    { filename: names.entity, content: JSON.stringify(files.entity.data, null, 2) },
    { filename: names.entityDesc, content: JSON.stringify(files.entity.descriptor, null, 2) },
    { filename: names.action, content: JSON.stringify(files.action.data, null, 2) },
    { filename: names.actionDesc, content: JSON.stringify(files.action.descriptor, null, 2) },
    { filename: names.glam, content: JSON.stringify(files.glamService.data, null, 2) },
    { filename: names.glamDesc, content: JSON.stringify(files.glamService.descriptor, null, 2) },
  ]
}

/**
 * Upload feeds to Google. Returns a per-file summary.
 *
 * SFTP transport is loaded dynamically — the kit doesn't hard-depend on
 * ssh2-sftp-client. If the dep isn't installed, throws a clear error.
 *
 * @example
 *   const { buildRwgFeeds } = await import('@vizuh/.../integration/rwg/feed-builder')
 *   const files = buildRwgFeeds(merchants)
 *   await publishRwgFeeds({ files, timestamp, sftp: {...}, logger })
 */
export async function publishRwgFeeds(opts: PublishOptions): Promise<PublishSummary> {
  const summary: PublishSummary = { uploaded: [], skipped: [], errors: [] }
  const pairs = pairFiles(opts.files, opts.timestamp)

  if (opts.dryRunDir) {
    // Dry run path — write to disk via fs/promises (Node-only).
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    await fs.mkdir(opts.dryRunDir, { recursive: true })
    for (const { filename, content } of pairs) {
      await fs.writeFile(path.join(opts.dryRunDir, filename), content, 'utf8')
      summary.skipped.push(filename)
    }
    opts.logger.info({
      evt: 'rwg.publish.dry_run',
      ctx: { dir: opts.dryRunDir, count: String(pairs.length) },
    })
    return summary
  }

  // Real SFTP path
  let SftpClient
  try {
    // ssh2-sftp-client default export
    const mod = (await import('ssh2-sftp-client')) as { default: new () => unknown }
    SftpClient = mod.default
  } catch {
    throw new BookingError(
      'DEPENDENCY_UNAVAILABLE',
      'publishRwgFeeds: ssh2-sftp-client is not installed. Run `npm i ssh2-sftp-client` ' +
        'or use { dryRunDir } for testing.',
    )
  }

  const client = new SftpClient() as {
    connect(opts: object): Promise<void>
    put(input: Buffer, remote: string): Promise<unknown>
    end(): Promise<void>
  }

  await client.connect({
    host: opts.sftp.host ?? DEFAULT_HOST,
    port: opts.sftp.port ?? DEFAULT_PORT,
    username: opts.sftp.username,
    privateKey: opts.sftp.privateKey,
    ...(opts.sftp.passphrase !== undefined ? { passphrase: opts.sftp.passphrase } : {}),
  })

  try {
    for (const { filename, content } of pairs) {
      try {
        await client.put(Buffer.from(content, 'utf8'), filename)
        summary.uploaded.push(filename)
        opts.logger.info({ evt: 'rwg.publish.file_ok', ctx: { filename } })
      } catch (err) {
        // Fail the WHOLE generation on the first file error — a partial snapshot
        // must never reach Google. Carry the summary-so-far so the runner keeps
        // the evidence of what was already uploaded (F11c).
        const error = errMessage(err)
        summary.errors.push({ file: filename, error })
        opts.logger.error({ evt: 'rwg.publish.file_failed', ctx: { filename, error } })
        throw new RwgPublishError(`RwG upload failed for ${filename}: ${error}`, summary)
      }
    }
  } finally {
    // ponytail: swallow close errors so a failing client.end() can't mask the
    // upload result (success OR the RwgPublishError above).
    try {
      await client.end()
    } catch {
      /* connection close is best-effort */
    }
  }

  return summary
}
