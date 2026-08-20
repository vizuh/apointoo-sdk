// Reserve-with-Google feed builder. Pure functions — no IO.
// Input: list of merchants. Output: 3 JSON files in Google's RwG schemas.
// Mirrors apointoo-direct integration/mongo-generatem.php logic.

export type RwgMerchant = {
  /** External ID — usually the merchant's URL slug. */
  entityId: string
  name: string
  telephone: string
  /** Public homepage / merchant URL. Optional — Google's schema marks this
   * "highly recommended", not required. */
  url?: string
  location: {
    latitude: number
    longitude: number
    address: {
      country: string
      locality: string
      region: string
      postalCode: string
      streetAddress: string
    }
  }
  /** Booking URL Google should deep-link to. If absent, falls back to bookingPath template. */
  bookingUrl?: string
  /** Per-language booking URLs. Used when bookingUrl absent. */
  perLanguageBookingUrls?: ReadonlyArray<{ language: string; url: string }>
  /** Service catalog. Defaults to one 'General' service if empty. */
  services?: ReadonlyArray<{
    serviceId: string
    name: string
    description?: string
    localizedNames?: ReadonlyArray<{ locale: string; value: string }>
    localizedDescriptions?: ReadonlyArray<{ locale: string; value: string }>
  }>
}

export type RwgFiles = {
  entity: { descriptor: object; data: object }
  action: { descriptor: object; data: object }
  glamService: { descriptor: object; data: object }
}

export type BuildOptions = {
  /** Generation timestamp (epoch seconds). Defaults to current time. */
  timestamp?: number
  /** Schema version label for descriptors. Default 'reservewithgoogle.action.v2'. */
  actionSchema?: string
}

export function buildRwgFeeds(
  merchants: ReadonlyArray<RwgMerchant>,
  opts: BuildOptions = {},
): RwgFiles {
  const ts = opts.timestamp ?? Math.floor(Date.now() / 1000)
  const actionSchema = opts.actionSchema ?? 'reservewithgoogle.action.v2'

  return {
    entity: buildEntity(merchants, ts),
    action: buildAction(merchants, ts, actionSchema),
    glamService: buildGlamService(merchants, ts),
  }
}

// ── Entity feed ─────────────────────────────────────────────────────────────

function buildEntity(
  merchants: ReadonlyArray<RwgMerchant>,
  ts: number,
): { descriptor: object; data: object } {
  return {
    descriptor: {
      generation_timestamp: ts,
      name: 'reservewithgoogle.entity',
      data_file: [`0entity_${ts}.json`],
    },
    data: {
      data: merchants.map((m) => ({
        entity_id: m.entityId,
        name: m.name,
        telephone: m.telephone,
        url: m.url,
        location: {
          latitude: m.location.latitude,
          longitude: m.location.longitude,
          address: {
            country: m.location.address.country,
            locality: m.location.address.locality,
            region: m.location.address.region,
            postal_code: m.location.address.postalCode,
            street_address: m.location.address.streetAddress,
          },
        },
      })),
    },
  }
}

// ── Action feed ─────────────────────────────────────────────────────────────

function buildAction(
  merchants: ReadonlyArray<RwgMerchant>,
  ts: number,
  schema: string,
): { descriptor: object; data: object } {
  const data: Array<Record<string, unknown>> = []
  const appointmentInfo = [{ appointment_info: {} }]

  for (const m of merchants) {
    if (m.bookingUrl) {
      data.push({
        entity_id: m.entityId,
        link_id: `link-${m.entityId}`,
        url: m.bookingUrl,
        actions: appointmentInfo,
      })
      continue
    }
    const langUrls = m.perLanguageBookingUrls ?? []
    if (langUrls.length === 0) continue // no booking URL — skip from feed
    for (const { language, url } of langUrls) {
      data.push({
        entity_id: m.entityId,
        link_id: `link-${language}-${m.entityId}`,
        url,
        actions: appointmentInfo,
      })
    }
  }

  return {
    descriptor: {
      generation_timestamp: ts,
      name: schema,
      data_file: [`1action_${ts}.json`],
    },
    data: { data },
  }
}

// ── Glam service feed ────────────────────────────────────────────────────────

function buildGlamService(
  merchants: ReadonlyArray<RwgMerchant>,
  ts: number,
): { descriptor: object; data: object } {
  const data: Array<Record<string, unknown>> = []

  for (const m of merchants) {
    const services =
      m.services && m.services.length > 0
        ? m.services
        : [
            {
              serviceId: `service-${m.entityId}`,
              name: 'General',
              description: 'General booking',
            },
          ]

    const links: Array<{ language?: string; url: string }> = []
    if (m.bookingUrl) {
      links.push({ language: 'en', url: m.bookingUrl })
    } else if (m.perLanguageBookingUrls?.length) {
      for (const l of m.perLanguageBookingUrls) {
        links.push({ language: l.language, url: l.url })
      }
    }

    for (const svc of services) {
      // Google flags DUPLICATE_PROPERTY_VALUE when description echoes the
      // name verbatim. Guard on more than `undefined`: a defined
      // description that merely equals the name (case/whitespace
      // differences included) carries the same collision risk — that's
      // the actual shape of the 21 services Google flagged 2026-07-05
      // (operator typed the same string into both dashboard fields).
      // Fallback is 'General booking', not bare 'General' — the
      // zero-services default below already pairs those two, and
      // localized_service_category is hardcoded 'General'; a bare
      // 'General' fallback would just trade a name/description collision
      // for a description/category one.
      const trimmedDescription = svc.description?.trim()
      const isEchoOfName = trimmedDescription?.toLowerCase() === svc.name.trim().toLowerCase()
      const description = trimmedDescription && !isEchoOfName ? trimmedDescription : 'General booking'
      data.push({
        merchant_id: m.entityId,
        service_id: svc.serviceId,
        localized_service_name: {
          value: svc.name,
          localized_value: svc.localizedNames ?? [{ locale: 'en', value: svc.name }],
        },
        localized_service_category: {
          value: 'General',
          localized_value: [{ locale: 'en', value: 'General' }],
        },
        localized_service_description: {
          value: description,
          localized_value: svc.localizedDescriptions ?? [{ locale: 'en', value: description }],
        },
        service_duration: { duration_interpretation: 'INTERPRETATION_NOT_DISPLAYED' },
        service_price: { price_interpretation: 'INTERPRETATION_NOT_DISPLAYED' },
        action_link: links,
      })
    }
  }

  return {
    descriptor: {
      generation_timestamp: ts,
      name: 'glam.service.v0',
      data_file: [`2glam.service.v0_${ts}.json`],
    },
    data: { data },
  }
}

// ── Filename helpers ─────────────────────────────────────────────────────────

export function feedFilenames(ts: number): {
  entityDesc: string
  entity: string
  actionDesc: string
  action: string
  glamDesc: string
  glam: string
} {
  return {
    entityDesc: `0entity_${ts}.filesetdesc.json`,
    entity: `0entity_${ts}.json`,
    actionDesc: `1action_${ts}.filesetdesc.json`,
    action: `1action_${ts}.json`,
    glamDesc: `2glam.service.v0_${ts}.filesetdesc.json`,
    glam: `2glam.service.v0_${ts}.json`,
  }
}
