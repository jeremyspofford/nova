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

  it('a device with only system.info shows the powerful capabilities unchecked, and granting fs.read saves the new list', async () => {
    const updated = device({ capabilities: ['system.info', 'fs.read'] })
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

    // Grant fs.read and save.
    fireEvent.click(screen.getByRole('checkbox', { name: /fs\.read/i }))
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() =>
      expect(api.setGrants).toHaveBeenCalledWith('d-1', {
        capabilities: ['system.info', 'fs.read'],
        fs_roots: [],
      }),
    )
  })

  it('adding a relative fs-root shows a stated refusal and does not enter the list', async () => {
    const { api } = renderSection({
      listDevices: vi.fn(async () => [device({ capabilities: ['system.info'] })]),
      setGrants: vi.fn(async () => device({ capabilities: ['system.info', 'fs.list'] })),
    })
    await waitFor(() => screen.getByText('laptop'))
    fireEvent.click(screen.getByRole('button', { name: /grants/i }))

    // A legitimate toggle makes the panel dirty so Save is offered.
    fireEvent.click(screen.getByRole('checkbox', { name: /fs\.list/i }))

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
