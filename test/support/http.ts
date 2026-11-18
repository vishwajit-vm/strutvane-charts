/** Small helpers for calling the charts handler like a browser would. */
import type { ChartsHandler, ChartsRequestContext } from '../../src/server/handler.ts'
import type { MetricResult } from '../../src/shared/contract.ts'

/** A fixed clock: Wednesday 2026-11-18, noon UTC. */
export const NOW: Date = new Date('2026-11-18T12:00:00.000Z')

/** What a call returned: the status, the parsed body and the headers. */
export interface Answer {
  readonly status: number
  readonly body: Record<string, unknown>
  readonly headers: Headers
}

/**
 * Call the handler with a path under the base (e.g. `/metrics/invoices.count?interval=week`).
 *
 * @example
 * const { status, body } = await call(handler, '/metrics/invoices.count', { actor: USER, tenantId: TENANT_A })
 */
export async function call(
  handler: ChartsHandler,
  path: string,
  context: ChartsRequestContext,
  method = 'GET',
): Promise<Answer> {
  const response = await handler.fetch(
    new Request(`http://app.test${handler.basePath}${path}`, { method }),
    context,
  )
  const text = await response.text()
  return {
    status: response.status,
    body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
    headers: response.headers,
  }
}

/** The body as a metric result (fails the test when it isn't 200). */
export function result(answer: Answer): MetricResult {
  if (answer.status !== 200)
    throw new Error(`Expected 200, got ${answer.status}: ${JSON.stringify(answer.body)}`)
  return answer.body as unknown as MetricResult
}

/** `{ key: value }` of a single-series result. */
export function values(answer: Answer, series = 'value'): Record<string, number | null> {
  const out: Record<string, number | null> = {}
  for (const point of result(answer).data) out[point.key] = point.values[series] ?? null
  return out
}

/** The issue codes of a 422. */
export function issueCodes(answer: Answer): string[] {
  const issues = answer.body['issues']
  return Array.isArray(issues)
    ? issues.map((item) => String((item as Record<string, unknown>)['code']))
    : []
}
