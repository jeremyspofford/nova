import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { DevicesSection } from './DevicesSection'
import type { AgentManifest, Device, PairingCode } from '../../lib/api'

// S42b: the public manifest (Task 19/28) — the same shape publicPages.test.tsx
// reads, so the pairing modal's filled command and the public /add page's
// never drift apart.
const MANIFEST: AgentManifest = {
  version: 'aaaaaaaaaaaa',
  commands: { linux: 'L --code {CODE}', macos: 'M --code {CODE}', windows: 'W --code {CODE}' },
  commands_reason: null,
  walks: { linux: 'Linux: walked', macos: 'macOS: not walked yet', windows: 'Windows: walked' },
  notes: { linux: '', macos: '', windows: '' },
}

function device(overrides: Partial<Device> = {}): Device {
  return {
    id: 'd-1',
    name: 'laptop',
    platform: 'linux',
    hostname: 'thinkpad',
    enrolled_at: '2026-08-30T00:00:00Z',
    last_seen: null,
    revoked_at: null,
    connected: false,
    os: null,
    wsl: null,
    agent_version: null,
    facts_at: null,
    ...overrides,
  }
}

const freshIso = () => new Date().toISOString()
const staleIso = () => new Date(Date.now() - 10 * 60 * 1000).toISOString() // 10m ago

function renderSection(
  api: Partial<{
    listDevices: ReturnType<typeof vi.fn>
    mintPairingCode: ReturnType<typeof vi.fn>
    renameDevice: ReturnType<typeof vi.fn>
    revokeDevice: ReturnType<typeof vi.fn>
    getNetworkAddress: ReturnType<typeof vi.fn>
    getAgentManifest: ReturnType<typeof vi.fn>
    mintRepairCode: ReturnType<typeof vi.fn>
  }> = {},
  pollIntervalMs = 1_000_000,
) {
  const full = {
    listDevices: vi.fn(async () => [] as Device[]),
    mintPairingCode: vi.fn(
      async (): Promise<PairingCode> => ({
        code: 'K7PQ9XYZ',
        expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      }),
    ),
    renameDevice: vi.fn(),
    revokeDevice: vi.fn(),
    getNetworkAddress: vi.fn(async () => ({ address: 'https://nova.fake-tailnet.ts.net', reason: null, read_at: new Date().toISOString() })),
    getAgentManifest: vi.fn(async (): Promise<AgentManifest> => MANIFEST),
    mintRepairCode: vi.fn(
      async (): Promise<PairingCode> => ({
        code: 'K7PQ9XYZ',
        expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      }),
    ),
    ...api,
  }
  return { ...render(<DevicesSection api={full} pollIntervalMs={pollIntervalMs} />), api: full }
}

describe('DevicesSection', () => {
  it('shows a skeleton while loading', () => {
    renderSection({ listDevices: vi.fn(() => new Promise<Device[]>(() => {})) })
    expect(screen.getByTestId('devices-skeleton')).toBeTruthy()
  })

  it('a failed load states the reason in an alert banner', async () => {
    renderSection({
      listDevices: vi.fn(async () => {
        throw new Error('the server refused the turn (500)')
      }),
    })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('500'))
  })

  it('an empty list shows the EmptyState with a Pair-a-device CTA', async () => {
    renderSection({ listDevices: vi.fn(async () => []) })
    await waitFor(() => expect(screen.getByText(/no devices paired/i)).toBeTruthy())
    expect(screen.getByRole('button', { name: /pair a device/i })).toBeTruthy()
  })

  it('a never-seen device renders "never connected" and NO online indicator', async () => {
    renderSection({ listDevices: vi.fn(async () => [device({ last_seen: null })]) })
    await waitFor(() => expect(screen.getByText('laptop')).toBeTruthy())
    expect(screen.getByText(/never connected/i)).toBeTruthy()
    // The no-fake-numbers rail (DoD item 5): assert the ABSENCE of green/online.
    expect(screen.queryByText('online')).toBeNull()
  })

  it('a fresh device is online (green); a stale one is not', async () => {
    renderSection({
      listDevices: vi.fn(async () => [
        device({ id: 'fresh', name: 'freshbox', last_seen: freshIso() }),
        device({ id: 'stale', name: 'stalebox', last_seen: staleIso() }),
      ]),
    })
    await waitFor(() => expect(screen.getByText('freshbox')).toBeTruthy())
    expect(screen.getByText('online')).toBeTruthy()
    expect(screen.getByText(/last seen/i)).toBeTruthy()
  })

  it('the light poll flips a reconnected device from stale to online with no manual action', async () => {
    let lastSeen = staleIso()
    const listDevices = vi.fn(async () => [device({ name: 'roamer', last_seen: lastSeen })])
    renderSection({ listDevices }, 10)

    await waitFor(() => expect(screen.getByText(/last seen/i)).toBeTruthy())
    expect(screen.queryByText('online')).toBeNull()

    // The device reconnects: its heartbeat bumped last_seen to now.
    lastSeen = freshIso()

    await waitFor(() => expect(screen.getByText('online')).toBeTruthy())
    expect(screen.queryByText(/last seen/i)).toBeNull()
  })

  it('a paired device offers exactly rename and revoke — there is no grants control (no approvals)', async () => {
    // Owner ruling 2026-09-03: pairing IS the authorization. The tile must not
    // grow a control that decides what a paired device may do — this is the
    // line that reddens the day someone rebuilds a grants editor here.
    renderSection({ listDevices: vi.fn(async () => [device({ last_seen: freshIso() })]) })
    await waitFor(() => screen.getByText('laptop'))
    const tile = screen.getByTestId('device-d-1')
    expect(within(tile).getByRole('button', { name: /rename/i })).toBeTruthy()
    expect(within(tile).getByRole('button', { name: /^revoke$/i })).toBeTruthy()
    expect(within(tile).queryByRole('button', { name: /grants/i })).toBeNull()
    expect(within(tile).queryByRole('checkbox')).toBeNull()
    expect(within(tile).queryByText(/filesystem root/i)).toBeNull()
  })

  it('stops polling after unmount — the interval is cleared', async () => {
    const listDevices = vi.fn(async () => [device()])
    const { unmount, api } = renderSection({ listDevices }, 10)

    // Let the poll tick a few times so we know it is genuinely running.
    await waitFor(() => expect(api.listDevices.mock.calls.length).toBeGreaterThanOrEqual(3))
    unmount()
    const countAtUnmount = api.listDevices.mock.calls.length

    // Wait well past several 10ms intervals; a leaked interval would keep firing.
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(api.listDevices.mock.calls.length).toBe(countAtUnmount)
  })

  it('revoke takes a confirm — one click does not call the API, the confirm does', async () => {
    const revoked = device({ revoked_at: new Date().toISOString() })
    const { api } = renderSection({
      listDevices: vi.fn(async () => [device()]),
      revokeDevice: vi.fn(async () => revoked),
    })
    await waitFor(() => screen.getByText('laptop'))

    fireEvent.click(screen.getByRole('button', { name: /^revoke$/i }))
    expect(api.revokeDevice).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /confirm revoke/i }))
    await waitFor(() => expect(api.revokeDevice).toHaveBeenCalledWith('d-1'))
    // Now revoked, the device drops out of the default (live-only) view —
    // reveal it via the toggle to check the row flipped.
    fireEvent.click(await screen.findByRole('button', { name: /show revoked \(1\)/i }))
    const tile = await screen.findByTestId('device-d-1')
    expect(within(tile).getByText(/revoked/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^revoke$/i })).toBeNull()
  })

  it('a revoked device, once revealed, is shown muted with no rename/revoke controls', async () => {
    renderSection({
      listDevices: vi.fn(async () => [device({ revoked_at: new Date().toISOString() })]),
    })
    fireEvent.click(await screen.findByRole('button', { name: /show revoked \(1\)/i }))
    const tile = await screen.findByTestId('device-d-1')
    expect(within(tile).getByText('laptop')).toBeTruthy()
    expect(within(tile).getByText(/revoked/i)).toBeTruthy()
    expect(within(tile).queryByRole('button', { name: /rename/i })).toBeNull()
    expect(within(tile).queryByRole('button', { name: /^revoke$/i })).toBeNull()
  })

  it('revoked devices are hidden by default; live devices render exactly as before', async () => {
    renderSection({
      listDevices: vi.fn(async () => [
        device({ id: 'd-1', name: 'laptop', last_seen: freshIso() }),
        device({ id: 'd-2', name: 'old-wsl-box', revoked_at: new Date().toISOString() }),
      ]),
    })
    await waitFor(() => expect(screen.getByText('laptop')).toBeTruthy())
    expect(screen.getByText('online')).toBeTruthy()
    expect(screen.queryByText('old-wsl-box')).toBeNull()
    expect(screen.getByRole('button', { name: /show revoked \(1\)/i })).toBeTruthy()
  })

  it('no toggle appears when no device is revoked', async () => {
    renderSection({ listDevices: vi.fn(async () => [device({ last_seen: freshIso() })]) })
    await waitFor(() => expect(screen.getByText('laptop')).toBeTruthy())
    expect(screen.queryByRole('button', { name: /revoked/i })).toBeNull()
  })

  it('the toggle names the count, reveals the revoked devices, and toggling back hides them', async () => {
    renderSection({
      listDevices: vi.fn(async () => [
        device({ id: 'd-1', name: 'laptop', last_seen: freshIso() }),
        device({ id: 'd-2', name: 'old-wsl-box', revoked_at: new Date().toISOString() }),
      ]),
    })
    await waitFor(() => screen.getByText('laptop'))

    const showButton = screen.getByRole('button', { name: /show revoked \(1\)/i })
    expect(showButton.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(showButton)

    expect(screen.getByText('old-wsl-box')).toBeTruthy()
    const hideButton = screen.getByRole('button', { name: /^hide revoked$/i })
    expect(hideButton.getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(hideButton)
    expect(screen.queryByText('old-wsl-box')).toBeNull()
    expect(screen.getByRole('button', { name: /show revoked \(1\)/i })).toBeTruthy()
  })

  it('when every device is revoked, the empty state says so plainly and still offers the toggle', async () => {
    renderSection({
      listDevices: vi.fn(async () => [
        device({ id: 'd-1', name: 'old-box', revoked_at: new Date().toISOString() }),
      ]),
    })
    await waitFor(() => expect(screen.getByText(/no devices paired/i)).toBeTruthy())
    expect(screen.queryByText('old-box')).toBeNull()

    const toggle = screen.getByRole('button', { name: /show revoked \(1\)/i })
    fireEvent.click(toggle)

    await waitFor(() => expect(screen.getByText('old-box')).toBeTruthy())
    expect(screen.getByText(/no devices paired/i)).toBeTruthy()
  })

  it('rename calls the API and echoes the new name', async () => {
    const renamed = device({ name: 'workstation' })
    const { api } = renderSection({
      listDevices: vi.fn(async () => [device({ name: 'laptop' })]),
      renameDevice: vi.fn(async () => renamed),
    })
    await waitFor(() => screen.getByText('laptop'))

    fireEvent.click(screen.getByRole('button', { name: /rename/i }))
    const input = screen.getByDisplayValue('laptop')
    fireEvent.change(input, { target: { value: 'workstation' } })
    fireEvent.click(screen.getByRole('button', { name: /^save name$/i }))

    await waitFor(() => expect(api.renameDevice).toHaveBeenCalledWith('d-1', 'workstation'))
    await waitFor(() => expect(screen.getByText('workstation')).toBeTruthy())
  })

  it("the pairing modal mints a code and shows it with the command on Nova's derived address", async () => {
    const { api } = renderSection({ listDevices: vi.fn(async () => []) })
    await waitFor(() => screen.getByRole('button', { name: /pair a device/i }))

    fireEvent.click(screen.getByRole('button', { name: /pair a device/i }))

    await waitFor(() => expect(api.mintPairingCode).toHaveBeenCalled())
    const dialog = await screen.findByRole('dialog')
    // The code is shown big, formatted the way it is read aloud.
    expect(within(dialog).getByTestId('setup-code').textContent).toBe('K7PQ-9XYZ')
    // The Linux line, filled in the BROWSER (S42b) — never the retired
    // novad-enroll one-liner core used to hand back already filled.
    expect(await within(dialog).findByText('L --code K7PQ-9XYZ')).toBeTruthy()
  })

  it('shows what the agent reported, and the WSL note on an agent inside WSL', async () => {
    renderSection({
      listDevices: vi.fn().mockResolvedValue([
        device({ id: 'd-1', name: 'pc', os: 'Windows 11 Pro 24H2 (build 26100)', agent_version: '0.2.0', last_seen: freshIso() }),
        device({ id: 'd-2', name: 'pc-wsl', wsl: 'Ubuntu-26.04', last_seen: freshIso() }),
      ]),
    })
    expect(await screen.findByText('Windows 11 Pro 24H2 (build 26100) · thinkpad · agent 0.2.0')).toBeTruthy()
    expect(screen.getByText(/Runs inside WSL \(Ubuntu-26\.04\)/)).toBeTruthy()
  })
})
