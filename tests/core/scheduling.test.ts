// Tier 1 (unit, pure function) — slot generator.
import { describe, expect, it } from 'vitest'
import { generateSlots, type BusyInterval, type WeeklySchedule } from '../../src/core/scheduling.js'

describe('generateSlots — basic', () => {
  it('produces slots for one open day with one window', () => {
    // 2026-06-01 is a Monday
    const schedule: WeeklySchedule = { mon: [{ start: '09:00', end: '11:00' }] }
    const slots = generateSlots({
      weeklySchedule: schedule,
      fromDate: '2026-06-01',
      toDate: '2026-06-01',
      slotDurationMinutes: 60,
    })
    expect(slots).toEqual([
      { date: '2026-06-01', time: '09:00' },
      { date: '2026-06-01', time: '10:00' },
    ])
  })

  it('respects slotDurationMinutes', () => {
    const schedule: WeeklySchedule = { mon: [{ start: '09:00', end: '10:00' }] }
    const slots = generateSlots({
      weeklySchedule: schedule,
      fromDate: '2026-06-01',
      toDate: '2026-06-01',
      slotDurationMinutes: 30,
    })
    expect(slots).toEqual([
      { date: '2026-06-01', time: '09:00' },
      { date: '2026-06-01', time: '09:30' },
    ])
  })

  it('respects paddingMinutes (start-to-start spacing = duration + padding)', () => {
    const schedule: WeeklySchedule = { mon: [{ start: '09:00', end: '12:00' }] }
    const slots = generateSlots({
      weeklySchedule: schedule,
      fromDate: '2026-06-01',
      toDate: '2026-06-01',
      slotDurationMinutes: 30,
      paddingMinutes: 30, // 60-min spacing total
    })
    // 09:00, 10:00, 11:00 — 11:30 doesn't fit (would need 30min until 12:00, OK)
    // Actually 11:00 + 30 = 11:30 ≤ 12:00 → fits
    expect(slots.map((s) => s.time)).toEqual(['09:00', '10:00', '11:00'])
  })
})

describe('generateSlots — multi-window (lunch break)', () => {
  it('produces slots for two windows in the same day with a gap', () => {
    const schedule: WeeklySchedule = {
      mon: [
        { start: '09:00', end: '12:00' },
        { start: '14:00', end: '17:00' },
      ],
    }
    const slots = generateSlots({
      weeklySchedule: schedule,
      fromDate: '2026-06-01',
      toDate: '2026-06-01',
      slotDurationMinutes: 60,
    })
    expect(slots.map((s) => s.time)).toEqual([
      '09:00',
      '10:00',
      '11:00',
      '14:00',
      '15:00',
      '16:00',
    ])
  })
})

describe('generateSlots — date range + closed days', () => {
  it('skips days without windows', () => {
    const schedule: WeeklySchedule = { mon: [{ start: '09:00', end: '10:00' }] }
    // Mon 2026-06-01, Tue 2026-06-02 (closed), Wed 2026-06-03 (closed)
    const slots = generateSlots({
      weeklySchedule: schedule,
      fromDate: '2026-06-01',
      toDate: '2026-06-03',
      slotDurationMinutes: 60,
    })
    expect(slots).toEqual([{ date: '2026-06-01', time: '09:00' }])
  })

  it('skips blackout dates', () => {
    const schedule: WeeklySchedule = {
      mon: [{ start: '09:00', end: '10:00' }],
      tue: [{ start: '09:00', end: '10:00' }],
    }
    const slots = generateSlots({
      weeklySchedule: schedule,
      fromDate: '2026-06-01',
      toDate: '2026-06-02',
      slotDurationMinutes: 60,
      blackoutDates: ['2026-06-02'],
    })
    expect(slots).toEqual([{ date: '2026-06-01', time: '09:00' }])
  })
})

describe('generateSlots — lead time', () => {
  it('respects minLeadMinutes', () => {
    const schedule: WeeklySchedule = { mon: [{ start: '09:00', end: '12:00' }] }
    // Set "now" to 2026-06-01 10:00 UTC, lead = 60min
    // → only slots at 11:00 onwards qualify (10:00 + 60min)
    const slots = generateSlots({
      weeklySchedule: schedule,
      fromDate: '2026-06-01',
      toDate: '2026-06-01',
      slotDurationMinutes: 60,
      minLeadMinutes: 60,
      now: new Date('2026-06-01T10:00:00Z'),
    })
    expect(slots.map((s) => s.time)).toEqual(['11:00'])
  })
})

describe('generateSlots — busy-event exclusion (kit #77)', () => {
  const schedule: WeeklySchedule = { mon: [{ start: '09:00', end: '12:00' }] }
  const baseOpts = {
    weeklySchedule: schedule,
    fromDate: '2026-06-01',
    toDate: '2026-06-01',
    slotDurationMinutes: 60,
  }

  it('excludes a slot that is exactly covered by a busy interval', () => {
    const busy: BusyInterval[] = [
      { date: '2026-06-01', startHhmm: '10:00', endHhmm: '11:00' },
    ]
    const slots = generateSlots({ ...baseOpts, busyIntervals: busy })
    expect(slots.map((s) => s.time)).toEqual(['09:00', '11:00'])
  })

  it('excludes a slot partially overlapped at the start', () => {
    // busy 09:30–10:30 overlaps both 09:00–10:00 and 10:00–11:00
    const busy: BusyInterval[] = [
      { date: '2026-06-01', startHhmm: '09:30', endHhmm: '10:30' },
    ]
    const slots = generateSlots({ ...baseOpts, busyIntervals: busy })
    expect(slots.map((s) => s.time)).toEqual(['11:00'])
  })

  it('excludes a slot that is completely contained within a busy interval', () => {
    // busy 08:00–12:00 covers everything
    const busy: BusyInterval[] = [
      { date: '2026-06-01', startHhmm: '08:00', endHhmm: '12:00' },
    ]
    const slots = generateSlots({ ...baseOpts, busyIntervals: busy })
    expect(slots).toEqual([])
  })

  it('keeps slots on other dates when busy interval only covers one date', () => {
    const schedule2: WeeklySchedule = {
      mon: [{ start: '09:00', end: '10:00' }],
      tue: [{ start: '09:00', end: '10:00' }],
    }
    const busy: BusyInterval[] = [
      { date: '2026-06-01', startHhmm: '09:00', endHhmm: '10:00' },
    ]
    const slots = generateSlots({
      weeklySchedule: schedule2,
      fromDate: '2026-06-01',
      toDate: '2026-06-02',
      slotDurationMinutes: 60,
      busyIntervals: busy,
    })
    // Mon blocked, Tue free
    expect(slots.map((s) => `${s.date}/${s.time}`)).toEqual(['2026-06-02/09:00'])
  })

  it('does not exclude a slot whose end touches a busy start (adjacent, not overlapping)', () => {
    // slot 09:00–10:00, busy 10:00–11:00 → no overlap (half-open intervals)
    const busy: BusyInterval[] = [
      { date: '2026-06-01', startHhmm: '10:00', endHhmm: '11:00' },
    ]
    const slots = generateSlots({
      ...baseOpts,
      weeklySchedule: { mon: [{ start: '09:00', end: '10:00' }] },
      busyIntervals: busy,
    })
    expect(slots.map((s) => s.time)).toEqual(['09:00'])
  })

  it('produces all slots when busyIntervals is empty', () => {
    const slots = generateSlots({ ...baseOpts, busyIntervals: [] })
    expect(slots.map((s) => s.time)).toEqual(['09:00', '10:00', '11:00'])
  })
})

describe('generateSlots — timezone-aware lead time (kit #79)', () => {
  const schedule: WeeklySchedule = { mon: [{ start: '09:00', end: '12:00' }] }

  it('adjusts lead-time comparison for UTC-5 business timezone', () => {
    // Business is in UTC-5 (timezoneOffsetMinutes = -300).
    // "now" = 2026-06-01T14:00:00Z = local 09:00 AM.
    // lead = 60 min → cutoff = 2026-06-01T15:00:00Z = local 10:00 AM.
    // Slot 09:00 local = UTC 14:00 → < cutoff → skip.
    // Slot 10:00 local = UTC 15:00 → ≥ cutoff → keep.
    // Slot 11:00 local = UTC 16:00 → keep.
    const slots = generateSlots({
      weeklySchedule: schedule,
      fromDate: '2026-06-01',
      toDate: '2026-06-01',
      slotDurationMinutes: 60,
      minLeadMinutes: 60,
      now: new Date('2026-06-01T14:00:00Z'),
      timezoneOffsetMinutes: -300,
    })
    expect(slots.map((s) => s.time)).toEqual(['10:00', '11:00'])
  })

  it('adjusts lead-time comparison for UTC+3 business timezone', () => {
    // Business is in UTC+3 (timezoneOffsetMinutes = 180).
    // "now" = 2026-06-01T06:00:00Z = local 09:00 AM.
    // lead = 60 min → cutoff = 2026-06-01T07:00:00Z = local 10:00 AM.
    // Slot 09:00 local = UTC 06:00 → < cutoff → skip.
    // Slot 10:00 local = UTC 07:00 → keep.
    // Slot 11:00 local = UTC 08:00 → keep.
    const slots = generateSlots({
      weeklySchedule: schedule,
      fromDate: '2026-06-01',
      toDate: '2026-06-01',
      slotDurationMinutes: 60,
      minLeadMinutes: 60,
      now: new Date('2026-06-01T06:00:00Z'),
      timezoneOffsetMinutes: 180,
    })
    expect(slots.map((s) => s.time)).toEqual(['10:00', '11:00'])
  })

  it('is backward-compatible: absent timezoneOffsetMinutes defaults to UTC (existing behaviour)', () => {
    // Identical to the existing lead-time test in the basic suite.
    const slots = generateSlots({
      weeklySchedule: schedule,
      fromDate: '2026-06-01',
      toDate: '2026-06-01',
      slotDurationMinutes: 60,
      minLeadMinutes: 60,
      now: new Date('2026-06-01T10:00:00Z'),
    })
    expect(slots.map((s) => s.time)).toEqual(['11:00'])
  })
})

describe('generateSlots — empty / edge', () => {
  it('returns empty when no windows defined for any day in range', () => {
    const slots = generateSlots({
      weeklySchedule: {},
      fromDate: '2026-06-01',
      toDate: '2026-06-07',
      slotDurationMinutes: 60,
    })
    expect(slots).toEqual([])
  })

  it('throws on invalid date format', () => {
    expect(() =>
      generateSlots({
        weeklySchedule: {},
        fromDate: 'not-a-date',
        toDate: '2026-06-01',
        slotDurationMinutes: 60,
      }),
    ).toThrow()
  })
})
