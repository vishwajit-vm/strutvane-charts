/**
 * Attack-style tests for the charts endpoint, on both engines:
 * - tenant A never sees tenant B, through any metric shape, and no tenant means no data;
 * - the actor's row filter (policy) limits every number, and a broken policy fails closed;
 * - permission is checked before validation, so field names never leak to outsiders;
 * - unknown, malformed and hostile metric names all get one identical 404;
 * - hidden, secret, tenant and id columns can't be aggregated, grouped or filtered, and are never
 *   named in hints;
 * - injection through parameter names, group fields and filter values goes nowhere;
 * - small-group suppression (with complementary cells), and privacy refusing filters;
 * - a seeded fuzz of random requests only ever answers 200 or 422.
 */
import type { Connection } from '@strutvane/framework/database'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { createChartsHandler } from '../../src/server/handler.ts'
import { defineMetric, resolveMetric } from '../../src/server/metric.ts'
import { ChartsDefinitionError } from '../../src/shared/widgets.ts'
import {
  clearTables,
  Employee,
  ENGINES,
  Invoice,
  openEngine,
  permissions,
  seedEmployees,
  seedInvoices,
  TENANT_A,
  TENANT_B,
  USER,
} from '../support/fixture.ts'
import { call, issueCodes, NOW, result, values } from '../support/http.ts'

const BIG = '1000000.00'

const metrics = [
  defineMetric({ name: 'invoices.count', model: Invoice, aggregate: 'count', dateField: false }),
  defineMetric({
    name: 'invoices.revenue',
    model: Invoice,
    aggregate: { fn: 'sum', field: 'total' },
    groupBy: [{ field: 'issued_on', interval: 'day' }, 'status', 'customer_id'],
    splitBy: 'paid',
    filterable: ['status', 'total'],
  }),
  defineMetric({
    name: 'invoices.avg',
    model: Invoice,
    aggregate: { fn: 'avg', field: 'total' },
    groupBy: 'customer_id',
    limit: 1,
    dateField: false,
  }),
  defineMetric({
    name: 'employees.salary',
    model: Employee,
    aggregate: { fn: 'avg', field: 'salary' },
    groupBy: 'department',
    splitBy: 'remote',
    dateField: false,
    privacy: { minGroupSize: 5 },
  }),
  defineMetric({
    name: 'employees.headcount',
    model: Employee,
    aggregate: 'count',
    groupBy: 'department',
    dateField: false,
    privacy: { minGroupSize: 5 },
  }),
  defineMetric({
    name: 'employees.total',
    model: Employee,
    aggregate: 'count',
    dateField: false,
    privacy: { minGroupSize: 5 },
  }),
]

describe.each(ENGINES)('security on %s', (engine) => {
  let connection: Connection
  const open = createChartsHandler({ metrics, permissions: permissions(), now: () => NOW })
  const asA = (path: string) => call(open, path, { actor: USER, tenantId: TENANT_A })
  const asB = (path: string) => call(open, path, { actor: USER, tenantId: TENANT_B })

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
        total: '10.00',
        issued_on: '2026-11-17',
        customer_id: 1,
        owner_id: 7,
      },
      { status: 'sent', total: '20.00', issued_on: '2026-11-18', customer_id: 2, owner_id: 8 },
    ])
    // Tenant B's rows are huge, so any leak shows up in every number.
    await seedInvoices(TENANT_B, [
      {
        status: 'paid',
        paid: true,
        total: BIG,
        issued_on: '2026-11-17',
        customer_id: 1,
        owner_id: 7,
      },
      { status: 'void', total: BIG, issued_on: '2026-11-18', customer_id: 99, owner_id: 7 },
      { status: 'draft', total: BIG, issued_on: '2026-11-18', customer_id: 98, owner_id: 7 },
    ])
  })

  describe('tenancy', () => {
    test('tenant A never sees tenant B: totals, days, categories, relations, splits, other', async () => {
      expect(values(await asA('/metrics/invoices.count'))).toEqual({ __total__: 2 })
      const days = result(await asA('/metrics/invoices.revenue?from=2026-11-17&to=2026-11-19'))
      expect(days.data).toEqual([
        { key: '2026-11-17', values: { true: 10, false: 0 } },
        { key: '2026-11-18', values: { true: 0, false: 20 } },
      ])
      const statuses = result(
        await asA('/metrics/invoices.revenue?groupBy=status&from=2026-11-01&to=2026-12-01'),
      )
      expect(JSON.stringify(statuses)).not.toContain('1000000')
      const relations = result(
        await asA('/metrics/invoices.revenue?groupBy=customer_id&from=2026-11-01&to=2026-12-01'),
      )
      expect(relations.data.map((point) => point.key)).toEqual(['2', '1'])
      expect(JSON.stringify(relations)).not.toMatch(/1000000|"99"|"98"/)
      expect(values(await asA('/metrics/invoices.avg'))).toEqual({ '2': 20, __other__: 10 })
    })

    test('tenant B sees exactly its own rows', async () => {
      expect(values(await asB('/metrics/invoices.count'))).toEqual({ __total__: 3 })
      expect(values(await asB('/metrics/invoices.avg'))).toEqual({
        '1': 1_000_000,
        __other__: 1_000_000,
      })
    })

    test('no tenant: tenant tables answer 403, never every tenant', async () => {
      const answer = await call(open, '/metrics/invoices.count', { actor: USER })
      expect(answer.status).toBe(403)
      expect(answer.body['code']).toBe('forbidden')
    })

    test('the tenant column is not a usable field at all', () => {
      expect(() =>
        resolveMetric(
          defineMetric({
            name: 'x.tenants',
            model: Invoice,
            aggregate: 'count',
            groupBy: 'tenant_id',
          }),
        ),
      ).toThrow(ChartsDefinitionError)
    })
  })

  describe('authorization', () => {
    test("the actor's row filter limits every number", async () => {
      const own = createChartsHandler({
        metrics,
        now: () => NOW,
        permissions: permissions({
          filter: { field: 'owner_id', op: 'eq', value: { $actor: 'attrs.ownerId' } },
        }),
      })
      const answer = await call(own, '/metrics/invoices.count', { actor: USER, tenantId: TENANT_A })
      expect(values(answer)).toEqual({ __total__: 1 })
    })

    test('a row filter of FALSE with no permission is 403; for a guest it is 401', async () => {
      const closed = createChartsHandler({ metrics, permissions: permissions({ allow: false }) })
      const member = await call(closed, '/metrics/invoices.count', {
        actor: USER,
        tenantId: TENANT_A,
      })
      expect(member.status).toBe(403)
      const guest = await call(closed, '/metrics/invoices.count', {
        actor: null,
        tenantId: TENANT_A,
      })
      expect(guest.status).toBe(401)
      expect(guest.body['code']).toBe('unauthenticated')
    })

    test('permission is checked before validation: no field names leak in a 403', async () => {
      const closed = createChartsHandler({ metrics, permissions: permissions({ allow: false }) })
      const answer = await call(closed, '/metrics/invoices.revenue?groupBy=nope&filter[x][eq]=1', {
        actor: USER,
        tenantId: TENANT_A,
      })
      expect(answer.status).toBe(403)
      expect(answer.body['issues']).toBeUndefined()
      expect(JSON.stringify(answer.body)).not.toMatch(/customer_id|issued_on|"total"|allowed/)
    })

    test('the permission checked is <table>.viewAny (or the metric permission)', async () => {
      const provider = permissions()
      const handler = createChartsHandler({
        metrics: [
          defineMetric({
            name: 'custom.perm',
            model: Invoice,
            aggregate: 'count',
            permission: 'billing',
            dateField: false,
          }),
          ...metrics,
        ],
        permissions: provider,
      })
      await call(handler, '/metrics/invoices.count', { actor: USER, tenantId: TENANT_A })
      await call(handler, '/metrics/custom.perm', { actor: USER, tenantId: TENANT_A })
      expect(provider.calls).toEqual([
        'can:invoices.viewAny',
        'filter:invoices.viewAny',
        'can:billing.viewAny',
        'filter:billing.viewAny',
      ])
    })

    test('a policy that cannot be bound fails closed with a generic 500, logged', async () => {
      const logged: string[] = []
      const broken = createChartsHandler({
        metrics,
        permissions: permissions({ filter: { field: 'no_such_column', op: 'eq', value: 1 } }),
        logger: recordingLogger(logged),
      })
      const answer = await call(broken, '/metrics/invoices.count', {
        actor: USER,
        tenantId: TENANT_A,
      })
      expect(answer.status).toBe(500)
      expect(JSON.stringify(answer.body)).not.toContain('no_such_column')
      expect(logged.join('\n')).toContain('charts.metric_failed')
    })
  })

  describe('names and injection', () => {
    test('unknown, malformed and hostile metric names share one 404 body', async () => {
      const bodies = new Set<string>()
      for (const name of [
        'nope',
        'invoices.nope',
        '..%2F..%2Fetc%2Fpasswd',
        'INVOICES.COUNT',
        'invoices.count%00',
        "invoices.count'--",
        'a'.repeat(300),
        '__proto__',
        'constructor',
      ]) {
        const answer = await asA(`/metrics/${name}`)
        expect(answer.status, name).toBe(404)
        bodies.add(JSON.stringify(answer.body))
      }
      expect(bodies.size).toBe(1)
      expect((await asA('/nothing-here')).status).toBe(404)
    })

    test('hidden, secret, id, tenant and soft-delete columns are never usable', () => {
      for (const field of ['api_token', 'internal_note', 'id', 'tenant_id', 'deleted_at', 'notes'])
        expect(
          () =>
            resolveMetric(
              defineMetric({
                name: `x.${field.replace('_', '-')}`,
                model: Invoice,
                aggregate: 'count',
                groupBy: field,
              }),
            ),
          field,
        ).toThrow(ChartsDefinitionError)
      let message = ''
      try {
        resolveMetric(
          defineMetric({ name: 'x.y', model: Invoice, aggregate: 'count', groupBy: 'api_token' }),
        )
      } catch (error) {
        message = (error as Error).message
      }
      // The hint lists usable columns only, never the hidden or secret ones.
      const listed = (message.split('Usable: ')[1] ?? '').split('.')[0]?.split(', ') ?? []
      expect(listed).toContain('status')
      for (const secret of ['api_token', 'internal_note', 'tenant_id', 'deleted_at', 'id', 'notes'])
        expect(listed).not.toContain(secret)
    })

    test('group and filter names outside the allow-list are 422s that name only allowed fields', async () => {
      const group = await asA('/metrics/invoices.revenue?groupBy=api_token')
      expect(group.status).toBe(422)
      expect(issueCodes(group)).toEqual(['group_not_allowed'])
      expect(JSON.stringify(group.body)).not.toContain('internal_note')
      for (const field of ['api_token', 'internal_note', 'tenant_id', 'owner_id', 'id']) {
        const answer = await asA(`/metrics/invoices.revenue?filter[${field}][eq]=1`)
        expect(answer.status, field).toBe(422)
        expect(issueCodes(answer), field).toEqual(['filter_not_allowed'])
      }
    })

    test('SQL in parameter names never reaches the builder; SQL in values is just a value', async () => {
      const names = [
        'filter[status;DROP TABLE invoices][eq]=x',
        'filter[status][eq) OR 1=1 --]=x',
        "groupBy=status'--",
        'groupBy=status) UNION SELECT api_token FROM invoices --',
        'interval=day;DELETE',
        'filter%5Bstatus%5D%5Beq%5D%00=paid',
      ]
      for (const query of names) {
        const answer = await asA(`/metrics/invoices.revenue?${query}`)
        expect(answer.status, query).toBe(422)
      }
      const enumValue = await asA("/metrics/invoices.revenue?filter[status][eq]=paid' OR '1'='1")
      expect(enumValue.status).toBe(422)
      expect(issueCodes(enumValue)).toEqual(['filter_value'])
      const decimal = await asA('/metrics/invoices.revenue?filter[total][gte]=0 OR 1=1')
      expect(decimal.status).toBe(422)
      // The table is intact and the numbers unchanged.
      expect(values(await asA('/metrics/invoices.count'))).toEqual({ __total__: 2 })
    })

    test('every problem with a request is reported at once', async () => {
      const answer = await asA(
        '/metrics/invoices.revenue?interval=year&from=2026-02-30&limit=3&bogus=1&filter[status][like]=x',
      )
      expect(answer.status).toBe(422)
      expect(issueCodes(answer).sort()).toEqual(
        [
          'filter_operator',
          'interval_not_allowed',
          'invalid_date',
          'limit_not_allowed',
          'unknown_parameter',
        ].sort(),
      )
    })
  })

  describe('privacy', () => {
    beforeEach(async () => {
      await seedEmployees(TENANT_A, [
        ['sales', '50000.00'],
        ['sales', '52000.00'],
        ['sales', '54000.00', true],
        ['sales', '56000.00', true],
        ['sales', '58000.00', true],
        ['sales', '60000.00', true],
        ['sales', '62000.00', true],
        ['legal', '150000.00'],
        ['eng', '90000.00'],
        ['eng', '91000.00'],
        ['eng', '92000.00'],
        ['eng', '93000.00'],
        ['eng', '94000.00'],
        ['eng', '95000.00', true],
        ['eng', '96000.00', true],
        ['eng', '97000.00', true],
        ['eng', '98000.00', true],
        ['eng', '99000.00', true],
      ])
    })

    test('groups of 1–4 people are hidden, and so is their complementary partner', async () => {
      const answer = result(await asA('/metrics/employees.headcount'))
      // legal (1 person) is hidden; the next smallest non-empty group (sales, 7) is hidden too, so
      // "total minus the others" can't recover legal. ops (0) is shown: nobody is in it.
      expect(answer.data).toEqual([
        { key: 'sales', values: { value: null }, suppressed: ['value'] },
        { key: 'legal', values: { value: null }, suppressed: ['value'] },
        { key: 'eng', values: { value: 10 } },
        { key: 'ops', values: { value: 0 } },
      ])
      expect(answer.meta.minGroupSize).toBe(5)
      expect(answer.meta.suppressedCells).toBe(2)
      expect(JSON.stringify(answer)).not.toContain('150000')
    })

    test('a split hides small cells in both directions', async () => {
      const answer = result(await asA('/metrics/employees.salary'))
      const legal = answer.data.find((point) => point.key === 'legal')
      expect(legal?.values).toEqual({ true: null, false: null })
      // Nobody's salary is recoverable: every visible average covers at least 5 people.
      expect(JSON.stringify(answer)).not.toContain('150000')
      for (const point of answer.data)
        for (const series of Object.keys(point.values))
          if (point.values[series] !== null && point.values[series] !== 0)
            expect(['eng:true', 'eng:false', 'sales:true']).toContain(`${point.key}:${series}`)
    })

    test('an ungrouped total under the floor is hidden too', async () => {
      await clearTables(connection)
      await seedEmployees(TENANT_A, [['legal', '150000.00']])
      expect(values(await asA('/metrics/employees.total'))).toEqual({ __total__: null })
    })

    test('privacy metrics refuse every filter (differencing attacks)', async () => {
      const answer = await asA('/metrics/employees.headcount?filter[department][eq]=legal')
      expect(answer.status).toBe(422)
      expect(issueCodes(answer)).toEqual(['filter_with_privacy'])
    })

    test('min/max and filterable fields are refused on privacy metrics at definition time', () => {
      expect(() =>
        defineMetric({
          name: 'employees.max',
          model: Employee,
          aggregate: { fn: 'max', field: 'salary' },
          privacy: { minGroupSize: 5 },
        }),
      ).toThrow(/defeats privacy/)
      expect(() =>
        defineMetric({
          name: 'employees.f',
          model: Employee,
          aggregate: 'count',
          filterable: ['department'],
          privacy: { minGroupSize: 5 },
        }),
      ).toThrow(/differencing/)
    })
  })

  test('fuzz: 600 seeded random requests answer only 200 or 422', async () => {
    const random = seeded(20261118)
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T
    const keys = [
      'from',
      'to',
      'interval',
      'groupBy',
      'limit',
      'filter[status][eq]',
      'filter[total][gte]',
      'filter[status][in]',
      'filter[api_token][eq]',
      'x',
      'filter[total][null]',
    ]
    const vals = [
      '',
      '2026-11-01',
      '2026-11-30T23:59:59Z',
      '9999-12-31',
      '0001-01-01',
      'day',
      'week',
      'month',
      'year',
      'status',
      'customer_id',
      'issued_on',
      '1',
      '50',
      '51',
      '-1',
      'paid',
      'paid,sent',
      "'; DROP TABLE invoices; --",
      '1e309',
      'NaN',
      'true',
      '\u0000',
      '😀',
      '%',
      '_',
      'a'.repeat(1200),
    ]
    const names = ['invoices.revenue', 'invoices.count', 'invoices.avg', 'employees.headcount']
    const statuses = new Set<number>()
    for (let i = 0; i < 600; i += 1) {
      const params = new URLSearchParams()
      const count = Math.floor(random() * 5)
      for (let j = 0; j < count; j += 1) params.append(pick(keys), pick(vals))
      const answer = await asA(`/metrics/${pick(names)}?${params.toString()}`)
      statuses.add(answer.status)
      expect([200, 422], `${params.toString()} -> ${JSON.stringify(answer.body)}`).toContain(
        answer.status,
      )
    }
    expect(statuses).toEqual(new Set([200, 422]))
  })
})

/** A deterministic PRNG (mulberry32), so a failing fuzz case can be replayed. */
function seeded(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A logger that records message names. */
function recordingLogger(lines: string[]): import('@strutvane/framework/contracts').Logger {
  const logger: import('@strutvane/framework/contracts').Logger = {
    trace: (msg) => lines.push(msg),
    debug: (msg) => lines.push(msg),
    info: (msg) => lines.push(msg),
    warn: (msg) => lines.push(msg),
    error: (msg, fields) => lines.push(`${msg} ${JSON.stringify(fields)}`),
    fatal: (msg) => lines.push(msg),
    child: () => logger,
    isLevelEnabled: () => true,
    flush: async () => undefined,
  }
  return logger
}
