/**
 * `@strutvane/charts/installer`: what `node strut install:charts` runs (declared as
 * `strutvane.installer` in package.json, blueprint §3.3). It installs charts completely, in one
 * transaction the framework's devkit previews (`--dry-run --diff`) and commits or rolls back:
 *
 * 1. `config/charts.ts`: the settings (kept if it exists: it is the app's).
 * 2. `config/index.ts`: lists it under the `charts` key, so `config('charts')` loads it.
 * 3. `.env` / `.env.example`: `CHARTS_CACHE_TTL=0` (caching off until the app chooses a TTL).
 * 4. `app/charts/metrics.ts`: the app's metrics, with one example on the skeleton's `User` model
 *    (kept if it exists).
 * 5. `app/providers/charts.provider.ts`: the charts provider with those metrics (kept if it exists).
 * 6. `bootstrap/providers.ts`: registers that provider (an older app with `strutvane.config.ts`
 *    gets it through the framework's config patcher instead).
 *
 * Nothing here hard-codes another package, install order never changes the result, and running it
 * twice changes nothing the second time. A file that doesn't look like the skeleton's is never
 * guessed at: the installer prints the one line to add by hand instead. `uninstall` reverses
 * steps 2, 3 and 6 and keeps the app's own files (1, 4, 5: they may hold the developer's work).
 *
 * @module
 */
import {
  type DevkitInstallContext,
  type DevkitInstaller,
  defineInstaller,
} from '@strutvane/framework/devkit'
import {
  addConfigKey,
  addProvider,
  CONFIG_LOCAL,
  CONFIG_SPECIFIER,
  PROVIDER_LOCAL,
  PROVIDER_SPECIFIER,
  removeConfigKey,
  removeProvider,
} from './install/patch.ts'

/** Where the installer writes and edits files, relative to the project root. */
export const INSTALL_PATHS: {
  readonly config: string
  readonly configIndex: string
  readonly metrics: string
  readonly provider: string
  readonly providers: string
  readonly legacyConfig: string
  readonly userModel: string
} = Object.freeze({
  config: 'config/charts.ts',
  configIndex: 'config/index.ts',
  metrics: 'app/charts/metrics.ts',
  provider: 'app/providers/charts.provider.ts',
  providers: 'bootstrap/providers.ts',
  legacyConfig: 'strutvane.config.ts',
  userModel: 'app/models/user.ts',
})

/** The `.env` keys the installer adds. */
export const ENV_KEYS: readonly string[] = Object.freeze(['CHARTS_CACHE_TTL'])

/** The `config/charts.ts` the installer writes. */
export const CONFIG_TEMPLATE = `// Charts (@strutvane/charts): KPI cards and chart widgets, computed on the server.
// Your metrics live in app/charts/metrics.ts; the endpoints are /api/_charts/metrics/<name>.
import { defineConfig } from '@strutvane/framework'

export default defineConfig((env) => ({
  /** Serve the chart endpoints at all. */
  enabled: true,
  /** Where they live. Letters, digits, /, _ and - only. */
  path: '/api/_charts',
  /** Cache each result this many seconds, per tenant, user and request. 0 turns caching off. */
  cacheTtl: env.integer('CHARTS_CACHE_TTL', 0),
  /** The most rows one grouped chart may read; above it the chart asks for a shorter period. */
  maxRows: 50_000,
}))
`

/** `app/charts/metrics.ts` when the app has the skeleton's `User` model. */
export const METRICS_TEMPLATE = `// Your chart metrics: what the server may compute for dashboards.
// A metric fixes the model, the function and the groupings; a widget only picks a metric by name.
// Charts read through the query builder, so the tenant scope and the users.viewAny permission apply.
import { defineMetric, type Metric } from '@strutvane/charts/server'
import { User } from '../models/user.ts'

export const metrics: readonly Metric[] = [
  defineMetric({
    name: 'users.new',
    label: 'New users',
    model: User,
    aggregate: 'count',
    groupBy: { field: 'created_at', interval: 'week' },
  }),
]
`

/** `app/charts/metrics.ts` for an app without a `User` model. */
export const EMPTY_METRICS_TEMPLATE = `// Your chart metrics: what the server may compute for dashboards.
// A metric fixes the model, the function and the groupings; a widget only picks a metric by name.
//
//   defineMetric({ name: 'invoices.revenue', model: Invoice, aggregate: { fn: 'sum', field: 'total' },
//     groupBy: { field: 'issued_on', interval: 'month' } })
import type { Metric } from '@strutvane/charts/server'

export const metrics: readonly Metric[] = []
`

/** `app/providers/charts.provider.ts`: the charts provider, with the app's metrics. */
export const PROVIDER_TEMPLATE = `// The charts provider, with your metrics (app/charts/metrics.ts).
// Settings are in config/charts.ts; who may see a chart is your PermissionProvider's
// <resource>.viewAny (e.g. users.viewAny), with its row filter applied.
import { createChartsProvider } from '@strutvane/charts/provider'
import { metrics } from '../charts/metrics.ts'

export default createChartsProvider({ metrics })
`

/** Read a project file, or `undefined` when it doesn't exist. */
async function readIfExists(ctx: DevkitInstallContext, path: string): Promise<string | undefined> {
  return (await ctx.fs.exists(path)) ? ctx.fs.read(path) : undefined
}

/** Write an app-owned file once; never overwrite the developer's version. */
async function writeOnce(ctx: DevkitInstallContext, path: string, content: string): Promise<void> {
  if (!(await ctx.fs.exists(path))) await ctx.fs.write(path, content)
}

/** Step 2: list the config file in `config/index.ts`. */
async function registerConfig(ctx: DevkitInstallContext): Promise<void> {
  const source = await readIfExists(ctx, INSTALL_PATHS.configIndex)
  if (source === undefined) {
    ctx.log.warn(
      `${INSTALL_PATHS.configIndex} was not found, so charts use their defaults. To use ${INSTALL_PATHS.config}, import it as ${CONFIG_LOCAL} from '${CONFIG_SPECIFIER}' and add ${CONFIG_LOCAL} to your config files.`,
    )
    return
  }
  const edited = addConfigKey(source)
  if (edited === undefined) {
    ctx.log.warn(
      `${INSTALL_PATHS.configIndex} has an unexpected shape, so it was not changed. Add these two lines yourself: import ${CONFIG_LOCAL} from '${CONFIG_SPECIFIER}', and ${CONFIG_LOCAL} in the exported object.`,
    )
    return
  }
  if (edited !== source) await ctx.fs.write(INSTALL_PATHS.configIndex, edited, { overwrite: true })
}

/** Step 6: register the provider. */
async function registerProvider(ctx: DevkitInstallContext): Promise<void> {
  const source = await readIfExists(ctx, INSTALL_PATHS.providers)
  if (source !== undefined) {
    const edited = addProvider(source)
    if (edited === undefined) {
      ctx.log.warn(
        `${INSTALL_PATHS.providers} has an unexpected shape, so it was not changed. Add the provider yourself: import ${PROVIDER_LOCAL} from '${PROVIDER_SPECIFIER}', and ${PROVIDER_LOCAL} in the providers array.`,
      )
      return
    }
    if (edited !== source) await ctx.fs.write(INSTALL_PATHS.providers, edited, { overwrite: true })
    return
  }
  if (await ctx.fs.exists(INSTALL_PATHS.legacyConfig)) {
    await ctx.config.registerProvider('./app/providers/charts.provider.ts')
    return
  }
  ctx.log.warn(
    `Neither ${INSTALL_PATHS.providers} nor ${INSTALL_PATHS.legacyConfig} was found. Register the provider yourself: import ${PROVIDER_LOCAL} from '${PROVIDER_SPECIFIER}' and add it to your providers.`,
  )
}

/** Undo step 6. */
async function unregisterProvider(ctx: DevkitInstallContext): Promise<void> {
  const source = await readIfExists(ctx, INSTALL_PATHS.providers)
  if (source !== undefined) {
    const edited = removeProvider(source)
    if (edited !== source) await ctx.fs.write(INSTALL_PATHS.providers, edited, { overwrite: true })
    return
  }
  if (await ctx.fs.exists(INSTALL_PATHS.legacyConfig))
    await ctx.config.unregisterProvider('./app/providers/charts.provider.ts')
}

/**
 * The installer, loaded by `node strut install:charts` / `node strut remove charts`.
 *
 * @example
 * await runInstaller(installer, { projectRoot: '/srv/crm', dryRun: true })
 */
export const installer: DevkitInstaller = defineInstaller({
  name: 'charts',
  description: 'KPI cards and chart widgets, computed on the server from your models.',
  async install(ctx: DevkitInstallContext): Promise<void> {
    await writeOnce(ctx, INSTALL_PATHS.config, CONFIG_TEMPLATE)
    await registerConfig(ctx)
    await ctx.env.add('Charts (@strutvane/charts)', [
      {
        key: 'CHARTS_CACHE_TTL',
        value: '0',
        comment: 'Seconds to cache each chart result (per tenant, user and request). 0: off.',
      },
    ])
    const hasUser = await ctx.fs.exists(INSTALL_PATHS.userModel)
    await writeOnce(ctx, INSTALL_PATHS.metrics, hasUser ? METRICS_TEMPLATE : EMPTY_METRICS_TEMPLATE)
    await writeOnce(ctx, INSTALL_PATHS.provider, PROVIDER_TEMPLATE)
    await registerProvider(ctx)
    ctx.log.info(
      `Charts are served at /api/_charts. Add metrics in ${INSTALL_PATHS.metrics}; a metric is visible to users with <resource>.viewAny.`,
    )
  },
  async uninstall(ctx: DevkitInstallContext): Promise<void> {
    await unregisterProvider(ctx)
    const index = await readIfExists(ctx, INSTALL_PATHS.configIndex)
    if (index !== undefined) {
      const edited = removeConfigKey(index)
      if (edited !== index)
        await ctx.fs.write(INSTALL_PATHS.configIndex, edited, { overwrite: true })
    }
    await ctx.env.remove(ENV_KEYS)
    ctx.log.info(
      `${INSTALL_PATHS.config}, ${INSTALL_PATHS.metrics} and ${INSTALL_PATHS.provider} were kept: delete them if you no longer need them.`,
    )
  },
})

export default installer
