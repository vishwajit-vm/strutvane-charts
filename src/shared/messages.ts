/**
 * Every sentence the package shows or sends, in one catalog (RFC-0003: messages come from
 * catalogs, never hard-coded). Apps translate by passing a partial catalog over this one; keys are
 * stable, and the server's problem `code`s match the `charts.issue.*` keys.
 *
 * Placeholders are `{name}` and are filled by {@link formatMessage}; a missing parameter stays
 * visible as `{name}` rather than becoming "undefined".
 *
 * Browser-safe.
 *
 * @module
 */

/** A message catalog: key → text with `{placeholders}`. */
export type MessageCatalog = Readonly<Record<string, string>>

/** The English catalog. */
export const CHARTS_MESSAGES_EN: MessageCatalog = Object.freeze({
  // Server: problem details
  'charts.problem.not_found': 'There is no chart metric with this name.',
  'charts.problem.forbidden': 'You may not view this chart.',
  'charts.problem.unauthenticated': 'Sign in to view this chart.',
  'charts.problem.validation_failed': 'The chart request has invalid parameters.',
  'charts.problem.method_not_allowed': 'Chart data can only be read (GET).',
  'charts.problem.internal_error': 'The chart could not be computed. The error was logged.',
  'charts.problem.payload_too_large':
    'This chart covers too many records to compute. Choose a shorter period or add a filter.',
  'charts.problem.rate_limited': 'Too many chart requests. Wait a moment and try again.',
  // Server: validation issues (one per problem with the request)
  'charts.issue.unknown_parameter':
    '"{parameter}" is not a chart parameter. Use from, to, interval, groupBy, limit or filter[field][op].',
  'charts.issue.repeated_parameter': '"{parameter}" was given more than once. Give it once.',
  'charts.issue.too_many_parameters': 'The request has too many parameters (at most {max}).',
  'charts.issue.invalid_date':
    '"{parameter}" must be a UTC date (YYYY-MM-DD) or timestamp ending in Z, in the years 1900–9998.',
  'charts.issue.empty_range': '"from" must be before "to".',
  'charts.issue.too_many_buckets':
    'This range has {count} {interval} buckets; at most {max} fit in one chart. Choose a shorter range or a larger interval.',
  'charts.issue.interval_not_allowed': 'interval must be one of: {allowed}.',
  'charts.issue.interval_without_date':
    'interval only applies when grouping by a date; this chart groups by {groupBy}.',
  'charts.issue.range_without_date': 'This chart has no date field, so from and to do not apply.',
  'charts.issue.group_not_allowed': 'groupBy must be one of: {allowed}.',
  'charts.issue.limit_invalid': 'limit must be a whole number from 1 to {max}.',
  'charts.issue.limit_not_allowed': 'limit only applies to charts grouped by a related record.',
  'charts.issue.filter_not_allowed':
    'Filtering on "{field}" is not allowed. Filterable: {allowed}.',
  'charts.issue.filter_not_allowed_none': 'This chart takes no filters.',
  'charts.issue.filter_operator':
    '"{op}" is not a filter operator. Use one of: eq, ne, in, gt, gte, lt, lte, null.',
  'charts.issue.filter_value': 'The value for {field} [{op}] is not valid: {reason}.',
  'charts.issue.filter_with_privacy':
    'This chart hides small groups for privacy, so it cannot be filtered: a filter could single out a person.',
  // Browser
  'charts.ui.loading': 'Loading chart',
  'charts.ui.retry': 'Retry',
  'charts.ui.empty': 'No data for this period.',
  'charts.ui.show_table': 'Show as a table',
  'charts.ui.hide_table': 'Show as a chart',
  'charts.ui.interval': 'Interval',
  'charts.ui.interval.day': 'Day',
  'charts.ui.interval.week': 'Week',
  'charts.ui.interval.month': 'Month',
  'charts.ui.total': 'Total',
  'charts.ui.other': 'Other',
  'charts.ui.none': 'None',
  'charts.ui.value': 'Value',
  'charts.ui.yes': 'Yes',
  'charts.ui.no': 'No',
  'charts.ui.hidden': 'Hidden (too few records)',
  'charts.ui.privacy_note': 'Groups with fewer than {min} records are hidden to protect privacy.',
  'charts.ui.no_value': 'No value',
  'charts.ui.change_up': 'Up {percent} from the previous period',
  'charts.ui.change_down': 'Down {percent} from the previous period',
  'charts.ui.change_flat': 'No change from the previous period',
  'charts.ui.change_new': 'New this period (nothing in the previous one)',
  'charts.ui.summary_series':
    '{title}: {count} points. Highest {max} at {maxLabel}, lowest {min} at {minLabel}.',
  'charts.ui.summary_parts': '{title}: {count} parts. Largest is {maxLabel} with {max}.',
  'charts.ui.summary_empty': '{title}: no data.',
  'charts.ui.keyboard_hint': 'Use the arrow keys to move between points.',
  'charts.ui.group': 'Group',
  'charts.ui.error.network': 'The chart could not be loaded. Check your connection and retry.',
  'charts.ui.error.server': 'The server could not compute this chart. Retry in a moment.',
  'charts.ui.error.forbidden': 'You do not have access to this chart.',
  'charts.ui.error.unauthenticated': 'Sign in again to see this chart.',
  'charts.ui.error.not_found': 'This chart is not available.',
  'charts.ui.error.validation': 'This chart is set up with invalid options: {detail}',
  'charts.ui.error.too_large': 'Too many records for one chart. Choose a shorter period.',
  'charts.ui.error.rate_limited': 'Too many requests. Retry in a moment.',
})

/**
 * Fill a message's `{placeholders}`. Unknown keys fall back to the key itself, so a missing
 * translation is visible instead of blank.
 *
 * @example
 * formatMessage('charts.issue.limit_invalid', { max: 50 }) // 'limit must be a whole number from 1 to 50.'
 */
export function formatMessage(
  key: string,
  params: Readonly<Record<string, string | number>> = {},
  catalog: MessageCatalog = CHARTS_MESSAGES_EN,
): string {
  const template = Object.hasOwn(catalog, key)
    ? catalog[key]
    : Object.hasOwn(CHARTS_MESSAGES_EN, key)
      ? CHARTS_MESSAGES_EN[key]
      : undefined
  if (template === undefined) return key
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : whole,
  )
}
