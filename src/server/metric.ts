/**
 * Server-side metrics: the only things the aggregate endpoint computes.
 *
 * ```ts
 * export const revenue = defineMetric({
 *   name: 'invoices.revenue',
 *   label: 'Revenue',
 *   model: Invoice,
 *   aggregate: { fn: 'sum', field: 'total' },
 *   groupBy: { field: 'issued_on', interval: 'month' },
 *   range: { last: 12, unit: 'month' },
 * })
 * ```
 *
 * A metric fixes **what** is computed (the function, the field, the possible groupings, the
 * filterable fields, the privacy floor); a request may only pick among those options. That is why
 * the browser can never aggregate a column nobody declared.
 *
 * Checking happens in two steps, because model metadata (the schema snapshot) only exists once the
 * app has booted:
 * 1. {@link defineMetric}, at import: the shape (names, functions, numbers), so typos fail at once.
 * 2. {@link resolveMetric}, at boot (the provider calls it for every metric) or on first use:
 *    every field against the model's chart columns (`columns.ts`). A failure is a
 *    {@link ChartsDefinitionError}, which fails the boot: a misconfigured chart never half-works.
 *
 * @module
 */

import type { ModelBase } from '@strutvane/framework/database'
import { type Interval, isInterval, type RelativeRange } from '../shared/calendar.ts'
import { type AggregateFn, type GroupKind, isValidName } from '../shared/contract.ts'
import { ChartsDefinitionError } from '../shared/widgets.ts'
import { asModel, type ChartColumn, type ChartModel, chartColumns } from './columns.ts'

/**
 * What to aggregate: `'count'` (rows), or a function over a numeric field.
 *
 * @example
 * const sum: MetricAggregate = { fn: 'sum', field: 'total' }
 */
export type MetricAggregate =
  | 'count'
  | { readonly fn: Exclude<AggregateFn, 'count'>; readonly field: string }

/**
 * One way to group: a field name, or a date field with its default interval.
 *
 * @example
 * const monthly: GroupOption = { field: 'issued_on', interval: 'month' }
 */
export type GroupOption = string | { readonly field: string; readonly interval?: Interval }

/**
 * Small-group suppression: groups computed from fewer than `minGroupSize` rows are hidden
 * (with complementary suppression, so totals can't recover them). Turn it on for anything about
 * people: salaries, ages, health, performance.
 *
 * @example
 * const privacy: MetricPrivacy = { minGroupSize: 5 }
 */
export interface MetricPrivacy {
  readonly minGroupSize: number
}

/**
 * A metric as the app writes it.
 *
 * @example
 * defineMetric({ name: 'invoices.count', model: Invoice, aggregate: 'count' })
 */
export interface MetricDefinition {
  /** Unique name, used in the URL: dot-separated lowercase words, e.g. `invoices.revenue`. */
  readonly name: string
  /** Human label (default: the name). */
  readonly label?: string
  /** The model whose rows are aggregated. All reads go through its query builder. */
  readonly model: ChartModel
  /**
   * The permission resource checked for `viewAny` and used for the row filter, e.g. `invoices`
   * checks `invoices.viewAny`. Default: the model's table.
   */
  readonly permission?: string
  readonly aggregate: MetricAggregate
  /**
   * How results may be grouped. The first option is the default; a request may pick another
   * with `?groupBy=`. Omit for a single number.
   */
  readonly groupBy?: GroupOption | readonly GroupOption[]
  /** A second dimension (stacked or grouped bars): an enum or boolean field. */
  readonly splitBy?: string
  /**
   * The date field that `from`/`to` limit (when not grouping by a date). Default: `created_at`
   * when the table has it. When grouping by a date field, the range always applies to that field.
   */
  readonly dateField?: string | false
  /** The default window when a request gives no range. Default: depends on the interval. */
  readonly range?: RelativeRange
  /** Intervals a request may choose for date groups. Default: day, week and month. */
  readonly intervals?: readonly Interval[]
  /** Fields a request may filter on (`filter[field][op]=value`). Default: none. */
  readonly filterable?: readonly string[]
  /** Top N for relation groups (1–50). Default 10. */
  readonly limit?: number
  /** Hide small groups. Default: off. */
  readonly privacy?: MetricPrivacy | false
  /** Cache results for this many seconds (per tenant, actor and request). Default: the app's setting. */
  readonly cacheTtl?: number
}

/** A grouping, resolved against the model. */
export interface ResolvedGroup {
  readonly column: ChartColumn
  readonly kind: Exclude<GroupKind, 'none'>
  /** The default interval of a date group. */
  readonly interval: Interval | undefined
}

/**
 * A metric checked against its model: every name is a real, usable column.
 *
 * @example
 * const resolved = resolveMetric(revenue)
 */
export interface ResolvedMetric {
  readonly name: string
  readonly label: string
  readonly model: typeof ModelBase
  readonly permission: string
  readonly fn: AggregateFn
  readonly field: ChartColumn | undefined
  readonly groups: readonly ResolvedGroup[]
  readonly splitBy: ChartColumn | undefined
  readonly dateField: ChartColumn | undefined
  readonly range: RelativeRange | undefined
  readonly intervals: readonly Interval[]
  readonly filterable: ReadonlyMap<string, ChartColumn>
  readonly limit: number
  readonly minGroupSize: number | undefined
  readonly cacheTtl: number | undefined
}

/**
 * A defined metric: the definition (frozen) plus its lazily resolved form.
 *
 * @example
 * const metric: Metric = defineMetric({ name: 'invoices.count', model: Invoice, aggregate: 'count' })
 */
export interface Metric {
  readonly definition: MetricDefinition
  readonly name: string
}

/** The most groups a top N may keep. */
export const MAX_LIMIT = 50
/** The default top N. */
export const DEFAULT_LIMIT = 10
const DEFAULT_INTERVALS: readonly Interval[] = Object.freeze(['day', 'week', 'month'])
const MAX_GROUP_SIZE = 1000
const MAX_CACHE_TTL = 86_400
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/

/**
 * Check the shape of a metric and freeze it. Field names are checked against the model later
 * ({@link resolveMetric}), once the schema is registered.
 *
 * @throws ChartsDefinitionError naming the problem and the fix.
 *
 * @example
 * export const perMonth = defineMetric({ name: 'invoices.per-month', model: Invoice, aggregate: 'count', groupBy: { field: 'created_at', interval: 'month' } })
 */
export function defineMetric(definition: MetricDefinition): Metric {
  const where = `Metric "${String(definition.name)}"`
  if (typeof definition.name !== 'string' || !isValidName(definition.name))
    fail(`${where}: the name must be dot-separated lowercase words, e.g. "invoices.revenue".`)
  asModelOrFail(where, definition.model)
  const agg = definition.aggregate
  if (agg !== 'count') {
    if (typeof agg !== 'object' || agg === null || !['sum', 'avg', 'min', 'max'].includes(agg.fn))
      fail(`${where}: aggregate must be 'count' or { fn: 'sum' | 'avg' | 'min' | 'max', field }.`)
    checkIdentifier(where, 'aggregate.field', agg.field)
  }
  for (const option of groupOptions(definition)) {
    checkIdentifier(where, 'groupBy', option.field)
    if (option.interval !== undefined && !isInterval(option.interval))
      fail(`${where}: groupBy interval must be day, week or month.`)
  }
  if (definition.splitBy !== undefined) checkIdentifier(where, 'splitBy', definition.splitBy)
  if (typeof definition.dateField === 'string')
    checkIdentifier(where, 'dateField', definition.dateField)
  for (const field of definition.filterable ?? []) checkIdentifier(where, 'filterable', field)
  if (definition.permission !== undefined && !/^[A-Za-z][\w-]{0,63}$/.test(definition.permission))
    fail(`${where}: permission must be a resource name such as "invoices".`)
  if (definition.intervals !== undefined) {
    if (definition.intervals.length === 0 || !definition.intervals.every(isInterval))
      fail(`${where}: intervals must list at least one of day, week and month.`)
  }
  if (definition.range !== undefined) {
    const { last, unit } = definition.range
    if (!Number.isInteger(last) || last < 1 || last > 400 || !isInterval(unit))
      fail(`${where}: range must be { last: 1..400, unit: 'day' | 'week' | 'month' }.`)
  }
  if (definition.limit !== undefined && !isWhole(definition.limit, 1, MAX_LIMIT))
    fail(`${where}: limit must be a whole number from 1 to ${MAX_LIMIT}.`)
  if (definition.cacheTtl !== undefined && !isWhole(definition.cacheTtl, 0, MAX_CACHE_TTL))
    fail(`${where}: cacheTtl must be whole seconds from 0 to ${MAX_CACHE_TTL}.`)
  const privacy = definition.privacy
  if (privacy !== undefined && privacy !== false) {
    if (!isWhole(privacy.minGroupSize, 2, MAX_GROUP_SIZE))
      fail(`${where}: privacy.minGroupSize must be a whole number from 2 to ${MAX_GROUP_SIZE}.`)
    if (agg !== 'count' && (agg.fn === 'min' || agg.fn === 'max'))
      fail(
        `${where}: ${agg.fn} returns one row's exact value, which defeats privacy. Use count, sum or avg, or turn privacy off.`,
      )
    if ((definition.filterable ?? []).length > 0)
      fail(
        `${where}: a metric with privacy can't be filterable: a filter can single out one person (a differencing attack). Remove filterable, or make a separate metric per segment.`,
      )
  }
  return Object.freeze({ definition: Object.freeze({ ...definition }), name: definition.name })
}

const resolvedCache = new WeakMap<Metric, ResolvedMetric>()

/**
 * Check a metric against its model and return the resolved form (cached per metric). Call it
 * after the schema snapshot is registered (the provider does, at boot).
 *
 * @throws ChartsDefinitionError when a field is unknown or can't play its role; the message lists
 *   only the usable columns (never hidden or secret ones).
 *
 * @example
 * const resolved = resolveMetric(revenue)
 * resolved.field?.name // 'total'
 */
export function resolveMetric(metric: Metric): ResolvedMetric {
  const cached = resolvedCache.get(metric)
  if (cached !== undefined) return cached
  const definition = metric.definition
  const where = `Metric "${metric.name}"`
  const model = asModel(definition.model)
  const columns = chartColumns(model)
  const pick = (field: string, roles: readonly string[], what: string): ChartColumn => {
    const column = columns.get(field)
    if (column === undefined || !roles.includes(column.role)) {
      const allowed = [...columns.values()].filter((c) => roles.includes(c.role)).map((c) => c.name)
      fail(
        `${where}: ${what} "${field}" is not a usable ${roles.join(' or ')} column of ${model.table}. ` +
          (allowed.length > 0 ? `Usable: ${allowed.join(', ')}.` : 'This table has none.') +
          ' Hidden, secret, id and tenant columns are never usable.',
      )
    }
    return column
  }
  const agg = definition.aggregate
  const field = agg === 'count' ? undefined : pick(agg.field, ['numeric'], `aggregate.field`)
  const groups: ResolvedGroup[] = groupOptions(definition).map((option) => {
    const column = pick(option.field, ['date', 'category', 'relation'], 'groupBy')
    const kind =
      column.role === 'date' ? 'date' : column.role === 'category' ? 'category' : 'relation'
    if (kind !== 'date' && option.interval !== undefined)
      fail(`${where}: groupBy "${option.field}" is not a date, so it takes no interval.`)
    return { column, kind, interval: kind === 'date' ? (option.interval ?? 'month') : undefined }
  })
  const fieldsSeen = new Set<string>()
  for (const group of groups) {
    if (fieldsSeen.has(group.column.name))
      fail(`${where}: groupBy lists "${group.column.name}" twice.`)
    fieldsSeen.add(group.column.name)
  }
  const splitBy =
    definition.splitBy === undefined ? undefined : pick(definition.splitBy, ['category'], 'splitBy')
  if (splitBy !== undefined && groups.some((group) => group.column.name === splitBy.name))
    fail(
      `${where}: splitBy "${splitBy.name}" is also a groupBy option; split by a different field.`,
    )
  const dateField =
    definition.dateField === false
      ? undefined
      : typeof definition.dateField === 'string'
        ? pick(definition.dateField, ['date'], 'dateField')
        : columns.get('created_at')?.role === 'date'
          ? columns.get('created_at')
          : undefined
  const filterable = new Map<string, ChartColumn>()
  for (const name of definition.filterable ?? [])
    filterable.set(
      name,
      pick(name, ['numeric', 'date', 'category', 'relation'], 'filterable field'),
    )
  const intervals = definition.intervals ?? DEFAULT_INTERVALS
  for (const group of groups) {
    if (group.interval !== undefined && !intervals.includes(group.interval))
      fail(
        `${where}: the default interval "${group.interval}" of "${group.column.name}" is not in intervals.`,
      )
  }
  const resolved: ResolvedMetric = Object.freeze({
    name: metric.name,
    label: definition.label ?? metric.name,
    model,
    permission: definition.permission ?? model.table,
    fn: agg === 'count' ? 'count' : agg.fn,
    field,
    groups,
    splitBy,
    dateField,
    range: definition.range,
    intervals,
    filterable,
    limit: definition.limit ?? DEFAULT_LIMIT,
    minGroupSize:
      definition.privacy === undefined || definition.privacy === false
        ? undefined
        : definition.privacy.minGroupSize,
    cacheTtl: definition.cacheTtl,
  })
  resolvedCache.set(metric, resolved)
  return resolved
}

/** The groupBy options of a definition, normalised to objects. */
function groupOptions(
  definition: MetricDefinition,
): { readonly field: string; readonly interval?: Interval }[] {
  const raw = definition.groupBy
  if (raw === undefined) return []
  const list: readonly GroupOption[] = Array.isArray(raw) ? raw : [raw as GroupOption]
  return list.map((option) => (typeof option === 'string' ? { field: option } : option))
}

function asModelOrFail(where: string, model: ChartModel): void {
  try {
    asModel(model)
  } catch (error) {
    fail(`${where}: ${(error as Error).message}`)
  }
}

function checkIdentifier(where: string, what: string, value: unknown): void {
  if (typeof value !== 'string' || !IDENTIFIER.test(value))
    fail(
      `${where}: ${what} must be a column name (lowercase letters, digits and _), got ${JSON.stringify(value)}.`,
    )
}

function isWhole(value: unknown, min: number, max: number): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
}

function fail(message: string): never {
  throw new ChartsDefinitionError(message)
}
