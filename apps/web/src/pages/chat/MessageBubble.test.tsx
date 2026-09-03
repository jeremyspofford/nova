import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MessageBubble } from './MessageBubble'
import type { MessageRow } from './chatReducer'

function assistantRow(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    kind: 'message',
    id: 'a1',
    role: 'assistant',
    text: '',
    streaming: true,
    interrupted: false,
    activity: null,
    ...overrides,
  }
}

describe('MessageBubble — the live tool-call line', () => {
  it('shows nothing extra when there is no activity', () => {
    render(<MessageBubble row={assistantRow({ text: 'hi' })} />)
    expect(screen.queryByTestId('activity-line')).toBeNull()
  })

  it('names the tool while it is running', () => {
    render(
      <MessageBubble
        row={assistantRow({ activity: { tool: 'workspace_write_file', status: 'start' } })}
      />,
    )
    const line = screen.getByTestId('activity-line')
    expect(line.textContent).toContain('workspace_write_file')
  })

  it('shows a stated failure when the tool errors, distinct from the running state', () => {
    render(
      <MessageBubble
        row={assistantRow({ activity: { tool: 'workspace_read_file', status: 'error' } })}
      />,
    )
    const line = screen.getByTestId('activity-line')
    expect(line.textContent).toContain('workspace_read_file')
    expect(line.className).toMatch(/danger/)
  })

  // Owner's walk, 2026-09-02: device_run tree FINISHED with a stated refusal
  // ("executable file not found in $PATH") and the model adapted around it —
  // but the bubble said the tool "did not finish", a claim the frame cannot
  // back. Pinned both ways: with a reason the bubble states it; without one
  // it says only "failed", never "did not finish" (that phrase is reserved
  // for a genuinely interrupted stream — row.interrupted, a different case).
  it('states the tool\'s own reason on a stated error, never "did not finish"', () => {
    render(
      <MessageBubble
        row={assistantRow({
          activity: {
            tool: 'device_run',
            status: 'error',
            reason: 'could not run tree: executable file not found in $PATH',
          },
        })}
      />,
    )
    const line = screen.getByTestId('activity-line')
    expect(line.textContent).toBe(
      'device_run: could not run tree: executable file not found in $PATH',
    )
    expect(line.textContent).not.toContain('did not finish')
  })

  it('falls back to a plain "failed" when the error carries no reason, never "did not finish"', () => {
    render(
      <MessageBubble
        row={assistantRow({ activity: { tool: 'workspace_read_file', status: 'error' } })}
      />,
    )
    const line = screen.getByTestId('activity-line')
    expect(line.textContent).toBe('workspace_read_file failed')
    expect(line.textContent).not.toContain('did not finish')
  })

  it('does not also show the generic loading dots while a tool is announced', () => {
    render(
      <MessageBubble row={assistantRow({ activity: { tool: 'get_time', status: 'start' } })} />,
    )
    expect(screen.queryByLabelText('waiting for the model')).toBeNull()
  })
})
