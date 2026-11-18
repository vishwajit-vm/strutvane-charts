/**
 * The charts HTTP endpoints, as a plain Web `Request → Response` handler (mounted by the provider
 * through the framework's `http.onRequest` hook, or by any Web-standard server):
 *
 * - `GET {base}/metrics/<name>`: one metric's {@link MetricResult};
 * - `GET {base}/manifest`: the metrics the actor may view ({@link ChartsManifest}).
 *
 * The order of checks is deliberate (spike 16, finding 9):
 * 1. **Unknown metric → 404**, one identical body whatever the reason, so names can't be probed.
 * 2. **Method → 405** for anything but GET/HEAD.
 * 3. **Permission → 401/403 before validation**: a 422 lists allowed field names, which someone
 *    without `viewAny` must not learn. The check matches the framework's list route: allowed when
 *    `can(<permission>.viewAny)` allows it, or when the row filter is not FALSE (conditional rules).
 * 4. **Validation → 422** with every issue at once.
 * 5. **Compute**, as the request's tenant, through the query builder (`engine.ts`).
 *
 * Failures: a tenant table queried without a tenant is a 403; a broken policy, an unscopable table
 * or a misconfigured metric is a generic 500 (details go to the logger, never to the client);
 * a cache that fails is a miss. Results are `Cache-Control: private, no-store`.
 *
 * @module
 */
import type { Actor, Logger, PermissionProvider, QueryFilter } from '@strutvane/framework/contracts'
import { currentTenant, runWithTenant, TenantRequiredError } from '@strutvane/framework/database'
import {
  type ChartsManifest,
  DEFAULT_BASE_PATH,
  isValidName,
  type MetricInfo,
  type MetricResult,
} from '../shared/contract.ts'
import type { MessageCatalog } from '../shared/messages.ts'
import {
  type ChartsCache,
  cacheGeneration,
  cacheKey,
  isMetricResult,
  normaliseParams,
} from './cache.ts'
import { computeMetric, DEFAULT_MAX_ROWS } from './engine.ts'
import { type Metric, type ResolvedMetric, resolveMetric } from './metric.ts'
import { ChartsProblem, jsonResponse, problemResponse } from './problems.ts'
import { planRequest } from './request.ts'

/**
 * How to build the handler.
 *
 * @example
 * createChartsHandler({ metrics: [revenue, perMonth], permissions })
 */
export interface ChartsHandlerOptions {
  readonly metrics: readonly Metric[]
  /** Decides `viewAny` and supplies the row filter (`@strutvane/auth`, or any implementation). */
  readonly permissions: PermissionProvider
  /** URL prefix. Default `/api/_charts`. */
  readonly basePath?: string
  readonly logger?: Logger
  /** Where results may be cached; without it nothing is cached. */
  readonly cache?: ChartsCache
  /** Seconds to cache a result when the metric sets no `cacheTtl`. Default 0 (off). */
  readonly cacheTtl?: number
  /** The most rows one grouped metric may read. Default {@link DEFAULT_MAX_ROWS}. */
  readonly maxRows?: number
  /** The clock, for default ranges (tests pass a fixed one). */
  readonly now?: () => Date
  readonly messages?: MessageCatalog
}

/**
 * Who is asking: the actor the identity layer resolved, and their tenant.
 *
 * @example
 * const ctx: ChartsRequestContext = { actor, tenantId: '0193…' }
 */
export interface ChartsRequestContext {
  readonly actor: Actor | null
  readonly tenantId?: string
}

/**
 * The handler: does a request belong to it, and the answer.
 *
 * @example
 * if (charts.matches(request)) return charts.fetch(request, { actor })
 */
export interface ChartsHandler {
  readonly basePath: string
  matches(request: Request): boolean
  fetch(request: Request, context: ChartsRequestContext): Promise<Response>
  /** The metrics `context.actor` may view (what `GET {base}/manifest` answers). */
  manifest(context: ChartsRequestContext): Promise<ChartsManifest>
}

const BASE_PATH = /^\/[A-Za-z0-9/_-]{0,100}$/

/**
 * Create the charts handler. Metric names must be unique.
 *
 * @throws TypeError for a duplicate metric name or an invalid base path (a boot-time mistake).
 *
 * @example
 * const charts = createChartsHandler({ metrics, permissions, logger })
 */
export function createChartsHandler(options: ChartsHandlerOptions): ChartsHandler {
  const basePath = trimSlash(options.basePath ?? DEFAULT_BASE_PATH)
  if (!BASE_PATH.test(basePath))
    throw new TypeError(
      `Charts basePath "${basePath}" is not a plain path. Use letters, digits, /, _ and -, e.g. "/api/_charts".`,
    )
  const metrics = new Map<string, Metric>()
  for (const metric of options.metrics) {
    if (metrics.has(metric.name))
      throw new TypeError(`Two charts metrics are named "${metric.name}". Names must be unique.`)
    metrics.set(metric.name, metric)
  }
  const now = options.now ?? (() => new Date())
  const logger = options.logger
  const catalog = options.messages

  const authorize = async (metric: ResolvedMetric, actor: Actor | null): Promise<QueryFilter> => {
    const permission = `${metric.permission}.viewAny` as const
    const decision = await options.permissions.can(actor, permission, { type: metric.permission })
    const filter = await options.permissions.filterFor(actor, permission, metric.permission)
    if (!decision.allowed && (filter.op === 'false' || actor === null))
      throw new ChartsProblem(actor === null ? 'unauthenticated' : 'forbidden')
    return filter
  }

  const resolve = (metric: Metric): ResolvedMetric => {
    try {
      return resolveMetric(metric)
    } catch (error) {
      throw new ChartsProblem('internal_error', [], { cause: error })
    }
  }

  const cached = async (
    key: () => Promise<string>,
    ttl: number,
    compute: () => Promise<MetricResult>,
  ): Promise<MetricResult> => {
    const cache = options.cache
    if (cache === undefined || ttl <= 0) return compute()
    let entry: string | undefined
    try {
      entry = await key()
      const hit = await cache.get(entry)
      if (isMetricResult(hit)) return hit
    } catch (error) {
      logger?.warn('charts.cache_read_failed', { error: describe(error) })
    }
    const result = await compute()
    if (entry !== undefined) {
      try {
        await cache.put(entry, result, ttl)
      } catch (error) {
        logger?.warn('charts.cache_write_failed', { error: describe(error) })
      }
    }
    return result
  }

  const metricResponse = async (
    request: Request,
    name: string,
    context: ChartsRequestContext,
  ): Promise<Response> => {
    const metric = metrics.get(name)
    if (metric === undefined) throw new ChartsProblem('not_found')
    if (request.method !== 'GET' && request.method !== 'HEAD')
      throw new ChartsProblem('method_not_allowed')
    const resolved = resolve(metric)
    return asTenant(context.tenantId, async () => {
      const filter = await authorize(resolved, context.actor)
      const params = new URL(request.url).searchParams
      const plan = planRequest(resolved, params, now(), catalog)
      const ttl = resolved.cacheTtl ?? options.cacheTtl ?? 0
      const result = await cached(
        async () =>
          cacheKey({
            generation: options.cache === undefined ? 0 : await cacheGeneration(options.cache),
            metric: resolved.name,
            params: normaliseParams(params),
            tenant: currentTenant() ?? context.tenantId,
            actor: context.actor,
            filter,
          }),
        ttl,
        () =>
          computeMetric(plan, {
            actor: context.actor,
            filter,
            maxRows: options.maxRows ?? DEFAULT_MAX_ROWS,
          }),
      )
      return jsonResponse(result, request.method === 'HEAD')
    })
  }

  const manifest = async (context: ChartsRequestContext): Promise<ChartsManifest> => {
    const visible: MetricInfo[] = []
    for (const metric of metrics.values()) {
      const resolved = resolve(metric)
      try {
        await authorize(resolved, context.actor)
      } catch (error) {
        if (error instanceof ChartsProblem) continue
        throw error
      }
      visible.push({
        name: resolved.name,
        label: resolved.label,
        fn: resolved.fn,
        groupKind: resolved.groups[0]?.kind ?? 'none',
        intervals: resolved.groups.some((group) => group.kind === 'date') ? resolved.intervals : [],
        groupByOptions: resolved.groups.map((group) => group.column.name),
        filterable: [...resolved.filterable.keys()],
      })
    }
    return { version: 1, metrics: visible }
  }

  const route = (request: Request): string | undefined => {
    const path = new URL(request.url).pathname
    if (path !== basePath && !path.startsWith(`${basePath}/`)) return undefined
    return path.slice(basePath.length)
  }

  return {
    basePath,
    matches: (request) => route(request) !== undefined,
    manifest,
    async fetch(request, context) {
      const rest = route(request) ?? ''
      try {
        if (rest === '/manifest') {
          if (request.method !== 'GET' && request.method !== 'HEAD')
            throw new ChartsProblem('method_not_allowed')
          return jsonResponse(
            await asTenant(context.tenantId, () => manifest(context)),
            request.method === 'HEAD',
          )
        }
        const match = /^\/metrics\/([^/]+)$/.exec(rest)
        const name = match?.[1]
        if (name === undefined || !isValidName(name)) throw new ChartsProblem('not_found')
        return await metricResponse(request, name, context)
      } catch (error) {
        return problemResponse(toProblem(error, logger, rest), catalog)
      }
    },
  }
}

/** Run as the request's tenant, unless a tenant context is already active. */
function asTenant<T>(tenantId: string | undefined, work: () => Promise<T>): Promise<T> {
  if (tenantId === undefined || currentTenant() !== undefined) return work()
  return runWithTenant(tenantId, work)
}

/** Map any failure to the problem the client sees; log what the client must not see. */
function toProblem(error: unknown, logger: Logger | undefined, path: string): ChartsProblem {
  if (error instanceof ChartsProblem) {
    if (error.code === 'internal_error')
      logger?.error('charts.metric_failed', { path: safePath(path), error: describe(error.cause) })
    return error
  }
  if (error instanceof TenantRequiredError) return new ChartsProblem('forbidden')
  logger?.error('charts.metric_failed', { path: safePath(path), error: describe(error) })
  return new ChartsProblem('internal_error')
}

function describe(error: unknown): { readonly name: string; readonly message: string } {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: 'Error', message: String(error) }
}

/** The request path for a log line: printable ASCII only, bounded. */
function safePath(path: string): string {
  return path.replace(/[^\x20-\x7e]/g, '?').slice(0, 200)
}

function trimSlash(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
}
