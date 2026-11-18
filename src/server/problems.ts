/**
 * The error model of the charts endpoints: RFC 9457 problems with a stable lowercase `code` and,
 * for bad requests, every issue at once (RFC-0003). Messages come from the catalog.
 *
 * @module
 */
import {
  PROBLEM_CONTENT_TYPE,
  type Problem,
  type ValidationIssue,
} from '@strutvane/framework/contracts'
import { CHARTS_MESSAGES_EN, formatMessage, type MessageCatalog } from '../shared/messages.ts'

/** The problem codes the charts endpoints answer with (a subset of the framework's). */
export type ChartsProblemCode =
  | 'not_found'
  | 'forbidden'
  | 'unauthenticated'
  | 'validation_failed'
  | 'method_not_allowed'
  | 'payload_too_large'
  | 'internal_error'

const STATUS: Readonly<Record<ChartsProblemCode, number>> = Object.freeze({
  not_found: 404,
  forbidden: 403,
  unauthenticated: 401,
  validation_failed: 422,
  method_not_allowed: 405,
  payload_too_large: 422,
  internal_error: 500,
})

const TITLES: Readonly<Record<ChartsProblemCode, string>> = Object.freeze({
  not_found: 'Not found',
  forbidden: 'Forbidden',
  unauthenticated: 'Unauthenticated',
  validation_failed: 'Validation failed',
  method_not_allowed: 'Method not allowed',
  payload_too_large: 'Too many records',
  internal_error: 'Internal error',
})

/**
 * A request the charts endpoint refuses, with what the client needs to know (and nothing more).
 *
 * @example
 * throw new ChartsProblem('validation_failed', [issue('limit', 'charts.issue.limit_invalid', { max: 50 })])
 */
export class ChartsProblem extends Error {
  override readonly name = 'ChartsProblem'
  readonly code: ChartsProblemCode
  readonly issues: readonly ValidationIssue[]

  constructor(
    code: ChartsProblemCode,
    issues: readonly ValidationIssue[] = [],
    options?: ErrorOptions,
  ) {
    super(code, options)
    this.code = code
    this.issues = issues
  }

  /** The HTTP status for this problem. */
  get status(): number {
    return STATUS[this.code]
  }
}

/**
 * One validation issue, its message taken from the catalog.
 *
 * @example
 * issue('interval', 'charts.issue.interval_not_allowed', { allowed: 'day, week' })
 */
export function issue(
  field: string,
  key: string,
  params: Readonly<Record<string, string | number>> = {},
  catalog: MessageCatalog = CHARTS_MESSAGES_EN,
): ValidationIssue {
  const code = key.slice(key.lastIndexOf('.') + 1)
  const safe: Record<string, string | number> = {}
  for (const [name, value] of Object.entries(params)) safe[name] = value
  return { path: [field], field, code, params: safe, message: formatMessage(key, params, catalog) }
}

/**
 * The problem+json response for a {@link ChartsProblem}. `Cache-Control: no-store` always: a
 * 403 or 404 must never be served from a shared cache to someone else.
 *
 * @example
 * return problemResponse(new ChartsProblem('not_found'))
 */
export function problemResponse(
  problem: ChartsProblem,
  catalog: MessageCatalog = CHARTS_MESSAGES_EN,
): Response {
  const body: Problem = {
    type: 'about:blank',
    title: TITLES[problem.code],
    status: problem.status,
    code: problem.code,
    detail: formatMessage(`charts.problem.${problem.code}`, {}, catalog),
    ...(problem.issues.length > 0 ? { issues: problem.issues } : {}),
  }
  const headers: Record<string, string> = {
    'content-type': PROBLEM_CONTENT_TYPE,
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
  }
  if (problem.code === 'method_not_allowed') headers['allow'] = 'GET, HEAD'
  return new Response(JSON.stringify(body), { status: problem.status, headers })
}

/**
 * A JSON 200 response that no shared cache may store (results depend on who asks).
 *
 * @example
 * return jsonResponse(result)
 */
export function jsonResponse(body: unknown, head = false): Response {
  return new Response(head ? null : JSON.stringify(body), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      vary: 'Cookie, Authorization',
    },
  })
}
