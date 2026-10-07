import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { MessageBubble } from './MessageBubble'
import type { LiveDelegation, MessageRow } from './chatReducer'
import { attachmentFixture } from './attachmentFixture'

function assistantRow(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    kind: 'message',
    id: 'a1',
    role: 'assistant',
    text: '',
    streaming: true,
    interrupted: false,
    stoppedNote: null,
    thinking: '',
    activity: null,
    servedBy: null,
    cost: null,
    routeReason: null,
    turnKind: null,
    // S12: who wrote the row and what she delegated (pin moved 2026-09-08).
    agent: null,
    delegation: null,
    delegationsDone: [],
    delegations: [],
    attachments: [],
    cards: [],
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

  it('shows the tool\'s own progress words while a long call runs', () => {
    render(
      <MessageBubble
        row={assistantRow({
          activity: { tool: 'model_pull', status: 'progress', detail: 'pulling qwen3:4b — 42% (1.0 GB of 2.3 GB)' },
        })}
      />,
    )
    const line = screen.getByTestId('activity-line')
    expect(line.textContent).toContain('using model_pull… pulling qwen3:4b — 42% (1.0 GB of 2.3 GB)')
    expect(line.className).not.toMatch(/danger/)
  })

  // S15: a download that knows its fraction gets a real bar. The words stay —
  // they carry the byte counts a bar cannot show.
  it('draws a determinate bar at the stated percent', () => {
    render(
      <MessageBubble
        row={assistantRow({
          activity: {
            tool: 'model_pull',
            status: 'progress',
            detail: 'pulling qwen3:4b — 42% (1.0 GB of 2.3 GB)',
            percent: 42,
          },
        })}
      />,
    )
    const bar = screen.getByRole('progressbar')
    expect(bar.getAttribute('aria-valuenow')).toBe('42')
    expect(screen.getByTestId('activity-line').textContent).toContain('1.0 GB of 2.3 GB')
  })

  it('draws no bar for a call that never stated a fraction', () => {
    render(
      <MessageBubble
        row={assistantRow({
          activity: { tool: 'model_pull', status: 'progress', detail: 'pulling manifest' },
        })}
      />,
    )
    expect(screen.queryByRole('progressbar')).toBeNull()
  })

  // S15: a stop is deliberate. It reads as a note on the reply, never as a
  // failure — the whole point is that the owner did this on purpose.
  it('shows the stop note under the text that was watched', () => {
    render(
      <MessageBubble
        row={assistantRow({
          text: 'I will now do ',
          streaming: false,
          stoppedNote: 'Stopped while running model_pull — you asked to stop it.',
        })}
      />,
    )
    const note = screen.getByTestId('stopped-note')
    expect(note.textContent).toContain('Stopped while running model_pull')
    expect(note.className).not.toMatch(/danger/)
    expect(screen.queryByTestId('activity-line')).toBeNull()
  })

  it('shows the stop note on a turn stopped before it wrote anything', () => {
    render(
      <MessageBubble
        row={assistantRow({ text: '', streaming: false, stoppedNote: 'Stopped while working.' })}
      />,
    )
    expect(screen.getByTestId('stopped-note').textContent).toContain('Stopped while working.')
  })

  it('shows no stop note on an ordinary reply', () => {
    render(<MessageBubble row={assistantRow({ text: 'hi', streaming: false })} />)
    expect(screen.queryByTestId('stopped-note')).toBeNull()
  })

  it('draws no bar on a failure, whatever percent the last frame carried', () => {
    render(
      <MessageBubble
        row={assistantRow({
          activity: { tool: 'model_pull', status: 'error', reason: 'out of disk', percent: 80 },
        })}
      />,
    )
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(screen.getByTestId('activity-line').textContent).toBe('model_pull: out of disk')
  })

  it('shows the turn\'s cost beside who answered, and nothing when no round was priced', () => {
    render(<MessageBubble row={assistantRow({ text: 'hi', streaming: false, servedBy: 'openrouter:openai/gpt-x', cost: 0.0013 })} />)
    expect(screen.getByTestId('turn-cost').textContent).toContain('$0.0013')
    render(<MessageBubble row={assistantRow({ id: 'a2', text: 'hi', streaming: false, servedBy: 'hub:qwen3:8b', cost: null })} />)
    expect(screen.getAllByTestId('served-by')).toHaveLength(2)
    expect(screen.getAllByTestId('turn-cost')).toHaveLength(1)
  })

  it('states a fallback in the gateway\'s own words when a later link answered', () => {
    render(
      <MessageBubble
        row={assistantRow({ text: 'hi', streaming: false, servedBy: 'hub:qwen3:8b', routeReason: 'fell back to link 2 (hub:qwen3:8b) — openrouter over its monthly cap $10.00' })}
      />,
    )
    expect(screen.getByTestId('route-fallback').textContent).toContain('fell back to link 2')
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
    servedBy: null,
    cost: null,
    routeReason: null,
    turnKind: null,
    streaming: false,
    interrupted: false,
    stoppedNote: null,
    thinking: '',
    activity: null,
    agent: null,
    delegation: null,
    delegationsDone: [],
    delegations: [],
    attachments: [],
    cards: [],
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


describe('MessageBubble — who answered (S10-pre)', () => {
  it('shows no badge until the server stated one', () => {
    render(<MessageBubble row={assistantRow({ text: 'hi', streaming: false })} />)
    expect(screen.queryByTestId('served-by')).toBeNull()
  })

  it('shows provider:model exactly as stated', () => {
    render(
      <MessageBubble
        row={assistantRow({ text: 'hi', streaming: false, servedBy: 'anthropic:claude-opus-5' })}
      />,
    )
    expect(screen.getByTestId('served-by').textContent).toBe('anthropic:claude-opus-5')
  })
})

describe('MessageBubble — where a row came from, when it was not a chat turn (S9)', () => {
  it('labels a row a reminder firing wrote "Reminder"', () => {
    render(
      <MessageBubble
        row={assistantRow({ text: 'Reminder: stretch', streaming: false, turnKind: 'reminder' })}
      />,
    )
    expect(screen.getByTestId('turn-kind-label').textContent).toBe('Reminder')
  })

  it('labels a row a scheduled turn wrote "Scheduled"', () => {
    render(
      <MessageBubble
        row={assistantRow({ text: 'Your calendar today: …', streaming: false, turnKind: 'scheduled' })}
      />,
    )
    expect(screen.getByTestId('turn-kind-label').textContent).toBe('Scheduled')
  })

  it('shows no label for an ordinary chat turn, or when the server stated no kind', () => {
    const { unmount } = render(
      <MessageBubble row={assistantRow({ text: 'hi', streaming: false, turnKind: 'chat' })} />,
    )
    expect(screen.queryByTestId('turn-kind-label')).toBeNull()
    unmount()
    render(<MessageBubble row={assistantRow({ text: 'hi', streaming: false, turnKind: null })} />)
    expect(screen.queryByTestId('turn-kind-label')).toBeNull()
  })

  // The label is DERIVED from turns.kind, never read off the text: a reply
  // that merely says "Reminder:" is a chat turn claiming to be one.
  it('never infers the label from the text — a chat reply that says "Reminder:" earns none', () => {
    render(
      <MessageBubble
        row={assistantRow({ text: 'Reminder: I am not a timer', streaming: false, turnKind: 'chat' })}
      />,
    )
    expect(screen.queryByTestId('turn-kind-label')).toBeNull()
  })

  it('shows nothing for a kind this client has not met, rather than a guess', () => {
    render(
      <MessageBubble row={assistantRow({ text: 'x', streaming: false, turnKind: 'future-kind' })} />,
    )
    expect(screen.queryByTestId('turn-kind-label')).toBeNull()
  })

  it('never labels the owner\'s own bubble', () => {
    render(<MessageBubble row={{ ...userRow('remind me'), turnKind: 'reminder' }} />)
    expect(screen.queryByTestId('turn-kind-label')).toBeNull()
  })
})

describe('MessageBubble — a row an agent wrote (S12)', () => {
  it('labels the row with the agent\'s name, linking to its page, and takes its initial for the avatar', () => {
    render(<MessageBubble row={assistantRow({ text: 'fixed', streaming: false, agent: 'coder' })} />)
    const label = screen.getByTestId('agent-label')
    expect(label.textContent).toBe('coder')
    const link = label.querySelector('a')
    expect(link?.getAttribute('href')).toBe('/agents/coder')
    expect(link?.getAttribute('title')).toBe('this reply was written by the agent coder — see /agents/coder')
    expect(screen.getByTestId('assistant-avatar').textContent).toBe('C')
  })

  it('shows no label and the N avatar for Nova\'s own reply', () => {
    render(<MessageBubble row={assistantRow({ text: 'hi', streaming: false })} />)
    expect(screen.queryByTestId('agent-label')).toBeNull()
    expect(screen.getByTestId('assistant-avatar').textContent).toBe('N')
  })

  it('is a router Link inside a Router, an anchor outside one — same href either way', () => {
    render(
      <MemoryRouter>
        <MessageBubble row={assistantRow({ text: 'fixed', streaming: false, agent: 'coder' })} />
      </MemoryRouter>,
    )
    expect(screen.getByTestId('agent-label').querySelector('a')?.getAttribute('href')).toBe('/agents/coder')
  })

  it('sits beside the turn-kind label when an agent\'s scheduled turn earns both', () => {
    render(
      <MessageBubble row={assistantRow({ text: 'report', streaming: false, agent: 'coder', turnKind: 'scheduled' })} />,
    )
    expect(screen.getByTestId('turn-kind-label').textContent).toBe('Scheduled')
    expect(screen.getByTestId('agent-label').textContent).toBe('coder')
  })

  it('never labels the owner\'s own bubble, even for the @coder message that started the turn', () => {
    render(<MessageBubble row={{ ...userRow('@coder fix the tests'), agent: 'coder' }} />)
    expect(screen.queryByTestId('agent-label')).toBeNull()
  })
})

describe('MessageBubble — the delegation line (S12)', () => {
  const working = (overrides: Partial<LiveDelegation> = {}): LiveDelegation => ({
    agent: 'coder',
    turnId: 't-child',
    steps: [
      { step: 'start', status: 'start' },
      { step: 'workspace_write_file', status: 'start' },
      { step: 'workspace_write_file', status: 'ok' },
    ],
    dropped: 0,
    status: 'working',
    ...overrides,
  })

  it('while working: one collapsed line naming the agent and the step count; the steps only on expand', () => {
    render(<MessageBubble row={assistantRow({ delegation: working() })} />)
    expect(screen.getByTestId('delegation-line').getAttribute('data-status')).toBe('working')
    expect(screen.getByTestId('delegation-headline').textContent).toBe('coder is working… (3 steps)')
    expect(screen.queryByTestId('delegation-steps')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /coder is working/ }))
    expect(screen.getAllByTestId('delegation-step').map(li => li.textContent)).toEqual([
      'start · start',
      'workspace_write_file · start',
      'workspace_write_file · ok',
    ])
    expect(screen.queryByTestId('delegation-more')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /coder is working/ }))
    expect(screen.queryByTestId('delegation-steps')).toBeNull()
  })

  it('does not also show the delegate tool\'s own marker while the delegation works — one line, not two', () => {
    render(
      <MessageBubble
        row={assistantRow({
          activity: { tool: 'delegate_to_agent', status: 'progress', detail: 'coder is working…' },
          delegation: working(),
        })}
      />,
    )
    expect(screen.queryByTestId('activity-line')).toBeNull()
    expect(screen.getByTestId('delegation-line')).toBeDefined()
    expect(screen.queryByLabelText('waiting for the model')).toBeNull()
  })

  it('counts the steps it stopped keeping, and says "and N more" when expanded', () => {
    render(<MessageBubble row={assistantRow({ delegation: working({ dropped: 50 }) })} />)
    expect(screen.getByTestId('delegation-headline').textContent).toBe('coder is working… (53 steps)')
    fireEvent.click(screen.getByRole('button', { name: /coder is working/ }))
    expect(screen.getByTestId('delegation-more').textContent).toBe('and 50 more')
  })

  it('finished ok: "coder finished", still expandable', () => {
    render(<MessageBubble row={assistantRow({ text: 'done', streaming: false, delegation: working({ status: 'ok' }) })} />)
    expect(screen.getByTestId('delegation-headline').textContent).toBe('coder finished')
    expect(screen.getByTestId('delegation-line').className).not.toMatch(/danger/)
    fireEvent.click(screen.getByRole('button', { name: /coder finished/ }))
    expect(screen.getAllByTestId('delegation-step')).toHaveLength(3)
  })

  it('finished error: "coder did not finish", and the delegate tool\'s error marker still states its reason', () => {
    render(
      <MessageBubble
        row={assistantRow({
          text: 'coder could not',
          streaming: false,
          delegation: working({ status: 'error' }),
          activity: { tool: 'delegate_to_agent', status: 'error', reason: 'agent coder did not finish — status error' },
        })}
      />,
    )
    expect(screen.getByTestId('delegation-headline').textContent).toBe('coder did not finish')
    expect(screen.getByRole('button', { name: /coder did not finish/ }).className).toMatch(/danger/)
    expect(screen.getByTestId('activity-line').textContent).toBe(
      'delegate_to_agent: agent coder did not finish — status error',
    )
    fireEvent.click(screen.getByRole('button', { name: /coder did not finish/ }))
    expect(screen.getAllByTestId('delegation-step')).toHaveLength(3)
  })

  it('cut off: says no result was stated, never "finished"', () => {
    render(<MessageBubble row={assistantRow({ streaming: false, delegation: working({ status: 'interrupted' }) })} />)
    const headline = screen.getByTestId('delegation-headline').textContent
    expect(headline).toBe('coder — cut off before a result was stated')
    expect(headline).not.toContain('finished')
  })

  it('an agent the relay has not named yet is "an agent", with no steps yet', () => {
    render(<MessageBubble row={assistantRow({ delegation: working({ agent: null, steps: [] }) })} />)
    expect(screen.getByTestId('delegation-headline').textContent).toBe('an agent is working… (0 steps)')
    fireEvent.click(screen.getByRole('button', { name: /an agent is working/ }))
    expect(screen.getByTestId('delegation-steps').textContent).toContain('no steps reported yet')
  })

  it('shows every delegation this row watched, the finished ones before the one in flight', () => {
    render(
      <MessageBubble
        row={assistantRow({
          delegationsDone: [working({ status: 'ok' })],
          delegation: working({ agent: 'mailer', steps: [], status: 'working' }),
        })}
      />,
    )
    expect(screen.getAllByTestId('delegation-headline').map(h => h.textContent)).toEqual([
      'coder finished',
      'mailer is working… (0 steps)',
    ])
  })

  it('after a reload: a chip per delegation — agent, status, file count — linking to the agent, no live line', () => {
    render(
      <MessageBubble
        row={assistantRow({
          text: 'I asked coder',
          streaming: false,
          delegations: [
            { agent: 'coder', agent_turn_id: 't1', status: 'ok', files: ['agents/coder/a.md', 'agents/coder/b.md'] },
            { agent: 'mailer', agent_turn_id: 't2', status: 'error', files: [] },
            { agent: 'cook', agent_turn_id: 't3', status: 'interrupted', files: ['agents/cook/menu.md'] },
          ],
        })}
      />,
    )
    const chips = screen.getAllByTestId('delegation-chip')
    expect(chips.map(c => c.textContent)).toEqual([
      'coder · ok · 2 files',
      'mailer · error · 0 files',
      'cook · interrupted · 1 file',
    ])
    expect(chips.map(c => c.getAttribute('href'))).toEqual(['/agents/coder', '/agents/mailer', '/agents/cook'])
    expect(screen.queryByTestId('delegation-line')).toBeNull()
  })

  it('shows no delegation line or chip on an ordinary reply', () => {
    render(<MessageBubble row={assistantRow({ text: 'hi', streaming: false })} />)
    expect(screen.queryByTestId('delegation-line')).toBeNull()
    expect(screen.queryByTestId('delegation-chips')).toBeNull()
  })
})

describe('MessageBubble — setup cards (S47)', () => {
  it('draws a setup card after the reply, and nothing when there is none', () => {
    const { rerender } = render(
      <MessageBubble
        row={assistantRow({
          text: 'Scan the card with the tablet.',
          streaming: false,
          cards: [
            {
              kind: 'setup_qr',
              setup: 'install_pwa',
              address: 'https://nova.fake-tailnet.ts.net',
              url: 'https://nova.fake-tailnet.ts.net/install',
            },
          ],
        })}
      />,
    )
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe('QR code for https://nova.fake-tailnet.ts.net/install')
    // The card sits AFTER the reply, not before it.
    const reply = screen.getByText('Scan the card with the tablet.')
    const cards = screen.getByTestId('setup-cards')
    expect(reply.compareDocumentPosition(cards) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    // And nothing when there is none (round 1, Folded Minor #4 — this title
    // claimed both halves; only the first was ever checked).
    rerender(<MessageBubble row={assistantRow({ text: 'Nothing to scan.', streaming: false })} />)
    expect(screen.queryByTestId('setup-cards')).toBeNull()
  })

  it('a reloaded machine card past expiry says so, drawing no QR and no code (Review Focus 4)', () => {
    render(
      <MessageBubble
        row={assistantRow({
          text: 'Scan the card.',
          streaming: false,
          cards: [
            {
              kind: 'setup_qr',
              setup: 'add_machine',
              address: 'https://nova.fake-tailnet.ts.net',
              url: 'https://nova.fake-tailnet.ts.net/add',
              code_shown: true,
              expires_at: '2020-01-01T00:00:00Z',
            },
          ],
        })}
      />,
    )
    expect(screen.getByTestId('setup-shown-once').textContent).toContain('shown once and expired')
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.queryByTestId('setup-code')).toBeNull()
  })

  it('a reloaded machine card not yet expired still shows no QR and no code (Review Focus 4)', () => {
    render(
      <MessageBubble
        row={assistantRow({
          text: 'Scan the card.',
          streaming: false,
          cards: [
            {
              kind: 'setup_qr',
              setup: 'add_machine',
              address: 'https://nova.fake-tailnet.ts.net',
              url: 'https://nova.fake-tailnet.ts.net/add',
              code_shown: true,
              expires_at: '2099-01-01T00:00:00Z',
            },
          ],
        })}
      />,
    )
    expect(screen.getByTestId('setup-shown-once').textContent).toContain('shown once and expires')
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.queryByTestId('setup-code')).toBeNull()
  })

  it('a card kind this build does not know is drawn as its link, never dropped', () => {
    render(
      <MessageBubble
        row={assistantRow({
          text: 'Here.',
          streaming: false,
          cards: [{ kind: 'setup_qr', setup: 'fax_machine', address: 'https://nova.fake-tailnet.ts.net', url: 'https://nova.fake-tailnet.ts.net/fax' }],
        })}
      />,
    )
    expect(screen.getByRole('link', { name: 'https://nova.fake-tailnet.ts.net/fax' })).toBeTruthy()
  })
})

/**
 * Thinking, while she thinks (2026-09-15).
 *
 * Core dropped the reasoning stream entirely until then, so a model that
 * thought for two minutes was indistinguishable from a hung one — measured
 * at 146 s of empty bubble for "what is 2+2". These pin the two properties
 * that make showing it safe: it appears only while there is no reply yet,
 * and it never becomes the reply.
 */
describe('MessageBubble — a model that is thinking', () => {
  it('says she is thinking, and shows what she is on', () => {
    render(
      <MemoryRouter>
        <MessageBubble row={assistantRow({ thinking: 'weighing the options', streaming: true })} />
      </MemoryRouter>,
    )
    const line = screen.getByTestId('thinking-line')
    expect(line.textContent).toContain('Thinking')
    expect(line.textContent).toContain('weighing the options')
  })

  it('gives way to the reply the moment one starts', () => {
    // The answer is the thing to read. Leaving the working on screen beside
    // it would double the height of every bubble on a thinking model.
    render(
      <MemoryRouter>
        <MessageBubble
          row={assistantRow({ thinking: 'weighing the options', text: 'four', streaming: true })}
        />
      </MemoryRouter>,
    )
    expect(screen.queryByTestId('thinking-line')).toBeNull()
    expect(screen.getByText('four')).toBeTruthy()
  })

  it('is gone once the turn is over', () => {
    render(
      <MemoryRouter>
        <MessageBubble row={assistantRow({ thinking: 'weighing it', text: '', streaming: false })} />
      </MemoryRouter>,
    )
    expect(screen.queryByTestId('thinking-line')).toBeNull()
  })

  it('shows the tail of a long think rather than all of it', () => {
    // Reasoning arrives token by token for minutes. A box that only ever
    // grows would push the composer off the screen.
    const long = 'a'.repeat(400) + 'THE LATEST PART'
    render(
      <MemoryRouter>
        <MessageBubble row={assistantRow({ thinking: long, streaming: true })} />
      </MemoryRouter>,
    )
    const line = screen.getByTestId('thinking-line')
    expect(line.textContent).toContain('THE LATEST PART')
    expect(line.textContent!.length).toBeLessThan(220)
  })
})

describe('MessageBubble — a message that carried a file (S28)', () => {
  it('draws the attachment under his words', () => {
    render(
      <MessageBubble
        row={{ ...userRow('what is this?'), attachments: [attachmentFixture()] }}
      />,
    )

    expect(screen.getByTestId('message-attachments')).toBeTruthy()
    expect(screen.getByText('what is this?')).toBeTruthy()
  })

  it('draws no empty bubble when the file WAS the message', () => {
    // "Here, look at this" with nothing typed is a thing people send. An
    // empty bubble above the picture is a message he did not write.
    const { container } = render(
      <MessageBubble row={{ ...userRow(''), attachments: [attachmentFixture()] }} />,
    )

    expect(screen.getByTestId('attached-image')).toBeTruthy()
    expect(container.querySelector('.whitespace-pre-wrap')).toBeNull()
  })
})

describe('MessageBubble — the Rewind control on his messages (chat rewind T7)', () => {
  const MSG_ID = '6f1c2a8e-0000-4000-8000-000000000001'
  function hisRow(): MessageRow {
    return { ...userRow('rename notes.md to plan.md'), id: MSG_ID }
  }
  const rewindButton = () => screen.queryByRole('button', { name: /rewind/i })
  /** The Rewind button, asserted present (an assertion failure, not a
   *  "please provide a DOM element" crash, while it does not exist). */
  function mustRewind(): HTMLElement {
    const button = rewindButton()
    expect(button, 'a Rewind button').not.toBeNull()
    return button!
  }

  it('a stored user row offered a rewind shows a real, visible, thumb-sized Rewind button', () => {
    render(<MessageBubble row={hisRow()} onRewind={() => {}} />)
    const button = rewindButton()
    expect(button).not.toBeNull()
    expect(button!.tagName).toBe('BUTTON')
    // A thumb-sized target on a phone, like ThreadStub — and never
    // hover-only: no opacity-0 / invisible / group-hover reveal.
    expect(button!.className).toContain('min-h-11')
    expect(button!.className).not.toMatch(/opacity-0|invisible|hidden|group-hover/)
  })

  it('her replies show no Rewind control, even when one is offered', () => {
    // Beside one of his rows, so "none" is measured against a control that
    // exists rather than against a component that draws none at all.
    render(
      <>
        <MessageBubble row={hisRow()} onRewind={() => {}} />
        <MessageBubble row={assistantRow({ id: 'a1', text: 'done', streaming: false })} onRewind={() => {}} />
      </>,
    )
    const buttons = screen.queryAllByRole('button', { name: /rewind/i })
    expect(buttons).toHaveLength(1)
    expect(screen.getByTestId('message-assistant').contains(buttons[0])).toBe(false)
  })

  it('a row offered no rewind (a just-sent client row, a room) shows none', () => {
    render(
      <>
        <MessageBubble row={hisRow()} onRewind={() => {}} />
        <MessageBubble row={{ ...hisRow(), id: 'u-1760000000000-1', text: 'just sent' }} />
      </>,
    )
    const buttons = screen.queryAllByRole('button', { name: /rewind/i })
    expect(buttons).toHaveLength(1)
    const offered = screen.getAllByTestId('message-user').find(el => el.dataset.messageId === MSG_ID)!
    expect(offered.contains(buttons[0])).toBe(true)
  })

  it('activating Rewind opens exactly two options, each saying what it does, and calls nothing yet', () => {
    const onRewind = vi.fn()
    render(<MessageBubble row={hisRow()} onRewind={onRewind} />)
    expect(screen.queryByTestId('rewind-option-chat')).toBeNull()
    fireEvent.click(mustRewind())
    expect(screen.queryAllByTestId(/^rewind-option-/)).toHaveLength(2)
    const chat = screen.getByTestId('rewind-option-chat')
    const executions = screen.getByTestId('rewind-option-executions')
    // Each states in a line what it does — two different statements.
    expect(chat.textContent!.trim().length).toBeGreaterThan(10)
    expect(executions.textContent!.trim().length).toBeGreaterThan(10)
    expect(chat.textContent).not.toBe(executions.textContent)
    expect(onRewind).not.toHaveBeenCalled()
  })

  it('choosing "chat only" calls onRewind once with this row and mode chat', () => {
    const onRewind = vi.fn()
    render(<MessageBubble row={hisRow()} onRewind={onRewind} />)
    fireEvent.click(mustRewind())
    fireEvent.click(screen.getByTestId('rewind-option-chat'))
    expect(onRewind).toHaveBeenCalledTimes(1)
    expect(onRewind).toHaveBeenCalledWith(MSG_ID, 'chat')
  })

  it('choosing "chat + her executions" calls onRewind once with this row and mode executions', () => {
    const onRewind = vi.fn()
    render(<MessageBubble row={hisRow()} onRewind={onRewind} />)
    fireEvent.click(mustRewind())
    fireEvent.click(screen.getByTestId('rewind-option-executions'))
    expect(onRewind).toHaveBeenCalledTimes(1)
    expect(onRewind).toHaveBeenCalledWith(MSG_ID, 'executions')
  })

  it('the choice can be dismissed without calling anything', () => {
    const onRewind = vi.fn()
    render(<MessageBubble row={hisRow()} onRewind={onRewind} />)
    fireEvent.click(mustRewind())
    fireEvent.click(screen.getByTestId('rewind-dismiss'))
    expect(screen.queryByTestId('rewind-option-chat')).toBeNull()
    expect(screen.queryByTestId('rewind-option-executions')).toBeNull()
    expect(onRewind).not.toHaveBeenCalled()
  })

  it('is disabled while a turn runs, and opens no choice', () => {
    const onRewind = vi.fn()
    render(<MessageBubble row={hisRow()} onRewind={onRewind} rewindDisabled />)
    const button = rewindButton()
    expect(button).not.toBeNull()
    expect((button as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(button!)
    expect(screen.queryByTestId('rewind-option-chat')).toBeNull()
    expect(onRewind).not.toHaveBeenCalled()
  })
})

describe('MessageBubble — a rewind marker is a divider, not his bubble (chat rewind T7)', () => {
  function markerRow(rewind: NonNullable<MessageRow['rewind']>): MessageRow {
    // The content deliberately says none of the facts: the divider must read
    // them from row.rewind, never parse them out of the text.
    return { ...userRow('(marker)'), id: 'm1', rewind }
  }

  it('renders a full-width divider with the mode and withdrawn count, no user bubble and no Rewind', () => {
    render(
      <MessageBubble
        row={markerRow({
          id: 'r1',
          mode: 'chat',
          target_message_id: 'u1',
          withdrawn: 4,
          undone: [],
          not_undone: [],
        })}
        onRewind={() => {}}
      />,
    )
    const divider = screen.queryByTestId('rewind-marker')
    expect(divider, 'the rewind-marker divider').not.toBeNull()
    expect(screen.queryByTestId('message-user')).toBeNull()
    expect(screen.queryByRole('button', { name: /rewind/i })).toBeNull()
    expect(divider!.textContent).toMatch(/chat/i)
    expect(divider!.textContent).toContain('4')
    expect(divider!.textContent).not.toContain('(marker)')
  })

  it('states each undone and not-undone action from the stored rewinds row, "unknown" for an unnamed tool', () => {
    render(
      <MessageBubble
        row={markerRow({
          id: 'r1',
          mode: 'executions',
          target_message_id: 'u1',
          withdrawn: 2,
          undone: [{ tool: 'workspace_write_file', action_id: 'a1', line: 'restored notes.md' }],
          not_undone: [
            { tool: 'device_run', action_id: 'a2', reason: 'a command already run cannot be taken back' },
            { tool: null, turn_id: 't9', reason: 'that turn never closed; its actions were not recorded' },
          ],
        })}
      />,
    )
    const divider = screen.queryByTestId('rewind-marker')
    expect(divider, 'the rewind-marker divider').not.toBeNull()
    const text = divider!.textContent!
    expect(text).toContain('2')
    expect(text).toContain('workspace_write_file')
    expect(text).toContain('restored notes.md')
    expect(text).toContain('device_run')
    expect(text).toContain('a command already run cannot be taken back')
    expect(text).toContain('unknown')
    expect(text).toContain('that turn never closed; its actions were not recorded')
  })

  it('states which mode it was: a chat-only and an executions divider read differently on their own line', () => {
    const base = { id: 'r1', target_message_id: 'u1', withdrawn: 4, undone: [], not_undone: [] }
    const { unmount } = render(<MessageBubble row={markerRow({ ...base, mode: 'chat' })} />)
    // The divider's own line (its first child), not the facts under it.
    const chatLine = screen.getByTestId('rewind-marker').firstElementChild!.textContent
    unmount()
    render(<MessageBubble row={markerRow({ ...base, mode: 'executions' })} />)
    const executionsLine = screen.getByTestId('rewind-marker').firstElementChild!.textContent
    expect(chatLine).toContain('4')
    expect(executionsLine).toContain('4')
    expect(chatLine).not.toBe(executionsLine)
  })
})
