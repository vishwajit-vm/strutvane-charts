/**
 * The test app: two tenant-scoped tables on real engines (node:sqlite and PGlite, in process),
 * reached only through the framework's ORM, exactly as an app would.
 *
 * - `invoices`: every column kind charts care about, plus columns charts must never touch
 *   (`api_token`, secret by name; `internal_note`, hidden by the model; `tenant_id`; `id`;
 *   `deleted_at`).
 * - `employees`: people data for the privacy (small-group suppression) tests.
 */
import { PGlite } from '@electric-sql/pglite'
import type {
  Actor,
  Decision,
  PermissionProvider,
  QueryFilter,
} from '@strutvane/framework/contracts'
import {
  Connection,
  configureOrm,
  Model,
  type ModelClass,
  pgliteDriver,
  registerSchema,
  runWithTenant,
  type SchemaSnapshot,
  sql,
  sqliteDriver,
  useConnection,
} from '@strutvane/framework/database'
import './tables.ts'

export const TENANT_A = '0193a0b2-0000-7000-8000-00000000000a'
export const TENANT_B = '0193a0b2-0000-7000-8000-00000000000b'

const timestamps = [
  { name: 'created_at', kind: 'timestamp', nullable: true },
  { name: 'updated_at', kind: 'timestamp', nullable: true },
] as const
const tenant = { name: 'tenant_id', kind: 'uuid', nullable: false, tenant: true } as const

/** The schema the migrations would leave behind. */
export const snapshot: SchemaSnapshot = {
  version: 1,
  tables: {
    invoices: {
      name: 'invoices',
      columns: [
        { name: 'id', kind: 'id', nullable: false },
        tenant,
        { name: 'customer_id', kind: 'foreignId', nullable: true },
        { name: 'owner_id', kind: 'integer', nullable: false },
        {
          name: 'status',
          kind: 'enum',
          nullable: false,
          values: ['draft', 'sent', 'paid', 'void'],
        },
        { name: 'paid', kind: 'boolean', nullable: false },
        { name: 'total', kind: 'decimal', nullable: true, precision: 12, scale: 2 },
        { name: 'discount', kind: 'double', nullable: true },
        { name: 'quantity', kind: 'integer', nullable: false },
        { name: 'issued_on', kind: 'date', nullable: true },
        { name: 'sent_at', kind: 'timestamp', nullable: true },
        { name: 'api_token', kind: 'string', nullable: true, length: 80 },
        { name: 'internal_note', kind: 'text', nullable: true },
        { name: 'notes', kind: 'text', nullable: true },
        ...timestamps,
        { name: 'deleted_at', kind: 'timestamp', nullable: true },
      ],
      indexes: [],
    },
    employees: {
      name: 'employees',
      columns: [
        { name: 'id', kind: 'id', nullable: false },
        tenant,
        {
          name: 'department',
          kind: 'enum',
          nullable: false,
          values: ['sales', 'legal', 'eng', 'ops'],
        },
        { name: 'remote', kind: 'boolean', nullable: false },
        { name: 'salary', kind: 'decimal', nullable: false, precision: 12, scale: 2 },
        { name: 'hired_on', kind: 'date', nullable: false },
        ...timestamps,
      ],
      indexes: [],
    },
  },
}

// No fillable list: tests seed with forceCreate (owner_id and sent_at are privilege-looking
// columns the ORM would refuse to make fillable).
const invoiceOptions = { hidden: ['internal_note'] } as const

const employeeOptions = {} as const

/** Invoices: tenant-scoped, soft-deleting, with a hidden note. */
export const Invoice: ModelClass<'invoices', typeof invoiceOptions> = Model(
  'invoices',
  invoiceOptions,
)

/** Employees: tenant-scoped people data. */
export const Employee: ModelClass<'employees', typeof employeeOptions> = Model(
  'employees',
  employeeOptions,
)

/** The in-process engines every data test runs on. */
export const ENGINES = ['sqlite', 'pglite'] as const
export type EngineName = (typeof ENGINES)[number]

/**
 * Open a fresh database on `engine`, create the tables, and point the ORM at it.
 *
 * @example
 * const connection = await openEngine('sqlite')
 */
export async function openEngine(engine: EngineName): Promise<Connection> {
  registerSchema(snapshot)
  configureOrm({ tenancy: { column: 'tenant_id' }, onUnsafeTenancy: () => undefined })
  const connection =
    engine === 'sqlite'
      ? new Connection(sqliteDriver(':memory:'))
      : new Connection(pgliteDriver(await PGlite.create()))
  if (engine === 'sqlite') {
    await connection.run(sql`CREATE TABLE "invoices" (
      "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      "tenant_id" CHAR(36) NOT NULL,
      "customer_id" INTEGER NULL,
      "owner_id" INTEGER NOT NULL DEFAULT 0,
      "status" VARCHAR(20) NOT NULL DEFAULT 'draft',
      "paid" INTEGER NOT NULL DEFAULT 0,
      "total" NUMERIC NULL,
      "discount" REAL NULL,
      "quantity" INTEGER NOT NULL DEFAULT 0,
      "issued_on" DATE NULL,
      "sent_at" TEXT NULL,
      "api_token" VARCHAR(80) NULL,
      "internal_note" TEXT NULL,
      "notes" TEXT NULL,
      "created_at" TEXT NULL,
      "updated_at" TEXT NULL,
      "deleted_at" TEXT NULL
    )`)
    await connection.run(sql`CREATE TABLE "employees" (
      "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      "tenant_id" CHAR(36) NOT NULL,
      "department" VARCHAR(20) NOT NULL,
      "remote" INTEGER NOT NULL DEFAULT 0,
      "salary" NUMERIC NOT NULL,
      "hired_on" DATE NOT NULL,
      "created_at" TEXT NULL,
      "updated_at" TEXT NULL
    )`)
  } else {
    await connection.run(sql`CREATE TABLE "invoices" (
      "id" BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      "tenant_id" UUID NOT NULL,
      "customer_id" BIGINT NULL,
      "owner_id" INTEGER NOT NULL DEFAULT 0,
      "status" VARCHAR(20) NOT NULL DEFAULT 'draft',
      "paid" BOOLEAN NOT NULL DEFAULT FALSE,
      "total" DECIMAL(12, 2) NULL,
      "discount" DOUBLE PRECISION NULL,
      "quantity" INTEGER NOT NULL DEFAULT 0,
      "issued_on" DATE NULL,
      "sent_at" TIMESTAMP(3) WITH TIME ZONE NULL,
      "api_token" VARCHAR(80) NULL,
      "internal_note" TEXT NULL,
      "notes" TEXT NULL,
      "created_at" TIMESTAMP(3) WITH TIME ZONE NULL,
      "updated_at" TIMESTAMP(3) WITH TIME ZONE NULL,
      "deleted_at" TIMESTAMP(3) WITH TIME ZONE NULL
    )`)
    await connection.run(sql`CREATE TABLE "employees" (
      "id" BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      "tenant_id" UUID NOT NULL,
      "department" VARCHAR(20) NOT NULL,
      "remote" BOOLEAN NOT NULL DEFAULT FALSE,
      "salary" DECIMAL(12, 2) NOT NULL,
      "hired_on" DATE NOT NULL,
      "created_at" TIMESTAMP(3) WITH TIME ZONE NULL,
      "updated_at" TIMESTAMP(3) WITH TIME ZONE NULL
    )`)
  }
  useConnection(connection)
  return connection
}

/**
 * Delete every row (outside any tenant context, so the statement guard allows it).
 *
 * @example
 * await clearTables(connection)
 */
export async function clearTables(connection: Connection): Promise<void> {
  await connection.run(sql`DELETE FROM "invoices"`)
  await connection.run(sql`DELETE FROM "employees"`)
}

/** Fields an invoice row may be seeded with. */
export interface InvoiceSeed {
  readonly customer_id?: number | null
  readonly owner_id?: number
  readonly status?: 'draft' | 'sent' | 'paid' | 'void'
  readonly paid?: boolean
  readonly total?: string | null
  readonly discount?: number | null
  readonly quantity?: number
  readonly issued_on?: string | null
  readonly sent_at?: Date | null
  readonly api_token?: string | null
  readonly internal_note?: string | null
}

/**
 * Create invoices as `tenantId`.
 *
 * @example
 * await seedInvoices(TENANT_A, [{ status: 'paid', total: '10.00' }])
 */
export async function seedInvoices(
  tenantId: string,
  rows: readonly InvoiceSeed[],
): Promise<unknown[]> {
  return runWithTenant(tenantId, async () => {
    const created: unknown[] = []
    for (const row of rows)
      created.push(await Invoice.forceCreate({ owner_id: 1, quantity: 1, ...row }))
    return created
  })
}

/**
 * Create employees as `tenantId`.
 *
 * @example
 * await seedEmployees(TENANT_A, [['legal', '90000.00']])
 */
export async function seedEmployees(
  tenantId: string,
  rows: readonly (readonly [
    department: 'sales' | 'legal' | 'eng' | 'ops',
    salary: string,
    remote?: boolean,
  ])[],
): Promise<void> {
  await runWithTenant(tenantId, async () => {
    for (const [department, salary, remote] of rows)
      await Employee.forceCreate({
        department,
        salary,
        remote: remote ?? false,
        hired_on: '2026-01-15',
      })
  })
}

/**
 * A PermissionProvider for tests: allow or deny `viewAny`, with an optional row filter.
 *
 * @example
 * permissions({ allow: true, filter: { field: 'owner_id', op: 'eq', value: { $actor: 'attrs.ownerId' } } })
 */
export function permissions(
  options: { readonly allow?: boolean; readonly filter?: QueryFilter } = {},
): PermissionProvider & { readonly calls: string[] } {
  const calls: string[] = []
  const allow = options.allow ?? true
  return {
    calls,
    async can(_actor: Actor | null, action: string): Promise<Decision> {
      calls.push(`can:${action}`)
      return { allowed: allow, reason: allow ? 'allow:test' : 'default-deny' }
    },
    async filterFor(_actor: Actor | null, action: string): Promise<QueryFilter> {
      calls.push(`filter:${action}`)
      if (!allow) return { op: 'false' }
      return options.filter ?? { op: 'true' }
    },
  }
}

/** A signed-in user. */
export const USER: Actor = { id: '7', type: 'user', roles: ['member'], attrs: { ownerId: 7 } }
