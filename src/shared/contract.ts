/**
 * The wire contract between the aggregate endpoint and the browser, shared by both sides.
 *
 * ```text
 * GET /api/_charts/metrics/<name>
 *     ?from=2026-01-01&to=2026-12-31     optional range (UTC), from inclusive, to exclusive
 *     &interval=day|week|month           optional, one of the metric's intervals (date groups only)
 *     &groupBy=<field>                   optional, one of the metric's groupBy options
 *     &limit=1..50                       optional top N (category and relation groups)
 *     &filter[status][in]=paid,sent      optional, only on the metric's filterable fields
 * ```
 *
 * Why named metrics instead of a free-form aggregate endpoint: the **server** decides what may be
 * aggregated (the function, the field, the groupings), so a client can only choose among options
 * the app declared. A request can narrow (range, filters) and switch (interval, groupBy among the
 * declared ones), never widen. Unknown parameters are refused (422), never ignored, so a typo
 * can't silently change a number.
 *
 * Browser-safe: types and constants only.
 *
 * @module
 */
import type { Interval } from './calendar.ts'

/**
 * What to compute per group.
 *
 * `min` and `max` return one row's exact value, which defeats small-group suppression (the
 * highest salary *is* one person's salary), so a metric with `privacy` refuses them.
 *
 * @example
 * const fn: AggregateFn = 'sum'
 */
export type AggregateFn = 'count' | 'sum' | 'avg' | 'min' | 'max'

/** Every aggregate function. */
export const AGGREGATE_FNS: readonly AggregateFn[] = Object.freeze([
  'count',
  'sum',
  'avg',
  'min',
  'max',
])

/**
 * How group keys were produced, so the browser knows how to label them.
 * - `none`: one point, key {@link TOTAL_KEY};
 * - `date`: bucket starts, `YYYY-MM-DD`;
 * - `category`: enum values in declaration order, or `true`/`false`;
 * - `relation`: related record ids (top N), plus {@link OTHER_KEY}.
 *
 * @example
 * const kind: GroupKind = 'date'
 */
export type GroupKind = 'none' | 'date' | 'category' | 'relation'

/** The key of the single point of an ungrouped metric. */
export const TOTAL_KEY = '__total__'
/** The key that collects every group outside the top N. */
export const OTHER_KEY = '__other__'
/** The key of rows whose group value is `NULL`. */
export const NONE_KEY = '__none__'
/** The series key of a metric without `splitBy`. */
export const VALUE_SERIES = 'value'

/**
 * Filter operators a chart request may use. A deliberately small set: text matching
 * (`contains`, `startsWith`) is a search feature, not a chart one, and every operator is one more
 * way to single out a row.
 *
 * @example
 * const op: ChartFilterOperator = 'in'
 */
export type ChartFilterOperator = 'eq' | 'ne' | 'in' | 'gt' | 'gte' | 'lt' | 'lte' | 'null'

/** Every filter operator a chart request may use. */
export const CHART_FILTER_OPERATORS: readonly ChartFilterOperator[] = Object.freeze([
  'eq',
  'ne',
  'in',
  'gt',
  'gte',
  'lt',
  'lte',
  'null',
])

/**
 * One `filter[field][op]=value`. `in` takes comma-separated values; `null` takes `true`/`false`.
 *
 * @example
 * const filter: ChartFilter = { field: 'status', op: 'in', value: 'paid,sent' }
 */
export interface ChartFilter {
  readonly field: string
  readonly op: ChartFilterOperator
  readonly value: string
}

/**
 * What a client may ask of a metric: everything optional, the metric's defaults apply.
 *
 * @example
 * const request: MetricRequest = { interval: 'week', from: '2026-01-01', to: '2026-04-01' }
 */
export interface MetricRequest {
  readonly from?: string
  readonly to?: string
  readonly interval?: Interval
  readonly groupBy?: string
  readonly limit?: number
  readonly filters?: readonly ChartFilter[]
}

/**
 * One point (group) of a result: its key and one value per series. A value is `null` when it
 * was hidden for privacy (then its series key is in `suppressed`) or when there is nothing to
 * average.
 *
 * @example
 * const point: MetricPoint = { key: '2026-11-01', values: { paid: 4, draft: null }, suppressed: ['draft'] }
 */
export interface MetricPoint {
  readonly key: string
  readonly values: Readonly<Record<string, number | null>>
  readonly suppressed?: readonly string[]
}

/**
 * One series. Without `splitBy` there is one, {@link VALUE_SERIES}.
 *
 * @example
 * const series: MetricSeries = { key: 'paid' }
 */
export interface MetricSeries {
  readonly key: string
}

/**
 * Facts about how a result was computed, for labels, legends and the privacy note.
 *
 * @example
 * result.meta.minGroupSize // 5: groups of 1–4 rows are hidden
 */
export interface MetricMeta {
  readonly name: string
  readonly label: string
  readonly fn: AggregateFn
  readonly field: string | null
  readonly groupBy: string | null
  readonly groupKind: GroupKind
  readonly interval: Interval | null
  readonly splitBy: string | null
  readonly dateField: string | null
  /** The aligned range actually used (ISO), or `null` when the metric has no date field. */
  readonly from: string | null
  readonly to: string | null
  readonly timezone: 'UTC'
  /** Groups backed by fewer rows than this are hidden; `null` when privacy is off. */
  readonly minGroupSize: number | null
  readonly suppressedCells: number
  /** `true` when groups beyond the top N were folded into {@link OTHER_KEY}. */
  readonly truncated: boolean
}

/**
 * The answer of `GET /api/_charts/metrics/<name>`.
 *
 * @example
 * const result: MetricResult = { data: [{ key: '__total__', values: { value: 42 } }], series: [{ key: 'value' }], meta }
 */
export interface MetricResult {
  readonly data: readonly MetricPoint[]
  readonly series: readonly MetricSeries[]
  readonly meta: MetricMeta
}

/**
 * What the manifest says about one metric the actor may view: enough to draw controls (interval
 * switch, groupBy picker) without trying requests that would fail.
 *
 * @example
 * const info: MetricInfo = { name: 'invoices.revenue', label: 'Revenue', fn: 'sum', groupKind: 'date', intervals: ['day', 'week', 'month'], groupByOptions: ['issued_on'], filterable: [] }
 */
export interface MetricInfo {
  readonly name: string
  readonly label: string
  readonly fn: AggregateFn
  readonly groupKind: GroupKind
  readonly intervals: readonly Interval[]
  readonly groupByOptions: readonly string[]
  readonly filterable: readonly string[]
}

/**
 * The answer of `GET /api/_charts/manifest`: the metrics this actor may view.
 *
 * @example
 * const manifest: ChartsManifest = { version: 1, metrics: [] }
 */
export interface ChartsManifest {
  readonly version: 1
  readonly metrics: readonly MetricInfo[]
}

/** The default URL prefix of the charts endpoints. */
export const DEFAULT_BASE_PATH = '/api/_charts'

/**
 * A metric or widget name: dot-separated lowercase words, e.g. `invoices.revenue`. The same rule
 * on both sides keeps names safe in URLs, cache keys and log lines.
 */
export const NAME_PATTERN: RegExp = /^[a-z][a-z0-9_-]{0,47}(\.[a-z][a-z0-9_-]{0,47}){0,3}$/

/**
 * Is `value` a valid metric or widget name?
 *
 * @example
 * isValidName('invoices.revenue') // true
 * isValidName('../secrets') // false
 */
export function isValidName(value: string): boolean {
  return NAME_PATTERN.test(value)
}
