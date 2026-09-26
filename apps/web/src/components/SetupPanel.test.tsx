import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { SetupPanel } from './SetupPanel'

const ADDRESS = 'https://nova.fake-tailnet.ts.net'
const EXPIRES = '2026-09-25T14:10:00Z'
const BEFORE = () => new Date('2026-09-25T14:05:00Z')
const AFTER = () => new Date('2026-09-25T14:11:00Z')

describe('SetupPanel', () => {
  it('encodes the derived address, never the origin this page was opened at (Review Focus 1)', () => {
    render(<SetupPanel setup="install_pwa" address={ADDRESS} fallbackOrigin="http://127.0.0.1:3000" />)
    const label = screen.getByRole('img').getAttribute('aria-label')
    expect(label).toBe(`QR code for ${ADDRESS}/install`)
    expect(label).not.toContain(window.location.host)
    expect(label).not.toContain('127.0.0.1')
    expect(screen.getByText(/signed in to the same tailnet/)).toBeTruthy()
  })

  it('an add_machine setup uses the derived address for the QR and the command, never the loopback fallback (Review Focus 1)', () => {
    render(
      <SetupPanel
        setup="add_machine"
        address={ADDRESS}
        code="ABCD2345"
        expiresAt={EXPIRES}
        clock={BEFORE}
        fallbackOrigin="http://127.0.0.1:3000"
      />,
    )
    const label = screen.getByRole('img').getAttribute('aria-label')
    expect(label).toBe(`QR code for ${ADDRESS}/add#ABCD-2345`)
    expect(label).not.toContain('127.0.0.1')
    expect(screen.getByText(`novad enroll --server ${ADDRESS} --code ABCD-2345`)).toBeTruthy()
    expect(screen.queryByText(/127\.0\.0\.1/)).toBeNull()
  })

  it('states why there is no QR code', () => {
    render(<SetupPanel setup="install_pwa" address={null} reason="the tailnet sidecar is NeedsLogin, not Running" />)
    expect(screen.getByRole('alert').textContent).toContain('NeedsLogin')
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('a machine setup shows the QR, the code and the command, all on the derived address', () => {
    render(<SetupPanel setup="add_machine" address={ADDRESS} code="ABCD2345" expiresAt={EXPIRES} clock={BEFORE} />)
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe(`QR code for ${ADDRESS}/add#ABCD-2345`)
    expect(screen.getByTestId('setup-code').textContent).toBe('ABCD-2345')
    expect(screen.getByText(`novad enroll --server ${ADDRESS} --code ABCD-2345`)).toBeTruthy()
    expect(screen.getByText(/5:00 left/)).toBeTruthy()
  })

  it('an expired code draws nothing to scan and offers a new one', () => {
    const onNewCode = vi.fn()
    render(
      <SetupPanel setup="add_machine" address={ADDRESS} code="ABCD2345" expiresAt={EXPIRES} clock={AFTER} onNewCode={onNewCode} />,
    )
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.queryByText(/novad enroll/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'New code' }))
    expect(onNewCode).toHaveBeenCalledTimes(1)
  })

  it('a reloaded machine card has no code, no QR and no command (Review Focus 4)', () => {
    render(<SetupPanel setup="add_machine" address={ADDRESS} code={null} expiresAt={EXPIRES} clock={BEFORE} />)
    expect(screen.getByTestId('setup-shown-once').textContent).toContain('shown once and expires')
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.queryByTestId('setup-code')).toBeNull()
    expect(screen.queryByText(/novad enroll/)).toBeNull()
  })

  it('a model server says what is not built yet', () => {
    render(<SetupPanel setup="add_model_server" address={ADDRESS} code="ABCD2345" expiresAt={EXPIRES} clock={BEFORE} />)
    expect(screen.getByText(/arrives with S44/)).toBeTruthy()
  })

  it('the app setup says there is no app yet', () => {
    render(<SetupPanel setup="get_app" address={ADDRESS} />)
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe(`QR code for ${ADDRESS}/app`)
    expect(screen.getByText(/no Nova app yet/)).toBeTruthy()
  })

  it('with no address, a machine setup still gives the command for a machine that reaches this page', () => {
    render(
      <SetupPanel setup="add_machine" address={null} reason="no status" code="ABCD2345" expiresAt={EXPIRES} clock={BEFORE} fallbackOrigin="http://127.0.0.1:3000" />,
    )
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByText('novad enroll --server http://127.0.0.1:3000 --code ABCD-2345')).toBeTruthy()
  })
})
