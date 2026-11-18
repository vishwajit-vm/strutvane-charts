/**
 * Reading a chart request: query string in, a typed plan (or every problem at once) out.
 *
 * Rules, in the order a request meets them:
 * - **Only known parameters:** `from`, `to`, `interval`, `groupBy`, `limit` and
 *   `filter[field][op]`, each at most once, at most {@link MAX_PARAMETERS} in total and
 *   {@link MAX_VALUE_LENGTH} characters each. Anything else is a 422, never silently ignored.
 * - **Names from allow-lists only:** `groupBy` must be one of the metric's options, a filter
 *   field one of its `filterable` fields. Field names never reach the query builder unchecked, and
 *   error messages list allowed names only (never hidden or secret columns).
 * - **Values parsed by column type**: numbers by kind, dates strictly (UTC, 1900–9998), enum values
 *   against the declared list, ids as whole numbers or UUIDs. Values are bound by the query builder,
 *   never written into SQL.
 * - **Ranges are aligned to whole buckets** (whole UTC days when not grouping by date), and a date
 *   grouping may have at most {@link MAX_BUCKETS} buckets.
 * - **Privacy:** a metric with `minGroupSize` refuses every filter (a filter is the simplest
 *   differencing attack: "count where department = legal" next to the total).
 *
 * @module
 */
import type { ValidationIssue } from '@strutvane/framework/contracts'
import {
  addBuckets,
  ceilToBucket,
  countBuckets,
  type Interval,
  isInterval,
  parseUtcDate,
  type RelativeRange,
  relativeWindow,
  startOfBucket,
} from '../shared/calendar.ts'
import { CHART_FILTER_OPERATORS, type ChartFilterOperator } from '../shared/contract.ts'
import type { MessageCatalog } from '../shared/messages.ts'
import type { ChartColumn } from './columns.ts'
import { MAX_LIMIT, type ResolvedGroup, type ResolvedMetric } from './metric.ts'
import { ChartsProblem, issue } from './problems.ts'

/** At most this many query parameters. */
export const MAX_PARAMETERS = 24
/** At most this many characters per parameter value. */
export const MAX_VALUE_LENGTH = 1000
/** At most this many date buckets in one result. */
export const MAX_BUCKETS = 400
/** At most this many values in one `in` filter. */
export const MAX_IN_VALUES = 50

/**
 * One filter, checked and converted to what the query builder binds.
 *
 * @example
 * const filter: PlannedFilter = { column: status, op: 'in', value: ['paid', 'sent'] }
 */
export interface PlannedFilter {
  readonly column: ChartColumn
  readonly op: ChartFilterOperator
  readonly value: unknown
}

/**
 * Everything the engine needs, all checked.
 *
 * @example
 * const plan = planRequest(metric, new URLSearchParams('interval=week'), new Date())
 */
export interface AggregatePlan {
  readonly metric: ResolvedMetric
  readonly group: ResolvedGroup | undefined
  readonly interval: Interval | undefined
  /** The date column `range` limits (the group's own column when grouping by a date). */
  readonly rangeColumn: ChartColumn | undefined
  readonly range: { readonly from: Date; readonly to: Date } | undefined
  readonly limit: number
  readonly filters: readonly PlannedFilter[]
}

const SIMPLE = new Set(['from', 'to', 'interval', 'groupBy', 'limit'])
const FILTER_KEY = /^filter\[([a-z_][a-z0-9_]{0,62})\]\[([A-Za-z]{1,16})\]$/
const DEFAULT_WINDOWS: Readonly<Record<Interval, RelativeRange>> = Object.freeze({
  day: { last: 30, unit: 'day' },
  week: { last: 12, unit: 'week' },
  month: { last: 12, unit: 'month' },
})

/**
 * Turn a request into a plan, or throw a 422 {@link ChartsProblem} listing every issue.
 *
 * @example
 * planRequest(resolveMetric(revenue), new URL(request.url).searchParams, new Date())
 */
export function planRequest(
  metric: ResolvedMetric,
  params: URLSearchParams,
  now: Date,
  catalog?: MessageCatalog,
): AggregatePlan {
  const issues: ValidationIssue[] = []
  const add = (field: string, key: string, values: Record<string, string | number> = {}): void => {
    issues.push(issue(field, key, values, catalog))
  }
  const single = new Map<string, string>()
  const rawFilters: { field: string; op: string; value: string; key: string }[] = []
  const seen = new Set<string>()
  let total = 0
  for (const [key, value] of params) {
    total += 1
    if (total > MAX_PARAMETERS) {
      add('query', 'charts.issue.too_many_parameters', { max: MAX_PARAMETERS })
      throw new ChartsProblem('validation_failed', issues)
    }
    const shown = key.length > 64 ? `${key.slice(0, 64)}…` : key
    if (seen.has(key)) {
      add(shown, 'charts.issue.repeated_parameter', { parameter: shown })
      continue
    }
    seen.add(key)
    if (value.length > MAX_VALUE_LENGTH) {
      add(shown, 'charts.issue.filter_value', { field: shown, op: '', reason: 'too long' })
      continue
    }
    if (SIMPLE.has(key)) {
      single.set(key, value)
      continue
    }
    const match = FILTER_KEY.exec(key)
    if (match === null) {
      add(shown, 'charts.issue.unknown_parameter', { parameter: shown })
      continue
    }
    rawFilters.push({ field: match[1] ?? '', op: match[2] ?? '', value, key })
  }

  // Grouping
  const groupParam = single.get('groupBy')
  let group: ResolvedGroup | undefined = metric.groups[0]
  if (groupParam !== undefined) {
    const chosen = metric.groups.find((option) => option.column.name === groupParam)
    if (chosen === undefined)
      add('groupBy', 'charts.issue.group_not_allowed', {
        allowed: metric.groups.map((option) => option.column.name).join(', ') || '(none)',
      })
    else group = chosen
  }

  // Interval
  const intervalParam = single.get('interval')
  let interval: Interval | undefined = group?.kind === 'date' ? group.interval : undefined
  if (intervalParam !== undefined) {
    if (group?.kind !== 'date')
      add('interval', 'charts.issue.interval_without_date', {
        groupBy: group?.column.name ?? '(nothing)',
      })
    else if (!isInterval(intervalParam) || !metric.intervals.includes(intervalParam))
      add('interval', 'charts.issue.interval_not_allowed', { allowed: metric.intervals.join(', ') })
    else interval = intervalParam
  }

  // Range
  const rangeColumn = group?.kind === 'date' ? group.column : metric.dateField
  const fromParam = single.get('from')
  const toParam = single.get('to')
  let range: AggregatePlan['range']
  if (rangeColumn === undefined) {
    if (fromParam !== undefined || toParam !== undefined)
      add(fromParam !== undefined ? 'from' : 'to', 'charts.issue.range_without_date')
  } else {
    const unit: Interval = interval ?? 'day'
    const window = metric.range ?? DEFAULT_WINDOWS[interval ?? 'month']
    const fallback = relativeWindow(window, now)
    const from = fromParam === undefined ? undefined : parseUtcDate(fromParam)
    const to = toParam === undefined ? undefined : parseUtcDate(toParam)
    if (fromParam !== undefined && from === undefined)
      add('from', 'charts.issue.invalid_date', { parameter: 'from' })
    if (toParam !== undefined && to === undefined)
      add('to', 'charts.issue.invalid_date', { parameter: 'to' })
    if (
      (fromParam === undefined || from !== undefined) &&
      (toParam === undefined || to !== undefined)
    ) {
      const end = ceilToBucket(to ?? fallback.to, unit)
      const start = startOfBucket(
        from ?? (to === undefined ? fallback.from : addBuckets(end, window.unit, -window.last)),
        unit,
      )
      if (start >= end) add('from', 'charts.issue.empty_range')
      else if (interval !== undefined) {
        const count = countBuckets(start, end, interval, MAX_BUCKETS)
        if (count > MAX_BUCKETS)
          add('from', 'charts.issue.too_many_buckets', {
            count: `more than ${MAX_BUCKETS}`,
            interval,
            max: MAX_BUCKETS,
          })
      }
      range = { from: start, to: end }
    }
  }

  // Top N
  const limitParam = single.get('limit')
  let limit = metric.limit
  if (limitParam !== undefined) {
    if (group?.kind !== 'relation') add('limit', 'charts.issue.limit_not_allowed')
    else if (
      !/^\d{1,2}$/.test(limitParam) ||
      Number(limitParam) < 1 ||
      Number(limitParam) > MAX_LIMIT
    )
      add('limit', 'charts.issue.limit_invalid', { max: MAX_LIMIT })
    else limit = Number(limitParam)
  }

  // Filters
  const filters: PlannedFilter[] = []
  if (rawFilters.length > 0 && metric.minGroupSize !== undefined)
    add('filter', 'charts.issue.filter_with_privacy')
  else {
    for (const raw of rawFilters) {
      const column = metric.filterable.get(raw.field)
      if (column === undefined) {
        if (metric.filterable.size === 0) add(raw.key, 'charts.issue.filter_not_allowed_none')
        else
          add(raw.key, 'charts.issue.filter_not_allowed', {
            field: raw.field,
            allowed: [...metric.filterable.keys()].join(', '),
          })
        continue
      }
      if (!(CHART_FILTER_OPERATORS as readonly string[]).includes(raw.op)) {
        add(raw.key, 'charts.issue.filter_operator', { op: raw.op.slice(0, 16) })
        continue
      }
      const op = raw.op as ChartFilterOperator
      const parsed = parseFilterValue(column, op, raw.value)
      if (isParseError(parsed)) {
        add(raw.key, 'charts.issue.filter_value', { field: raw.field, op, reason: parsed.error })
        continue
      }
      filters.push({ column, op, value: parsed })
    }
  }

  if (issues.length > 0) throw new ChartsProblem('validation_failed', issues)
  return { metric, group, interval, rangeColumn, range, limit, filters }
}

interface ParseError {
  readonly error: string
}

const INTEGER = /^-?\d{1,15}$/
const DECIMAL = /^-?\d{1,18}(\.\d{1,10})?$/
const DOUBLE = /^-?\d{1,18}(\.\d{1,18})?([eE][+-]?\d{1,3})?$/
const ID =
  /^(\d{1,15}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/

/** One filter value, converted for the builder, or why it is invalid. */
function parseFilterValue(column: ChartColumn, op: ChartFilterOperator, raw: string): unknown {
  if (op === 'null') {
    if (raw === 'true') return true
    if (raw === 'false') return false
    return { error: 'use true (is empty) or false (is not empty)' } satisfies ParseError
  }
  const ordered = column.role === 'numeric' || column.role === 'date'
  if ((op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte') && !ordered)
    return { error: `${op} only applies to numbers and dates` } satisfies ParseError
  if (op === 'in') {
    const parts = raw.split(',')
    if (raw === '' || parts.length > MAX_IN_VALUES)
      return { error: `give 1 to ${MAX_IN_VALUES} comma-separated values` } satisfies ParseError
    const values: unknown[] = []
    for (const part of parts) {
      const value = parseScalar(column, part)
      if (isParseError(value)) return value
      values.push(value)
    }
    return values
  }
  return parseScalar(column, raw)
}

function parseScalar(column: ChartColumn, raw: string): unknown {
  switch (column.role) {
    case 'numeric':
      if (column.kind === 'decimal')
        return DECIMAL.test(raw)
          ? raw
          : ({ error: 'expected a decimal number' } satisfies ParseError)
      if (column.kind === 'double')
        return DOUBLE.test(raw) && Number.isFinite(Number(raw))
          ? Number(raw)
          : ({ error: 'expected a number' } satisfies ParseError)
      return INTEGER.test(raw)
        ? Number(raw)
        : ({ error: 'expected a whole number' } satisfies ParseError)
    case 'date': {
      const date = parseUtcDate(raw)
      if (date === undefined)
        return {
          error: 'expected a UTC date (YYYY-MM-DD) or timestamp ending in Z',
        } satisfies ParseError
      return column.kind === 'date' ? raw.slice(0, 10) : date
    }
    case 'category':
      if (column.kind === 'boolean') {
        if (raw === 'true') return true
        if (raw === 'false') return false
        return { error: 'expected true or false' } satisfies ParseError
      }
      return column.values.includes(raw)
        ? raw
        : ({ error: `expected one of ${column.values.join(', ')}` } satisfies ParseError)
    case 'relation':
      return ID.test(raw)
        ? /^\d+$/.test(raw)
          ? Number(raw)
          : raw.toLowerCase()
        : ({ error: 'expected a record id' } satisfies ParseError)
  }
}

function isParseError(value: unknown): value is ParseError {
  return typeof value === 'object' && value !== null && 'error' in value
}
