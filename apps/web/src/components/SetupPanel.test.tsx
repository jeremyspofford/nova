import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { AgentCommands, SetupPanel } from './SetupPanel'

const ADDRESS = 'https://nova.fake-tailnet.ts.net'
const EXPIRES = '2026-09-25T14:10:00Z'
const BEFORE = () => new Date('2026-09-25T14:05:00Z')
const AFTER = () => new Date('2026-09-25T14:11:00Z')

const COMMANDS = {
  linux: `curl -fsSL ${ADDRESS}/api/v1/agent/dist/novad-linux-amd64 … install --hub ${ADDRESS} --code ABCD-2345`,
  macos: `curl -fsSL ${ADDRESS}/api/v1/agent/dist/novad-darwin-arm64 … install --hub ${ADDRESS} --code ABCD-2345`,
  windows: `curl.exe -fsSL -o $f "${ADDRESS}/api/v1/agent/dist/novad-windows-amd64.exe"; … --code ABCD-2345`,
}
const WALKS = { linux: 'Linux: walked 2026-09-01 (S5)', macos: 'macOS: not walked yet', windows: 'Windows: walked 2026-09-28 (S42a, by hand)' }
const NOTES = { linux: '', macos: '', windows: 'Nova’s agent is unsigned for now.' }

describe('SetupPanel', () => {
  it('encodes the derived address, never the origin this page was opened at (Review Focus 1)', () => {
    render(<SetupPanel setup="install_pwa" address={ADDRESS} />)
    const label = screen.getByRole('img').getAttribute('aria-label')
    expect(label).toBe(`QR code for ${ADDRESS}/install`)
    expect(label).not.toContain(window.location.host)
    expect(screen.getByText(/signed in to the same tailnet/)).toBeTruthy()
  })

  it('the PWA setup says a PWA cannot manage the phone it runs on; the app setup does not', () => {
    const { unmount } = render(<SetupPanel setup="install_pwa" address={ADDRESS} />)
    expect(screen.getByTestId('setup-pwa-limit').textContent).toContain('cannot manage the phone it runs on')
    unmount()
    render(<SetupPanel setup="get_app" address={ADDRESS} />)
    expect(screen.queryByTestId('setup-pwa-limit')).toBeNull()
  })

  it('an add_machine setup uses the derived address for the QR, never this browser’s own origin — the command is whatever core generated (Review Focus 1)', () => {
    render(
      <SetupPanel
        setup="add_machine"
        address={ADDRESS}
        code="ABCD2345"
        expiresAt={EXPIRES}
        clock={BEFORE}
        commands={COMMANDS}
      />,
    )
    const label = screen.getByRole('img').getAttribute('aria-label')
    expect(label).toBe(`QR code for ${ADDRESS}/add#ABCD-2345`)
    expect(label).not.toContain(window.location.host)
    expect(screen.getByText(COMMANDS.linux)).toBeTruthy()
  })

  it('states why there is no QR code', () => {
    render(<SetupPanel setup="install_pwa" address={null} reason="the tailnet sidecar is NeedsLogin, not Running" />)
    expect(screen.getByRole('alert').textContent).toContain('NeedsLogin')
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('a machine setup shows the QR, the code and the per-OS command, all on the derived address', () => {
    render(
      <SetupPanel
        setup="add_machine"
        address={ADDRESS}
        code="ABCD2345"
        expiresAt={EXPIRES}
        clock={BEFORE}
        commands={COMMANDS}
      />,
    )
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe(`QR code for ${ADDRESS}/add#ABCD-2345`)
    expect(screen.getByTestId('setup-code').textContent).toBe('ABCD-2345')
    expect(screen.getByText(COMMANDS.linux)).toBeTruthy()
    expect(screen.getByText(/5:00 left/)).toBeTruthy()
  })

  it('an expired code draws nothing to scan and offers a new one', () => {
    const onNewCode = vi.fn()
    render(
      <SetupPanel setup="add_machine" address={ADDRESS} code="ABCD2345" expiresAt={EXPIRES} clock={AFTER} onNewCode={onNewCode} commands={COMMANDS} />,
    )
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.queryByText(COMMANDS.linux)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'New code' }))
    expect(onNewCode).toHaveBeenCalledTimes(1)
  })

  // Final review: spec §10 promises a way forward once a code lapses. Her
  // chat card has no onNewCode (only Settings can mint), so a lapsed LIVE card
  // there says where the next code comes from; Settings keeps its button.
  it('a lapsed live code with no way to mint here says to ask Nova for a new card', () => {
    render(<SetupPanel setup="add_machine" address={ADDRESS} code="ABCD2345" expiresAt={EXPIRES} clock={AFTER} />)
    expect(screen.getByText(/^Expired at .+\. Ask Nova for a new card\.$/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'New code' })).toBeNull()
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('a lapsed live code where a new one can be minted offers the button, not the sentence', () => {
    render(
      <SetupPanel setup="add_machine" address={ADDRESS} code="ABCD2345" expiresAt={EXPIRES} clock={AFTER} onNewCode={vi.fn()} />,
    )
    expect(screen.getByRole('button', { name: 'New code' })).toBeTruthy()
    expect(screen.getByText(/^Expired at .+\.$/)).toBeTruthy()
    expect(screen.queryByText(/Ask Nova for a new card/)).toBeNull()
  })

  it('a reloaded machine card has no code, no QR and no command (Review Focus 4)', () => {
    render(<SetupPanel setup="add_machine" address={ADDRESS} code={null} expiresAt={EXPIRES} clock={BEFORE} commands={COMMANDS} />)
    expect(screen.getByTestId('setup-shown-once').textContent).toContain('shown once and expires')
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.queryByTestId('setup-code')).toBeNull()
    expect(screen.queryByText(COMMANDS.linux)).toBeNull()
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

  it('with no address, core’s commands still show when given, and this page’s origin appears nowhere', () => {
    render(
      <SetupPanel
        setup="add_machine"
        address={null}
        reason="no status"
        code="ABCD2345"
        expiresAt={EXPIRES}
        clock={BEFORE}
        commands={COMMANDS}
      />,
    )
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByText(COMMANDS.linux)).toBeTruthy()
    expect(screen.getByRole('alert').textContent).not.toContain(window.location.origin)
  })

  it('a live machine card shows one command per OS, opening on the asked-for one, with its walk and note', () => {
    render(
      <SetupPanel setup="add_machine" address={ADDRESS} code="ABCD2345" expiresAt={EXPIRES} clock={BEFORE}
        commands={COMMANDS} walks={WALKS} notes={NOTES} forOs="wsl" />,
    )
    expect(screen.getByText(COMMANDS.windows)).toBeTruthy()
    expect(screen.getByText('Windows: walked 2026-09-28 (S42a, by hand)')).toBeTruthy()
    expect(screen.getByText('Nova’s agent is unsigned for now.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'macOS' }))
    expect(screen.getByText(COMMANDS.macos)).toBeTruthy()
    expect(screen.getByText('macOS: not walked yet')).toBeTruthy()
    expect(screen.queryByText(/build it as its README says/)).toBeNull()
  })

  it('no command is said, with the reason, when core could not make one', () => {
    render(
      <SetupPanel setup="add_machine" address={ADDRESS} code="ABCD2345" expiresAt={EXPIRES} clock={BEFORE}
        commands={null} commandsReason="the hub has no agent build yet" />,
    )
    expect(screen.getByRole('alert').textContent).toContain('No command: the hub has no agent build yet')
  })

  it('an expired or reloaded card shows no command at all (Review Focus 4)', () => {
    const { unmount } = render(
      <SetupPanel setup="add_machine" address={ADDRESS} code="ABCD2345" expiresAt={EXPIRES} clock={AFTER} commands={COMMANDS} />,
    )
    expect(screen.queryByText(COMMANDS.linux)).toBeNull()
    unmount()
    render(<SetupPanel setup="add_machine" address={ADDRESS} code={null} expiresAt={EXPIRES} clock={BEFORE} commands={COMMANDS} />)
    expect(screen.queryByText(COMMANDS.linux)).toBeNull()
  })
})

describe('AgentCommands — never offers a line still carrying {CODE}, or a missing one, for copying (S42b K3)', () => {
  it('commands already null (fillCommands’ own reason) shows it verbatim', () => {
    render(<AgentCommands commands={null} reason="the pairing code is not in Nova's code format, so no command was filled" />)
    expect(screen.getByRole('alert').textContent).toContain("the pairing code is not in Nova's code format")
  })

  it('a commands map missing the active OS key is never offered for copying (the reviewer’s probe)', () => {
    render(<AgentCommands commands={{ linux: 'l' } as never} forOs="windows" />)
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Copy/ })).toBeNull()
    expect(document.querySelectorAll('code')).toHaveLength(0)
  })

  it('a line that still carries {CODE} is never offered for copying', () => {
    render(<AgentCommands commands={{ linux: 'L --code {CODE}', macos: 'm', windows: 'w' }} forOs="linux" />)
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(screen.queryByText(/\{CODE\}/)).toBeNull()
    expect(document.querySelectorAll('code')).toHaveLength(0)
  })
})
