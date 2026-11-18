/**
 * `@strutvane/charts/server`: metrics and the aggregate endpoint.
 *
 * - {@link defineMetric}: what may be computed (function, field, groupings, filters, privacy).
 * - {@link createChartsHandler}: the `GET /api/_charts/...` endpoints as a Web handler.
 * - {@link computeMetric} / {@link planRequest}: the engine, for custom routes and jobs.
 *
 * Every read goes through the framework's query builder, scoped to the tenant and the actor's
 * `viewAny` row filter.
 *
 * @module
 */
export {
  type CacheKeyParts,
  type ChartsCache,
  cacheGeneration,
  cacheKey,
  clearChartsCache,
  GENERATION_KEY,
  isMetricResult,
  normaliseParams,
} from './cache.ts'
export {
  asModel,
  type ChartColumn,
  type ChartModel,
  type ColumnRole,
  chartColumns,
} from './columns.ts'
export { computeMetric, DEFAULT_MAX_ROWS, type EngineScope } from './engine.ts'
export {
  type ChartsHandler,
  type ChartsHandlerOptions,
  type ChartsRequestContext,
  createChartsHandler,
} from './handler.ts'
export {
  DEFAULT_LIMIT,
  defineMetric,
  type GroupOption,
  MAX_LIMIT,
  type Metric,
  type MetricAggregate,
  type MetricDefinition,
  type MetricPrivacy,
  type ResolvedGroup,
  type ResolvedMetric,
  resolveMetric,
} from './metric.ts'
export { Accumulator, formatScaled, toScaled } from './numbers.ts'
export {
  ChartsProblem,
  type ChartsProblemCode,
  issue,
  jsonResponse,
  problemResponse,
} from './problems.ts'
export {
  type AggregatePlan,
  MAX_BUCKETS,
  MAX_IN_VALUES,
  MAX_PARAMETERS,
  MAX_VALUE_LENGTH,
  type PlannedFilter,
  planRequest,
} from './request.ts'
export { type Cell, suppressSmallGroups } from './suppress.ts'
