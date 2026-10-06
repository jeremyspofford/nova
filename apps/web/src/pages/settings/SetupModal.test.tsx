import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor, within, act } from '@testing-library/react'
import { SetupModal, type SetupModalApi } from './SetupModal'

const ADDRESS = { address: 'https://nova.fake-tailnet.ts.net', reason: null, read_at: '2026-09-25T14:00:00Z' }
const MANIFEST = {
  version: 'aaaaaaaaaaaa',
  commands: { linux: 'L --code {CODE}', macos: 'M --code {CODE}', windows: 'W --code {CODE}' },
  commands_reason: null,
  walks: { linux: 'Linux: walked', macos: 'macOS: not walked yet', windows: 'Windows: walked' },
  notes: { linux: '', macos: '', windows: '' },
}

function fakeApi(over: Partial<SetupModalApi> = {}): SetupModalApi {
  return {
    getNetworkAddress: vi.fn(async () => ADDRESS),
    mintPairingCode: vi.fn(async () => ({ code: 'ABCD2345', expires_at: new Date(Date.now() + 600_000).toISOString() })),
    mintRepairCode: vi.fn(async () => ({ code: 'K7PQ9XYZ', expires_at: new Date(Date.now() + 600_000).toISOString() })),
    getAgentManifest: vi.fn(async () => MANIFEST),
    ...over,
  }
}

describe('SetupModal — repair mode (S42b decision 4)', () => {
  it('with no repair, mints an ordinary pairing code and titles the setup normally', async () => {
    const api = fakeApi()
    render(<SetupModal setup="add_machine" onClose={vi.fn()} api={api} />)
    await waitFor(() => expect(api.mintPairingCode).toHaveBeenCalledTimes(1))
    expect(api.mintRepairCode).not.toHaveBeenCalled()
    expect(await screen.findByRole('dialog', { name: 'A machine Nova controls' })).toBeTruthy()
  })

  it('with repair, mints a code bound to that one device and titles it Re-pair <name>', async () => {
    const api = fakeApi()
    render(<SetupModal setup="add_machine" onClose={vi.fn()} api={api} repair={{ id: 'd-9', name: 'thinkpad' }} />)
    await waitFor(() => expect(api.mintRepairCode).toHaveBeenCalledWith('d-9'))
    expect(api.mintPairingCode).not.toHaveBeenCalled()
    const dialog = await screen.findByRole('dialog', { name: 'Re-pair thinkpad' })
    expect(within(dialog).getByTestId('setup-code').textContent).toBe('K7PQ-9XYZ')
    expect(await within(dialog).findByText('L --code K7PQ-9XYZ')).toBeTruthy()
  })

  it('a manifest failure becomes the panel’s “no command” reason, not the modal’s error state', async () => {
    const api = fakeApi({
      getAgentManifest: vi.fn(async () => {
        throw new Error('the hub has no agent build yet')
      }),
    })
    render(<SetupModal setup="add_machine" onClose={vi.fn()} api={api} />)
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).queryByText(/Could not prepare this/)).toBeNull()
    expect((await within(dialog).findByRole('alert')).textContent).toContain('the hub has no agent build yet')
    // The QR code and the live pairing code still work.
    expect(within(dialog).getByTestId('setup-code').textContent).toBe('ABCD-2345')
  })

  it('a re-render with a new but equal-valued repair object mints only once (S42b K11)', async () => {
    const api = fakeApi()
    const { rerender } = render(
      <SetupModal setup="add_machine" onClose={vi.fn()} api={api} repair={{ id: 'd-9', name: 'thinkpad' }} />,
    )
    await waitFor(() => expect(api.mintRepairCode).toHaveBeenCalledTimes(1))
    rerender(<SetupModal setup="add_machine" onClose={vi.fn()} api={api} repair={{ id: 'd-9', name: 'thinkpad' }} />)
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(api.mintRepairCode).toHaveBeenCalledTimes(1)
  })
})
