import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { GeneralSection } from './GeneralSection'
import * as api from '../../lib/api'

// Only the settings write is stubbed; the section uses nothing else from the
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

function select(): HTMLSelectElement {
  return screen.getByLabelText('Timezone') as HTMLSelectElement
}

describe('GeneralSection — the instance timezone', () => {
  it('shows the stored zone and the time there, with no save controls until it changes', () => {
    render(<GeneralSection timezone="Europe/Oslo" timezoneIsDefault={false} onChanged={vi.fn()} />)
    expect(select().value).toBe('Europe/Oslo')
    const line = screen.getByTestId('general-timezone-now').textContent ?? ''
    expect(line).toContain('Right now in Europe/Oslo')
    expect(line).toMatch(/\d{2}:\d{2}:\d{2}/)
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Reset' })).toBeNull()
    expect(screen.queryByTestId('general-timezone-default')).toBeNull()
  })

  it('ticks: the shown time moves with the clock, it is not a snapshot', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-09-06T09:00:00Z'))
      render(<GeneralSection timezone="UTC" timezoneIsDefault={true} onChanged={vi.fn()} />)
      const before = screen.getByTestId('general-timezone-now').textContent ?? ''
      expect(before).toContain('09:00:00')
      act(() => {
        vi.advanceTimersByTime(1000)
      })
      const after = screen.getByTestId('general-timezone-now').textContent ?? ''
      expect(after).toContain('09:00:01')
      expect(after).not.toBe(before)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a stored zone the engine does not list pickable', () => {
    render(<GeneralSection timezone="Asia/Calcutta" timezoneIsDefault={false} onChanged={vi.fn()} />)
    expect(select().value).toBe('Asia/Calcutta')
    expect(Array.from(select().options).map(o => o.value)).toContain('UTC')
  })

  it('says the registry default counts as unset, and stops saying so once a pick is pending', () => {
    render(<GeneralSection timezone="UTC" timezoneIsDefault={true} onChanged={vi.fn()} />)
    expect(screen.getByTestId('general-timezone-default').textContent).toContain('treats it as unset')
    fireEvent.change(select(), { target: { value: 'Asia/Tokyo' } })
    expect(screen.queryByTestId('general-timezone-default')).toBeNull()
  })

  it('renders "Not set" when this core does not expose the key, without crashing', () => {
    render(<GeneralSection timezone="" timezoneIsDefault={false} onChanged={vi.fn()} />)
    expect(select().value).toBe('')
    expect(screen.getByTestId('general-timezone-now').textContent).toContain('No timezone is set')
  })

  it('previews the pick live but writes only on Save, then echoes the new value', async () => {
    const onChanged = vi.fn()
    render(<GeneralSection timezone="UTC" timezoneIsDefault={true} onChanged={onChanged} />)

    fireEvent.change(select(), { target: { value: 'Asia/Tokyo' } })
    // Live preview, nothing written yet.
    expect(screen.getByTestId('general-timezone-now').textContent).toContain('Right now in Asia/Tokyo')
    expect(putSetting).not.toHaveBeenCalled()
    expect(onChanged).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(putSetting).toHaveBeenCalledWith('nova.timezone', 'Asia/Tokyo'))
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith('Asia/Tokyo'))
    expect(screen.getByText('Saved — Nova keeps time in Asia/Tokyo')).toBeDefined()
    expect(putSetting).toHaveBeenCalledTimes(1)
  })

  it('shows the refusal in core\'s words, marks the field invalid, and keeps the stored value', async () => {
    putSetting.mockRejectedValueOnce(
      new Error('nova.timezone: "Mars/Olympus" is not an IANA time zone'),
    )
    const onChanged = vi.fn()
    render(<GeneralSection timezone="UTC" timezoneIsDefault={true} onChanged={onChanged} />)

    fireEvent.change(select(), { target: { value: 'Asia/Tokyo' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain(
        'Could not save the timezone: nova.timezone: "Mars/Olympus" is not an IANA time zone',
      ),
    )
    expect(onChanged).not.toHaveBeenCalled()
    expect(select().getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByText('Not saved — the stored zone stands.')).toBeDefined()
    expect(screen.queryByText(/^Saved/)).toBeNull()
    // Still dirty: the owner can fix the pick or give up.
    expect(screen.getByRole('button', { name: 'Save' })).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Reset' }))
    expect(select().value).toBe('UTC')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(select().getAttribute('aria-invalid')).toBeNull()
    expect(screen.queryByText('Not saved — the stored zone stands.')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
  })
})
