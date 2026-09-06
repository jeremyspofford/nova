import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Timezone } from './Timezone'
import * as api from '../../../lib/api'

// Only the settings write is stubbed; the step uses nothing else from the api
// module. importOriginal keeps the rest of the module real.
vi.mock('../../../lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../lib/api')>()
  return { ...actual, putSetting: vi.fn(async () => {}) }
})

const putSetting = vi.mocked(api.putSetting)

beforeEach(() => {
  putSetting.mockClear()
  putSetting.mockResolvedValue(undefined)
})

// The zone the test process itself resolves — the step must preselect
// exactly this, whatever machine the suite runs on.
const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone

function select(): HTMLSelectElement {
  return screen.getByLabelText('Timezone') as HTMLSelectElement
}

describe('Timezone step — the instance zone, written before the wizard moves on', () => {
  it('preselects the zone this browser reports and offers UTC beside it', () => {
    render(<Timezone onNext={vi.fn()} />)
    expect(select().value).toBe(browserZone)
    const offered = Array.from(select().options).map(o => o.value)
    expect(offered).toContain(browserZone)
    expect(offered).toContain('UTC')
    expect(screen.getByText(`This browser reports ${browserZone}.`, { exact: false })).toBeDefined()
    expect(screen.getByTestId('timezone-now').textContent).toContain(`Right now in ${browserZone}`)
  })

  it('shows the current time in whichever zone is picked, so the pick can be checked', () => {
    render(<Timezone onNext={vi.fn()} />)
    fireEvent.change(select(), { target: { value: 'Asia/Tokyo' } })
    const line = screen.getByTestId('timezone-now').textContent ?? ''
    expect(line).toContain('Right now in Asia/Tokyo')
    expect(line).toMatch(/\d{2}:\d{2}:\d{2}/)
  })

  it('ticks: the shown time moves with the clock, it is not a snapshot', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-09-06T09:00:00Z'))
      render(<Timezone onNext={vi.fn()} />)
      fireEvent.change(select(), { target: { value: 'UTC' } })
      const before = screen.getByTestId('timezone-now').textContent ?? ''
      expect(before).toContain('09:00:00')
      act(() => {
        vi.advanceTimersByTime(1000)
      })
      const after = screen.getByTestId('timezone-now').textContent ?? ''
      expect(after).toContain('09:00:01')
      expect(after).not.toBe(before)
    } finally {
      vi.useRealTimers()
    }
  })

  it('writes nova.timezone on Continue and advances only once the write resolved', async () => {
    let resolveWrite!: () => void
    putSetting.mockReturnValueOnce(
      new Promise<void>(resolve => {
        resolveWrite = resolve
      }),
    )
    const onNext = vi.fn()
    render(<Timezone onNext={onNext} />)

    fireEvent.change(select(), { target: { value: 'Europe/Oslo' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    await waitFor(() => expect(putSetting).toHaveBeenCalledWith('nova.timezone', 'Europe/Oslo'))
    // Pending: nothing has advanced, and the controls are held.
    expect(onNext).not.toHaveBeenCalled()
    expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(true)
    expect(select().disabled).toBe(true)

    resolveWrite()
    await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1))
    expect(putSetting).toHaveBeenCalledTimes(1)
  })

  it('stays on the step and states the reason when core refuses the write', async () => {
    putSetting.mockRejectedValueOnce(
      new Error('nova.timezone: "Mars/Olympus" is not an IANA time zone'),
    )
    const onNext = vi.fn()
    render(<Timezone onNext={onNext} />)

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain(
        'Could not save the timezone: nova.timezone: "Mars/Olympus" is not an IANA time zone',
      ),
    )
    expect(onNext).not.toHaveBeenCalled()
    // The field itself is marked, not only the banner.
    expect(select().getAttribute('aria-invalid')).toBe('true')
    // Not skipped and not stuck: Continue is usable again for a retry.
    expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(false)
    expect(select().disabled).toBe(false)
  })

  it('clears a stated refusal when the pick changes, and a retry can then advance', async () => {
    putSetting.mockRejectedValueOnce(new Error('could not reach Nova — network down'))
    const onNext = vi.fn()
    render(<Timezone onNext={onNext} />)

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(screen.getByRole('alert')).toBeDefined())

    fireEvent.change(select(), { target: { value: 'UTC' } })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(select().getAttribute('aria-invalid')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1))
    expect(putSetting).toHaveBeenLastCalledWith('nova.timezone', 'UTC')
  })

  it('has no Back — the step behind it is the one-shot account step', () => {
    // The step is listed on the fresh run only (steps.test.ts), where the step
    // behind it is CreateAccount; core registers an owner once, so a Back
    // here would land on a step that refuses. HardwareDetection has none for
    // the same reason.
    render(<Timezone onNext={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDefined()
  })
})
