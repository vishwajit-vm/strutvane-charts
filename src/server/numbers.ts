/**
 * Exact arithmetic for aggregates.
 *
 * Decimals arrive from the ORM as canonical strings (`'1234.50'`), integers as numbers. Summing
 * them as JavaScript floats drifts (`0.1 + 0.2`), and money charts that disagree with the invoice
 * list by a cent lose trust. So integers and decimals are summed as scaled `bigint`s (exact), and
 * only the final value becomes a `number` for the wire. Doubles are floats in the database already
 * and are summed as numbers.
 *
 * @module
 */

/**
 * A running aggregate of one cell: how many values, their exact sum, and the extremes.
 *
 * @example
 * const acc = new Accumulator(2); acc.add('1.25'); acc.add('2.50'); acc.sum() // 3.75
 */
export class Accumulator {
  /** Values seen (non-NULL). */
  count = 0
  /** Rows seen, including rows whose value is NULL (what `count` metrics report). */
  rows = 0
  readonly #scale: number
  readonly #float: boolean
  #exact = 0n
  #floatSum = 0
  #min: number | undefined
  #max: number | undefined

  /**
   * @param scale digits after the decimal point (0 for integers)
   * @param float sum as floating point (double columns)
   */
  constructor(scale: number, float = false) {
    this.#scale = scale
    this.#float = float
  }

  /** Count a row; add its value when it has one (`null`/`undefined` count as rows only). */
  add(value: unknown): void {
    this.rows += 1
    if (value === null || value === undefined) return
    const numeric = this.#float ? toFloat(value) : toScaled(value, this.#scale)
    if (numeric === undefined) return
    this.count += 1
    let asNumber: number
    if (typeof numeric === 'bigint') {
      this.#exact += numeric
      asNumber = Number(numeric) / 10 ** this.#scale
    } else {
      this.#floatSum += numeric
      asNumber = numeric
    }
    if (this.#min === undefined || asNumber < this.#min) this.#min = asNumber
    if (this.#max === undefined || asNumber > this.#max) this.#max = asNumber
  }

  /** Fold another accumulator in (for "other" groups). */
  merge(other: Accumulator): void {
    this.rows += other.rows
    this.count += other.count
    this.#exact += other.#exact
    this.#floatSum += other.#floatSum
    if (other.#min !== undefined && (this.#min === undefined || other.#min < this.#min))
      this.#min = other.#min
    if (other.#max !== undefined && (this.#max === undefined || other.#max > this.#max))
      this.#max = other.#max
  }

  /** The sum, rounded to the column's scale (0 when there were no values). */
  sum(): number {
    if (this.#float) return this.#floatSum
    return Number(formatScaled(this.#exact, this.#scale))
  }

  /** The average, rounded to scale + 2 digits, or `null` when there is nothing to average. */
  avg(): number | null {
    if (this.count === 0) return null
    if (this.#float) return this.#floatSum / this.count
    // (sum / 10^scale) / count, kept exact at scale + 2 digits, rounded half away from zero.
    const extra = 2
    const scaled = this.#exact * 10n ** BigInt(extra)
    const divisor = BigInt(this.count)
    const quotient = scaled / divisor
    const remainder = scaled % divisor
    const twice = (remainder < 0n ? -remainder : remainder) * 2n
    const rounded = twice >= divisor ? quotient + (scaled < 0n ? -1n : 1n) : quotient
    return Number(formatScaled(rounded, this.#scale + extra))
  }

  /** The smallest value, or `null`. */
  min(): number | null {
    return this.#min ?? null
  }

  /** The largest value, or `null`. */
  max(): number | null {
    return this.#max ?? null
  }
}

/** A decimal string or a whole number as an integer scaled by 10^scale, or `undefined`. */
export function toScaled(value: unknown, scale: number): bigint | undefined {
  if (typeof value === 'bigint') return value * 10n ** BigInt(scale)
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value)) return BigInt(value) * 10n ** BigInt(scale)
    if (!Number.isFinite(value)) return undefined
    return toScaled(value.toFixed(scale), scale)
  }
  if (typeof value !== 'string') return undefined
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim())
  if (match === null) return undefined
  const [, sign = '', whole = '0', fraction = ''] = match
  const digits = `${whole}${fraction.padEnd(scale, '0').slice(0, scale)}`
  const magnitude = BigInt(digits)
  return sign === '-' ? -magnitude : magnitude
}

/** A scaled integer back to a decimal string: `formatScaled(12345n, 2)` is `'123.45'`. */
export function formatScaled(value: bigint, scale: number): string {
  const negative = value < 0n
  const digits = (negative ? -value : value).toString().padStart(scale + 1, '0')
  const whole = scale === 0 ? digits : digits.slice(0, -scale)
  const fraction = scale === 0 ? '' : `.${digits.slice(-scale)}`
  return `${negative ? '-' : ''}${whole}${fraction}`
}

function toFloat(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(number) ? number : undefined
}
