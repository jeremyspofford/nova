import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { AutonomySection } from './AutonomySection'
import type { AutonomyClass, GovernanceEvent } from '../../lib/api'

function cls(overrides: Partial<AutonomyClass> = {}): AutonomyClass {
  return {
    action_class: 'fetch_url',
    risk_tier: 'outward',
    disposition: 'consent',
    earned: false,
    consecutive_successes: 3,
    graduation_runs: 5,
    updated_at: '2026-08-30T00:00:00Z',
    ...overrides,
  }
}

function renderSection(
  api: Partial<{
    getAutonomyState: ReturnType<typeof vi.fn>
    revokeAutonomy: ReturnType<typeof vi.fn>
    setDisposition: ReturnType<typeof vi.fn>
    setAllDispositions: ReturnType<typeof vi.fn>
    getGovernanceEvents: ReturnType<typeof vi.fn>
  }> = {},
) {
  const full = {
    getAutonomyState: vi.fn(async () => [cls()]),
    revokeAutonomy: vi.fn(),
    setDisposition: vi.fn(),
    setAllDispositions: vi.fn(),
    getGovernanceEvents: vi.fn(async () => [] as GovernanceEvent[]),
    ...api,
  }
  return { ...render(<AutonomySection api={full} />), api: full }
}

/** The "Per-class (N)" disclosure — collapsed on every mount, so a test that
 * needs a row waits for the list to load, then opens it. */
const perClassButton = () => screen.getByRole('button', { name: /^Per-class \(\d+\)$/ })
const masterSelect = () =>
  screen.getByRole('combobox', { name: /disposition for every class/i }) as HTMLSelectElement

async function expandRows() {
  await waitFor(() => perClassButton())
  fireEvent.click(perClassButton())
}

describe('AutonomySection', () => {
  it('shows a skeleton while loading', () => {
    renderSection({ getAutonomyState: vi.fn(() => new Promise<AutonomyClass[]>(() => {})) })
    expect(screen.getByTestId('autonomy-skeleton')).toBeTruthy()
  })

  it('lists a class with its disposition and the REAL stored progress, not a guess', async () => {
    renderSection({
      getAutonomyState: vi.fn(async () => [cls({ consecutive_successes: 3, graduation_runs: 5 })]),
    })
    await expandRows()
    await waitFor(() => expect(screen.getByText('fetch_url')).toBeTruthy())
    expect(screen.getByText(/3\s*\/\s*5/)).toBeTruthy()
    expect(screen.getByText(/consent/i)).toBeTruthy()
  })

  it('an earned auto class shows Revoke, not a progress bar', async () => {
    renderSection({
      getAutonomyState: vi.fn(async () => [
        cls({ disposition: 'auto', earned: true, consecutive_successes: 0 }),
      ]),
    })
    await expandRows()
    await waitFor(() => expect(screen.getByRole('button', { name: /revoke/i })).toBeTruthy())
    expect(screen.queryByText(/\d\s*\/\s*5/)).toBeNull()
  })

  it('a baseline (never-earned) auto class shows no Revoke button', async () => {
    renderSection({
      getAutonomyState: vi.fn(async () => [
        cls({ action_class: 'memory_save', disposition: 'auto', earned: false }),
      ]),
    })
    await expandRows()
    await waitFor(() => expect(screen.getByText('memory_save')).toBeTruthy())
    expect(screen.queryByRole('button', { name: /revoke/i })).toBeNull()
  })

  it('revoking calls the API and the class flips back to consent in place', async () => {
    const revoked = cls({ disposition: 'consent', earned: false, consecutive_successes: 0 })
    const { api } = renderSection({
      getAutonomyState: vi.fn(async () => [cls({ disposition: 'auto', earned: true })]),
      revokeAutonomy: vi.fn(async () => [revoked]),
    })
    await expandRows()
    await waitFor(() => screen.getByRole('button', { name: /revoke/i }))

    fireEvent.click(screen.getByRole('button', { name: /revoke/i }))

    await waitFor(() => expect(api.revokeAutonomy).toHaveBeenCalledWith('fetch_url'))
    await waitFor(() => expect(screen.queryByRole('button', { name: /revoke/i })).toBeNull())
    expect(screen.getByText(/0\s*\/\s*5/)).toBeTruthy()
  })

  it('a failed revoke states the reason and leaves the class as it was', async () => {
    const { api } = renderSection({
      getAutonomyState: vi.fn(async () => [cls({ disposition: 'auto', earned: true })]),
      revokeAutonomy: vi.fn(async () => {
        throw new Error('the server refused the turn (404)')
      }),
    })
    await expandRows()
    await waitFor(() => screen.getByRole('button', { name: /revoke/i }))

    fireEvent.click(screen.getByRole('button', { name: /revoke/i }))

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('404'))
    expect(api.revokeAutonomy).toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /revoke/i })).toBeTruthy()
  })

  it('every class row carries a disposition selector with the three plain-word choices', async () => {
    renderSection({
      getAutonomyState: vi.fn(async () => [
        cls({ action_class: 'device_run', disposition: 'consent' }),
        cls({ action_class: 'memory_save', disposition: 'auto' }),
      ]),
    })
    await expandRows()
    await waitFor(() => screen.getByText('device_run'))
    const select = screen.getByRole('combobox', { name: /disposition for device_run/i }) as HTMLSelectElement
    expect(select.value).toBe('consent')
    const labels = Array.from(select.options).map(o => o.textContent)
    expect(labels).toEqual(['Runs automatically', 'Needs my approval', 'Never'])
    const other = screen.getByRole('combobox', { name: /disposition for memory_save/i }) as HTMLSelectElement
    expect(other.value).toBe('auto')
    expect(screen.getByText(/recorded in governance/i)).toBeTruthy()
  })

  it('choosing "Runs automatically" calls setDisposition with auto and echoes the returned row', async () => {
    const returned = cls({
      action_class: 'device_run',
      disposition: 'auto',
      earned: false,
      consecutive_successes: 0,
    })
    const { api } = renderSection({
      getAutonomyState: vi.fn(async () => [
        cls({ action_class: 'device_run', disposition: 'consent', consecutive_successes: 3 }),
      ]),
      setDisposition: vi.fn(async () => returned),
    })
    await expandRows()
    await waitFor(() => screen.getByText('device_run'))
    expect(screen.getByText(/3\s*\/\s*5/)).toBeTruthy()

    fireEvent.change(screen.getByRole('combobox', { name: /disposition for device_run/i }), {
      target: { value: 'auto' },
    })

    await waitFor(() => expect(api.setDisposition).toHaveBeenCalledWith('device_run', 'auto'))
    // The row is the SERVER's: auto, progress bar gone, and no Revoke (an
    // operator-set auto is not earned — there is nothing to take back).
    await waitFor(() => expect(screen.queryByText(/3\s*\/\s*5/)).toBeNull())
    expect(
      (screen.getByRole('combobox', { name: /disposition for device_run/i }) as HTMLSelectElement).value,
    ).toBe('auto')
    expect(screen.queryByRole('button', { name: /revoke/i })).toBeNull()
  })

  it('choosing "Never" sends deny; a refused change states the reason and leaves the row as it was', async () => {
    const { api } = renderSection({
      getAutonomyState: vi.fn(async () => [cls({ action_class: 'fetch_url', disposition: 'consent' })]),
      setDisposition: vi.fn(async () => {
        throw new Error('the server refused the turn (404)')
      }),
    })
    await expandRows()
    await waitFor(() => screen.getByText('fetch_url'))

    fireEvent.change(screen.getByRole('combobox', { name: /disposition for fetch_url/i }), {
      target: { value: 'deny' },
    })

    await waitFor(() => expect(api.setDisposition).toHaveBeenCalledWith('fetch_url', 'deny'))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('404'))
    expect(
      (screen.getByRole('combobox', { name: /disposition for fetch_url/i }) as HTMLSelectElement).value,
    ).toBe('consent')
  })

  it('a failed load states the reason', async () => {
    renderSection({
      getAutonomyState: vi.fn(async () => {
        throw new Error('the server refused the turn (500)')
      }),
    })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('500'))
  })

  it('expanding a class fetches and shows its recent decisions', async () => {
    const events: GovernanceEvent[] = [
      {
        id: 'e-1',
        kind: 'consent.burned',
        action_class: 'fetch_url',
        actor: 'p-1',
        subject_ref: 'c-1',
        meta: {},
        created_at: '2026-08-30T00:00:00Z',
      },
    ]
    const getGovernanceEvents = vi.fn(async () => events)
    renderSection({ getGovernanceEvents })
    await expandRows()
    await waitFor(() => screen.getByText('fetch_url'))

    fireEvent.click(screen.getByText('fetch_url'))

    await waitFor(() =>
      expect(getGovernanceEvents).toHaveBeenCalledWith(
        expect.objectContaining({ actionClass: 'fetch_url' }),
      ),
    )
    await waitFor(() => expect(screen.getByText(/consent\.burned/)).toBeTruthy())
  })

  it('a class with no recent decisions shows an EmptyState, not a blank space', async () => {
    renderSection({ getGovernanceEvents: vi.fn(async () => []) })
    await expandRows()
    await waitFor(() => screen.getByText('fetch_url'))

    fireEvent.click(screen.getByText('fetch_url'))

    await waitFor(() => expect(screen.getByText(/no decisions/i)).toBeTruthy())
  })

  // ── the master control + the collapsed per-class disclosure ─────────────

  it('renders the master control and keeps the per-class rows collapsed — absent from the DOM, not hidden', async () => {
    const { api } = renderSection({
      getAutonomyState: vi.fn(async () => [
        cls({ action_class: 'fetch_url', disposition: 'consent' }),
        cls({ action_class: 'memory_save', disposition: 'consent' }),
      ]),
    })
    await waitFor(() => masterSelect())
    // The count is derived from the rows that loaded, and the disclosure is shut.
    expect(perClassButton().textContent).toContain('Per-class (2)')
    expect(perClassButton().getAttribute('aria-expanded')).toBe('false')
    // Not hidden by CSS — not rendered at all.
    expect(screen.queryByText('fetch_url')).toBeNull()
    expect(screen.queryByText('memory_save')).toBeNull()
    expect(screen.queryByRole('combobox', { name: /disposition for fetch_url/i })).toBeNull()
    // Merely rendering sends nothing.
    expect(api.setAllDispositions).not.toHaveBeenCalled()
    expect(api.setDisposition).not.toHaveBeenCalled()
  })

  it('expanding the disclosure shows the rows unchanged; collapsing removes them again', async () => {
    renderSection({
      getAutonomyState: vi.fn(async () => [
        cls({ action_class: 'fetch_url', disposition: 'consent', consecutive_successes: 3 }),
        cls({ action_class: 'memory_save', disposition: 'auto' }),
      ]),
    })
    await expandRows()
    expect(perClassButton().getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('fetch_url')).toBeTruthy()
    expect(screen.getByText(/3\s*\/\s*5/)).toBeTruthy()
    expect(
      (screen.getByRole('combobox', { name: /disposition for memory_save/i }) as HTMLSelectElement).value,
    ).toBe('auto')

    fireEvent.click(perClassButton())
    expect(perClassButton().getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('fetch_url')).toBeNull()
  })

  it('is collapsed again on every mount — nothing remembers it was opened', async () => {
    const state = vi.fn(async () => [cls({ action_class: 'fetch_url' })])
    const first = renderSection({ getAutonomyState: state })
    await expandRows()
    expect(screen.getByText('fetch_url')).toBeTruthy()
    first.unmount()

    renderSection({ getAutonomyState: state })
    await waitFor(() => perClassButton())
    expect(perClassButton().getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('fetch_url')).toBeNull()
  })

  it('the master shows the shared value when every class agrees, with no "Mixed" option', async () => {
    renderSection({
      getAutonomyState: vi.fn(async () => [
        cls({ action_class: 'fetch_url', disposition: 'deny' }),
        cls({ action_class: 'memory_save', disposition: 'deny' }),
      ]),
    })
    await waitFor(() => masterSelect())
    expect(masterSelect().value).toBe('deny')
    const labels = Array.from(masterSelect().options).map(o => o.textContent)
    expect(labels).toEqual(['Runs automatically', 'Needs my approval', 'Never'])
  })

  it('a mixed state shows "Mixed" as an unselectable placeholder, and rendering sends no PUT', async () => {
    const { api } = renderSection({
      getAutonomyState: vi.fn(async () => [
        cls({ action_class: 'fetch_url', disposition: 'consent' }),
        cls({ action_class: 'memory_save', disposition: 'auto' }),
      ]),
    })
    await waitFor(() => masterSelect())
    expect(masterSelect().value).toBe('mixed')
    const mixed = Array.from(masterSelect().options).find(o => o.value === 'mixed')
    expect(mixed?.textContent).toBe('Mixed')
    expect(mixed?.disabled).toBe(true)
    expect(screen.getByText(/currently differ/i)).toBeTruthy()
    expect(api.setAllDispositions).not.toHaveBeenCalled()
    expect(api.setDisposition).not.toHaveBeenCalled()
  })

  it('choosing a master value calls setAllDispositions ONCE and re-renders the returned classes, still collapsed', async () => {
    const committed = [
      cls({ action_class: 'fetch_url', disposition: 'auto', consecutive_successes: 0 }),
      cls({ action_class: 'memory_save', disposition: 'auto' }),
    ]
    const { api } = renderSection({
      getAutonomyState: vi.fn(async () => [
        cls({ action_class: 'fetch_url', disposition: 'consent', consecutive_successes: 3 }),
        cls({ action_class: 'memory_save', disposition: 'auto' }),
      ]),
      setAllDispositions: vi.fn(async () => ({ classes: committed, changed: ['fetch_url'] })),
    })
    await waitFor(() => masterSelect())
    expect(masterSelect().value).toBe('mixed')

    fireEvent.change(masterSelect(), { target: { value: 'auto' } })

    await waitFor(() => expect(api.setAllDispositions).toHaveBeenCalledWith('auto'))
    expect(api.setAllDispositions).toHaveBeenCalledTimes(1)
    expect(api.setDisposition).not.toHaveBeenCalled() // one PUT, never N
    // The master re-derives from the SERVER's rows: all auto, so no Mixed left.
    await waitFor(() => expect(masterSelect().value).toBe('auto'))
    expect(Array.from(masterSelect().options).some(o => o.value === 'mixed')).toBe(false)
    // Still collapsed after the change.
    expect(perClassButton().getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('fetch_url')).toBeNull()
    // And the rows, once opened, are the returned ones.
    fireEvent.click(perClassButton())
    expect(
      (screen.getByRole('combobox', { name: /disposition for fetch_url/i }) as HTMLSelectElement).value,
    ).toBe('auto')
    expect(screen.queryByText(/3\s*\/\s*5/)).toBeNull()
  })

  it('a refused master change states the reason and leaves the master (and rows) as they were', async () => {
    const { api } = renderSection({
      getAutonomyState: vi.fn(async () => [
        cls({ action_class: 'fetch_url', disposition: 'consent' }),
        cls({ action_class: 'memory_save', disposition: 'consent' }),
      ]),
      setAllDispositions: vi.fn(async () => {
        throw new Error('the server refused the turn (400)')
      }),
    })
    await waitFor(() => masterSelect())

    fireEvent.change(masterSelect(), { target: { value: 'deny' } })

    await waitFor(() => expect(api.setAllDispositions).toHaveBeenCalledWith('deny'))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('400'))
    expect(masterSelect().value).toBe('consent')
    fireEvent.click(perClassButton())
    expect(
      (screen.getByRole('combobox', { name: /disposition for fetch_url/i }) as HTMLSelectElement).value,
    ).toBe('consent')
  })
})
