import { useState } from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { ToolRoundsSection, type ToolRoundsApi } from './ToolRoundsSection'
import { storedFrom } from './shared'
import { ApiError, type SettingDef, type SettingWritten } from '../../lib/api'

/**
 * Settings → Behaviour → Tool rounds: the tool-round limit
 * (`agents.max_tool_rounds`), through the dependency-injection seam
 * ProactiveSection uses. Two rules, both ProactiveSection's:
 *
 * 1. Core is the only validator. The browser holds no copy of the bounds
 *    (agents.MIN_ROUNDS..MAX_ROUNDS, which core reads at write time): what was
 *    typed is sent as typed, and a refusal is core's sentence, verbatim.
 * 2. A write is shown as done only when the answer states what was STORED
 *    (storedFrom), and the field then shows that, never the typed value.
 *
 * The harness is stateful: it feeds onChanged's value back in as the def's
 * `value`, exactly as SettingsPage does, so a section that only looked right
 * because it kept its own optimistic copy fails here.
 */

const KEY = 'agents.max_tool_rounds'

/** Core's description of the key (settings_store.py), as GET lists it. It
 * carries no digit, which the no-bounds test relies on. */
const CORE_DESCRIPTION =
  'How many times one chat turn may call the model while it is still asking for tools. ' +
  'Reaching the limit ends the turn with a note saying so, never silently.'

/** Core's refusal of 51, as lib/api hands it to the page (the 400's `error`). */
const CORE_REFUSES_51 =
  'setting agents.max_tool_rounds: the tool-round limit must be between 1 and 50, got 51'

/**
 * A fake core for this key, after settings_store.validated(): the type check
 * first (an int and nothing else), then the range (agents' bounds, 1..50
 * unless a test moves them), then it answers with what it stored, or with
 * `answer`'s reply when a test needs core to say something else. A refusal is
 * thrown the way lib/api throws core's 400: an ApiError carrying core's
 * sentence.
 */
function fakeCore(opts: { low?: number; high?: number; answer?: (value: number) => unknown } = {}) {
  const { low = 1, high = 50, answer } = opts
  const putSetting = vi.fn(
    async (key: string, value: boolean | string | number): Promise<SettingWritten> => {
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        const got =
          typeof value === 'string'
            ? `str: '${value}'`
            : typeof value === 'boolean'
              ? `bool: ${value ? 'True' : 'False'}`
              : `float: ${value}`
        throw new ApiError(400, `setting ${key} expects int, got ${got}`)
      }
      if (value < low || value > high) {
        throw new ApiError(
          400,
          `setting ${key}: the tool-round limit must be between ${low} and ${high}, got ${value}`,
        )
      }
      return (answer ? answer(value) : { key, value }) as SettingWritten
    },
  )
  return { putSetting }
}

function Harness({
  api,
  value,
  description = CORE_DESCRIPTION,
  onChanged,
}: {
  api: ToolRoundsApi
  /** The stored limit, as the def's `value` (the def's default is 6). */
  value: number
  description?: string
  onChanged?: (value: number) => void
}) {
  const [def, setDef] = useState<SettingDef>({
    key: KEY,
    type: 'int',
    default: 6,
    description,
    value,
  })
  return (
    <ToolRoundsSection
      def={def}
      api={api}
      onChanged={stored => {
        onChanged?.(stored)
        setDef(prev => ({ ...prev, value: stored }))
      }}
    />
  )
}

const limitField = () => screen.getByLabelText('Tool-round limit') as HTMLInputElement
const saveButton = () => screen.getByRole('button', { name: 'Save' })
const resetButton = () => screen.getByRole('button', { name: 'Reset' })
const refusalShown = () => screen.getByTestId('tool-rounds-error').textContent ?? ''

/** What the alert must read for `reason`: the section's lead, then the reason
 * word for word. Matched whole, never with toContain, so a reason the section
 * decorates ("ApiError: …", advice of its own after it) is not core's verbatim. */
const alertFor = (reason: string) => `Could not save the limit: ${reason}`

/** No success line ("Saved — stored as N") anywhere in the section. */
function expectNothingSaysSaved(container: HTMLElement) {
  expect(screen.queryByText(/^Saved\b/)).toBeNull()
  expect(container.textContent).not.toContain('stored as')
}

/** storedFrom's own reason for refusing `answer` as this key's stored number:
 * the words the section must show, read from the one reader, not copied. */
function storedFromReason(answer: unknown): string {
  try {
    storedFrom(answer, KEY, 'number')
  } catch (err) {
    return (err as Error).message
  }
  throw new Error(`storedFrom took ${JSON.stringify(answer)} as a stored number: not a case here`)
}

describe('ToolRoundsSection: what it shows', () => {
  it("shows the stored limit, not the default, and core's description verbatim; rendering writes nothing", () => {
    const api = fakeCore()
    const onChanged = vi.fn()
    const first = render(<Harness api={api} value={12} onChanged={onChanged} />)

    expect(screen.getByRole('heading', { name: 'Tool rounds' })).toBeDefined()
    // 12 is stored; the def's default is 6.
    expect(limitField().value).toBe('12')
    expect(screen.getByTestId('tool-rounds-description').textContent).toBe(CORE_DESCRIPTION)
    first.unmount()

    // Whatever text the def carries is the text shown: a description written
    // into the page would match core's real one above and fail here.
    const elsewhere = 'Words only this test wrote, so only the def can have brought them.'
    render(<Harness api={api} value={7} description={elsewhere} onChanged={onChanged} />)
    expect(limitField().value).toBe('7')
    expect(screen.getByTestId('tool-rounds-description').textContent).toBe(elsewhere)

    expect(api.putSetting).not.toHaveBeenCalled()
    expect(onChanged).not.toHaveBeenCalled()
  })

  it("says the limit is the backstop in its own sentence, not the count Nova stops at (turn-cap T5)", () => {
    // The def's description is core's to say; the section's own sentence is
    // the page's. A turn going in circles is stopped before the limit, so the
    // page must not state the count as the stop.
    const elsewhere = 'Words only this test wrote, so only the def can have brought them.'
    const { container } = render(<Harness api={fakeCore()} value={20} description={elsewhere} />)
    const own = (container.textContent ?? '').replace(elsewhere, '')
    expect(own).not.toContain('How many rounds of tool calls one reply may take before Nova stops.')
    expect(own).not.toMatch(/before Nova stops/i)
    expect(own).toMatch(/backstop|safety ceiling/i)
  })

  it('rendering writes nothing, even a minute later', async () => {
    // A write put off past the render (a mount timer, an autosave that waits)
    // is still a write the render made, so the clock runs a minute first.
    vi.useFakeTimers()
    try {
      const api = fakeCore()
      const onChanged = vi.fn()
      render(<Harness api={api} value={12} onChanged={onChanged} />)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000)
      })

      expect(limitField().value).toBe('12')
      expect(api.putSetting).not.toHaveBeenCalled()
      expect(onChanged).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('ToolRoundsSection: saving', () => {
  it('typing writes nothing; Save writes the typed limit once, as a number', async () => {
    const api = fakeCore()
    const onChanged = vi.fn()
    render(<Harness api={api} value={6} onChanged={onChanged} />)

    fireEvent.change(limitField(), { target: { value: '1' } })
    fireEvent.change(limitField(), { target: { value: '12' } })
    fireEvent.blur(limitField())
    expect(limitField().value).toBe('12')
    expect(api.putSetting).not.toHaveBeenCalled()
    expect(onChanged).not.toHaveBeenCalled()

    fireEvent.click(saveButton())

    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(12))
    // 12, never "12": core types this key int, and a string is refused by
    // type before the range is ever read.
    expect(api.putSetting).toHaveBeenCalledTimes(1)
    expect(api.putSetting.mock.calls[0]).toEqual([KEY, 12])
    expect(typeof api.putSetting.mock.calls[0][1]).toBe('number')
  })

  it('after an accepted write the field shows what core stored, not what was typed', async () => {
    // Core answers that it stored 13 for a typed 12: the page must show 13.
    const api = fakeCore({ answer: () => ({ key: KEY, value: 13 }) })
    const onChanged = vi.fn()
    const { container } = render(<Harness api={api} value={6} onChanged={onChanged} />)

    fireEvent.change(limitField(), { target: { value: '12' } })
    fireEvent.click(saveButton())

    await waitFor(() => {
      expect(limitField().value).toBe('13')
      expect(screen.getByText(/^Saved\b/).textContent).toContain('stored as 13')
    })
    expect(api.putSetting.mock.calls).toEqual([[KEY, 12]])
    expect(container.textContent).not.toContain('stored as 12')
    expect(onChanged.mock.calls).toEqual([[13]])
    expect(screen.queryByTestId('tool-rounds-error')).toBeNull()
  })

  it('typing writes nothing, key by key or a minute on; Save writes once and no second write follows', async () => {
    // Typed as a browser types it: keydown, input and keyup for each key, then
    // change and blur as the field is left. A write on any of those, or on a
    // timer they start (an autosave debounce), is a write typing made.
    vi.useFakeTimers()
    try {
      const api = fakeCore()
      const onChanged = vi.fn()
      render(<Harness api={api} value={6} onChanged={onChanged} />)

      let typed = ''
      for (const key of ['1', '2']) {
        typed += key
        fireEvent.keyDown(limitField(), { key })
        fireEvent.input(limitField(), { target: { value: typed } })
        fireEvent.keyUp(limitField(), { key })
      }
      fireEvent.change(limitField(), { target: { value: typed } })
      fireEvent.blur(limitField())
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000)
      })

      expect(limitField().value).toBe('12')
      expect(api.putSetting).not.toHaveBeenCalled()
      expect(onChanged).not.toHaveBeenCalled()

      // The same fake core sees a write the moment Save is clicked, so the
      // silence above is the section's, not a blind spot of this harness.
      fireEvent.click(saveButton())
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(api.putSetting.mock.calls).toEqual([[KEY, 12]])
      expect(onChanged.mock.calls).toEqual([[12]])

      // Once means once: a minute on, no second write has followed.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000)
      })
      expect(api.putSetting.mock.calls).toEqual([[KEY, 12]])
      expect(onChanged.mock.calls).toEqual([[12]])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('ToolRoundsSection: an answer that states no stored number', () => {
  it.each([
    ['no value', { key: KEY }],
    ['another key', { key: 'agents.responsiveness_check', value: 13 }],
    ['a value that is not a number', { key: KEY, value: '13' }],
  ])("an answer with %s is a failure, not a save, and shows storedFrom's reason", async (_kind, answer) => {
    const reason = storedFromReason(answer)
    const api = fakeCore({ answer: () => answer })
    const onChanged = vi.fn()
    const { container } = render(<Harness api={api} value={6} onChanged={onChanged} />)

    fireEvent.change(limitField(), { target: { value: '12' } })
    fireEvent.click(saveButton())

    await waitFor(() => expect(refusalShown()).toBe(alertFor(reason)))
    expect(api.putSetting.mock.calls).toEqual([[KEY, 12]])
    expect(onChanged).not.toHaveBeenCalled()
    expectNothingSaysSaved(container)
  })
})

describe('ToolRoundsSection: a refused write', () => {
  it("shows core's reason verbatim, saves nothing, and Reset puts the stored limit back", async () => {
    const api = fakeCore()
    const onChanged = vi.fn()
    const { container } = render(<Harness api={api} value={12} onChanged={onChanged} />)

    fireEvent.change(limitField(), { target: { value: '51' } })
    fireEvent.click(saveButton())

    await waitFor(() => expect(refusalShown()).toBe(alertFor(CORE_REFUSES_51)))
    expect(api.putSetting.mock.calls).toEqual([[KEY, 51]])
    expect(onChanged).not.toHaveBeenCalled()
    expectNothingSaysSaved(container)
    // The field is still the operator's, to correct; core's description stays up.
    expect(limitField().value).toBe('51')
    expect(screen.getByTestId('tool-rounds-description').textContent).toBe(CORE_DESCRIPTION)

    fireEvent.click(resetButton())

    expect(limitField().value).toBe('12')
    expect(api.putSetting).toHaveBeenCalledTimes(1)
    expect(onChanged).not.toHaveBeenCalled()
  })
})

describe('ToolRoundsSection: no bounds in the browser', () => {
  it.each([
    ['0', 0, 'setting agents.max_tool_rounds: the tool-round limit must be between 1 and 50, got 0'],
    ['51', 51, CORE_REFUSES_51],
    ['6.5', 6.5, 'setting agents.max_tool_rounds expects int, got float: 6.5'],
  ] as const)(
    "sends %s to core as the number %s, and core's refusal is the only one shown",
    async (typed, sent, refusal) => {
      const api = fakeCore()
      render(<Harness api={api} value={12} />)

      fireEvent.change(limitField(), { target: { value: typed } })
      fireEvent.click(saveButton())

      // One alert, carrying core's sentence: the section refused, clamped and
      // rounded nothing of its own.
      await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(alertFor(refusal)))
      expect(api.putSetting.mock.calls).toEqual([[KEY, sent]])
      expect(typeof api.putSetting.mock.calls[0][1]).toBe('number')
    },
  )

  it('sends an emptied field as "", for core to refuse in its own words', async () => {
    const api = fakeCore()
    render(<Harness api={api} value={12} />)

    fireEvent.change(limitField(), { target: { value: '' } })
    fireEvent.click(saveButton())

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe(
        alertFor("setting agents.max_tool_rounds expects int, got str: ''"),
      ),
    )
    expect(api.putSetting.mock.calls).toEqual([[KEY, '']])
  })

  it('gives the limit field no min or max', () => {
    render(<Harness api={fakeCore()} value={12} />)

    expect(limitField().hasAttribute('min')).toBe(false)
    expect(limitField().hasAttribute('max')).toBe(false)
  })

  it("with core's bounds moved to 3..60 it sends 2 and 55, and states no number of its own", async () => {
    // agents' bounds moved, as core's write-time test moves them: a pair kept
    // in the browser would refuse or clamp 55, or print its own range beside
    // core's sentence.
    const api = fakeCore({ low: 3, high: 60 })
    const { container } = render(<Harness api={api} value={12} />)

    // At rest the section states neither the default nor a range: its words
    // carry no number at all (the field's value is not text).
    expect(limitField().value).toBe('12')
    expect(container.textContent).not.toMatch(/\d/)

    fireEvent.change(limitField(), { target: { value: '2' } })
    fireEvent.click(saveButton())
    const refusal =
      'setting agents.max_tool_rounds: the tool-round limit must be between 3 and 60, got 2'
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(alertFor(refusal)))
    // Core's sentence is the only place a range appears.
    expect((container.textContent ?? '').replace(refusal, '')).not.toMatch(/\d/)

    fireEvent.change(limitField(), { target: { value: '55' } })
    fireEvent.click(saveButton())
    await waitFor(() => expect(screen.getByText(/^Saved\b/).textContent).toContain('stored as 55'))
    expect(limitField().value).toBe('55')
    expect(api.putSetting.mock.calls).toEqual([
      [KEY, 2],
      [KEY, 55],
    ])
  })

  it('until core answers, it draws 0, 51 and 6.5 exactly as it draws 13', () => {
    // A bound kept in the browser shows before any write: a warning, a hint, a
    // red field, a disabled Save. Holding none, the section cannot tell a
    // limit core will refuse from one it will store until core says which.
    const api = fakeCore()
    const { container } = render(<Harness api={api} value={12} />)
    const drawn = (typed: string) => {
      fireEvent.change(limitField(), { target: { value: typed } })
      expect(limitField().value).toBe(typed)
      // Everything the section draws but the field's own value.
      return container.innerHTML.replace(/ value="[^"]*"/g, '')
    }

    const inRange = drawn('13')
    expect(saveButton()).toBeDefined()
    for (const typed of ['0', '51', '6.5']) {
      expect(drawn(typed)).toBe(inRange)
    }
    expect(api.putSetting).not.toHaveBeenCalled()
  })
})
