/**
 * Declarative widgets and dashboards: what an app writes to put charts on a screen.
 *
 * ```ts
 * export const sales = defineDashboard({
 *   name: 'sales',
 *   label: 'Sales',
 *   widgets: [
 *     defineWidget({ id: 'revenue', kind: 'kpi', title: 'Revenue', metric: 'invoices.revenue', compare: true, format: { style: 'currency', currency: 'EUR' } }),
 *     defineWidget({ id: 'per-month', kind: 'bar', title: 'Invoices per month', metric: 'invoices.per-month', stacked: true, size: 'lg' }),
 *   ],
 * })
 * ```
 *
 * A widget names a **metric** (declared on the server with `defineMetric`) instead of carrying its
 * own query, so the browser never decides what is aggregated. Definitions are plain, frozen data:
 * they can live in a shared file, be listed in a manifest, and be rendered by any renderer (the
 * React one ships in `@strutvane/charts/react`).
 *
 * Browser-safe.
 *
 * @module
 */
import { type Interval, isInterval } from './calendar.ts'
import { isValidName, type MetricRequest } from './contract.ts'

/** The kinds of widget. */
export type WidgetKind = 'kpi' | 'line' | 'area' | 'bar' | 'pie'

/** Every widget kind. */
export const WIDGET_KINDS: readonly WidgetKind[] = Object.freeze([
  'kpi',
  'line',
  'area',
  'bar',
  'pie',
])

/** How much of the dashboard grid a widget takes: a quarter, a third, half, or the full row. */
export type WidgetSize = 'sm' | 'md' | 'lg' | 'full'

/**
 * How numbers are written: `Intl.NumberFormat` options, limited to what a chart needs.
 *
 * @example
 * const money: NumberFormat = { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }
 */
export interface NumberFormat {
  readonly style?: 'decimal' | 'currency' | 'percent'
  /** ISO 4217 code, required for `currency`. */
  readonly currency?: string
  readonly minimumFractionDigits?: number
  readonly maximumFractionDigits?: number
  /** `compact` writes 12.3K instead of 12,345. */
  readonly notation?: 'standard' | 'compact'
}

/** What every widget has. */
interface WidgetBase {
  /** Unique within its dashboard: lowercase words, e.g. `revenue` or `sales.revenue`. */
  readonly id: string
  /** The server metric it draws (`defineMetric({ name })`). */
  readonly metric: string
  readonly title: string
  /** One sentence under the title (also read by screen readers). */
  readonly description?: string
  readonly size?: WidgetSize
  /** Fixed request options (range, interval, filters) sent with every load. */
  readonly request?: MetricRequest
  readonly format?: NumberFormat
}

/**
 * A single number with an optional comparison to the previous period of the same length.
 *
 * @example
 * defineWidget({ id: 'revenue', kind: 'kpi', title: 'Revenue', metric: 'invoices.revenue', compare: true })
 */
export interface KpiWidget extends WidgetBase {
  readonly kind: 'kpi'
  /** Show the change from the previous period (needs a metric with a date field). */
  readonly compare?: boolean
  /** Draw a small trend line under the number (needs a date-grouped metric). */
  readonly sparkline?: boolean
  /** Is a rise good (`up`, the default: revenue) or bad (`down`: churn, errors)? */
  readonly goodDirection?: 'up' | 'down'
}

/**
 * A line or an area over time (or over ordered categories).
 *
 * @example
 * defineWidget({ id: 'signups', kind: 'line', title: 'Sign-ups', metric: 'users.per-day', intervals: ['day', 'week'] })
 */
export interface LineWidget extends WidgetBase {
  readonly kind: 'line' | 'area'
  /** Intervals offered by the switch above the chart; empty or absent: no switch. */
  readonly intervals?: readonly Interval[]
  /** Stack the series (areas only). */
  readonly stacked?: boolean
}

/**
 * Bars: grouped or stacked, vertical or horizontal (long category names read better sideways).
 *
 * @example
 * defineWidget({ id: 'by-status', kind: 'bar', title: 'Invoices by status', metric: 'invoices.by-status', horizontal: true })
 */
export interface BarWidget extends WidgetBase {
  readonly kind: 'bar'
  readonly intervals?: readonly Interval[]
  readonly stacked?: boolean
  readonly horizontal?: boolean
}

/**
 * A pie or donut of one series. Best for 2–6 parts; more become hard to compare (use bars).
 *
 * @example
 * defineWidget({ id: 'status', kind: 'pie', title: 'Status', metric: 'invoices.by-status', donut: true })
 */
export interface PieWidget extends WidgetBase {
  readonly kind: 'pie'
  readonly donut?: boolean
}

/** Any widget. */
export type WidgetDefinition = KpiWidget | LineWidget | BarWidget | PieWidget

/**
 * A named dashboard: an ordered list of widgets.
 *
 * @example
 * const home: DashboardDefinition = { name: 'home', label: 'Dashboard', widgets: [] }
 */
export interface DashboardDefinition {
  readonly name: string
  readonly label: string
  readonly description?: string
  readonly widgets: readonly WidgetDefinition[]
}

/**
 * A definition is wrong. Thrown when the app defines it (at import or boot), never on a request,
 * and the message says how to fix it.
 *
 * @example
 * try { defineWidget(bad) } catch (error) { if (error instanceof ChartsDefinitionError) … }
 */
export class ChartsDefinitionError extends Error {
  override readonly name = 'ChartsDefinitionError'
}

const SIZES: ReadonlySet<string> = new Set(['sm', 'md', 'lg', 'full'])
const CURRENCY = /^[A-Z]{3}$/

/**
 * Check and freeze a widget definition.
 *
 * @throws ChartsDefinitionError naming the problem and the fix.
 *
 * @example
 * export const revenue = defineWidget({ id: 'revenue', kind: 'kpi', title: 'Revenue', metric: 'invoices.revenue' })
 */
export function defineWidget<const T extends WidgetDefinition>(definition: T): T {
  const where = `Widget "${String(definition.id)}"`
  if (typeof definition.id !== 'string' || !isValidName(definition.id))
    fail(
      `${where}: the id must be lowercase words separated by dots, e.g. "revenue" or "sales.revenue".`,
    )
  if (!(WIDGET_KINDS as readonly string[]).includes(definition.kind))
    fail(`${where}: kind must be one of ${WIDGET_KINDS.join(', ')}.`)
  if (typeof definition.metric !== 'string' || !isValidName(definition.metric))
    fail(`${where}: metric must name a server metric, e.g. "invoices.revenue".`)
  if (typeof definition.title !== 'string' || definition.title.trim() === '')
    fail(`${where}: give it a title; it is also the chart's accessible name.`)
  if (definition.size !== undefined && !SIZES.has(definition.size))
    fail(`${where}: size must be sm, md, lg or full.`)
  if (definition.format !== undefined) checkFormat(where, definition.format)
  if ('intervals' in definition && definition.intervals !== undefined) {
    for (const interval of definition.intervals)
      if (!isInterval(interval)) fail(`${where}: intervals may only contain day, week and month.`)
  }
  if (definition.kind === 'bar' && definition.horizontal === true && definition.stacked === true)
    fail(`${where}: horizontal bars can't be stacked yet; drop one of the two options.`)
  return deepFreeze(definition)
}

function checkFormat(where: string, format: NumberFormat): void {
  if (
    format.style === 'currency' &&
    (format.currency === undefined || !CURRENCY.test(format.currency))
  )
    fail(`${where}: a currency format needs a three-letter ISO code, e.g. { currency: 'EUR' }.`)
  for (const digits of [format.minimumFractionDigits, format.maximumFractionDigits]) {
    if (digits !== undefined && (!Number.isInteger(digits) || digits < 0 || digits > 6))
      fail(`${where}: fraction digits must be whole numbers from 0 to 6.`)
  }
}

/**
 * Check and freeze a dashboard: a valid name, a label, and unique widget ids.
 *
 * @throws ChartsDefinitionError naming the problem and the fix.
 *
 * @example
 * export const sales = defineDashboard({ name: 'sales', label: 'Sales', widgets: [revenue] })
 */
export function defineDashboard<const T extends DashboardDefinition>(definition: T): T {
  const where = `Dashboard "${String(definition.name)}"`
  if (typeof definition.name !== 'string' || !isValidName(definition.name))
    fail(`${where}: the name must be lowercase words separated by dots, e.g. "sales".`)
  if (typeof definition.label !== 'string' || definition.label.trim() === '')
    fail(`${where}: give it a label; it is the page heading.`)
  const seen = new Set<string>()
  for (const widget of definition.widgets) {
    defineWidget(widget)
    if (seen.has(widget.id))
      fail(`${where}: two widgets have the id "${widget.id}". Ids must be unique per dashboard.`)
    seen.add(widget.id)
  }
  return deepFreeze(definition)
}

function fail(message: string): never {
  throw new ChartsDefinitionError(message)
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const inner of Object.values(value)) deepFreeze(inner)
  }
  return value
}
