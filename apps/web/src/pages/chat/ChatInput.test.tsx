import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
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
