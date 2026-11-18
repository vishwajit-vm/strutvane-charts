/**
 * `@strutvane/charts`: the browser-safe core. Widget and dashboard definitions, the wire format of
 * the aggregate endpoint, URL building and the UTC calendar.
 *
 * - Server metrics and the aggregate engine: `@strutvane/charts/server`.
 * - React widgets: `@strutvane/charts/react`.
 * - The Strutvane app integration: `@strutvane/charts/provider` (installed by `node strut install:charts`).
 *
 * @module
 */
export {
  addBuckets,
  bucketKeys,
  ceilToBucket,
  countBuckets,
  dateKey,
  INTERVALS,
  type Interval,
  isInterval,
  parseUtcDate,
  previousWindow,
  type RelativeRange,
  relativeWindow,
  startOfBucket,
  YEAR_RANGE,
} from './shared/calendar.ts'
export {
  AGGREGATE_FNS,
  type AggregateFn,
  CHART_FILTER_OPERATORS,
  type ChartFilter,
  type ChartFilterOperator,
  type ChartsManifest,
  DEFAULT_BASE_PATH,
  type GroupKind,
  isValidName,
  type MetricInfo,
  type MetricMeta,
  type MetricPoint,
  type MetricRequest,
  type MetricResult,
  type MetricSeries,
  NAME_PATTERN,
  NONE_KEY,
  OTHER_KEY,
  TOTAL_KEY,
  VALUE_SERIES,
} from './shared/contract.ts'
export { CHARTS_MESSAGES_EN, formatMessage, type MessageCatalog } from './shared/messages.ts'
export { manifestUrl, metricUrl, toSearchParams } from './shared/query.ts'
export {
  type BarWidget,
  ChartsDefinitionError,
  type DashboardDefinition,
  defineDashboard,
  defineWidget,
  type KpiWidget,
  type LineWidget,
  type NumberFormat,
  type PieWidget,
  WIDGET_KINDS,
  type WidgetDefinition,
  type WidgetKind,
  type WidgetSize,
} from './shared/widgets.ts'
