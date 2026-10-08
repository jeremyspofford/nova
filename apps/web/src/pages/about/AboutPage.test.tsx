import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { AboutPage } from './AboutPage'
import { attemptState, updateHeadline } from './aboutFormat'
import type { About, AboutRemoteModelMachine, AboutUpdateAttempt, AboutUpdates } from '../../lib/api'

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
      remotes: [],
      remotes_reason: null,
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
    render(<AboutPage getAbout={vi.fn().mockResolvedValue(about({ model_machines: { machines: null, reason: 'the gateway refused', remotes: [], remotes_reason: null } }))} />)
    expect((await screen.findByTestId('about-models')).textContent).toContain('Could not be read: the gateway refused')
  })

  it('re-asks GitHub when checking for updates', async () => {
    const getAbout = vi.fn().mockResolvedValue(about())
    render(<AboutPage getAbout={getAbout} />)
    await screen.findByTestId('about-version')
    fireEvent.click(within(screen.getByTestId('about-updates')).getByRole('button', { name: /check for updates/i }))
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
    // said in the Updates card, next to the button that was pressed
    const alert = await within(screen.getByTestId('about-updates')).findByRole('alert')
    expect(alert.textContent).toContain('did not start')
    expect(alert.textContent).toContain('is not connected')
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

// T6: the remote model machines (non-builtin gateway providers on a machine)
// render in the same "Machines running models" tier, after the engines.
const REMOTE: AboutRemoteModelMachine = {
  name: 'xps-ollama', host: '100.122.40.93', state: 'answering', reason: '16 models listed', walled_for_s: null,
  answering: true, models: 16, device: 'DELL-XPS-8950', device_said: 'runs on paired device DELL-XPS-8950 (its agent\'s addresses)',
}

function remote(over: Partial<AboutRemoteModelMachine> = {}): AboutRemoteModelMachine {
  return { ...REMOTE, ...over }
}

function withModels(mm: Partial<About['model_machines']>): About {
  const base = about()
  return about({ model_machines: { ...base.model_machines, ...mm } })
}

/** Each node card in the models tier, in DOM order: its title, badge, subtitle and full text. */
function modelNodes(tier: HTMLElement) {
  return Array.from(tier.querySelectorAll<HTMLElement>('.rounded-md')).map(card => ({
    title: card.querySelector('.font-semibold')?.textContent ?? '',
    subtitle: card.querySelector('.truncate')?.textContent ?? null,
    text: card.textContent ?? '',
  }))
}

/** The one remote node after the fixture's single engine (asserts both are there). */
function remoteNode(tier: HTMLElement) {
  const nodes = modelNodes(tier)
  expect(nodes.map(n => n.title)).toHaveLength(2)
  return nodes[1]
}

async function modelsTier(data: About): Promise<HTMLElement> {
  render(<AboutPage getAbout={vi.fn().mockResolvedValue(data)} />)
  return screen.findByTestId('about-models')
}

describe('AboutPage remote model machines (T6)', () => {
  it('C1: lists the engines first, then one node per remote in payload order', async () => {
    const tier = await modelsTier(withModels({ remotes: [remote(), remote({ name: 'dell-kev', state: 'failing', answering: false, reason: 'ConnectTimeout', models: null })] }))
    expect(modelNodes(tier).map(n => n.title)).toEqual(['dell', 'xps-ollama', 'dell-kev'])
  })

  it('C1: a remote may share an engine name and both render', async () => {
    const tier = await modelsTier(withModels({ remotes: [remote({ name: 'dell' })] }))
    expect(modelNodes(tier).map(n => n.title)).toEqual(['dell', 'dell'])
  })

  it.each([
    [remote(), 'Answering'],
    [remote({ state: 'failing', answering: false, reason: 'ConnectTimeout', models: null }), 'Failing'],
    [remote({ state: 'walled', answering: false, reason: 'rate limited', walled_for_s: 600, models: null }), 'Walled for 10 min'],
    [remote({ state: 'unknown', answering: null, reason: 'never listed', models: null }), 'Unknown'],
  ])('C1: the badge is remoteState(r).text (%#)', async (r, badge) => {
    const tier = await modelsTier(withModels({ remotes: [r] }))
    const node = remoteNode(tier)
    expect(node.title).toBe(r.name)
    expect(node.text).toContain(badge)
  })

  it.each(['failing', 'walled', 'unknown'] as const)('C1: never "Answering" for a %s remote even when answering is true', async state => {
    const tier = await modelsTier(withModels({ remotes: [remote({ state, answering: true, reason: 'the gateway said so', walled_for_s: 120 })] }))
    const node = remoteNode(tier)
    expect(node.title).toBe('xps-ollama')
    expect(node.text).not.toContain('Answering')
  })

  it('C2: subtitle is "on <device> · <host> · N models"', async () => {
    const tier = await modelsTier(withModels({ remotes: [remote()] }))
    expect(remoteNode(tier).subtitle).toBe('on DELL-XPS-8950 · 100.122.40.93 · 16 models')
  })

  it('C2: with no device the subtitle starts with device_said verbatim', async () => {
    const said = 'no paired device has 100.122.40.93 among its addresses'
    const tier = await modelsTier(withModels({ remotes: [remote({ device: null, device_said: said })] }))
    expect(remoteNode(tier).subtitle).toBe(`${said} · 100.122.40.93 · 16 models`)
  })

  it('C2: no host prints no host part', async () => {
    const tier = await modelsTier(withModels({ remotes: [remote({ host: null })] }))
    expect(remoteNode(tier).subtitle).toBe('on DELL-XPS-8950 · 16 models')
  })

  it.each([
    [1, 'on DELL-XPS-8950 · 100.122.40.93 · 1 model'],
    [0, 'on DELL-XPS-8950 · 100.122.40.93 · 0 models'],
    [null, 'on DELL-XPS-8950 · 100.122.40.93'],
  ])('C2: models %s prints its count only when it is a number', async (models, subtitle) => {
    const tier = await modelsTier(withModels({ remotes: [remote({ models, reason: 'never listed', state: 'unknown', answering: null })] }))
    expect(remoteNode(tier).subtitle).toBe(subtitle)
  })

  it.each([
    remote({ state: 'failing', answering: false, reason: 'could not reach http://100.122.40.93:8009/v1 — ConnectTimeout', models: null }),
    remote({ state: 'walled', answering: false, reason: 'walled after 3 failures', walled_for_s: 300, models: null }),
    remote({ state: 'unknown', answering: null, reason: 'the gateway has not listed it yet', models: null }),
  ])('C3: a non-answering remote shows its reason as its own line (%#)', async r => {
    const tier = await modelsTier(withModels({ remotes: [r] }))
    const node = remoteNode(tier)
    expect(node.title).toBe(r.name)
    expect(node.text).toContain(r.reason)
    expect(node.subtitle).not.toContain(r.reason)
  })

  it('C3: an answering remote with a count does not repeat the "N models listed" note', async () => {
    const tier = await modelsTier(withModels({ remotes: [remote()] }))
    const node = remoteNode(tier)
    expect(node.title).toBe('xps-ollama')
    expect(node.text.match(/16 models/g)).toHaveLength(1)
    expect(node.text).not.toContain('16 models listed')
  })

  it('C4: unread remotes say why, and the engines still render', async () => {
    const tier = await modelsTier(withModels({ remotes: null, remotes_reason: 'the gateway refused /admin/providers' }))
    expect(tier.textContent).toContain('Remote model machines could not be read: the gateway refused /admin/providers')
    const nodes = modelNodes(tier)
    expect(nodes.map(n => n.title)).toEqual(['dell'])
    expect(nodes[0].text).toContain('3 models')
    const line = within(tier).getByText(/Remote model machines could not be read/)
    expect(line.className).toContain('text-danger')
  })

  it('C4: the engine keeps its badge when the remotes are unread', async () => {
    const tier = await modelsTier(withModels({ remotes: null, remotes_reason: 'gateway down' }))
    const nodes = modelNodes(tier)
    expect(nodes.map(n => n.title)).toEqual(['dell'])
    expect(nodes[0].text).toContain('Ready')
  })

  it('C3: an answering remote with no count still shows its reason', async () => {
    const tier = await modelsTier(withModels({ remotes: [remote({ models: null, reason: 'answered; the listing gave no count' })] }))
    const node = remoteNode(tier)
    expect(node.title).toBe('xps-ollama')
    expect(node.text).toContain('answered; the listing gave no count')
  })

  it('C5: unread engines still show the remotes', async () => {
    const tier = await modelsTier(withModels({ machines: null, reason: 'the gateway refused', remotes: [remote()] }))
    expect(tier.textContent).toContain('Could not be read: the gateway refused')
    const nodes = modelNodes(tier)
    expect(nodes.map(n => n.title)).toEqual(['xps-ollama'])
    expect(nodes[0].text).toContain('Answering')
  })

  it('C6 guard: "None." when both lists are read and empty', async () => {
    const tier = await modelsTier(withModels({ machines: [], remotes: [] }))
    expect(tier.textContent).toContain('None.')
  })

  it('C6: no engines but a remote shows the remote and never "None."', async () => {
    const tier = await modelsTier(withModels({ machines: [], remotes: [remote()] }))
    expect(modelNodes(tier).map(n => n.title)).toEqual(['xps-ollama'])
    expect(tier.textContent).not.toContain('None.')
  })

  it('C6: unread engines and no remotes says so and never "None."', async () => {
    const tier = await modelsTier(withModels({ machines: null, reason: 'the gateway refused', remotes: [] }))
    expect(tier.textContent).toContain('Could not be read: the gateway refused')
    expect(tier.textContent).not.toContain('None.')
  })

  it('C6: no engines and unread remotes says so and never "None."', async () => {
    const tier = await modelsTier(withModels({ machines: [], remotes: null, remotes_reason: 'gateway down' }))
    expect(tier.textContent).toContain('Remote model machines could not be read: gateway down')
    expect(tier.textContent).not.toContain('None.')
  })
})
