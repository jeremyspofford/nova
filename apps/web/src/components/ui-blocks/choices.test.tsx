import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, fireEvent, screen, cleanup } from '@testing-library/react'
import { LIMITS, validateBlock } from './validate'
import { block as choices, composeMessage } from './choices'
import { UiBlocksContext, type UiBlocksCtx } from './context'

const REG = { choices }
const ok = (v: unknown) => choices.schema.safeParse(v).success

const opt = (value: string, label: string) => ({ value, label })
const F = {
  type: 'choices',
  questions: [
    { id: 'goal', label: 'What should the factory produce?', options: [opt('personal', 'Tools for myself'), opt('both', 'Both')], default: 'both' },
    { id: 'model', label: 'Where do models run?', options: [opt('local', 'On my machines'), opt('cloud', 'Cloud APIs')] },
  ],
  submit: { label: 'Design my factory', message: 'Design a software factory for me. Goal: {goal}. Models: {model}.' },
}
type Q = (typeof F.questions)[number]
const withQ = (patch: (qs: Q[]) => unknown[]) => ({ ...F, questions: patch(structuredClone(F.questions)) })
const withMsg = (message: string) => ({ ...F, submit: { ...F.submit, message } })

function draw(ctx: Partial<UiBlocksCtx> | null, block: unknown = F) {
  const node = <choices.Render {...(block as Record<string, unknown>)} />
  if (ctx === null) return render(node)
  const value: UiBlocksCtx = { onSend: vi.fn(), answered: false, streaming: false, ...ctx }
  return render(<UiBlocksContext.Provider value={value}>{node}</UiBlocksContext.Provider>)
}
const button = () => screen.queryByRole('button', { name: 'Design my factory' }) as HTMLButtonElement | null

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('choices schema + composeMessage (S54a T7)', () => {
  it('T7-C1 exports the block shape; example and the spec-shaped fixture parse and validate', () => {
    expect(choices.type).toBe('choices')
    expect(choices.describe.trim().length).toBeGreaterThan(0)
    expect(choices.describe).not.toContain('\n')
    expect(choices.example.type).toBe('choices')
    expect(ok(choices.example)).toBe(true)
    expect(validateBlock(JSON.stringify(choices.example), REG).ok).toBe(true)
    expect(ok(F)).toBe(true)
    expect(validateBlock(JSON.stringify(F), REG).ok).toBe(true)
  })

  it('T7-C2 `default` must be one of its option VALUES; omitting it is fine', () => {
    expect(ok(F)).toBe(true)
    expect(ok(withQ((qs) => [{ ...qs[0], default: 'nope' }, qs[1]]))).toBe(false)
    expect(ok(withQ((qs) => [{ ...qs[0], default: 'Both' }, qs[1]]))).toBe(false) // a label, not a value
    expect(ok(withQ((qs) => [{ ...qs[0], default: undefined }, qs[1]]))).toBe(true)
  })

  it('T7-C3 a {id} in submit.message naming no question is rejected; ids and option values unique', () => {
    expect(ok(withMsg('Goal: {goal}. Budget: {budget}.'))).toBe(false)
    expect(ok(withMsg('Just go.'))).toBe(true)
    expect(ok(withQ((qs) => [qs[0], { ...qs[1], id: 'goal' }]))).toBe(false)
    expect(ok(withQ((qs) => [{ ...qs[0], options: [opt('a', 'A'), opt('a', 'B')], default: 'a' }, qs[1]]))).toBe(false)
    const r = validateBlock(JSON.stringify(withMsg('Goal: {budget}')), REG)
    expect(r.ok).toBe(false)
  })

  it('T7-C4 composeMessage fills each {id} with the chosen option LABEL, the default when untouched', () => {
    expect(composeMessage(F, { model: 'cloud' })).toBe('Design a software factory for me. Goal: Both. Models: Cloud APIs.')
    expect(composeMessage(F, { goal: 'personal', model: 'local' })).toBe(
      'Design a software factory for me. Goal: Tools for myself. Models: On my machines.',
    )
    const twice = withMsg('{goal} and again {goal}; {model}')
    expect(composeMessage(twice, { model: 'local' })).toBe('Both and again Both; On my machines')
  })

  it('T7-C5 a referenced question with no default and no valid selection composes to null', () => {
    expect(composeMessage(F, {})).toBeNull()
    expect(composeMessage(F, { model: 'not-an-option' })).toBeNull()
    expect(composeMessage(F, { goal: 'not-an-option', model: 'cloud' })).toBe(
      'Design a software factory for me. Goal: Both. Models: Cloud APIs.',
    )
  })

  it('T7-C6 caps and strict props: questions 1..6, options 2..8, ids are plain words, strings capped', () => {
    const q = (i: number) => ({ ...F.questions[0], id: `q${i}` })
    const msg = (n: number) => withMsg(Array.from({ length: n }, (_, i) => `{q${i}}`).join(' '))
    expect(ok({ ...msg(0), questions: [] })).toBe(false)
    expect(ok({ ...msg(6), questions: Array.from({ length: 6 }, (_, i) => q(i)) })).toBe(true)
    expect(ok({ ...msg(7), questions: Array.from({ length: 7 }, (_, i) => q(i)) })).toBe(false)
    const opts = (n: number) => Array.from({ length: n }, (_, i) => opt(`v${i}`, `L${i}`))
    expect(ok(withQ((qs) => [{ ...qs[0], options: opts(1), default: 'v0' }, qs[1]]))).toBe(false)
    expect(ok(withQ((qs) => [{ ...qs[0], options: opts(8), default: 'v0' }, qs[1]]))).toBe(true)
    expect(ok(withQ((qs) => [{ ...qs[0], options: opts(9), default: 'v0' }, qs[1]]))).toBe(false)
    expect(ok({ ...withQ((qs) => [{ ...qs[0], id: 'Goal Id' }, qs[1]]), submit: { ...F.submit, message: 'x' } })).toBe(false)
    expect(ok(withQ((qs) => [{ ...qs[0], label: 'x'.repeat(LIMITS.strings.short + 1) }, qs[1]]))).toBe(false)
    expect(ok(withMsg('{goal}' + 'x'.repeat(LIMITS.strings.long)))).toBe(false)
    expect(ok({ ...F, style: { color: '#23354D' } })).toBe(false)
    expect(ok({ ...F, submit: { ...F.submit, url: 'https://x' } })).toBe(false)
    expect(ok(withQ((qs) => [{ ...qs[0], html: '<b>x</b>' }, qs[1]]))).toBe(false)
    expect(ok(withQ((qs) => [{ ...qs[0], options: [{ ...opt('personal', 'A'), href: 'x' }, opt('both', 'B')] }, qs[1]]))).toBe(false)
  })
})

describe('UiBlocksContext + choices Render (S54a T8)', () => {
  it('T8-C1 one labelled radio group per question; the default is preselected, none otherwise', () => {
    draw({})
    const groups = screen.getAllByRole('radiogroup')
    expect(groups).toHaveLength(2)
    screen.getByRole('radiogroup', { name: 'What should the factory produce?' })
    screen.getByRole('radiogroup', { name: 'Where do models run?' })
    expect((screen.getByRole('radio', { name: 'Both' }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole('radio', { name: 'Tools for myself' }) as HTMLInputElement).checked).toBe(false)
    expect((screen.getByRole('radio', { name: 'On my machines' }) as HTMLInputElement).checked).toBe(false)
    expect((screen.getByRole('radio', { name: 'Cloud APIs' }) as HTMLInputElement).checked).toBe(false)
  })

  it('T8-C2 the button calls ctx.onSend ONCE with composeMessage of the current selections', () => {
    const onSend = vi.fn()
    draw({ onSend })
    fireEvent.click(screen.getByRole('radio', { name: 'Tools for myself' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Cloud APIs' }))
    fireEvent.click(button()!)
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(onSend).toHaveBeenCalledWith(composeMessage(F, { goal: 'personal', model: 'cloud' }))
    expect(onSend.mock.calls[0][0]).toBe('Design a software factory for me. Goal: Tools for myself. Models: Cloud APIs.')
    const again = button()
    if (again) fireEvent.click(again)
    expect(onSend).toHaveBeenCalledTimes(1)
  })

  it('T8-C1b radios in one question share a name, each question its own (native arrow-key navigation per group)', () => {
    draw({})
    const [g1, g2] = screen.getAllByRole('radiogroup')
    const names = (g: HTMLElement) => new Set(Array.from(g.querySelectorAll('input[type="radio"]'), (r) => (r as HTMLInputElement).name))
    const n1 = names(g1)
    const n2 = names(g2)
    expect(n1.size).toBe(1)
    expect(n2.size).toBe(1)
    expect([...n1][0]).not.toBe('')
    expect([...n1][0]).not.toBe([...n2][0])
  })

  it('T8-C2b after a send the selections freeze: every radio disabled', () => {
    draw({})
    fireEvent.click(screen.getByRole('radio', { name: 'Cloud APIs' }))
    fireEvent.click(button()!)
    for (const r of screen.getAllByRole('radio') as HTMLInputElement[]) expect(r.disabled).toBe(true)
  })

  it('T8-C3 a submit never touches fetch, a URL, a form action or a link', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const onSend = vi.fn()
    const { container } = draw({ onSend })
    fireEvent.click(screen.getByRole('radio', { name: 'On my machines' }))
    const b = button()!
    expect(b.getAttribute('type')).toBe('button')
    fireEvent.click(b)
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(container.querySelector('a, [href], form[action], [formaction]')).toBeNull()
  })

  it('T8-C4 answered freezes the selections: inputs disabled, no live button, nothing sent', () => {
    const onSend = vi.fn()
    draw({ onSend, answered: true })
    const radios = screen.getAllByRole('radio') as HTMLInputElement[]
    expect(radios).toHaveLength(4)
    for (const r of radios) expect(r.disabled).toBe(true)
    const b = button()
    if (b) {
      expect(b.disabled).toBe(true)
      fireEvent.click(b)
    }
    expect(onSend).not.toHaveBeenCalled()
  })

  it('T8-C5 the button stays disabled until every referenced question has an answer', () => {
    const onSend = vi.fn()
    draw({ onSend })
    expect(button()).not.toBeNull()
    expect(button()!.disabled).toBe(true)
    fireEvent.click(button()!)
    expect(onSend).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('radio', { name: 'Cloud APIs' }))
    expect(button()!.disabled).toBe(false)
  })

  it('T8-C6 streaming or no provider: questions still draw, the button cannot send', () => {
    const onSend = vi.fn()
    draw({ onSend, streaming: true })
    fireEvent.click(screen.getByRole('radio', { name: 'Cloud APIs' }))
    expect(button()!.disabled).toBe(true)
    fireEvent.click(button()!)
    expect(onSend).not.toHaveBeenCalled()
    cleanup()
    draw(null)
    expect(screen.getAllByRole('radiogroup')).toHaveLength(2)
    fireEvent.click(screen.getByRole('radio', { name: 'Cloud APIs' }))
    expect(button()!.disabled).toBe(true)
  })
})

describe('choices never sends a slash command (S54a T7b)', () => {
  // A composed text starting with "/" would run as a slash command (/clear
  // empties the chat) from a button whose label does not say so.
  const SLASH = {
    type: 'choices',
    questions: [{ id: 'cmd', label: 'Next?', options: [opt('slash', '/clear'), opt('plain', 'Help me plan')], default: 'slash' }],
    submit: { label: 'Go', message: '{cmd}' },
  }

  it('T7b-C1 the schema rejects a submit.message whose trimmed text starts with "/"', () => {
    expect(ok(withMsg('/clear'))).toBe(false)
    expect(ok(withMsg('   /clear {goal} {model}'))).toBe(false)
    const r = validateBlock(JSON.stringify(withMsg('/clear')), REG)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('submit.message')
  })

  it('T7b-C2 a "/" anywhere but the start is an ordinary message', () => {
    expect(ok(withMsg('Use A/B testing for {goal} on {model}'))).toBe(true)
    expect(ok(withMsg('{goal}, then run /clear later'))).toBe(true)
    expect(composeMessage(withMsg('Use A/B testing for {goal}'), {})).toBe('Use A/B testing for Both')
  })

  it('T7b-C3 composeMessage returns null when the composed text would start with "/"', () => {
    expect(ok(SLASH)).toBe(true)
    expect(composeMessage(SLASH, {})).toBeNull()
    expect(composeMessage(SLASH, { cmd: 'slash' })).toBeNull()
    const spaced = { ...SLASH, questions: [{ ...SLASH.questions[0], options: [opt('slash', ' /clear'), opt('plain', 'Help me plan')] }] }
    expect(composeMessage(spaced, {})).toBeNull()
    expect(composeMessage(SLASH, { cmd: 'plain' })).toBe('Help me plan')
  })

  it('T7b-C4 the button cannot send a "/"-led text; picking an ordinary option sends it', () => {
    const onSend = vi.fn()
    draw({ onSend }, SLASH)
    const go = () => screen.getByRole('button', { name: 'Go' }) as HTMLButtonElement
    expect(go().disabled).toBe(true)
    fireEvent.click(go())
    expect(onSend).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('radio', { name: 'Help me plan' }))
    expect(go().disabled).toBe(false)
    fireEvent.click(go())
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(onSend).toHaveBeenCalledWith('Help me plan')
  })
})
