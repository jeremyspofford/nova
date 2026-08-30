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
    getGovernanceEvents: ReturnType<typeof vi.fn>
  }> = {},
) {
  const full = {
    getAutonomyState: vi.fn(async () => [cls()]),
    revokeAutonomy: vi.fn(),
    getGovernanceEvents: vi.fn(async () => [] as GovernanceEvent[]),
    ...api,
  }
  return { ...render(<AutonomySection api={full} />), api: full }
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
    await waitFor(() => expect(screen.getByRole('button', { name: /revoke/i })).toBeTruthy())
    expect(screen.queryByText(/\d\s*\/\s*5/)).toBeNull()
  })

  it('a baseline (never-earned) auto class shows no Revoke button', async () => {
    renderSection({
      getAutonomyState: vi.fn(async () => [
        cls({ action_class: 'memory_save', disposition: 'auto', earned: false }),
      ]),
    })
    await waitFor(() => expect(screen.getByText('memory_save')).toBeTruthy())
    expect(screen.queryByRole('button', { name: /revoke/i })).toBeNull()
  })

  it('revoking calls the API and the class flips back to consent in place', async () => {
    const revoked = cls({ disposition: 'consent', earned: false, consecutive_successes: 0 })
    const { api } = renderSection({
      getAutonomyState: vi.fn(async () => [cls({ disposition: 'auto', earned: true })]),
      revokeAutonomy: vi.fn(async () => [revoked]),
    })
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
    await waitFor(() => screen.getByRole('button', { name: /revoke/i }))

    fireEvent.click(screen.getByRole('button', { name: /revoke/i }))

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('404'))
    expect(api.revokeAutonomy).toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /revoke/i })).toBeTruthy()
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
    await waitFor(() => screen.getByText('fetch_url'))

    fireEvent.click(screen.getByText('fetch_url'))

    await waitFor(() => expect(screen.getByText(/no decisions/i)).toBeTruthy())
  })
})
