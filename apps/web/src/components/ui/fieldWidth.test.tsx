import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Input } from './Input'
import { Select } from './Select'
import { splitWidth } from './fieldWidth'

// UI review R7: <Input className="w-28"> sized the inner <input> while its
// wrapper stayed w-full, so a "25" cap field ran ~1120px across the card.

describe('splitWidth', () => {
  it('moves width-type classes to the wrapper and leaves the rest on the field', () => {
    expect(splitWidth('w-28 font-mono')).toEqual({ wrapper: 'w-28', field: 'font-mono' })
    expect(splitWidth('sm:w-64 max-w-xs flex-1 shrink-0 text-right')).toEqual({
      wrapper: 'sm:w-64 max-w-xs flex-1 shrink-0',
      field: 'text-right',
    })
  })

  it('keeps w-full only when no width was given', () => {
    expect(splitWidth(undefined).wrapper).toBe('w-full')
    expect(splitWidth('font-mono').wrapper).toBe('w-full')
    expect(splitWidth('max-w-xs').wrapper).toBe('w-full max-w-xs')
  })
})

describe('Input and Select honour a width', () => {
  it('Input: the wrapper takes w-28; the field is not given a second width', () => {
    render(<Input aria-label="cap" className="w-28 font-mono" />)
    const field = screen.getByLabelText('cap')
    const wrapper = field.parentElement!.parentElement!
    expect(wrapper.className.split(' ')).toContain('w-28')
    expect(wrapper.className.split(' ')).not.toContain('w-full')
    expect(field.className).not.toContain('w-28')
    expect(field.className).toContain('font-mono')
  })

  it('Select: the same', () => {
    render(<Select aria-label="pick" className="w-40" items={[{ value: 'a', label: 'A' }]} />)
    const wrapper = screen.getByLabelText('pick').parentElement!
    expect(wrapper.className.split(' ')).toContain('w-40')
    expect(wrapper.className.split(' ')).not.toContain('w-full')
  })
})
