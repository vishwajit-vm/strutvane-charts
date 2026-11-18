/**
 * Turning a {@link MetricRequest} into the URL the aggregate endpoint reads. The server parses
 * the same shape back (`server/request.ts`) and refuses anything else, so this is the one place
 * the browser spells parameters.
 *
 * Browser-safe.
 *
 * @module
 */
import { type ChartFilter, DEFAULT_BASE_PATH, isValidName, type MetricRequest } from './contract.ts'

/**
 * The query string of a request, with parameters in a stable order (so equal requests make equal
 * URLs, which keeps HTTP caches and React effects quiet).
 *
 * @example
 * toSearchParams({ interval: 'week', filters: [{ field: 'status', op: 'in', value: 'paid,sent' }] }).toString()
 * // 'interval=week&filter%5Bstatus%5D%5Bin%5D=paid%2Csent'
 */
export function toSearchParams(request: MetricRequest): URLSearchParams {
  const params = new URLSearchParams()
  if (request.from !== undefined) params.set('from', request.from)
  if (request.to !== undefined) params.set('to', request.to)
  if (request.interval !== undefined) params.set('interval', request.interval)
  if (request.groupBy !== undefined) params.set('groupBy', request.groupBy)
  if (request.limit !== undefined) params.set('limit', String(request.limit))
  const filters = [...(request.filters ?? [])].sort(compareFilters)
  for (const filter of filters) params.append(`filter[${filter.field}][${filter.op}]`, filter.value)
  return params
}

function compareFilters(a: ChartFilter, b: ChartFilter): number {
  return a.field === b.field ? a.op.localeCompare(b.op) : a.field.localeCompare(b.field)
}

/**
 * The URL of one metric, relative to the app (`/api/_charts/metrics/<name>?…`).
 *
 * @throws TypeError for a name that isn't a valid metric name (it would never match a route).
 *
 * @example
 * metricUrl('invoices.revenue', { interval: 'month' }) // '/api/_charts/metrics/invoices.revenue?interval=month'
 */
export function metricUrl(
  name: string,
  request: MetricRequest = {},
  basePath: string = DEFAULT_BASE_PATH,
): string {
  if (!isValidName(name))
    throw new TypeError(
      `"${name}" is not a metric name. Names are dot-separated lowercase words, e.g. "invoices.revenue".`,
    )
  const query = toSearchParams(request).toString()
  return `${trimSlash(basePath)}/metrics/${name}${query === '' ? '' : `?${query}`}`
}

/**
 * The URL of the manifest (the metrics the signed-in user may view).
 *
 * @example
 * manifestUrl() // '/api/_charts/manifest'
 */
export function manifestUrl(basePath: string = DEFAULT_BASE_PATH): string {
  return `${trimSlash(basePath)}/manifest`
}

function trimSlash(path: string): string {
  return path.endsWith('/') ? path.slice(0, -1) : path
}
