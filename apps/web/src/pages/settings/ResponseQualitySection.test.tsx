import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ResponseQualitySection } from './ResponseQualitySection'
import * as api from '../../lib/api'

// Only the settings write is stubbed; the component uses nothing else from the
// api module. importOriginal keeps the rest of the module real.
vi.mock('../../lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('../../lib/api')>()
  // 2026-09-08 (S11): putSetting answers with what core stored (and, for
  // the digest hour, a note) instead of nothing — the fake echoes the
  // write the way the real call does.
  return { ...actual, putSetting: vi.fn(async (key: string, value: boolean | string | number) => ({ key, value })) }
})

const putSetting = vi.mocked(api.putSetting)

beforeEach(() => {
  putSetting.mockClear()
  putSetting.mockImplementation(async (key, value) => ({ key, value }))
})

describe('ResponseQualitySection — the opt-in responsiveness toggle', () => {
  it('is off by default and renders the trade-off disclaimer', () => {
    render(<ResponseQualitySection checked={false} onChanged={vi.fn()} />)
    const toggle = screen.getByRole('switch', { name: 'Responsiveness check' })
    expect((toggle as HTMLInputElement).checked).toBe(false)
    // The disclaimer states the trade-off, what it helps, and that it is a
    // judgment, not a guarantee.
    expect(screen.getByText(/extra model calls per reply/)).toBeDefined()
    expect(screen.getByText(/not a guarantee/)).toBeDefined()
    expect(screen.getByText(/Off by default/)).toBeDefined()
  })

  it('reflects the stored value when it is on', () => {
    render(<ResponseQualitySection checked={true} onChanged={vi.fn()} />)
    const toggle = screen.getByRole('switch', { name: 'Responsiveness check' })
    expect((toggle as HTMLInputElement).checked).toBe(true)
  })

  it('writes the setting and echoes the new value when toggled on', async () => {
    const onChanged = vi.fn()
    render(<ResponseQualitySection checked={false} onChanged={onChanged} />)

    fireEvent.click(screen.getByRole('switch', { name: 'Responsiveness check' }))

    await waitFor(() =>
      expect(putSetting).toHaveBeenCalledWith('agents.responsiveness_check', true),
    )
    expect(onChanged).toHaveBeenCalledWith(true)
  })

  it('reverts and surfaces an error when the write fails', async () => {
    putSetting.mockRejectedValueOnce(new Error('nope'))
    const onChanged = vi.fn()
    render(<ResponseQualitySection checked={false} onChanged={onChanged} />)

    fireEvent.click(screen.getByRole('switch', { name: 'Responsiveness check' }))

    // Optimistic on, then reverted to off — nothing shown as saved that the
    // server refused.
    await waitFor(() => expect(onChanged).toHaveBeenLastCalledWith(false))
    expect(onChanged.mock.calls).toEqual([[true], [false]])
    expect(screen.getByRole('alert').textContent).toContain('nope')
  })
})
