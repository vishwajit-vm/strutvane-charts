/**
 * UTC calendar math for date buckets, done in JavaScript so the result is the same on every
 * engine (spike 16 found three engine-specific traps: PostgreSQL's session time zone, three
 * different "start of week" rules, and `NULL` ordering).
 *
 * Every bucket is keyed by its first day, `YYYY-MM-DD`, in UTC. Weeks start on Monday (ISO 8601).
 * Ranges are half-open, `[from, to)`, and always aligned to whole buckets, so the first and last
 * bar of a chart never silently cover a partial period.
 *
 * Browser-safe: no Node imports.
 *
 * @module
 */

/**
 * Date bucket size. Weeks start on Monday (ISO 8601).
 *
 * @example
 * const interval: Interval = 'month'
 */
export type Interval = 'day' | 'week' | 'month'

/** Every interval, smallest first. */
export const INTERVALS: readonly Interval[] = Object.freeze(['day', 'week', 'month'])

const DAY_MS = 86_400_000
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?Z$/

/**
 * Supported years. Outside them `Date.UTC` maps `0001` to `1901`, and `9999-12-31` aligned
 * forward prints as `+010000-01-01`, which no engine parses (spike 16, finding 5).
 */
export const YEAR_RANGE: { readonly min: number; readonly max: number } = Object.freeze({
  min: 1900,
  max: 9998,
})

/**
 * Is `value` one of the {@link INTERVALS}?
 *
 * @example
 * isInterval('week') // true
 */
export function isInterval(value: unknown): value is Interval {
  return value === 'day' || value === 'week' || value === 'month'
}

/**
 * Parse a range bound: `YYYY-MM-DD` (UTC midnight) or a UTC timestamp ending in `Z`, years
 * 1900–9998. Anything else (offsets, `2026-02-30`, `1e9`) is `undefined`.
 *
 * Why so strict: `new Date('2026-02-30')` rolls over to March and `new Date('1')` is the year
 * 2001. A range that means something other than it says is worse than a 422.
 *
 * @example
 * parseUtcDate('2026-11-14') // 2026-11-14T00:00:00.000Z
 * parseUtcDate('2026-02-30') // undefined
 */
export function parseUtcDate(value: string): Date | undefined {
  if (value.length > 24) return undefined
  const match = DATE_ONLY.exec(value) ?? DATE_TIME.exec(value)
  if (match === null) return undefined
  const year = Number(match[1])
  if (year < YEAR_RANGE.min || year > YEAR_RANGE.max) return undefined
  const date = new Date(value.length === 10 ? `${value}T00:00:00.000Z` : value)
  if (Number.isNaN(date.getTime())) return undefined
  // Round-trip the calendar part: rejects 2026-02-30 and 2026-13-01, which Date would "fix".
  return date.toISOString().slice(0, 10) === value.slice(0, 10) ? date : undefined
}

/**
 * The start of the bucket a moment falls in (UTC).
 *
 * @example
 * startOfBucket(new Date('2026-11-14T15:00:00Z'), 'week') // 2026-11-09, a Monday
 */
export function startOfBucket(date: Date, interval: Interval): Date {
  const day = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  if (interval === 'day') return new Date(day)
  if (interval === 'month') return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1))
  // getUTCDay: Sunday = 0. Days since Monday: Monday 0 … Sunday 6.
  const sinceMonday = (new Date(day).getUTCDay() + 6) % 7
  return new Date(day - sinceMonday * DAY_MS)
}

/**
 * Move by whole buckets (negative moves back). Months are calendar months, not 30 days; the
 * date must already be a bucket start for `month` (the 1st), which every caller guarantees.
 *
 * @example
 * addBuckets(new Date('2026-01-01T00:00:00Z'), 'month', 2) // 2026-03-01
 */
export function addBuckets(date: Date, interval: Interval, count: number): Date {
  if (interval === 'month')
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + count, date.getUTCDate()))
  return new Date(date.getTime() + count * (interval === 'week' ? 7 : 1) * DAY_MS)
}

/**
 * The first bucket boundary at or after a moment, so a range always ends on a whole bucket.
 *
 * @example
 * ceilToBucket(new Date('2026-11-14T10:00:00Z'), 'day') // 2026-11-15
 */
export function ceilToBucket(date: Date, interval: Interval): Date {
  const start = startOfBucket(date, interval)
  return start.getTime() === date.getTime() ? start : addBuckets(start, interval, 1)
}

/**
 * How many buckets fit in `[from, to)` (both aligned). Counting stops at `limit + 1`, so a
 * hostile range of thousands of years costs nothing to refuse.
 *
 * @example
 * countBuckets(new Date('2026-01-01Z'), new Date('2027-01-01Z'), 'month', 400) // 12
 */
export function countBuckets(from: Date, to: Date, interval: Interval, limit: number): number {
  let count = 0
  for (let at = from; at < to && count <= limit; at = addBuckets(at, interval, 1)) count += 1
  return count
}

/**
 * Every bucket key in `[from, to)`: empty buckets still get a key, so a quiet day shows as 0
 * instead of vanishing from the line.
 *
 * @example
 * bucketKeys(new Date('2026-11-01Z'), new Date('2026-11-04Z'), 'day') // ['2026-11-01', '2026-11-02', '2026-11-03']
 */
export function bucketKeys(from: Date, to: Date, interval: Interval): string[] {
  const keys: string[] = []
  for (let at = from; at < to; at = addBuckets(at, interval, 1)) keys.push(dateKey(at))
  return keys
}

/**
 * The `YYYY-MM-DD` key of a UTC date.
 *
 * @example
 * dateKey(new Date('2026-11-14T23:59:59Z')) // '2026-11-14'
 */
export function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/**
 * A relative window: "the last N whole units, including the current one".
 *
 * @example
 * const range: RelativeRange = { last: 12, unit: 'month' }
 */
export interface RelativeRange {
  readonly last: number
  readonly unit: Interval
}

/**
 * The aligned `[from, to)` of a relative window ending with the bucket that contains `now`.
 *
 * @example
 * relativeWindow({ last: 3, unit: 'month' }, new Date('2026-11-14T10:00:00Z'))
 * // { from: 2026-09-01, to: 2026-12-01 }
 */
export function relativeWindow(
  range: RelativeRange,
  now: Date,
): { readonly from: Date; readonly to: Date } {
  const to = addBuckets(startOfBucket(now, range.unit), range.unit, 1)
  return { from: addBuckets(to, range.unit, -range.last), to }
}

/**
 * The window of the same length just before `[from, to)`, for "compared with the previous
 * period". Months move by calendar months when both ends are month starts.
 *
 * @example
 * previousWindow(new Date('2026-11-01Z'), new Date('2026-12-01Z'))
 * // { from: 2026-10-01, to: 2026-11-01 }
 */
export function previousWindow(from: Date, to: Date): { readonly from: Date; readonly to: Date } {
  const monthAligned =
    from.getUTCDate() === 1 &&
    to.getUTCDate() === 1 &&
    from.getTime() === startOfBucket(from, 'month').getTime() &&
    to.getTime() === startOfBucket(to, 'month').getTime()
  if (monthAligned) {
    const months =
      (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth())
    return { from: addBuckets(from, 'month', -months), to: from }
  }
  return { from: new Date(from.getTime() - (to.getTime() - from.getTime())), to: from }
}
