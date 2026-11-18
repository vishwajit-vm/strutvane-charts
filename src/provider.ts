/**
 * `@strutvane/charts/provider`: the provider an app lists in `bootstrap/providers.ts` (the
 * installer adds it). It serves the charts endpoints (`/api/_charts/metrics/<name>`,
 * `/api/_charts/manifest`) for the metrics the app binds.
 *
 * It connects to the app only through the framework's public seams (integration map: container
 * tokens and hooks), never through another add-on:
 * - **`ChartsMetricsToken`**: the app binds its metrics in its own service provider:
 *   ```ts
 *   import { ChartsMetricsToken } from '@strutvane/charts/provider'
 *   import { metrics } from '../charts/metrics.ts'
 *   app.container.value(ChartsMetricsToken, metrics)
 *   ```
 * - **`PermissionProviderToken`**: `viewAny` and the row filter (bound by `@strutvane/auth` or any
 *   implementation). Without one, charts are open only while `APP_ENV=local` (with a warning),
 *   and closed (403) everywhere else.
 * - **`http.onRequest`** (handler `charts.serve`, after `auth.identity`): requests under the charts
 *   path are answered here with the actor and tenant the identity layer resolved; every other
 *   request passes through untouched.
 * - **`LoggerToken`** for failures and **`CacheManagerToken`** when caching is on.
 *
 * Settings come from `config/charts.ts` (key `charts`): `enabled`, `path`, `cacheTtl`,
 * `cacheStore`, `maxRows`. Metrics are code (they hold model classes), so they come from the
 * token, never from a config file (config may be cached as JSON).
 *
 * Failure scenarios:
 * - **No `config/charts.ts`:** the defaults (enabled, `/api/_charts`, no cache, 50,000 rows).
 * - **An invalid setting:** the boot fails naming it; a typo must never silently change limits.
 * - **A metric that names an unusable column:** the boot fails with the column list
 *   (`ChartsDefinitionError`), when the schema is already registered; otherwise the first request
 *   for that metric answers 500 and logs why.
 *
 * @module
 */
import { allowAllPermissions, CacheManagerToken, denyAllPermissions } from '@strutvane/framework'
import {
  HTTP_HOOKS,
  type HttpRequestHookPayload,
  type Logger,
  type PermissionProvider,
} from '@strutvane/framework/contracts'
import {
  type Application,
  defineProvider,
  HooksToken,
  LoggerToken,
  PermissionProviderToken,
  type Provider,
  type Token,
  token,
} from '@strutvane/framework/core'
import type { ChartsCache } from './server/cache.ts'
import { DEFAULT_MAX_ROWS } from './server/engine.ts'
import { type ChartsHandler, createChartsHandler } from './server/handler.ts'
import { type Metric, resolveMetric } from './server/metric.ts'
import { DEFAULT_BASE_PATH } from './shared/contract.ts'
import { ChartsDefinitionError } from './shared/widgets.ts'

/**
 * The app's metrics: bind them in your service provider.
 *
 * @example
 * app.container.value(ChartsMetricsToken, [revenue, perMonth])
 */
export const ChartsMetricsToken: Token<readonly Metric[]> = token<readonly Metric[]>(
  'strutvane.charts.metrics',
)

/**
 * `config/charts.ts`: the data-only settings.
 *
 * @example
 * export default defineConfig((env) => ({ enabled: true, cacheTtl: env.integer('CHARTS_CACHE_TTL', 0) }))
 */
export interface ChartsConfig {
  /** Serve the endpoints at all. Default `true`. */
  readonly enabled?: boolean
  /** URL prefix. Default `/api/_charts`. */
  readonly path?: string
  /** Seconds to cache a result (per tenant, user and request). Default 0: off. */
  readonly cacheTtl?: number
  /** Which framework cache store to use. Default: the app's default store. */
  readonly cacheStore?: string
  /** The most rows one grouped metric may read. Default 50,000. */
  readonly maxRows?: number
}

/** Options for {@link createChartsProvider}. */
export interface ChartsProviderOptions {
  /** Metrics, instead of (and overriding) the ones bound with {@link ChartsMetricsToken}. */
  readonly metrics?: readonly Metric[]
  /** Environment to read `APP_ENV` from. Default: `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>
}

/** The config key the installer registers `config/charts.ts` under. */
export const CONFIG_KEY = 'charts'

/** Name of the `http.onRequest` handler, for other packages' ordering hints. */
export const HOOK_NAME = 'charts.serve'

/**
 * Create the charts provider (a factory, so every app and test gets fresh state).
 *
 * @example
 * // bootstrap/providers.ts
 * import { createChartsProvider } from '@strutvane/charts/provider'
 * export default [AppServiceProvider, createChartsProvider()]
 */
export function createChartsProvider(options: ChartsProviderOptions = {}): Provider {
  let handler: ChartsHandler | undefined
  return defineProvider({
    name: '@strutvane/charts',
    register() {
      // Nothing to bind: the metrics token is the app's to bind.
    },
    boot(app) {
      const cfg = readConfig(app)
      if (cfg.enabled === false) return
      const logger = app.container.has(LoggerToken)
        ? app.make(LoggerToken).child({ component: 'charts' })
        : undefined
      const metrics =
        options.metrics ??
        (app.container.has(ChartsMetricsToken) ? app.make(ChartsMetricsToken) : [])
      checkMetrics(metrics, logger)
      const permissions = permissionsFor(app, options.env ?? process.env, logger)
      const cache = cacheFor(app, cfg)
      handler = createChartsHandler({
        metrics,
        permissions,
        basePath: cfg.path ?? DEFAULT_BASE_PATH,
        ...(logger === undefined ? {} : { logger }),
        ...(cache === undefined ? {} : { cache, cacheTtl: cfg.cacheTtl ?? 0 }),
        maxRows: cfg.maxRows ?? DEFAULT_MAX_ROWS,
      })
      const charts = handler
      app.make(HooksToken).on(
        HTTP_HOOKS.request,
        async (payload, control) => {
          const p = payload as HttpRequestHookPayload
          if (!charts.matches(p.request)) return undefined
          control.stop()
          const answered: HttpRequestHookPayload = {
            ...p,
            response: await charts.fetch(p.request, {
              actor: p.actor,
              ...(p.tenant === undefined ? {} : { tenantId: p.tenant.id }),
            }),
          }
          return answered
        },
        { name: HOOK_NAME, after: ['auth.identity'] },
      )
    },
  })
}

/**
 * Resolve every metric now, so a misconfigured one fails the boot. A metric whose model's schema
 * isn't registered yet (some test setups) is checked on its first request instead.
 */
function checkMetrics(metrics: readonly Metric[], logger: Logger | undefined): void {
  for (const metric of metrics) {
    try {
      resolveMetric(metric)
    } catch (error) {
      if (error instanceof ChartsDefinitionError) throw error
      logger?.debug('charts.metric_check_deferred', {
        metric: metric.name,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }
}

/** The app's PermissionProvider; without one, open in local development only (fail closed). */
function permissionsFor(
  app: Pick<Application, 'container' | 'make'>,
  env: Readonly<Record<string, string | undefined>>,
  logger: Logger | undefined,
): PermissionProvider {
  if (app.container.has(PermissionProviderToken)) return app.make(PermissionProviderToken)
  if (env['APP_ENV'] === 'local') {
    logger?.warn('charts.no_permission_provider', {
      detail: 'No PermissionProvider is bound, so every chart is open (APP_ENV=local only).',
    })
    return allowAllPermissions()
  }
  logger?.warn('charts.no_permission_provider', {
    detail:
      'No PermissionProvider is bound, so every chart answers 403. Install @strutvane/auth or bind one.',
  })
  return denyAllPermissions()
}

/** The framework cache store, when caching is on and the app has a cache. */
function cacheFor(
  app: Pick<Application, 'container' | 'make'>,
  cfg: ChartsConfig,
): ChartsCache | undefined {
  if ((cfg.cacheTtl ?? 0) <= 0 || !app.container.has(CacheManagerToken)) return undefined
  return app.make(CacheManagerToken).store(cfg.cacheStore)
}

/**
 * Read and check `config('charts')`. Absent is fine (the defaults); a wrong type is a boot error
 * naming the setting.
 *
 * @example
 * readConfig({ settings: { charts: { cacheTtl: 60 } } }) // { cacheTtl: 60 }
 */
export function readConfig(app: Pick<Application, 'settings'>): ChartsConfig {
  const value: unknown = Reflect.get(app.settings, CONFIG_KEY)
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError('config/charts.ts must export an object (use defineConfig).')
  const raw = value as Readonly<Record<string, unknown>>
  const known = new Set(['enabled', 'path', 'cacheTtl', 'cacheStore', 'maxRows'])
  for (const key of Object.keys(raw))
    if (!known.has(key))
      throw new TypeError(
        `config/charts.ts: unknown setting "${key}". Known: ${[...known].join(', ')}.`,
      )
  const out: { -readonly [K in keyof ChartsConfig]: ChartsConfig[K] } = {}
  if (raw['enabled'] !== undefined) {
    if (typeof raw['enabled'] !== 'boolean') throw setting('enabled', 'true or false')
    out.enabled = raw['enabled']
  }
  if (raw['path'] !== undefined) {
    if (typeof raw['path'] !== 'string' || !/^\/[A-Za-z0-9/_-]{0,100}$/.test(raw['path']))
      throw setting('path', 'a path such as /api/_charts (letters, digits, /, _ and -)')
    out.path = raw['path']
  }
  if (raw['cacheTtl'] !== undefined) {
    if (!isWhole(raw['cacheTtl'], 0, 86_400)) throw setting('cacheTtl', 'whole seconds, 0 to 86400')
    out.cacheTtl = raw['cacheTtl']
  }
  if (raw['cacheStore'] !== undefined) {
    if (typeof raw['cacheStore'] !== 'string' || raw['cacheStore'] === '')
      throw setting('cacheStore', 'the name of a cache store in config/cache.ts')
    out.cacheStore = raw['cacheStore']
  }
  if (raw['maxRows'] !== undefined) {
    if (!isWhole(raw['maxRows'], 1, 5_000_000))
      throw setting('maxRows', 'a whole number, 1 to 5000000')
    out.maxRows = raw['maxRows']
  }
  return out
}

function isWhole(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
}

function setting(name: string, expected: string): TypeError {
  return new TypeError(`config/charts.ts: "${name}" must be ${expected}.`)
}

/** The provider with default options: what the installer registers. */
const chartsProvider: Provider = createChartsProvider()
export default chartsProvider
