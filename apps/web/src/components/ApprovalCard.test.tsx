import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ApprovalCard } from './ApprovalCard'
import type { ConsentCard } from '../lib/consentCard'

function card(overrides: Partial<ConsentCard> = {}): ConsentCard {
  return {
    consent_id: 'c-1',
    action_class: 'fetch_url',
    args_hash: 'hash',
    args: { url: 'https://example.com/pricing' },
    summary: 'Run fetch_url with url=https://example.com/pricing',
    status: 'pending',
    conversation_id: 'conv-1',
    requested_by: { person_id: 'p-1', agent: 'chat' },
    created_at: '2026-08-30T00:00:00Z',
    expires_at: '2026-08-31T00:00:00Z',
    ...overrides,
  }
}

describe('ApprovalCard', () => {
  it('shows the exact args summary Nova will act on', () => {
    render(<ApprovalCard card={card()} onDecide={vi.fn()} />)
    expect(screen.getByText(/Run fetch_url with url=https:\/\/example\.com\/pricing/)).toBeTruthy()
  })

  it('a pending card offers Approve and Deny', () => {
    const onDecide = vi.fn()
    render(<ApprovalCard card={card()} onDecide={onDecide} />)
    fireEvent.click(screen.getByRole('button', { name: /approve/i }))
    expect(onDecide).toHaveBeenCalledWith('approve')

    fireEvent.click(screen.getByRole('button', { name: /deny/i }))
    expect(onDecide).toHaveBeenCalledWith('deny')
  })

  it('a decided card shows its status instead of the approve/deny buttons', () => {
    render(<ApprovalCard card={card({ status: 'approved' })} onDecide={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /^approve$/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /deny/i })).toBeNull()
    expect(screen.getByText(/approved/i)).toBeTruthy()
  })

  it('a denied card reads as denied, not as a generic failure', () => {
    render(<ApprovalCard card={card({ status: 'denied' })} onDecide={vi.fn()} />)
    expect(screen.getByText(/denied/i)).toBeTruthy()
  })

  it('an approved card offers Go ahead when a handler is given', () => {
    const onGoAhead = vi.fn()
    render(
      <ApprovalCard card={card({ status: 'approved' })} onDecide={vi.fn()} onGoAhead={onGoAhead} />,
    )
    fireEvent.click(screen.getByRole('button', { name: /go ahead/i }))
    expect(onGoAhead).toHaveBeenCalled()
  })

  it('an approved card with no onGoAhead shows no such button (e.g. auto-continued already)', () => {
    render(<ApprovalCard card={card({ status: 'approved' })} onDecide={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /go ahead/i })).toBeNull()
  })

  it('a denied card never offers Go ahead, even if a handler is given', () => {
    render(
      <ApprovalCard card={card({ status: 'denied' })} onDecide={vi.fn()} onGoAhead={vi.fn()} />,
    )
    expect(screen.queryByRole('button', { name: /go ahead/i })).toBeNull()
  })

  it('disables Go ahead while it is in flight', () => {
    render(
      <ApprovalCard
        card={card({ status: 'approved' })}
        onDecide={vi.fn()}
        onGoAhead={vi.fn()}
        goAheadBusy
      />,
    )
    expect(
      (screen.getByRole('button', { name: /go ahead/i }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })

  it('disables both buttons while a decision is in flight', () => {
    render(<ApprovalCard card={card()} onDecide={vi.fn()} busy />)
    expect((screen.getByRole('button', { name: /approve/i }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    expect((screen.getByRole('button', { name: /deny/i }) as HTMLButtonElement).disabled).toBe(true)
  })
})
