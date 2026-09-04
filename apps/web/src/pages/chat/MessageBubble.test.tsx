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

function userRow(text: string): MessageRow {
  return {
    kind: 'message',
    id: 'u1',
    role: 'user',
    text,
    streaming: false,
    interrupted: false,
    activity: null,
  }
}

describe('MessageBubble — her replies are markdown, the owner\'s are not', () => {
  it('renders an assistant reply\'s markdown as elements', () => {
    render(
      <MessageBubble
        row={assistantRow({
          streaming: false,
          text: '## Plan\n\n- **first** step\n- second\n\n```sh\nls -la\n```',
        })}
      />,
    )
    const bubble = screen.getByTestId('message-assistant')
    expect(bubble.querySelector('h2')?.textContent).toBe('Plan')
    expect(bubble.querySelectorAll('ul > li')).toHaveLength(2)
    expect(bubble.querySelector('strong')?.textContent).toBe('first')
    expect(bubble.querySelector('pre > code')?.textContent).toBe('ls -la\n')
    // The asterisks and fence markers are consumed, not shown.
    expect(bubble.textContent).not.toContain('**')
    expect(bubble.textContent).not.toContain('```')
  })

  it('renders a partial stream with an unclosed fence as a code block, without throwing', () => {
    render(
      <MessageBubble
        row={assistantRow({ streaming: true, text: 'Try this:\n\n```\necho partial' })}
      />,
    )
    const bubble = screen.getByTestId('message-assistant')
    expect(bubble.querySelector('pre > code')?.textContent).toContain('echo partial')
  })

  it('never executes HTML the model wrote — it is shown as text, in the same reply markdown renders', () => {
    render(
      <MessageBubble
        row={assistantRow({
          streaming: false,
          text: '**bold** <script>alert(1)</script> and <img src=x onerror=alert(1)>',
        })}
      />,
    )
    const bubble = screen.getByTestId('message-assistant')
    // Markdown is on (so this is not the old pre-wrap div passing by accident)…
    expect(bubble.querySelector('strong')?.textContent).toBe('bold')
    // …and HTML is still text.
    expect(bubble.querySelector('script')).toBeNull()
    expect(bubble.querySelector('img')).toBeNull()
    expect(bubble.textContent).toContain('<script>alert(1)</script>')
    expect(bubble.textContent).toContain('<img src=x onerror=alert(1)>')
  })

  it('keeps the owner\'s own message as literal text — asterisks stay asterisks', () => {
    render(<MessageBubble row={userRow('this is **not** markdown, `nor` this')} />)
    const bubble = screen.getByTestId('message-user')
    expect(bubble.textContent).toBe('this is **not** markdown, `nor` this')
    expect(bubble.querySelector('strong')).toBeNull()
    expect(bubble.querySelector('code')).toBeNull()
    expect(bubble.querySelector('.whitespace-pre-wrap')).not.toBeNull()
  })

  it('still shows the tool line and the interrupted note beneath a markdown reply', () => {
    render(
      <MessageBubble
        row={assistantRow({
          streaming: false,
          interrupted: true,
          text: '- a\n- b',
          activity: { tool: 'device_run', status: 'error', reason: 'no such file' },
        })}
      />,
    )
    expect(screen.getByTestId('activity-line').textContent).toBe('device_run: no such file')
    expect(screen.getByText(/Interrupted — the connection dropped/)).toBeDefined()
  })
})
