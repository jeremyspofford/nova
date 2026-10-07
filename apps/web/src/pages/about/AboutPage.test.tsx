import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { AboutPage } from './AboutPage'
import { attemptState, updateHeadline } from './aboutFormat'
import type { About, AboutUpdateAttempt, AboutUpdates } from '../../lib/api'

const COMMIT = '0123456789abcdef0123456789abcdef01234567'

function about(over: Partial<About> = {}): About {
  return {
    build: {
      commit: COMMIT,
      short: '0123456',
      version: 'v2.0.0-alpha-312-g0123456',
      committed_at: '2026-10-06T21:14:03+00:00',
      installed_at: '2026-10-07T08:00:00+00:00',
      dirty: false,
      repo: 'jeremyspofford/nova',
      branch: 'main',
      commit_url: `https://github.com/jeremyspofford/nova/commit/${COMMIT}`,
      reason: null,
    },
    updates: {
      state: 'available',
      behind_by: 2,
      ahead_by: 0,
      commits: [
        { sha: 'b'.repeat(40), short: 'bbbbbbb', message: 'feat: the newer one', date: null },
        { sha: 'a'.repeat(40), short: 'aaaaaaa', message: 'fix: the older one', date: null },
      ],
      latest: null,
      compare_url: 'https://github.com/jeremyspofford/nova/compare/x...main',
      reason: null,
      checked_at: new Date().toISOString(),
    },
    hub: {
      address: 'https://nova.tail1234.ts.net',
      address_reason: null,
      agent: {
        name: 'mini-pc', hostname: 'mini-pc', platform: 'linux', os: 'Ubuntu 24.04', connected: true,
        last_seen: null, agent_version: 'abc', build_state: 'current',
      },
    },
    satellites: [
      {
        name: 'dell', hostname: 'dell', platform: 'linux', os: 'Ubuntu 24.04', connected: false,
        last_seen: '2026-10-07T07:00:00+00:00', agent_version: 'abc', build_state: 'current',
      },
    ],
    model_machines: {
      machines: [{ name: 'dell', state: 'ready', serving: true, runtime: 'ollama', compute: 'CUDA', models: 3, reason: null }],
      reason: null,
    },
    services: [
      { name: 'core', state: 'up', reason: null },
      { name: 'gateway', state: 'up', reason: null },
      { name: 'memory', state: 'unreachable', reason: 'connection refused' },
    ],
    last_update: null,
    clients: {
      clients: [{
        kind: 'installed app', device: 'iPhone', browser: 'Safari', label: 'Installed app (PWA) on iPhone',
        person: 'jeremy', last_seen: new Date().toISOString(), signed_in_at: '2026-10-01T00:00:00+00:00',
      }],
      unseen: 1,
      window_days: 30,
    },
    ...over,
  }
}

describe('AboutPage', () => {
  it('shows the build, what is new, and the live architecture', async () => {
    render(<AboutPage getAbout={vi.fn().mockResolvedValue(about())} />)
    expect((await screen.findByTestId('about-version')).textContent).toContain('v2.0.0-alpha-312-g0123456')
    expect((screen.getByRole('link', { name: '0123456' })).getAttribute('href')).toBe(`https://github.com/jeremyspofford/nova/commit/${COMMIT}`)
    const updates = screen.getByTestId('about-updates')
    expect((updates).textContent).toContain('2 new commits on main')
    const listed = within(screen.getByTestId('about-new-commits')).getAllByRole('listitem')
    expect(listed.map(li => li.textContent)).toEqual(['bbbbbbbfeat: the newer one', 'aaaaaaafix: the older one'])
    expect(within(updates).getByRole('button', { name: /update now/i })).toBeTruthy()

    expect((screen.getByTestId('about-clients')).textContent).toContain('Installed app (PWA) on iPhone')
    expect((screen.getByTestId('about-clients')).textContent).toContain('Plus 1 signed-in session not used')
    expect((screen.getByTestId('about-hub')).textContent).toContain('mini-pc')
    expect((screen.getByTestId('about-hub')).textContent).toContain('https://nova.tail1234.ts.net')
    expect((screen.getByTestId('about-hub')).textContent).toContain('unreachable')
    expect((screen.getByTestId('about-satellites')).textContent).toContain('dell')
    expect((screen.getByTestId('about-satellites')).textContent).toContain('Not connected')
    expect((screen.getByTestId('about-models')).textContent).toContain('3 models')
  })

  it('says why there is no build instead of naming one', async () => {
    const reason = 'this stack carries no build stamp'
    const data = about()
    data.build = { ...data.build, commit: null, short: null, version: null, commit_url: null, reason }
    data.updates = { ...data.updates, state: 'unknown', behind_by: null, ahead_by: null, commits: [], compare_url: null, reason }
    render(<AboutPage getAbout={vi.fn().mockResolvedValue(data)} />)
    expect((await screen.findByTestId('about-version')).textContent).toContain('Unknown build')
    expect((screen.getByTestId('about-build')).textContent).toContain(reason)
    expect((screen.getByTestId('about-updates')).textContent).toContain('Could not check for updates')
    expect(within(screen.getByTestId('about-updates')).queryByRole('button', { name: /update now/i })).toBeNull()
  })

  it('states an unreadable gateway rather than showing no machines', async () => {
    render(<AboutPage getAbout={vi.fn().mockResolvedValue(about({ model_machines: { machines: null, reason: 'the gateway refused' } }))} />)
    expect((await screen.findByTestId('about-models')).textContent).toContain('Could not be read: the gateway refused')
  })

  it('re-asks GitHub when checking for updates', async () => {
    const getAbout = vi.fn().mockResolvedValue(about())
    render(<AboutPage getAbout={getAbout} />)
    await screen.findByTestId('about-version')
    fireEvent.click(screen.getByRole('button', { name: /check for updates/i }))
    await waitFor(() => expect(getAbout).toHaveBeenLastCalledWith({ refresh: true }))
    expect(getAbout).toHaveBeenNthCalledWith(1, { refresh: false })
  })

  it('shows a failed read as its reason', async () => {
    render(<AboutPage getAbout={vi.fn().mockRejectedValue(new Error('could not reach Nova'))} />)
    expect((await screen.findByRole('alert')).textContent).toContain('could not reach Nova')
  })
})

describe('updateHeadline', () => {
  const base: AboutUpdates = {
    state: 'unknown', behind_by: null, ahead_by: null, commits: [], latest: null, compare_url: null, reason: 'x', checked_at: '',
  }
  it('never calls an unknown check up to date', () => {
    expect(updateHeadline(base, 'main')).toEqual({ text: 'Could not check for updates', color: 'neutral' })
  })
  it('names each relation', () => {
    expect(updateHeadline({ ...base, state: 'up_to_date' }, 'main').text).toBe('Up to date with main')
    expect(updateHeadline({ ...base, state: 'available', behind_by: 1 }, 'main').text).toBe('1 new commit on main')
    expect(updateHeadline({ ...base, state: 'local_ahead', ahead_by: 2 }, 'main').text).toContain('nothing to pull')
    expect(updateHeadline({ ...base, state: 'diverged', behind_by: 1, ahead_by: 2 }, 'main').text).toBe(
      'Diverged: 1 to pull, 2 here that main does not have',
    )
  })
})

const ATTEMPT: AboutUpdateAttempt = {
  id: 'a1', from_commit: COMMIT, to_commit: 'b'.repeat(40), requested_by: 'jeremy', device: 'mini-pc',
  log_path: '/home/jeremy/workspace/nova/deploy/.update-a1.log', outcome: 'sent', reason: 'started: systemd-run',
  started_at: new Date().toISOString(), decided_at: null,
}

describe('AboutPage updates', () => {
  it('starts an update only after the owner confirms what it does', async () => {
    const startUpdate = vi.fn().mockResolvedValue({ update: ATTEMPT })
    render(<AboutPage getAbout={vi.fn().mockResolvedValue(about())} startUpdate={startUpdate} />)
    fireEvent.click(await screen.findByRole('button', { name: /update now/i }))
    const confirm = screen.getByTestId('about-update-confirm')
    expect(confirm.textContent).toContain('pulls 2 commits')
    expect(startUpdate).not.toHaveBeenCalled()
    fireEvent.click(within(confirm).getByRole('button', { name: /start the update/i }))
    await waitFor(() => expect(startUpdate).toHaveBeenCalledTimes(1))
    const last = await screen.findByTestId('about-last-update')
    expect(last.textContent).toContain('started, not yet reported back')
    // nothing to start while one is in flight
    expect(screen.queryByRole('button', { name: /update now/i })).toBeNull()
  })

  it('shows why the hub refused to start one', async () => {
    const startUpdate = vi.fn().mockRejectedValue(new Error("the hub's own agent (mini-pc) is not connected"))
    render(<AboutPage getAbout={vi.fn().mockResolvedValue(about())} startUpdate={startUpdate} />)
    fireEvent.click(await screen.findByRole('button', { name: /update now/i }))
    fireEvent.click(screen.getByRole('button', { name: /start the update/i }))
    expect((await screen.findByRole('alert')).textContent).toContain('is not connected')
  })

  it('names a failed update, its reason and where its log is', async () => {
    const failed = { ...ATTEMPT, outcome: 'failed' as const, reason: 'rolled back to 0123456, which is running again' }
    render(<AboutPage getAbout={vi.fn().mockResolvedValue(about({ last_update: failed }))} />)
    const last = await screen.findByTestId('about-last-update')
    expect(last.textContent).toContain('failed')
    expect(last.textContent).toContain('rolled back')
    expect(last.textContent).toContain('.update-a1.log')
  })

  it('reads again while an update is in flight and calls a failed read the restart', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const getAbout = vi
        .fn()
        .mockResolvedValueOnce(about({ last_update: ATTEMPT }))
        .mockRejectedValueOnce(new Error('could not reach Nova'))
        .mockResolvedValue(about({ last_update: { ...ATTEMPT, outcome: 'confirmed', reason: null } }))
      render(<AboutPage getAbout={getAbout} />)
      await screen.findByTestId('about-last-update')
      await vi.advanceTimersByTimeAsync(10_000)
      await waitFor(() => expect(screen.getByTestId('about-last-update').textContent).toContain('Nova is restarting'))
      expect(screen.queryByRole('alert')).toBeNull()
      await vi.advanceTimersByTimeAsync(10_000)
      await waitFor(() => expect(screen.getByTestId('about-last-update').textContent).toContain('Updated'))
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('attemptState', () => {
  it('never calls a started update done', () => {
    expect(attemptState(ATTEMPT).text).toContain('not yet reported back')
    expect(attemptState({ ...ATTEMPT, outcome: 'not_confirmed' }).text).toContain('never confirmed')
  })
})
