import { expect } from 'vitest'

/**
 * Every body cell of every `table.stack-table` under `root` can be read when
 * the table stacks on a phone (index.css, UI review R4): it names its column
 * in `data-label`, or it is the row's title (`stack-title`) or its buttons
 * (`stack-actions`), or it spans the row (an expanded detail). A cell with
 * none of these would stack as an unlabelled value nobody can place.
 */
export function expectStacked(root: ParentNode = document) {
  const tables = root.querySelectorAll('table.stack-table')
  expect(tables.length, 'no table.stack-table rendered').toBeGreaterThan(0)
  let cells = 0
  for (const td of root.querySelectorAll<HTMLTableCellElement>('table.stack-table > tbody > tr > td')) {
    if (td.colSpan > 1) continue
    cells++
    const ok =
      (td.dataset.label ?? '').trim() !== '' ||
      td.classList.contains('stack-title') ||
      td.classList.contains('stack-actions')
    expect(ok, `an unlabelled cell would stack on a phone: ${td.outerHTML.slice(0, 120)}`).toBe(true)
  }
  expect(cells, 'no body cells checked').toBeGreaterThan(0)
}
