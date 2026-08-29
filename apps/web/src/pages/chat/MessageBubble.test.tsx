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

  it('does not also show the generic loading dots while a tool is announced', () => {
    render(
      <MessageBubble row={assistantRow({ activity: { tool: 'get_time', status: 'start' } })} />,
    )
    expect(screen.queryByLabelText('waiting for the model')).toBeNull()
  })
})
