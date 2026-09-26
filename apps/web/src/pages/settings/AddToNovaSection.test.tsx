import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { AddToNovaSection } from './AddToNovaSection'

const ADDRESS = { address: 'https://nova.fake-tailnet.ts.net', reason: null, read_at: '2026-09-25T14:00:00Z' }

function renderSection(over: Record<string, unknown> = {}) {
  const api = {
    getNetworkAddress: vi.fn(async () => ADDRESS),
    mintPairingCode: vi.fn(async () => ({
      code: 'ABCD2345',
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    })),
    ...over,
  }
  render(<AddToNovaSection api={api as never} />)
  return api
}

describe('AddToNovaSection', () => {
  it('offers the four setups', () => {
    renderSection()
    for (const name of [/A machine Nova controls/, /A model server/, /Nova on a phone/, /The Nova app/]) {
      expect(screen.getByRole('button', { name })).toBeTruthy()
    }
  })

  it('a machine tile reads the address and mints exactly one code', async () => {
    const api = renderSection()
    fireEvent.click(screen.getByRole('button', { name: /A machine Nova controls/ }))
    const dialog = await screen.findByRole('dialog')
    expect((await within(dialog).findByTestId('setup-code')).textContent).toBe('ABCD-2345')
    expect(api.getNetworkAddress).toHaveBeenCalledTimes(1)
    expect(api.mintPairingCode).toHaveBeenCalledTimes(1)
  })

  it('a phone tile mints nothing', async () => {
    const api = renderSection()
    fireEvent.click(screen.getByRole('button', { name: /Nova on a phone/ }))
    const dialog = await screen.findByRole('dialog')
    const qr = await within(dialog).findByRole('img')
    expect(qr.getAttribute('aria-label')).toBe('QR code for https://nova.fake-tailnet.ts.net/install')
    expect(api.mintPairingCode).not.toHaveBeenCalled()
  })

  it('an already-expired minted code shows New code, and clicking it mints a second code', async () => {
    const expired = new Date(Date.now() - 60_000).toISOString()
    const fresh = new Date(Date.now() + 10 * 60 * 1000).toISOString()
    const mintPairingCode = vi
      .fn()
      .mockResolvedValueOnce({ code: 'K7PQ9XYZ', expires_at: expired })
      .mockResolvedValueOnce({ code: 'W4RS9YCD', expires_at: fresh })
    const api = renderSection({ mintPairingCode })

    fireEvent.click(screen.getByRole('button', { name: /A machine Nova controls/ }))
    const dialog = await screen.findByRole('dialog')

    const newCodeButton = await within(dialog).findByRole('button', { name: 'New code' })
    fireEvent.click(newCodeButton)

    expect((await within(dialog).findByTestId('setup-code')).textContent).toBe('W4RS-9YCD')
    expect(api.mintPairingCode).toHaveBeenCalledTimes(2)
  })

  it('an address that cannot be read is stated, not guessed', async () => {
    renderSection({ getNetworkAddress: vi.fn(async () => Promise.reject(new Error('Nova did not answer'))) })
    fireEvent.click(screen.getByRole('button', { name: /The Nova app/ }))
    const dialog = await screen.findByRole('dialog')
    expect((await within(dialog).findByRole('alert')).textContent).toContain('Nova did not answer')
  })
})
