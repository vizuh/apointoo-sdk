// Orchestrator — pulls merchants → builds feeds → publishes via SFTP (or dry-run).
// Single entry point for cron / scheduled function.
//
// Multi-tenant SaaS pattern: ONE Google RwG partner account (Vizuh's), so all
// tenants' merchants get batched into one set of 3 feed files per run. Google
// routes by `entity_id` per merchant.

import { errMessage } from '../../core/errors.js'
import { buildRwgFeeds, type BuildOptions, type RwgFiles } from './feed-builder.js'
import type { MerchantSource } from './merchant-source.js'
import {
  publishRwgFeeds,
  RwgPublishError,
  type PublishOptions,
  type PublishSummary,
  type SftpConfig,
} from './publisher.js'
import type { Logger } from '../../core/types.js'

export type RwgRunOptions = {
  merchantSource: MerchantSource
  /** SFTP config (Vizuh's partner credentials). */
  sftp: SftpConfig
  /** Where to write files for testing — bypasses SFTP entirely. */
  dryRunDir?: string
  /** Build-time options (timestamp override, schema version). */
  buildOptions?: BuildOptions
  logger: Logger
}

export type RwgRunSummary = {
  startedAt: string
  completedAt: string
  durationMs: number
  merchantCount: number
  files: { entity: string; action: string; glamService: string }
  publishSummary: PublishSummary
  ok: boolean
  error?: string
  /** Single generation clock (epoch seconds) shared by filenames + descriptors. Read-side (F16). */
  generationTimestamp?: number
  /** Merchant entityIds actually uploaded this run — empty on failure. Read-side (F16). */
  publishedMerchantIds?: string[]
}

/**
 * Run one feed publish cycle. Idempotent — safe to retry on failure.
 * Logs structured events for observability.
 */
export async function runRwgPublish(opts: RwgRunOptions): Promise<RwgRunSummary> {
  const startedAt = new Date()
  const startedAtIso = startedAt.toISOString()
  opts.logger.info({ evt: 'rwg.run.start' })

  // 1. Fetch merchants
  let merchants
  try {
    merchants = await opts.merchantSource.list()
  } catch (err) {
    const message = errMessage(err)
    opts.logger.error({ evt: 'rwg.run.merchants_fetch_failed', message })
    return makeFailureSummary(startedAt, message)
  }

  opts.logger.info({
    evt: 'rwg.run.merchants_loaded',
    ctx: { count: String(merchants.length) },
  })

  if (merchants.length === 0) {
    opts.logger.warn({ evt: 'rwg.run.no_merchants' })
    return makeFailureSummary(startedAt, 'No merchants returned by source')
  }

  // 2. Build feeds
  // Single clock: thread the same ts into the builder so descriptor `data_file`
  // names match the uploaded filenames even across a second boundary (F11a).
  const ts = opts.buildOptions?.timestamp ?? Math.floor(Date.now() / 1000)
  let files: RwgFiles
  try {
    files = buildRwgFeeds(merchants, { ...opts.buildOptions, timestamp: ts })
  } catch (err) {
    const message = errMessage(err)
    opts.logger.error({ evt: 'rwg.run.build_failed', message })
    return makeFailureSummary(startedAt, message)
  }

  // 3. Publish
  const publishOpts: PublishOptions = {
    files,
    timestamp: ts,
    sftp: opts.sftp,
    logger: opts.logger,
    ...(opts.dryRunDir !== undefined ? { dryRunDir: opts.dryRunDir } : {}),
  }

  let publishSummary: PublishSummary
  try {
    publishSummary = await publishRwgFeeds(publishOpts)
  } catch (err) {
    const message = errMessage(err)
    opts.logger.error({ evt: 'rwg.run.publish_failed', message })
    // Preserve evidence of files already uploaded before the failure (F11c).
    return makeFailureSummary(startedAt, message, {
      generationTimestamp: ts,
      ...(err instanceof RwgPublishError ? { publishSummary: err.summary } : {}),
    })
  }

  const completedAt = new Date()
  const ok = publishSummary.errors.length === 0

  const summary: RwgRunSummary = {
    startedAt: startedAtIso,
    completedAt: completedAt.toISOString(),
    durationMs: completedAt.getTime() - startedAt.getTime(),
    merchantCount: merchants.length,
    files: {
      entity: `0entity_${ts}.json`,
      action: `1action_${ts}.json`,
      glamService: `2glam.service.v0_${ts}.json`,
    },
    publishSummary,
    ok,
    ...(ok ? {} : { error: publishSummary.errors.map((e) => e.error).join('; ') }),
    generationTimestamp: ts,
    publishedMerchantIds: ok ? merchants.map((m) => m.entityId) : [],
  }

  opts.logger.info({
    evt: ok ? 'rwg.run.complete' : 'rwg.run.complete_with_errors',
    durationMs: summary.durationMs,
    ctx: {
      merchantCount: String(merchants.length),
      uploaded: String(publishSummary.uploaded.length),
      errors: String(publishSummary.errors.length),
    },
  })

  return summary
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeFailureSummary(
  startedAt: Date,
  error: string,
  extra?: { generationTimestamp?: number; publishSummary?: PublishSummary },
): RwgRunSummary {
  const completedAt = new Date()
  return {
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs: completedAt.getTime() - startedAt.getTime(),
    merchantCount: 0,
    files: {
      entity: '',
      action: '',
      glamService: '',
    },
    publishSummary: extra?.publishSummary ?? { uploaded: [], skipped: [], errors: [] },
    ok: false,
    error,
    ...(extra?.generationTimestamp !== undefined
      ? { generationTimestamp: extra.generationTimestamp }
      : {}),
    publishedMerchantIds: [],
  }
}
