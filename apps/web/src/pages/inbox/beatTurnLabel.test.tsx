import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MessageBubble } from '../chat/MessageBubble'
import type { MessageRow } from '../chat/chatReducer'

/**
 * The chat half of S11's beat carry, tested here rather than in the chat
 * page's own suite because the beat kind belongs to this slice: a digest — or
 * an urgent notice that could not wait for one — is written by a beat firing
 * into the owner's conversation, and the bubble must say so.
 *
 * The label is DERIVED from `turns.kind` as the server put it on the fetched
 * row, exactly as the reminder and scheduled labels are. A reply that merely
 * TALKS like a digest earns nothing.
 */
function assistantRow(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    kind: 'message',
    id: 'a1',
    role: 'assistant',
    text: '',
    streaming: false,
    interrupted: false,
    stoppedNote: null,
    activity: null,
    servedBy: null,
    cost: null,
    routeReason: null,
    turnKind: null,
    agent: null,
    delegation: null,
    delegationsDone: [],
    delegations: [],
    ...overrides,
  }
}

describe('MessageBubble — a beat firing labels itself (S11)', () => {
  it('labels a row a beat wrote, so a digest does not read as an ordinary reply', () => {
    render(
      <MessageBubble
        row={assistantRow({ text: 'Two things since yesterday: …', turnKind: 'beat' })}
      />,
    )
    const label = screen.getByTestId('turn-kind-label')
    expect(label.textContent).toBe('Noticed')
    expect(label.getAttribute('title')).toContain('beat')
  })

  it('never infers it from the text — a chat reply about what she noticed earns no label', () => {
    render(
      <MessageBubble
        row={assistantRow({ id: 'a2', text: 'I noticed the backups have not run', turnKind: 'chat' })}
      />,
    )
    expect(screen.queryByTestId('turn-kind-label')).toBeNull()
  })
})
