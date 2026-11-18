/**
 * Which columns of a model may be aggregated, and in which role.
 *
 * The facts come from the framework's schema snapshot through the model (`Model.info()`,
 * `Model.settings()`), the same facts the ORM itself enforces. A column is **never** usable by a
 * chart when it is:
 * - the primary key (counting ids is `count`; summing them is meaningless);
 * - the tenant column (grouping by tenant is a cross-tenant report, never a chart);
 * - `deleted_at` (soft deletes are a scope, not data);
 * - hidden (`.hidden()` in the migration or `hidden` on the model) or secret (`.secret()`), or
 *   named like a secret (`password`, `*_token`, `api_key`, …): aggregating a secret leaks it as
 *   surely as returning it (a `min(password_hash)` is a prefix oracle);
 * - free text, JSON, slugs and UUIDs (no meaningful aggregate or grouping).
 *
 * Roles:
 * - `numeric`: integer, bigInteger, decimal, double: sum, avg, min, max;
 * - `date`: date, timestamp: time buckets and ranges;
 * - `category`: enum and boolean: a fixed, known set of groups;
 * - `relation`: foreign ids: top N related records.
 *
 * @module
 */
import { ModelBase } from '@strutvane/framework/database'

/** How a column can take part in a chart. */
export type ColumnRole = 'numeric' | 'date' | 'category' | 'relation'

/**
 * One usable column and the facts the engine needs about it.
 *
 * @example
 * const total: ChartColumn = { name: 'total', role: 'numeric', kind: 'decimal', scale: 2, values: [] }
 */
export interface ChartColumn {
  readonly name: string
  readonly role: ColumnRole
  /** The framework column kind (`decimal`, `timestamp`, `enum`, …). */
  readonly kind: string
  /** Digits after the decimal point, for decimals; 0 for integers. */
  readonly scale: number
  /** Enum values in declaration order (`true`/`false` for booleans); empty otherwise. */
  readonly values: readonly string[]
}

/**
 * A model class the charts engine can query: any class made with the framework's `Model(…)`.
 * Typed loosely on purpose (an app's model has a precise generated type that differs per table);
 * {@link asModel} checks the real thing at runtime.
 *
 * @example
 * const model: ChartModel = Invoice
 */
export interface ChartModel {
  readonly name: string
  readonly prototype: object
}

/**
 * The framework model class behind a {@link ChartModel}, or a descriptive error. The check is the
 * class chain (`prototype instanceof ModelBase`), so an object that only looks like a model is
 * refused.
 *
 * @example
 * const runtime = asModel(Invoice) // typeof ModelBase
 */
export function asModel(model: ChartModel): typeof ModelBase {
  if (isModelClass(model)) return model
  throw new TypeError(
    `${String(model.name)} is not a Strutvane model. Pass a class made with Model('table') from @strutvane/framework/database.`,
  )
}

function isModelClass(value: unknown): value is typeof ModelBase {
  return (
    typeof value === 'function' &&
    (value === ModelBase || value.prototype instanceof ModelBase) &&
    typeof Reflect.get(value, 'table') === 'string'
  )
}

/** Column names that read as secrets, whatever their kind (mirrors the framework's own rule). */
const SECRET_NAME =
  /(^|_)(password|passwd|secret|token|api_?key|private_?key|salt|hash|otp|pin|ssn|iban|cvv|card_?number)(_|$)/i

const ROLE_BY_KIND: Readonly<Record<string, ColumnRole>> = Object.freeze({
  integer: 'numeric',
  bigInteger: 'numeric',
  decimal: 'numeric',
  double: 'numeric',
  date: 'date',
  timestamp: 'date',
  enum: 'category',
  boolean: 'category',
  foreignId: 'relation',
})

/** Names the framework treats as tenant columns even when the snapshot doesn't flag them. */
const TENANT_NAMES: ReadonlySet<string> = new Set(['tenant_id', 'team_id'])

/**
 * Every column of `model` a chart may use, by name. Columns that are not here do not exist as far
 * as charts are concerned (error hints list only these).
 *
 * @example
 * chartColumns(Invoice).get('total')?.role // 'numeric'
 */
export function chartColumns(model: typeof ModelBase): ReadonlyMap<string, ChartColumn> {
  const info = model.info()
  const hidden = model.settings().hidden
  const usable = new Map<string, ChartColumn>()
  for (const column of info.columns.values()) {
    const role = Object.hasOwn(ROLE_BY_KIND, column.kind) ? ROLE_BY_KIND[column.kind] : undefined
    if (role === undefined) continue
    if (column.name === info.primaryKey.name || column.primary === true) continue
    if (column.tenant === true || TENANT_NAMES.has(column.name)) continue
    if (column.name === 'deleted_at') continue
    if (column.hidden === true || column.secret === true || hidden.has(column.name)) continue
    if (SECRET_NAME.test(column.name)) continue
    usable.set(column.name, {
      name: column.name,
      role,
      kind: column.kind,
      scale: column.kind === 'decimal' ? (column.scale ?? 2) : 0,
      values:
        column.kind === 'boolean'
          ? ['true', 'false']
          : column.kind === 'enum'
            ? [...(column.values ?? [])]
            : [],
    })
  }
  return usable
}
