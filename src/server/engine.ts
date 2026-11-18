/**
 * The aggregate engine: a checked plan in, a {@link MetricResult} out.
 *
 * **Every read goes through the framework's query builder** (`Model.query()`), so the framework's
 * own guarantees apply unchanged, with no SQL written here:
 * - the tenant scope (ADR-0007: a top-level `tenant_id = <active tenant>` the ORM checks before it
 *   renders, and PostgreSQL RLS as the second layer), soft deletes and the model's global scopes;
 * - the row filter of the actor's `viewAny` permission, bound with `wherePolicy` (ADR-0008:
 *   two-valued, NULL-safe), so a chart never counts a row the list screen would not show;
 * - request filters through `filter()`, which checks names against the schema and binds values.
 *
 * The 0.2 query builder has no `GROUP BY`, so grouping happens here, in JavaScript, over the rows
 * the builder returns: bounded by the date range (pushed down to SQL), and by `maxRows`
 * (default {@link DEFAULT_MAX_ROWS}); a larger result is refused with a 422 that says to narrow
 * the range, never truncated silently. Ungrouped counts use the builder's `count()` and scale to
 * any table. Doing the bucketing in JavaScript also makes every engine agree by construction
 * (spike 16's findings 1–3: time zones, week starts, NULL ordering). When the framework gains
 * aggregate push-down, only this file changes.
 *
 * @module
 */
import type { Actor, QueryFilter } from '@strutvane/framework/contracts'
import type { ModelBase } from '@strutvane/framework/database'
import { bucketKeys, dateKey, startOfBucket } from '../shared/calendar.ts'
import {
  type MetricPoint,
  type MetricResult,
  NONE_KEY,
  OTHER_KEY,
  TOTAL_KEY,
  VALUE_SERIES,
} from '../shared/contract.ts'
import type { ChartColumn } from './columns.ts'
import { Accumulator } from './numbers.ts'
import { ChartsProblem } from './problems.ts'
import type { AggregatePlan } from './request.ts'
import { type Cell, suppressSmallGroups } from './suppress.ts'

/** The most rows one grouped metric reads by default. */
export const DEFAULT_MAX_ROWS = 50_000

/**
 * Who is asking, and the row filter their permission allows.
 *
 * @example
 * const scope: EngineScope = { actor, filter: { op: 'true' }, maxRows: 50_000 }
 */
export interface EngineScope {
  readonly actor: Actor | null
  /** The `viewAny` row filter from the PermissionProvider. */
  readonly filter: QueryFilter
  readonly maxRows?: number
}

type Query = ReturnType<typeof ModelBase.query>

/**
 * Compute a metric. Throws {@link ChartsProblem} `payload_too_large` when more than `maxRows`
 * rows match; any other error (tenancy, a broken policy) propagates for the handler to map.
 *
 * @example
 * const result = await computeMetric(plan, { actor, filter })
 */
export async function computeMetric(
  plan: AggregatePlan,
  scope: EngineScope,
): Promise<MetricResult> {
  const query = scopedQuery(plan, scope)
  const metric = plan.metric
  const field = metric.field
  const newAcc = (): Accumulator =>
    new Accumulator(field?.scale ?? 0, field !== undefined && field.kind === 'double')

  const groups = new Map<string, Map<string, Accumulator>>()
  const seriesSeen = new Set<string>()
  const groupsSeen = new Set<string>()

  if (plan.group === undefined && metric.fn === 'count') {
    // Ungrouped count: one COUNT(*) through the builder, whatever the table size.
    const total = await query.count()
    const acc = newAcc()
    acc.rows = total
    groups.set(TOTAL_KEY, new Map([[VALUE_SERIES, acc]]))
  } else {
    const maxRows = scope.maxRows ?? DEFAULT_MAX_ROWS
    const rows = await query.limit(maxRows + 1).get()
    if (rows.length > maxRows) throw new ChartsProblem('payload_too_large')
    for (const row of rows) {
      const json = row.toJSON()
      const groupKey = plan.group === undefined ? TOTAL_KEY : keyOf(plan, plan.group.column, json)
      if (groupKey === undefined) continue
      const seriesKey =
        metric.splitBy === undefined ? VALUE_SERIES : categoryKey(json[metric.splitBy.name])
      groupsSeen.add(groupKey)
      seriesSeen.add(seriesKey)
      let cells = groups.get(groupKey)
      if (cells === undefined) {
        cells = new Map()
        groups.set(groupKey, cells)
      }
      let acc = cells.get(seriesKey)
      if (acc === undefined) {
        acc = newAcc()
        cells.set(seriesKey, acc)
      }
      acc.add(field === undefined ? null : json[field.name])
    }
  }

  const seriesKeys =
    metric.splitBy === undefined
      ? [VALUE_SERIES]
      : withNone(metric.splitBy.values, seriesSeen.has(NONE_KEY))
  const { keys: groupKeys, truncated } = orderGroups(plan, groups, groupsSeen, seriesKeys, newAcc)

  const grid: Cell[][] = groupKeys.map((key) =>
    seriesKeys.map((series) => {
      const acc = groups.get(key)?.get(series) ?? newAcc()
      return {
        rows: metric.fn === 'count' ? acc.rows : acc.count,
        value: cellValue(metric.fn, acc),
        suppressed: false,
      }
    }),
  )
  const suppressedCells =
    metric.minGroupSize === undefined ? 0 : suppressSmallGroups(grid, metric.minGroupSize)

  const data: MetricPoint[] = groupKeys.map((key, g) => {
    const values: Record<string, number | null> = {}
    const hidden: string[] = []
    seriesKeys.forEach((series, s) => {
      const cell = grid[g]?.[s]
      values[series] = cell?.value ?? null
      if (cell?.suppressed === true) hidden.push(series)
    })
    return hidden.length > 0 ? { key, values, suppressed: hidden } : { key, values }
  })

  return {
    data,
    series: seriesKeys.map((key) => ({ key })),
    meta: {
      name: metric.name,
      label: metric.label,
      fn: metric.fn,
      field: field?.name ?? null,
      groupBy: plan.group?.column.name ?? null,
      groupKind: plan.group?.kind ?? 'none',
      interval: plan.interval ?? null,
      splitBy: metric.splitBy?.name ?? null,
      dateField: plan.rangeColumn?.name ?? null,
      from: plan.range?.from.toISOString() ?? null,
      to: plan.range?.to.toISOString() ?? null,
      timezone: 'UTC',
      minGroupSize: metric.minGroupSize ?? null,
      suppressedCells,
      truncated,
    },
  }
}

/** The builder query with every scope applied: tenant (by the ORM), policy, range, filters. */
function scopedQuery(plan: AggregatePlan, scope: EngineScope): Query {
  const query = plan.metric.model.query()
  query.wherePolicy(scope.filter, { actor: scope.actor })
  if (plan.range !== undefined && plan.rangeColumn !== undefined) {
    const column = plan.rangeColumn
    query.filter(column.name, 'gte', bound(column, plan.range.from))
    query.filter(column.name, 'lt', bound(column, plan.range.to))
  }
  for (const filter of plan.filters) query.filter(filter.column.name, filter.op, filter.value)
  return query
}

/** A range bound in the form the column stores: a `YYYY-MM-DD` string for DATE, a Date otherwise. */
function bound(column: ChartColumn, at: Date): unknown {
  return column.kind === 'date' ? dateKey(at) : at
}

/** The group key of a row, or `undefined` when its date is missing (outside every bucket). */
function keyOf(
  plan: AggregatePlan,
  column: ChartColumn,
  json: Readonly<Record<string, unknown>>,
): string | undefined {
  const value = json[column.name]
  if (column.role === 'date') {
    const date = toDate(value)
    if (date === undefined || plan.interval === undefined) return undefined
    return dateKey(startOfBucket(date, plan.interval))
  }
  return categoryKey(value)
}

function categoryKey(value: unknown): string {
  if (value === null || value === undefined) return NONE_KEY
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return String(value)
}

function toDate(value: unknown): Date | undefined {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value
  if (typeof value !== 'string') return undefined
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : value)
  return Number.isNaN(date.getTime()) ? undefined : date
}

function withNone(values: readonly string[], none: boolean): string[] {
  return none ? [...values, NONE_KEY] : [...values]
}

function cellValue(fn: AggregatePlan['metric']['fn'], acc: Accumulator): number | null {
  switch (fn) {
    case 'count':
      return acc.rows
    case 'sum':
      return acc.sum()
    case 'avg':
      return acc.avg()
    case 'min':
      return acc.min()
    case 'max':
      return acc.max()
  }
}

/**
 * The groups to show, in order:
 * - dates: every bucket of the range (empty ones too);
 * - categories: every declared value in declaration order, then "none" if any row had no value;
 * - relations: the top N by the metric's value (ties by key), the rest folded into "other",
 *   then "none".
 */
function orderGroups(
  plan: AggregatePlan,
  groups: Map<string, Map<string, Accumulator>>,
  seen: ReadonlySet<string>,
  seriesKeys: readonly string[],
  newAcc: () => Accumulator,
): { readonly keys: string[]; readonly truncated: boolean } {
  const group = plan.group
  if (group === undefined) return { keys: [TOTAL_KEY], truncated: false }
  if (group.kind === 'date') {
    const range = plan.range
    const interval = plan.interval
    if (range === undefined || interval === undefined) return { keys: [], truncated: false }
    return { keys: bucketKeys(range.from, range.to, interval), truncated: false }
  }
  if (group.kind === 'category')
    return { keys: withNone(group.column.values, seen.has(NONE_KEY)), truncated: false }

  const ranked = [...seen]
    .filter((key) => key !== NONE_KEY)
    .map((key) => ({ key, score: totalOf(plan, groups.get(key), newAcc) }))
    .sort((a, b) => b.score - a.score || compareKeys(a.key, b.key))
  const kept = ranked.slice(0, plan.limit).map((entry) => entry.key)
  const folded = ranked.slice(plan.limit)
  if (folded.length > 0) {
    const other = new Map<string, Accumulator>()
    for (const series of seriesKeys) {
      const acc = newAcc()
      for (const entry of folded) {
        const cell = groups.get(entry.key)?.get(series)
        if (cell !== undefined) acc.merge(cell)
      }
      other.set(series, acc)
    }
    groups.set(OTHER_KEY, other)
    kept.push(OTHER_KEY)
  }
  if (seen.has(NONE_KEY)) kept.push(NONE_KEY)
  return { keys: kept, truncated: folded.length > 0 }
}

/** A group's value across all its series, for ranking. */
function totalOf(
  plan: AggregatePlan,
  cells: Map<string, Accumulator> | undefined,
  newAcc: () => Accumulator,
): number {
  const total = newAcc()
  for (const acc of cells?.values() ?? []) total.merge(acc)
  return cellValue(plan.metric.fn, total) ?? Number.NEGATIVE_INFINITY
}

function compareKeys(a: string, b: string): number {
  const numeric = /^\d+$/.test(a) && /^\d+$/.test(b)
  return numeric ? Number(a) - Number(b) : a < b ? -1 : a > b ? 1 : 0
}
