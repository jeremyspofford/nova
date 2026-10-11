import { describe, it } from 'vitest'
import { render } from '@testing-library/react'
import { Table } from './Table'
import { expectStacked } from '../../test/expectStacked'

describe('Table on a phone (R4)', () => {
  it('stacks: every cell names its column, an unnamed column is the row\'s actions', () => {
    const { container } = render(
      <Table
        columns={[
          { key: 'model', header: 'Model' },
          { key: 'cost', header: 'Cost' },
          { key: 'go', header: '', render: () => <button>Go</button> },
        ]}
        data={[{ model: 'a', cost: '$1', go: '' }]}
      />,
    )
    expectStacked(container)
  })
})
