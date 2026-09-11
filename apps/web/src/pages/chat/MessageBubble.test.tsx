import { describe, it, expect } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { MessageBubble } from './MessageBubble'
import type { LiveDelegation, MessageRow } from './chatReducer'

function assistantRow(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    kind: 'message',
    id: 'a1',
    role: 'assistant',
    text: '',
    streaming: true,
    interrupted: false,
    stoppedNote: null,
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
    render(<MessageBubble row={assistantRow({ id: 'a2', text: 'hi', streaming: false, servedBy: 'ollama:qwen3:8b', cost: null })} />)
    expect(screen.getAllByTestId('served-by')).toHaveLength(2)
    expect(screen.getAllByTestId('turn-cost')).toHaveLength(1)
  })

  it('states a fallback in the gateway\'s own words when a later link answered', () => {
    render(
      <MessageBubble
        row={assistantRow({ text: 'hi', streaming: false, servedBy: 'ollama:qwen3:8b', routeReason: 'fell back to link 2 (ollama:qwen3:8b) — openrouter over its monthly cap $10.00' })}
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
    activity: null,
    agent: null,
    delegation: null,
    delegationsDone: [],
    delegations: [],
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
