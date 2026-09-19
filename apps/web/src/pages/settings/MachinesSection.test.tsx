import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { MachinesSection } from './MachinesSection'
import type { Machine } from '../../lib/api'

function machine(overrides: Partial<Machine> = {}): Machine {
  return {
    name: 'hub', lifecycle: 'always_on', serving: true, state: 'ready', reason: null,
    observed_at: '2026-09-18T15:00:00Z',
    compute: 'gpu:cuda:GPU-6f1c2a3b-4d5e-6f70-8192-a3b4c5d6e7f8', runtime: 'container',
    models: [
      { name: 'qwen3.8:27b', size_bytes: 17_400_000_000 },
      { name: 'nomic-embed-text:latest', size_bytes: 274_302_450 },
    ],
    ...overrides,
  }
}

function renderSection(api: Partial<{ getMachines: ReturnType<typeof vi.fn>; setMachineServing: ReturnType<typeof vi.fn> }> = {}) {
  const full = {
    getMachines: vi.fn(async () => ({ machines: [machine()] })),
    setMachineServing: vi.fn(async (name: string, serving: boolean) =>
      machine({ name, serving, state: serving ? 'ready' : 'switched_off' })),
    ...api,
  }
  return { ...render(<MachinesSection api={full} />), api: full }
}

const theSwitch = (tile: HTMLElement) =>
  within(tile).getByRole('switch', { name: 'This machine runs chat models' }) as HTMLInputElement

describe('MachinesSection', () => {
  it('says only what the switch does: it governs the role walk, not a call that names its model', () => {
    // The gateway's serving switch is read by the role walk alone (S40 T3's
    // decision, carried as G6). A request with no role, an eval or a
    // model_read naming its model, is still served on a switched-off
    // machine, and a role whose chain has no other link gets a stated 503.
    // "Sent no model calls" would promise a wall the gateway does not build.
    renderSection({ getMachines: vi.fn(() => new Promise(() => {})) })
    const text = screen.getByText(/^Where Nova's models run\./).textContent ?? ''
    expect(text).not.toMatch(/sent no model calls/i)
    expect(text).toMatch(/next link in the role's chain answers/)
    expect(text).toMatch(/no other link.*says why/)
    expect(text).toMatch(/names its model.*still served there/)
  })

  it('shows a skeleton while loading', () => {
    renderSection({ getMachines: vi.fn(() => new Promise(() => {})) })
    expect(screen.getByTestId('machines-skeleton')).toBeTruthy()
  })

  it('a failed load states the reason', async () => {
    renderSection({ getMachines: vi.fn(async () => { throw new Error('core refused (502)') }) })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('502'))
  })

  it('an answer with no list is a failure, not "no machines"', async () => {
    renderSection({ getMachines: vi.fn(async () => ({})) })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('no list of machines'))
    expect(screen.queryByTestId('machines-none')).toBeNull()
  })

  it('no machines is said, not drawn as an empty box', async () => {
    renderSection({ getMachines: vi.fn(async () => ({ machines: [] })) })
    await waitFor(() => expect(screen.getByTestId('machines-none').textContent).toContain('No machine runs models'))
  })

  it('shows the state, compute, runtime and models of each machine', async () => {
    renderSection()
    const tile = await screen.findByTestId('machine-hub')
    expect(tile.textContent).toContain('hub')
    expect(tile.textContent).toContain('ready')
    expect(tile.textContent).toContain('always on')
    expect(within(tile).getByTestId('machine-hub-compute').textContent).toBe('gpu:cuda:GPU-6f1c2a3b-4d5e-6f70-8192-a3b4c5d6e7f8')
    expect(within(tile).getByTestId('machine-hub-runtime').textContent).toBe('container')
    const models = within(tile).getByTestId('machine-hub-models').textContent ?? ''
    expect(models).toContain('qwen3.8:27b')
    expect(models).toContain('16.2 GB')
    expect(models).toContain('262 MB')
    expect(theSwitch(tile).checked).toBe(true)
  })

  it('an unidentified compute is said, never guessed', async () => {
    renderSection({ getMachines: vi.fn(async () => ({ machines: [machine({ compute: null, runtime: null })] })) })
    const tile = await screen.findByTestId('machine-hub')
    expect(within(tile).getByTestId('machine-hub-compute').textContent).toBe('compute not identified')
    expect(within(tile).queryByTestId('machine-hub-runtime')).toBeNull()
  })

  it('a machine that is not answering says why', async () => {
    renderSection({ getMachines: vi.fn(async () => ({ machines: [machine({ state: 'unreachable', reason: 'ConnectError: connection refused' })] })) })
    expect((await screen.findByTestId('machine-hub')).textContent).toContain('not answering — ConnectError: connection refused')
  })

  it('a reason gets a line of its own, never a fixed-height badge', async () => {
    // A gateway reason can be a sentence with a URL in it; a badge is one
    // line tall and cannot wrap, so a reason in one spills over the tile on
    // a phone (machines-layout.mjs measures it at 280px).
    const reason = 'could not reach hub at http://ollama:11434/api/tags — ConnectError: [Errno 111] Connection refused'
    renderSection({ getMachines: vi.fn(async () => ({ machines: [machine({ state: 'unreachable', reason })] })) })
    const tile = await screen.findByTestId('machine-hub')
    const line = within(tile).getByTestId('machine-hub-state')
    expect(line.tagName).toBe('P')
    expect(line.textContent).toBe(`not answering — ${reason}`)
  })

  it('a state without a reason is a badge beside the name', async () => {
    renderSection()
    const tile = await screen.findByTestId('machine-hub')
    const badge = within(tile).getByTestId('machine-hub-state')
    expect(badge.tagName).toBe('SPAN')
    expect(badge.textContent).toBe('ready')
  })

  it('an empty reason is no reason: the state stays a badge', async () => {
    renderSection({ getMachines: vi.fn(async () => ({ machines: [machine({ state: 'unreachable', reason: '' })] })) })
    const tile = await screen.findByTestId('machine-hub')
    const badge = within(tile).getByTestId('machine-hub-state')
    expect(badge.tagName).toBe('SPAN')
    expect(badge.textContent).toBe('not answering')
  })

  it('Refresh asks the gateway to look again, not for its cached reading', async () => {
    const { api } = renderSection()
    await screen.findByTestId('machine-hub')
    expect(api.getMachines).toHaveBeenLastCalledWith()
    api.getMachines.mockResolvedValueOnce({ machines: [machine({ state: 'unreachable', reason: 'ConnectError: connection refused' })] })
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(api.getMachines).toHaveBeenLastCalledWith({ live: true }))
    await waitFor(() => expect(screen.getByTestId('machine-hub').textContent).toContain('not answering — ConnectError: connection refused'))
  })

  it('switching it off writes serving=false and shows what was read back', async () => {
    const { api } = renderSection()
    const tile = await screen.findByTestId('machine-hub')
    fireEvent.click(theSwitch(tile))
    await waitFor(() => expect(api.setMachineServing).toHaveBeenCalledWith('hub', false))
    await waitFor(() => expect(theSwitch(tile).checked).toBe(false))
    expect(tile.textContent).toContain('not running chat models')
    expect(within(tile).queryByRole('alert')).toBeNull()
  })

  it('never shows the value it asked for when the machine reads back the other one', async () => {
    renderSection({ setMachineServing: vi.fn(async () => machine({ serving: true })) })
    const tile = await screen.findByTestId('machine-hub')
    fireEvent.click(theSwitch(tile))
    await waitFor(() => expect(within(tile).getByRole('alert').textContent).toBe('Asked to turn chat models off on hub, but it reads back on.'))
    expect(theSwitch(tile).checked).toBe(true)
  })

  it('a refused write leaves the switch where the machine is and says why', async () => {
    renderSection({ setMachineServing: vi.fn(async () => { throw new Error('the gateway refused the write (502)') }) })
    const tile = await screen.findByTestId('machine-hub')
    fireEvent.click(theSwitch(tile))
    await waitFor(() => expect(within(tile).getByRole('alert').textContent).toContain('502'))
    expect(theSwitch(tile).checked).toBe(true)
  })

  it('the switch is held while the write is in flight', async () => {
    let release: (m: Machine) => void = () => {}
    renderSection({ setMachineServing: vi.fn(() => new Promise<Machine>(r => { release = r })) })
    const tile = await screen.findByTestId('machine-hub')
    fireEvent.click(theSwitch(tile))
    await waitFor(() => expect(theSwitch(tile).disabled).toBe(true))
    release(machine({ serving: false, state: 'switched_off' }))
    await waitFor(() => expect(theSwitch(tile).disabled).toBe(false))
    expect(theSwitch(tile).checked).toBe(false)
  })
})
