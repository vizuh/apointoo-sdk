// Tier 2 (integration) — RwG merchant source + runner orchestrator.
import { describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import {
  filteredMerchantSource,
  fetchMerchantSource,
  staticMerchantSource,
} from '../../src/integration/rwg/merchant-source.js'
import { runRwgPublish } from '../../src/integration/rwg/runner.js'
import type { RwgMerchant } from '../../src/integration/rwg/feed-builder.js'
import type { Logger } from '../../src/core/types.js'

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
  url: 'https://salon-a.com',
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
  bookingUrl: 'https://salon-a.com/book',
}

const m2: RwgMerchant = {
  entityId: 'clinic-b',
  name: 'Clinic B',
  telephone: '+15555550002',
  url: 'https://clinic-b.com',
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
  bookingUrl: 'https://clinic-b.com/booking',
}

describe('staticMerchantSource', () => {
  it('returns the merchants given at construction', async () => {
    const src = staticMerchantSource({ merchants: [m1, m2] })
    const list = await src.list()
    expect(list).toEqual([m1, m2])
  })

  it('listSince returns same as list (full snapshot)', async () => {
    const src = staticMerchantSource({ merchants: [m1] })
    const since = await src.listSince!(new Date(0))
    expect(since).toEqual([m1])
  })

  it('health is always ok', async () => {
    const src = staticMerchantSource({ merchants: [] })
    expect(await src.health()).toEqual({ ok: true, name: 'static' })
  })
})

describe('fetchMerchantSource', () => {
  it('calls the supplied fetch fn', async () => {
    let callCount = 0
    const src = fetchMerchantSource({
      fetch: async () => {
        callCount++
        return [m1]
      },
    })
    expect(await src.list()).toEqual([m1])
    expect(callCount).toBe(1)
  })

  it('health uses fetch fn — succeeds when fetch resolves', async () => {
    const src = fetchMerchantSource({ fetch: async () => [m1] })
    expect((await src.health()).ok).toBe(true)
  })

  it('health fails when fetch throws', async () => {
    const src = fetchMerchantSource({
      fetch: async () => {
        throw new Error('DB down')
      },
    })
    const health = await src.health()
    expect(health.ok).toBe(false)
    expect(health.error).toContain('DB down')
  })
})

describe('filteredMerchantSource', () => {
  it('applies predicate to filter list', async () => {
    const inner = staticMerchantSource({ merchants: [m1, m2] })
    const filtered = filteredMerchantSource(inner, (m) => m.entityId === 'salon-a')
    expect(await filtered.list()).toEqual([m1])
  })
})

describe('runRwgPublish — dry-run mode', () => {
  it('writes 6 files (3 descriptors + 3 data) to dryRunDir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rwg-run-'))
    try {
      const summary = await runRwgPublish({
        merchantSource: staticMerchantSource({ merchants: [m1, m2] }),
        sftp: {
          host: 'unused',
          username: 'unused',
          privateKey: 'unused',
        },
        dryRunDir: dir,
        logger: silentLogger,
      })
      expect(summary.ok).toBe(true)
      expect(summary.merchantCount).toBe(2)
      expect(summary.publishSummary.skipped).toHaveLength(6)
      expect(summary.publishSummary.uploaded).toHaveLength(0)
      const files = readdirSync(dir)
      expect(files).toHaveLength(6)
      // Confirm naming convention
      expect(files.some((f) => f.startsWith('0entity_'))).toBe(true)
      expect(files.some((f) => f.startsWith('1action_'))).toBe(true)
      expect(files.some((f) => f.startsWith('2glam.service.v0_'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns failure summary when source has zero merchants', async () => {
    const summary = await runRwgPublish({
      merchantSource: staticMerchantSource({ merchants: [] }),
      sftp: {
        host: 'unused',
        username: 'unused',
        privateKey: 'unused',
      },
      dryRunDir: '/tmp/never-written',
      logger: silentLogger,
    })
    expect(summary.ok).toBe(false)
    expect(summary.merchantCount).toBe(0)
    expect(summary.error).toContain('No merchants')
  })

  it('returns failure when merchant source throws', async () => {
    const failingSource = fetchMerchantSource({
      fetch: async () => {
        throw new Error('Tenant DB unreachable')
      },
    })
    const summary = await runRwgPublish({
      merchantSource: failingSource,
      sftp: {
        host: 'unused',
        username: 'unused',
        privateKey: 'unused',
      },
      logger: silentLogger,
    })
    expect(summary.ok).toBe(false)
    expect(summary.error).toContain('Tenant DB unreachable')
  })
})
