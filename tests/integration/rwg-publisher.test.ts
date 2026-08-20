// Tier 2 (integration) — RwG atomic publish guarantees (audit F11).
// Covers: single generation clock, data-first upload ordering, and
// fail-whole-on-error with preserved uploaded[] evidence.
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { staticMerchantSource } from '../../src/integration/rwg/merchant-source.js'
import { runRwgPublish } from '../../src/integration/rwg/runner.js'
import type { RwgMerchant } from '../../src/integration/rwg/feed-builder.js'
import type { Logger } from '../../src/core/types.js'

// Shared mock state — `vi.hoisted` so the hoisted `vi.mock` factory can see it.
const sftp = vi.hoisted(() => ({ puts: [] as string[], failOnPut: 0 }))

vi.mock('ssh2-sftp-client', () => {
  class MockSftp {
    async connect(): Promise<void> {}
    async put(_buf: Buffer, remote: string): Promise<void> {
      sftp.puts.push(remote)
      if (sftp.puts.length === sftp.failOnPut) {
        throw new Error(`SFTP put boom: ${remote}`)
      }
    }
    async end(): Promise<void> {}
  }
  return { default: MockSftp }
})

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

const m1: RwgMerchant = {
  entityId: 'salon-a',
  name: 'Salon A',
  telephone: '+15555550001',
  bookingUrl: 'https://salon-a.com/book',
  location: {
    latitude: 40.7,
    longitude: -74.0,
    address: {
      country: 'US',
      locality: 'NYC',
      region: 'NY',
      postalCode: '10001',
      streetAddress: '1 Main St',
    },
  },
}
const m2: RwgMerchant = {
  entityId: 'clinic-b',
  name: 'Clinic B',
  telephone: '+15555550002',
  bookingUrl: 'https://clinic-b.com/book',
  location: {
    latitude: 40.8,
    longitude: -74.1,
    address: {
      country: 'US',
      locality: 'NYC',
      region: 'NY',
      postalCode: '10002',
      streetAddress: '2 Side St',
    },
  },
}

const unusedSftp = { host: 'unused', username: 'unused', privateKey: 'unused' }

beforeEach(() => {
  sftp.puts = []
  sftp.failOnPut = 0
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('runRwgPublish — fail-whole-on-error (F11c)', () => {
  it('2nd put throws → aborts, no descriptor uploaded, uploaded[] preserved, ok=false', async () => {
    sftp.failOnPut = 2 // data-first order: 1st put is entity DATA, 2nd is entity DESCRIPTOR
    const summary = await runRwgPublish({
      merchantSource: staticMerchantSource({ merchants: [m1, m2] }),
      sftp: unusedSftp,
      buildOptions: { timestamp: 1234567890 },
      logger: silentLogger,
    })

    expect(summary.ok).toBe(false)
    expect(summary.error).toContain('RwG upload failed')
    // Stopped on the 2nd put — never tried the remaining 4 files.
    expect(sftp.puts).toHaveLength(2)
    // The one file that succeeded (entity data) is preserved as evidence.
    expect(summary.publishSummary.uploaded).toEqual(['0entity_1234567890.json'])
    // No descriptor ever reached Google.
    expect(summary.publishSummary.uploaded.some((f) => f.endsWith('.filesetdesc.json'))).toBe(false)
    // Partial snapshot ⇒ nothing counts as published.
    expect(summary.publishedMerchantIds).toEqual([])
    expect(summary.generationTimestamp).toBe(1234567890)
  })
})

describe('runRwgPublish — single generation clock (F11a)', () => {
  it('descriptor internal data_file names match the uploaded filenames across a second boundary', async () => {
    // Runner computes ts from Date.now(); if the builder recomputed its own
    // Date.now() a millisecond later it would cross into the next second.
    let n = 0
    vi.spyOn(Date, 'now').mockImplementation(() => (n++ === 0 ? 1_000_000_999 : 1_000_001_000))

    const dir = mkdtempSync(join(tmpdir(), 'rwg-clock-'))
    try {
      const summary = await runRwgPublish({
        merchantSource: staticMerchantSource({ merchants: [m1, m2] }),
        sftp: unusedSftp,
        dryRunDir: dir,
        logger: silentLogger,
      })

      expect(summary.generationTimestamp).toBe(1_000_000) // floor(1000000999 / 1000)
      const written = new Set(readdirSync(dir))
      // Every descriptor's internal data_file must point at a file actually written.
      for (const name of written) {
        if (!name.endsWith('.filesetdesc.json')) continue
        const desc = JSON.parse(readFileSync(join(dir, name), 'utf8')) as { data_file: string[] }
        for (const df of desc.data_file) {
          expect(written.has(df)).toBe(true)
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('runRwgPublish — read-side fields on success (F16)', () => {
  it('populates generationTimestamp and publishedMerchantIds', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rwg-ok-'))
    try {
      const summary = await runRwgPublish({
        merchantSource: staticMerchantSource({ merchants: [m1, m2] }),
        sftp: unusedSftp,
        dryRunDir: dir,
        buildOptions: { timestamp: 42 },
        logger: silentLogger,
      })

      expect(summary.ok).toBe(true)
      expect(summary.generationTimestamp).toBe(42)
      expect(summary.publishedMerchantIds).toEqual(['salon-a', 'clinic-b'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
