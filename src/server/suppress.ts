/**
 * Small-group suppression: never reveal a number computed from fewer than `k` rows.
 *
 * Why: "average salary in Legal" is one person's salary when Legal has one person. For metrics
 * with `privacy: { minGroupSize: k }`, every cell backed by 1..k-1 rows is replaced by `null` and
 * listed in its point's `suppressed`.
 *
 * Primary suppression alone is not enough when totals are visible: with one hidden cell in a
 * line, "total minus the others" recovers it. So **complementary suppression** also hides the
 * smallest other non-empty cell of the same series (across groups) and, with a split, of the same
 * group (across series), repeating until no line has exactly one hidden cell (statistical
 * disclosure control's textbook minimum; its limits are in the README).
 *
 * Zero is shown: an empty group carries nobody's data.
 *
 * @module
 */

/**
 * One cell of the result grid: the rows behind it and its value.
 *
 * @example
 * const cell: Cell = { rows: 3, value: 182000, suppressed: false }
 */
export interface Cell {
  /** The rows the value is computed from: all rows for count, rows with a value for the others. */
  readonly rows: number
  value: number | null
  suppressed: boolean
}

/**
 * Apply primary and complementary suppression in place to a `groups × series` grid. Returns how
 * many cells were hidden.
 *
 * @example
 * const hidden = suppressSmallGroups(grid, 5)
 */
export function suppressSmallGroups(grid: Cell[][], minGroupSize: number): number {
  let hidden = 0
  for (const row of grid) {
    for (const cell of row) if (cell.rows > 0 && cell.rows < minGroupSize) hidden += hide(cell)
  }
  if (hidden === 0) return 0
  // Each round hides at least one more cell or stops, so the loop ends.
  for (let changed = true; changed; ) {
    changed = false
    for (const line of [...columnsOf(grid), ...grid]) {
      if (line.filter((cell) => cell.suppressed).length !== 1) continue
      const partner = smallestVisible(line)
      if (partner === undefined) continue
      hidden += hide(partner)
      changed = true
    }
  }
  return hidden
}

function hide(cell: Cell): number {
  cell.value = null
  cell.suppressed = true
  return 1
}

function columnsOf(grid: Cell[][]): Cell[][] {
  const width = grid[0]?.length ?? 0
  return Array.from({ length: width }, (_, index) =>
    grid.map((row) => row[index]).filter((cell): cell is Cell => cell !== undefined),
  )
}

/** The smallest non-empty, still visible cell of a line (ties: the first). */
function smallestVisible(line: readonly Cell[]): Cell | undefined {
  let best: Cell | undefined
  for (const cell of line) {
    if (cell.suppressed || cell.rows === 0) continue
    if (best === undefined || cell.rows < best.rows) best = cell
  }
  return best
}
