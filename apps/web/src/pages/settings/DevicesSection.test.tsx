import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { DevicesSection } from './DevicesSection'
import type { Device, PairingCode } from '../../lib/api'

function device(overrides: Partial<Device> = {}): Device {
  return {
    id: 'd-1',
    name: 'laptop',
    platform: 'linux',
    hostname: 'thinkpad',
    capabilities: ['system.info'],
    fs_roots: [],
    enrolled_at: '2026-08-30T00:00:00Z',
    last_seen: null,
    revoked_at: null,
    connected: false,
    home_dir: null,
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
    setGrants: ReturnType<typeof vi.fn>
    revokeDevice: ReturnType<typeof vi.fn>
  }> = {},
  pollIntervalMs = 1_000_000,
) {
  const full = {
    listDevices: vi.fn(async () => [] as Device[]),
    mintPairingCode: vi.fn(
      async (): Promise<PairingCode> => ({
        code: 'A1B2C3D4',
        expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      }),
    ),
    renameDevice: vi.fn(),
    setGrants: vi.fn(),
    revokeDevice: vi.fn(),
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

  it('a device with only system.info shows the powerful capabilities unchecked, and granting apps.list saves the new list', async () => {
    // apps.list, not fs.read: an fs.* grant now needs a root (its own tests
    // below) — this test is about the whole-set, sorted save.
    const updated = device({ capabilities: ['apps.list', 'system.info'] })
    const { api } = renderSection({
      listDevices: vi.fn(async () => [device({ capabilities: ['system.info'] })]),
      setGrants: vi.fn(async () => updated),
    })
    await waitFor(() => screen.getByText('laptop'))

    fireEvent.click(screen.getByRole('button', { name: /grants/i }))

    // The powerful set starts unchecked on a fresh device.
    const shellBox = screen.getByRole('checkbox', { name: /shell\.exec/i }) as HTMLInputElement
    const writeBox = screen.getByRole('checkbox', { name: /fs\.write/i }) as HTMLInputElement
    expect(shellBox.checked).toBe(false)
    expect(writeBox.checked).toBe(false)

    // Grant apps.list and save.
    fireEvent.click(screen.getByRole('checkbox', { name: /apps\.list/i }))
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() =>
      expect(api.setGrants).toHaveBeenCalledWith('d-1', {
        // Saved as the whole drafted set, sorted — preserves anything the row
        // holds that this UI doesn't render (see the preservation test below).
        capabilities: ['apps.list', 'system.info'],
        fs_roots: [],
      }),
    )
  })

  it('toggling a capability on one device tile does not cross-toggle another (unique per-tile ids)', async () => {
    renderSection({
      listDevices: vi.fn(async () => [
        device({ id: 'a', name: 'alpha', capabilities: ['system.info'] }),
        device({ id: 'b', name: 'bravo', capabilities: ['system.info'] }),
      ]),
    })
    await waitFor(() => screen.getByText('alpha'))
    const tileA = screen.getByTestId('device-a')
    const tileB = screen.getByTestId('device-b')

    // Open Grants on BOTH — the two "fs.read" checkboxes now coexist.
    fireEvent.click(within(tileA).getByRole('button', { name: /grants/i }))
    fireEvent.click(within(tileB).getByRole('button', { name: /grants/i }))

    const aRead = within(tileA).getByRole('checkbox', { name: /fs\.read/i }) as HTMLInputElement
    const bRead = within(tileB).getByRole('checkbox', { name: /fs\.read/i }) as HTMLInputElement
    // Distinct DOM ids: the exact thing the dup-id bug collapses.
    expect(aRead.id).not.toBe(bRead.id)
    expect(aRead.checked).toBe(false)
    expect(bRead.checked).toBe(false)

    // Click device B's LABEL (what a user actually clicks — the input is
    // sr-only). A label routes to its associated control by id; with a shared
    // id it would toggle device A's box instead.
    fireEvent.click(within(tileB).getByText(/read files \(fs\.read\)/i))

    expect(bRead.checked).toBe(true)
    expect(aRead.checked).toBe(false) // device A must NOT have moved
  })

  it('a capability the UI does not render survives an unrelated toggle + save (derived, not hardcoded)', async () => {
    const { api } = renderSection({
      // "future.cap" is held by the row but not among the rendered 8.
      listDevices: vi.fn(async () => [device({ capabilities: ['system.info', 'future.cap'] })]),
      setGrants: vi.fn(async () => device({ capabilities: ['system.info', 'future.cap', 'apps.list'] })),
    })
    await waitFor(() => screen.getByText('laptop'))
    fireEvent.click(screen.getByRole('button', { name: /grants/i }))

    fireEvent.click(screen.getByRole('checkbox', { name: /apps\.list/i }))
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => expect(api.setGrants).toHaveBeenCalled())
    // The unrendered capability is preserved in the saved list, never stripped.
    expect(api.setGrants.mock.calls[0][1].capabilities).toContain('future.cap')
    expect(api.setGrants.mock.calls[0][1].capabilities).toContain('apps.list')
    expect(api.setGrants.mock.calls[0][1].capabilities).toContain('system.info')
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

  it('adding a relative fs-root shows a stated refusal and does not enter the list', async () => {
    const { api } = renderSection({
      listDevices: vi.fn(async () => [device({ capabilities: ['system.info'] })]),
      setGrants: vi.fn(async () => device({ capabilities: ['system.info', 'apps.list'] })),
    })
    await waitFor(() => screen.getByText('laptop'))
    fireEvent.click(screen.getByRole('button', { name: /grants/i }))

    // A legitimate toggle makes the panel dirty so Save is offered (apps.list,
    // not an fs.* capability — those need a root, and the bad path below is
    // refused at entry so no root would be there to satisfy it).
    fireEvent.click(screen.getByRole('checkbox', { name: /apps\.list/i }))

    const rootInput = screen.getByPlaceholderText(/\/absolute\/path/i)
    fireEvent.change(rootInput, { target: { value: 'projects/notes' } })
    fireEvent.click(screen.getByRole('button', { name: /add root/i }))

    // A stated refusal appears, and the relative path never joins the list.
    expect(screen.getByText(/absolute path/i)).toBeTruthy()
    // Saving now carries the toggled capability but NO fs_roots — the bad path
    // was refused at entry, never queued for the save.
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() => expect(api.setGrants).toHaveBeenCalled())
    expect(api.setGrants.mock.calls[0][1].fs_roots).toEqual([])
  })

  it('saving an fs grant with no root is refused with the stated message and the API is never called', async () => {
    const { api } = renderSection({
      listDevices: vi.fn(async () => [device({ capabilities: ['system.info'], home_dir: '/home/jeremy' })]),
    })
    await waitFor(() => screen.getByText('laptop'))
    fireEvent.click(screen.getByRole('button', { name: /grants/i }))

    fireEvent.click(screen.getByRole('checkbox', { name: /fs\.list/i }))
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    // The same words core answers with: the capability, and the suggested home.
    const message = await screen.findByText(/fs\.list needs at least one filesystem root/i)
    expect(message.textContent).toContain('/home/jeremy')
    expect(api.setGrants).not.toHaveBeenCalled()
  })

  it('the suggested root (the device home) is offered, Add puts it in the list, and the save carries it', async () => {
    const { api } = renderSection({
      listDevices: vi.fn(async () => [device({ capabilities: ['system.info'], home_dir: '/home/jeremy' })]),
      setGrants: vi.fn(async () =>
        device({ capabilities: ['fs.list', 'system.info'], fs_roots: ['/home/jeremy'], home_dir: '/home/jeremy' }),
      ),
    })
    await waitFor(() => screen.getByText('laptop'))
    fireEvent.click(screen.getByRole('button', { name: /grants/i }))

    expect(screen.getByText(/suggested root/i)).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox', { name: /fs\.list/i }))
    fireEvent.click(screen.getByRole('button', { name: /add suggested root/i }))

    // It is now in the roots list (and the suggestion disappears — nothing to offer).
    expect(screen.getByRole('button', { name: /remove \/home\/jeremy/i })).toBeTruthy()
    expect(screen.queryByText(/suggested root/i)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() =>
      expect(api.setGrants).toHaveBeenCalledWith('d-1', {
        capabilities: ['fs.list', 'system.info'],
        fs_roots: ['/home/jeremy'],
      }),
    )
  })

  it('no suggestion is shown when the device reported no home', async () => {
    renderSection({
      listDevices: vi.fn(async () => [device({ capabilities: ['system.info'], home_dir: null })]),
    })
    await waitFor(() => screen.getByText('laptop'))
    fireEvent.click(screen.getByRole('button', { name: /grants/i }))
    expect(screen.queryByText(/suggested root/i)).toBeNull()
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
    // The row flips to the revoked rendering; its controls disappear.
    await waitFor(() => expect(screen.getByText(/revoked/i)).toBeTruthy())
    expect(screen.queryByRole('button', { name: /^revoke$/i })).toBeNull()
  })

  it('a revoked device is still shown, muted, with no rename/grants/revoke controls', async () => {
    renderSection({
      listDevices: vi.fn(async () => [device({ revoked_at: new Date().toISOString() })]),
    })
    await waitFor(() => screen.getByText('laptop'))
    expect(screen.getByText(/revoked/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /grants/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /rename/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /^revoke$/i })).toBeNull()
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

  it('the pairing modal mints a code and shows the enroll one-liner with this origin and the code', async () => {
    const { api } = renderSection({ listDevices: vi.fn(async () => []) })
    await waitFor(() => screen.getByRole('button', { name: /pair a device/i }))

    fireEvent.click(screen.getByRole('button', { name: /pair a device/i }))

    await waitFor(() => expect(api.mintPairingCode).toHaveBeenCalled())
    const dialog = await screen.findByRole('dialog')
    // The code is shown big.
    expect(within(dialog).getByText('A1B2C3D4')).toBeTruthy()
    // The enroll one-liner carries THIS origin and the code, verbatim.
    const expected = `novad enroll --server ${window.location.origin} --code A1B2C3D4`
    expect(within(dialog).getByText(content => content.includes(expected))).toBeTruthy()
  })
})
