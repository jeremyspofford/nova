import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { AboutPage } from './AboutPage'
import { updateHeadline } from './aboutFormat'
import type { About, AboutUpdates } from '../../lib/api'

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
    expect((updates).textContent).toContain('git pull && ./install')

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
    expect((screen.getByTestId('about-updates')).textContent).not.toContain('git pull')
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
