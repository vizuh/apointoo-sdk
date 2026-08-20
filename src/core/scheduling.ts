// Slot generator. Pure function — no IO, no side effects.
// Used when the vendor doesn't expose real-time availability (memory adapter,
// OpenDental until live, sandbox tests). Production with BLVD prefers the
// vendor's `cartBookableTimes` for accuracy.

import type { TimeWindow } from './schemas.js'

export type DayOfWeek = 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat'

export type WeeklySchedule = Partial<Record<DayOfWeek, ReadonlyArray<TimeWindow>>>

export type GeneratedSlot = {
  /** YYYY-MM-DD in the supplied timezone. */
  date: string
  /** HH:MM in 24h format. */
  time: string
  /** ISO 8601 — for ergonomics; equals new Date(`${date}T${time}:00${tzOffset}`). */
  iso?: string
}

/**
 * A calendar event that blocks one or more slots on a specific date.
 * Used by `busyIntervals` to exclude already-booked time.
 *
 * Interval is half-open: [startHhmm, endHhmm).
 * Examples:
 *   { date: '2026-06-01', startHhmm: '10:00', endHhmm: '11:00' }
 *   → blocks the 10:00 slot for a 60-min service (slot occupies 10:00–11:00).
 */
export type BusyInterval = {
  /** YYYY-MM-DD — must match the same date format used for fromDate/toDate. */
  date: string
  /** HH:MM 24h start of the busy window. */
  startHhmm: string
  /** HH:MM 24h end of the busy window (exclusive). */
  endHhmm: string
}

export type GenerateSlotsOptions = {
  /** Per-day open windows. Day with no windows = closed. */
  weeklySchedule: WeeklySchedule
  /** YYYY-MM-DD inclusive. */
  fromDate: string
  /** YYYY-MM-DD inclusive. */
  toDate: string
  /** Slot length in minutes. e.g. 60 for 1h appointments. */
  slotDurationMinutes: number
  /** Padding minutes BETWEEN slots (start-to-start spacing = duration + padding). */
  paddingMinutes?: number
  /** YYYY-MM-DD dates to skip entirely (holidays). */
  blackoutDates?: ReadonlyArray<string>
  /**
   * Already-booked or blocked intervals. A candidate slot is excluded when it
   * overlaps any interval on the same date.
   *
   * Overlap test (half-open intervals):
   *   slotStart < busyEnd && slotEnd > busyStart
   *
   * Callers should source these from the booking state store for the given
   * date range. See kit #77.
   */
  busyIntervals?: ReadonlyArray<BusyInterval>
  /** Optional minimum lead time in minutes from `now`. Slots earlier than now+lead skipped. */
  minLeadMinutes?: number
  /** Reference "now" for lead-time math. Defaults to new Date(). */
  now?: Date
  /**
   * UTC offset of the business timezone in minutes.
   * Positive = east of UTC (UTC+X), negative = west (UTC-X).
   * Examples: UTC+1 → 60, UTC-5 → -300.
   *
   * Used to convert the local slot time to UTC for lead-time comparison.
   * When absent the lead-time check uses UTC arithmetic (same as prior behaviour).
   * Does NOT affect date or time strings in the output — those are always the
   * local YYYY-MM-DD / HH:MM the caller passed in. See kit #79.
   */
  timezoneOffsetMinutes?: number
}

const DAYS: ReadonlyArray<DayOfWeek> = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

/**
 * Enumerate available slots in a date range from a weekly schedule.
 * Output is deterministic, sorted by (date, time).
 */
export function generateSlots(opts: GenerateSlotsOptions): GeneratedSlot[] {
  const padding = opts.paddingMinutes ?? 0
  const stepMinutes = opts.slotDurationMinutes + padding
  const blackouts = new Set(opts.blackoutDates ?? [])
  const tzOffsetMs = (opts.timezoneOffsetMinutes ?? 0) * 60_000
  const out: GeneratedSlot[] = []

  const fromMs = parseIsoDate(opts.fromDate)
  const toMs = parseIsoDate(opts.toDate)
  const leadCutoffMs =
    opts.minLeadMinutes !== undefined
      ? (opts.now ?? new Date()).getTime() + opts.minLeadMinutes * 60_000
      : 0

  // Pre-index busy intervals by date for O(1) lookup per day.
  const busyByDate = new Map<string, Array<{ startMin: number; endMin: number }>>()
  for (const b of opts.busyIntervals ?? []) {
    const entry = busyByDate.get(b.date)
    const interval = {
      startMin: hhmmToMinutes(b.startHhmm),
      endMin: hhmmToMinutes(b.endHhmm),
    }
    if (entry) {
      entry.push(interval)
    } else {
      busyByDate.set(b.date, [interval])
    }
  }

  for (let cursor = fromMs; cursor <= toMs; cursor += 86_400_000) {
    const dateStr = msToIsoDate(cursor)
    if (blackouts.has(dateStr)) continue

    const dow = DAYS[new Date(cursor).getUTCDay()]
    if (!dow) continue
    const windows = opts.weeklySchedule[dow]
    if (!windows || windows.length === 0) continue

    const busyOnDay = busyByDate.get(dateStr)

    for (const w of windows) {
      const startMin = hhmmToMinutes(w.start)
      const endMin = hhmmToMinutes(w.end)
      for (let t = startMin; t + opts.slotDurationMinutes <= endMin; t += stepMinutes) {
        // kit #79: convert local slot time to UTC for lead-time comparison.
        // cursor is UTC midnight; subtracting tzOffsetMs gives local midnight in UTC,
        // then adding t*60_000 gives the slot's UTC wall-clock time.
        if (leadCutoffMs > 0) {
          const slotMs = cursor - tzOffsetMs + t * 60_000
          if (slotMs < leadCutoffMs) continue
        }

        // kit #77: exclude slots that overlap any busy interval on this day.
        // Overlap test (half-open [start, end)): slotStart < busyEnd && slotEnd > busyStart.
        if (busyOnDay !== undefined) {
          const slotEnd = t + opts.slotDurationMinutes
          const overlaps = busyOnDay.some((b) => t < b.endMin && slotEnd > b.startMin)
          if (overlaps) continue
        }

        out.push({ date: dateStr, time: minutesToHhmm(t) })
      }
    }
  }

  return out
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseIsoDate(d: string): number {
  // YYYY-MM-DD parsed as UTC midnight to keep day arithmetic stable across DST.
  const [y, m, day] = d.split('-').map(Number)
  if (!y || !m || !day) throw new Error(`Invalid ISO date: ${d}`)
  return Date.UTC(y, m - 1, day)
}

function msToIsoDate(ms: number): string {
  const d = new Date(ms)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function hhmmToMinutes(s: string): number {
  const [h, m] = s.split(':').map(Number)
  return (h ?? 0) * 60 + (m ?? 0)
}

function minutesToHhmm(min: number): string {
  const h = Math.floor(min / 60)
  const m = min % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}
