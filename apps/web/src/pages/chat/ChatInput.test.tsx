import { describe, it, expect, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { AgentSummary } from '../../lib/api'
import { ChatInput } from './ChatInput'

/**
 * The composer's slash-command autocomplete. It is a projection of the command
 * registry (lib/commands.ts), so these assert behaviour, not a hardcoded list:
 * the dropdown shows only on a leading-slash token, filters by prefix, drives
 * with the keyboard, and never hijacks Enter when it is closed.
 */

function renderInput() {
  const onSubmit = vi.fn()
  render(<ChatInput onSubmit={onSubmit} disabled={false} />)
  const textarea = screen.getByLabelText('Message Nova') as HTMLTextAreaElement
  const type = (value: string) => fireEvent.change(textarea, { target: { value } })
  return { onSubmit, textarea, type }
}

describe('ChatInput — slash-command autocomplete', () => {
  it('shows the dropdown on a leading slash, listing the registry commands', () => {
    const { type } = renderInput()
    expect(screen.queryByTestId('command-autocomplete')).toBeNull()

    type('/')
    expect(screen.getByTestId('command-autocomplete')).toBeDefined()
    expect(screen.getByTestId('command-option-/clear')).toBeDefined()
    expect(screen.getByTestId('command-option-/help')).toBeDefined()
  })

  it('filters by the typed prefix', () => {
    const { type } = renderInput()
    type('/cl')
    expect(screen.getByTestId('command-option-/clear')).toBeDefined()
    expect(screen.queryByTestId('command-option-/help')).toBeNull()
  })

  it('is hidden when the input has no leading slash', () => {
    const { type } = renderInput()
    type('hello there')
    expect(screen.queryByTestId('command-autocomplete')).toBeNull()
  })

  it('never triggers on a mid-text slash', () => {
    const { type } = renderInput()
    type('hey /clear')
    expect(screen.queryByTestId('command-autocomplete')).toBeNull()
  })

  it('Enter completes a partial command first, then runs it once it is whole', () => {
    const { onSubmit, textarea, type } = renderInput()
    type('/cl')
    // First Enter: completes the input to the full command, does not send yet.
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(textarea.value).toBe('/clear')
    expect(onSubmit).not.toHaveBeenCalled()
    // Second Enter: the input IS the whole command now, so it runs.
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(onSubmit).toHaveBeenCalledWith('/clear')
  })

  it('Enter runs immediately when the input is already the exact command', () => {
    const { onSubmit, textarea, type } = renderInput()
    type('/clear')
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(onSubmit).toHaveBeenCalledWith('/clear')
  })

  it('ArrowDown moves the selection, then Enter completes the highlighted command', () => {
    const { onSubmit, textarea, type } = renderInput()
    type('/') // both commands shown, /clear highlighted first
    fireEvent.keyDown(textarea, { key: 'ArrowDown' }) // -> /help
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(textarea.value).toBe('/help')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('Esc dismisses the dropdown even though matches remain', () => {
    const { textarea, type } = renderInput()
    type('/cl')
    expect(screen.getByTestId('command-autocomplete')).toBeDefined()
    fireEvent.keyDown(textarea, { key: 'Escape' })
    expect(screen.queryByTestId('command-autocomplete')).toBeNull()
  })

  it('clicking a suggestion runs that command', () => {
    const { onSubmit, type } = renderInput()
    type('/cl')
    // The row runs on pointer-down (before the textarea blurs).
    fireEvent.mouseDown(screen.getByTestId('command-option-/clear'))
    expect(onSubmit).toHaveBeenCalledWith('/clear')
  })

  it('does not hijack Enter when the dropdown is closed — a normal message sends', () => {
    const { onSubmit, textarea, type } = renderInput()
    type('just a normal message')
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(onSubmit).toHaveBeenCalledWith('just a normal message')
  })

  it('an unknown /command shows no dropdown and sends as an ordinary message', () => {
    const { onSubmit, textarea, type } = renderInput()
    type('/nope')
    expect(screen.queryByTestId('command-autocomplete')).toBeNull()
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(onSubmit).toHaveBeenCalledWith('/nope')
  })
})

/**
 * The composer's `@` autocomplete (S12). The roster comes through the `api`
 * seam, so these assert behaviour against a fake GET /api/v1/agents: the menu
 * opens only on a leading-@ token, filters by prefix, completes to "@name "
 * and NEVER sends, and a roster that cannot be read is a menu that never
 * opens — no error UI, because the browser only offers; core decides.
 */

const AGENTS: AgentSummary[] = [
  { name: 'coder', purpose: 'writes and fixes code', role: 'agent_coder' },
  { name: 'mailer', purpose: 'drafts email', role: 'agent_mailer' },
]

function renderWithAgents(listAgents: () => Promise<AgentSummary[]> = async () => AGENTS) {
  const onSubmit = vi.fn()
  const spy = vi.fn(listAgents)
  render(<ChatInput onSubmit={onSubmit} disabled={false} api={{ listAgents: spy }} />)
  const textarea = screen.getByLabelText('Message Nova') as HTMLTextAreaElement
  const type = (value: string) => fireEvent.change(textarea, { target: { value } })
  return { onSubmit, textarea, type, listAgents: spy }
}

/** Let a settled promise's continuation run inside act. */
const settle = () =>
  act(async () => {
    await Promise.resolve()
  })

describe('ChatInput — the @agent autocomplete (S12)', () => {
  it('opens on a leading @ with the agents whose names start with it, showing name and purpose', async () => {
    const { type } = renderWithAgents()
    expect(screen.queryByTestId('mention-autocomplete')).toBeNull()
    type('@c')
    await screen.findByTestId('mention-autocomplete')
    const option = screen.getByTestId('mention-option-coder')
    expect(option.textContent).toContain('@coder')
    expect(option.textContent).toContain('writes and fixes code')
    expect(screen.queryByTestId('mention-option-mailer')).toBeNull()
  })

  it('a bare @ offers every agent, and the roster is read once for the life of the composer', async () => {
    const { type, listAgents } = renderWithAgents()
    type('@')
    await screen.findByTestId('mention-autocomplete')
    expect(screen.getByTestId('mention-option-coder')).toBeDefined()
    expect(screen.getByTestId('mention-option-mailer')).toBeDefined()
    type('@m')
    expect(screen.queryByTestId('mention-option-coder')).toBeNull()
    type('')
    type('@')
    expect(listAgents).toHaveBeenCalledTimes(1)
  })

  it('Enter completes the highlighted agent to "@name " and never sends; the message then sends as one', async () => {
    const { onSubmit, textarea, type } = renderWithAgents()
    type('@c')
    await screen.findByTestId('mention-autocomplete')
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(textarea.value).toBe('@coder ')
    expect(onSubmit).not.toHaveBeenCalled()
    // The trailing space closed the token: the menu is gone by itself.
    expect(screen.queryByTestId('mention-autocomplete')).toBeNull()
    type('@coder fix the tests')
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(onSubmit).toHaveBeenCalledWith('@coder fix the tests')
  })

  it('Tab completes too, and does not send', async () => {
    const { onSubmit, textarea, type } = renderWithAgents()
    type('@ma')
    await screen.findByTestId('mention-autocomplete')
    fireEvent.keyDown(textarea, { key: 'Tab' })
    expect(textarea.value).toBe('@mailer ')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('ArrowDown moves the selection, then Enter completes the highlighted agent', async () => {
    const { onSubmit, textarea, type } = renderWithAgents()
    type('@')
    await screen.findByTestId('mention-autocomplete')
    fireEvent.keyDown(textarea, { key: 'ArrowDown' })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(textarea.value).toBe('@mailer ')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('Escape closes the menu though matches remain; typing more re-opens it', async () => {
    const { textarea, type } = renderWithAgents()
    type('@c')
    await screen.findByTestId('mention-autocomplete')
    fireEvent.keyDown(textarea, { key: 'Escape' })
    expect(screen.queryByTestId('mention-autocomplete')).toBeNull()
    type('@co')
    expect(screen.getByTestId('mention-autocomplete')).toBeDefined()
  })

  it('clicking an option completes it, never sends', async () => {
    const { onSubmit, textarea, type } = renderWithAgents()
    type('@c')
    await screen.findByTestId('mention-autocomplete')
    fireEvent.mouseDown(screen.getByTestId('mention-option-coder'))
    expect(textarea.value).toBe('@coder ')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('never opens on a mid-text @ or once a space follows the name — and never asks the server for one', async () => {
    const { listAgents, type } = renderWithAgents()
    type('mail @coder')
    await settle()
    expect(screen.queryByTestId('mention-autocomplete')).toBeNull()
    type('@coder hi')
    await settle()
    expect(screen.queryByTestId('mention-autocomplete')).toBeNull()
    expect(listAgents).not.toHaveBeenCalled()
  })

  it('an @ that matches no agent shows no menu and sends as an ordinary message — core decides', async () => {
    const { onSubmit, textarea, type } = renderWithAgents()
    type('@nobody')
    await waitFor(() => expect(screen.queryByTestId('mention-autocomplete')).toBeNull())
    await settle()
    expect(screen.queryByTestId('mention-autocomplete')).toBeNull()
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(onSubmit).toHaveBeenCalledWith('@nobody')
  })

  it('when the roster cannot be read the menu simply never opens, with no error shown, and Enter still sends', async () => {
    const { listAgents, onSubmit, textarea, type } = renderWithAgents(async () => {
      throw new Error('the server refused the request (503)')
    })
    type('@c')
    await waitFor(() => expect(listAgents).toHaveBeenCalledTimes(1))
    await settle()
    expect(screen.queryByTestId('mention-autocomplete')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(document.body.textContent).not.toContain('503')
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(onSubmit).toHaveBeenCalledWith('@c')
  })

  it('the slash menu is untouched: a leading / still offers commands, never agents', async () => {
    const { listAgents, type } = renderWithAgents()
    type('/cl')
    await settle()
    expect(screen.getByTestId('command-autocomplete')).toBeDefined()
    expect(screen.queryByTestId('mention-autocomplete')).toBeNull()
    expect(listAgents).not.toHaveBeenCalled()
  })
})
