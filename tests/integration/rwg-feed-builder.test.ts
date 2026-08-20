// Tier 1 (unit, pure function) — glam.service.v0 description/category guard.
import { describe, expect, it } from 'vitest'
import { buildRwgFeeds } from '../../src/integration/rwg/feed-builder.js'
import type { RwgMerchant } from '../../src/integration/rwg/feed-builder.js'

function merchant(services?: RwgMerchant['services']): RwgMerchant {
  return {
    entityId: 'm1',
    name: 'Merchant One',
    telephone: '+15555550000',
    bookingUrl: 'https://example.com/book',
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
    ...(services !== undefined ? { services } : {}),
  }
}

function glamRows(merchants: RwgMerchant[]) {
  const { glamService } = buildRwgFeeds(merchants)
  return (glamService.data as { data: Array<Record<string, any>> }).data
}

describe('buildGlamService — description/category duplicate guard', () => {
  it('description undefined → falls back to "General booking"', () => {
    const rows = glamRows([merchant([{ serviceId: 's1', name: 'Haircut' }])])
    expect(rows[0]!.localized_service_description.value).toBe('General booking')
  })

  it('description exactly equals name → falls back', () => {
    const rows = glamRows([merchant([{ serviceId: 's1', name: 'Balayage', description: 'Balayage' }])])
    expect(rows[0]!.localized_service_description.value).toBe('General booking')
  })

  it('description equals name case-insensitively / with whitespace differences → falls back', () => {
    const rows = glamRows([
      merchant([{ serviceId: 's1', name: 'Swedish Massage', description: '  swedish massage  ' }]),
    ])
    expect(rows[0]!.localized_service_description.value).toBe('General booking')
  })

  it('description is empty/whitespace-only → falls back', () => {
    const rows = glamRows([merchant([{ serviceId: 's1', name: 'Manicure', description: '   ' }])])
    expect(rows[0]!.localized_service_description.value).toBe('General booking')
  })

  it('description is genuinely different and non-empty → passed through (trimmed)', () => {
    const rows = glamRows([
      merchant([{ serviceId: 's1', name: 'Balayage', description: '  Full-head color correction  ' }]),
    ])
    expect(rows[0]!.localized_service_description.value).toBe('Full-head color correction')
  })

  it('multiple services on one merchant — only the colliding one falls back', () => {
    const rows = glamRows([
      merchant([
        { serviceId: 's1', name: 'Balayage', description: 'Balayage' },
        { serviceId: 's2', name: 'Blowout', description: 'Quick blow-dry finish' },
      ]),
    ])
    expect(rows[0]!.localized_service_description.value).toBe('General booking')
    expect(rows[1]!.localized_service_description.value).toBe('Quick blow-dry finish')
  })

  it('fallback description never equals the hardcoded category (regression pin)', () => {
    const rows = glamRows([merchant([{ serviceId: 's1', name: 'Anything' }])])
    expect(rows[0]!.localized_service_description.value).not.toBe(rows[0]!.localized_service_category.value)
  })
})
