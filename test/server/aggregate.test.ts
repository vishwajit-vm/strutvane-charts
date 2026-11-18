/**
 * Aggregate correctness on real engines (node:sqlite and PGlite): the same rows give the same
 * numbers on both, through the framework's query builder. Covers every function, every group
 * kind, bucket boundaries, splits, top N, filters and the ungrouped count fast path.
 */
import type { Connection } from '@strutvane/framework/database'
import { runWithTenant } from '@strutvane/framework/database'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { createChartsHandler } from '../../src/server/handler.ts'
import { defineMetric } from '../../src/server/metric.ts'
import {
  clearTables,
  ENGINES,
  Invoice,
  openEngine,
  permissions,
  seedInvoices,
  TENANT_A,
  USER,
} from '../support/fixture.ts'
import { call, NOW, result, values } from '../support/http.ts'

const metrics = [
  defineMetric({
    name: 'invoices.count',
    model: Invoice,
    aggregate: 'count',
    dateField: false,
  }),
  defineMetric({
    name: 'invoices.by-status',
    model: Invoice,
    aggregate: 'count',
    groupBy: ['status', 'paid', 'customer_id'],
    dateField: false,
  }),
  defineMetric({
    name: 'invoices.avg-by-status',
    model: Invoice,
    aggregate: { fn: 'avg', field: 'total' },
    groupBy: 'status',
    dateField: false,
  }),
  defineMetric({
    name: 'invoices.min-by-paid',
    model: Invoice,
    aggregate: { fn: 'min', field: 'total' },
    groupBy: 'paid',
    dateField: false,
  }),
  defineMetric({
    name: 'invoices.max-by-paid',
    model: Invoice,
    aggregate: { fn: 'max', field: 'total' },
    groupBy: 'paid',
    dateField: false,
  }),
  defineMetric({
    name: 'invoices.revenue',
    label: 'Revenue',
    model: Invoice,
    aggregate: { fn: 'sum', field: 'total' },
    groupBy: { field: 'issued_on', interval: 'month' },
  }),
  defineMetric({
    name: 'invoices.sent',
    model: Invoice,
    aggregate: 'count',
    groupBy: { field: 'sent_at', interval: 'month' },
  }),
  defineMetric({
    name: 'invoices.split',
    model: Invoice,
    aggregate: 'count',
    groupBy: { field: 'issued_on', interval: 'month' },
    splitBy: 'paid',
  }),
  defineMetric({
    name: 'invoices.totals',
    model: Invoice,
    aggregate: { fn: 'sum', field: 'quantity' },
    dateField: 'issued_on',
  }),
  defineMetric({
    name: 'invoices.discounts',
    model: Invoice,
    aggregate: { fn: 'sum', field: 'discount' },
    dateField: false,
  }),
  defineMetric({
    name: 'invoices.filtered',
    model: Invoice,
    aggregate: 'count',
    dateField: false,
    filterable: ['status', 'total', 'customer_id', 'paid', 'issued_on', 'sent_at', 'discount'],
  }),
]

describe.each(ENGINES)('aggregates on %s', (engine) => {
  let connection: Connection
  const handler = createChartsHandler({ metrics, permissions: permissions(), now: () => NOW })
  const ask = (path: string) => call(handler, path, { actor: USER, tenantId: TENANT_A })

  beforeAll(async () => {
    connection = await openEngine(engine)
  })
  afterAll(async () => {
    await connection.close()
  })
  beforeEach(async () => {
    await clearTables(connection)
    await seedInvoices(TENANT_A, [
      {
        status: 'paid',
        paid: true,
        total: '100.10',
        discount: 1.5,
        quantity: 2,
        issued_on: '2026-09-30',
        sent_at: new Date('2026-09-30T23:59:59.999Z'),
        customer_id: 1,
      },
      {
        status: 'paid',
        paid: true,
        total: '200.20',
        quantity: 3,
        issued_on: '2026-10-01',
        sent_at: new Date('2026-10-01T00:00:00.000Z'),
        customer_id: 1,
      },
      {
        status: 'sent',
        total: '50.05',
        discount: 2.25,
        issued_on: '2026-10-15',
        sent_at: new Date('2026-11-08T23:59:59.000Z'),
        customer_id: 2,
      },
      {
        status: 'draft',
        total: null,
        quantity: 5,
        issued_on: '2026-11-02',
        sent_at: new Date('2026-11-09T00:00:00.000Z'),
      },
      {
        status: 'sent',
        total: '0.01',
        issued_on: '2026-11-17',
        sent_at: new Date('2026-11-17T10:00:00.000Z'),
        customer_id: 3,
      },
    ])
    // A soft-deleted invoice never counts.
    const [deleted] = await seedInvoices(TENANT_A, [
      { status: 'paid', paid: true, total: '999.99', issued_on: '2026-11-10', customer_id: 9 },
    ])
    await runWithTenant(TENANT_A, async () => {
      await (deleted as { delete(): Promise<unknown> }).delete()
    })
  })

  test('an ungrouped count is one total (soft-deleted rows excluded)', async () => {
    const answer = await ask('/metrics/invoices.count')
    expect(values(answer)).toEqual({ __total__: 5 })
    expect(result(answer).meta).toMatchObject({ groupKind: 'none', fn: 'count', timezone: 'UTC' })
  })

  test('counts by enum are zero-filled in declaration order', async () => {
    const answer = await ask('/metrics/invoices.by-status')
    expect(result(answer).data.map((point) => point.key)).toEqual(['draft', 'sent', 'paid', 'void'])
    expect(values(answer)).toEqual({ draft: 1, sent: 2, paid: 2, void: 0 })
  })

  test('booleans group as true/false on every engine', async () => {
    expect(values(await ask('/metrics/invoices.by-status?groupBy=paid'))).toEqual({
      true: 2,
      false: 3,
    })
  })

  test('top N by relation keeps ties in key order, folds the rest into other, NULL last', async () => {
    const answer = await ask('/metrics/invoices.by-status?groupBy=customer_id&limit=2')
    expect(result(answer).data.map((point) => point.key)).toEqual([
      '1',
      '2',
      '__other__',
      '__none__',
    ])
    expect(values(answer)).toEqual({ '1': 2, '2': 1, __other__: 1, __none__: 1 })
    expect(result(answer).meta.truncated).toBe(true)
  })

  test('averages skip NULL and are null for an empty group', async () => {
    expect(values(await ask('/metrics/invoices.avg-by-status'))).toEqual({
      draft: null,
      sent: 25.03,
      paid: 150.15,
      void: null,
    })
  })

  test('min and max per group', async () => {
    expect(values(await ask('/metrics/invoices.min-by-paid'))).toEqual({ true: 100.1, false: 0.01 })
    expect(values(await ask('/metrics/invoices.max-by-paid'))).toEqual({
      true: 200.2,
      false: 50.05,
    })
  })

  test('decimal sums per month are exact (no float drift) and empty months are zero', async () => {
    const answer = await ask('/metrics/invoices.revenue?from=2026-08-01&to=2026-12-01')
    expect(values(answer)).toEqual({
      '2026-08-01': 0,
      '2026-09-01': 100.1,
      '2026-10-01': 250.25,
      '2026-11-01': 0.01,
    })
    expect(result(answer).meta).toMatchObject({
      label: 'Revenue',
      groupKind: 'date',
      interval: 'month',
      from: '2026-08-01T00:00:00.000Z',
      to: '2026-12-01T00:00:00.000Z',
    })
  })

  test('the last millisecond of September and midnight on 1 October are different months', async () => {
    const answer = await ask('/metrics/invoices.sent?from=2026-09-01&to=2026-12-01')
    expect(values(answer)).toEqual({ '2026-09-01': 1, '2026-10-01': 1, '2026-11-01': 3 })
  })

  test('weeks start on Monday: Sunday 23:59:59 and Monday 00:00 are different weeks', async () => {
    const answer = await ask('/metrics/invoices.sent?interval=week&from=2026-11-02&to=2026-11-23')
    expect(values(answer)).toEqual({ '2026-11-02': 1, '2026-11-09': 1, '2026-11-16': 1 })
  })

  test('days are zero-filled, and a range is aligned to whole buckets', async () => {
    const answer = await ask(
      '/metrics/invoices.sent?interval=day&from=2026-11-07T15:00:00Z&to=2026-11-09T01:00:00Z',
    )
    expect(values(answer)).toEqual({ '2026-11-07': 0, '2026-11-08': 1, '2026-11-09': 1 })
    expect(result(answer).meta.from).toBe('2026-11-07T00:00:00.000Z')
    expect(result(answer).meta.to).toBe('2026-11-10T00:00:00.000Z')
  })

  test('the default window is the last 12 months up to the current one', async () => {
    const meta = result(await ask('/metrics/invoices.sent')).meta
    expect(meta.from).toBe('2025-12-01T00:00:00.000Z')
    expect(meta.to).toBe('2026-12-01T00:00:00.000Z')
  })

  test('a split gives one series per value, zero-filled', async () => {
    const answer = await ask('/metrics/invoices.split?from=2026-09-01&to=2026-12-01')
    const data = result(answer)
    expect(data.series.map((series) => series.key)).toEqual(['true', 'false'])
    expect(data.data).toEqual([
      { key: '2026-09-01', values: { true: 1, false: 0 } },
      { key: '2026-10-01', values: { true: 1, false: 1 } },
      { key: '2026-11-01', values: { true: 0, false: 2 } },
    ])
  })

  test('integer and double sums, limited by a DATE range field', async () => {
    expect(values(await ask('/metrics/invoices.totals?from=2026-10-01&to=2026-11-01'))).toEqual({
      __total__: 4,
    })
    expect(values(await ask('/metrics/invoices.discounts'))).toEqual({ __total__: 3.75 })
  })

  test('filters: in, decimal gte, null, NULL-safe ne, boolean eq, date and timestamp ranges', async () => {
    const count = async (query: string) =>
      values(await ask(`/metrics/invoices.filtered?${query}`))['__total__']
    expect(await count('filter[status][in]=paid,sent')).toBe(4)
    expect(await count('filter[total][gte]=100.10')).toBe(2)
    expect(await count('filter[customer_id][null]=true')).toBe(1)
    expect(await count('filter[customer_id][null]=false')).toBe(4)
    // NULL-safe: the invoice without a customer is "not customer 1" too.
    expect(await count('filter[customer_id][ne]=1')).toBe(3)
    expect(await count('filter[paid][eq]=true')).toBe(2)
    expect(await count('filter[issued_on][lt]=2026-10-02')).toBe(2)
    expect(await count('filter[sent_at][gte]=2026-11-09T00:00:00Z')).toBe(2)
    expect(await count('filter[discount][gt]=2')).toBe(1)
    expect(await count('filter[status][eq]=void')).toBe(0)
  })

  test('HEAD answers the headers only; results are never stored by shared caches', async () => {
    const head = await call(
      handler,
      '/metrics/invoices.count',
      { actor: USER, tenantId: TENANT_A },
      'HEAD',
    )
    expect(head.status).toBe(200)
    expect(head.body).toEqual({})
    const answer = await ask('/metrics/invoices.count')
    expect(answer.headers.get('cache-control')).toBe('private, no-store')
    expect(answer.headers.get('content-type')).toContain('application/json')
  })
})
