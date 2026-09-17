import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { ContextGauge, formatTokens, windowFor } from './ContextGauge'

/**
 * The gauge's one rule: NO RING WITHOUT A DENOMINATOR.
 *
 * A dial needs two numbers. The first is measured — the gateway's own
 * `prompt_tokens` for the last answered turn. The second is the model's
 * context window as the catalog states it, and when the catalog does not
 * state one there is no fraction to draw. Filling a ring against a window
 * guessed from a model's name would be a picture of a guess, and it would
 * look exactly as confident as a measured one.
 */

const row = (id: string, context?: number) => ({
  id,
  facts: context === undefined ? {} : { context_length: { value: context } },
})

const catalog = (rows: ReturnType<typeof row>[]) => vi.fn(async () => ({ rows }) as never)

describe('formatTokens', () => {
  it('reads at a glance', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(940)).toBe('940')
    expect(formatTokens(1200)).toBe('1.2K')
    expect(formatTokens(9900)).toBe('9.9K')
    expect(formatTokens(34_000)).toBe('34K')
    expect(formatTokens(262_144)).toBe('262K')
  })
})

describe('windowFor', () => {
  it('matches a qualified catalog id against a bare model setting', () => {
    // chat.model may hold either shape, so both are tried rather than one
    // being assumed.
    expect(windowFor([row('ollama:qwen3:8b', 40_960)], 'qwen3:8b')).toBe(40_960)
    expect(windowFor([row('ollama:qwen3:8b', 40_960)], 'ollama:qwen3:8b')).toBe(40_960)
  })

  it('answers null when the catalog states no window', () => {
    expect(windowFor([row('ollama:qwen3:8b')], 'qwen3:8b')).toBeNull()
  })

  it('answers null for a model the catalog does not carry', () => {
    expect(windowFor([row('ollama:other', 1000)], 'qwen3:8b')).toBeNull()
  })

  it('refuses a window that is not a positive number', () => {
    // A zero or a string would render a full ring or crash the arithmetic.
    expect(windowFor([{ id: 'm', facts: { context_length: { value: 0 } } }], 'm')).toBeNull()
    expect(windowFor([{ id: 'm', facts: { context_length: { value: '128K' } } }], 'm')).toBeNull()
  })
})

describe('ContextGauge', () => {
  it('draws nothing at all before a turn has reported a count', () => {
    const { container } = render(
      <ContextGauge promptTokens={null} model="qwen3:8b" getCatalog={catalog([])} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('shows the count and a ring when the window is known', async () => {
    render(
      <ContextGauge
        promptTokens={10_240}
        model="qwen3:8b"
        getCatalog={catalog([row('ollama:qwen3:8b', 40_960)])}
      />,
    )
    // 10K, not 10.2K: one decimal below ten thousand, whole above — the
    // rule pinned in formatTokens. A tenth of a K is not a fact anybody
    // acts on at this size.
    expect(screen.getByTestId('context-gauge-count').textContent).toBe('10K')
    await waitFor(() =>
      expect(screen.getByTestId('context-gauge').querySelector('svg')).toBeTruthy(),
    )
    expect(screen.getByTestId('context-gauge').getAttribute('title')).toContain('40,960')
  })

  it('shows the count and NO ring when the window is not stated', async () => {
    render(
      <ContextGauge
        promptTokens={10_240}
        model="qwen3:8b"
        getCatalog={catalog([row('ollama:qwen3:8b')])}
      />,
    )
    const gauge = await screen.findByTestId('context-gauge')
    expect(gauge.querySelector('svg')).toBeNull()
    // And it says WHY, rather than implying the window is unlimited.
    expect(gauge.getAttribute('title')).toContain('not stated in the catalog')
  })

  it('a catalog that cannot be read costs the ring, never the count', async () => {
    // Reading the catalog probes every installed model. The chat page must
    // not break when that is slow or refused.
    render(
      <ContextGauge
        promptTokens={512}
        model="qwen3:8b"
        getCatalog={vi.fn(async () => {
          throw new Error('catalog unavailable')
        }) as never}
      />,
    )
    const gauge = await screen.findByTestId('context-gauge')
    expect(gauge.querySelector('svg')).toBeNull()
    expect(screen.getByTestId('context-gauge-count').textContent).toBe('512')
  })

  it('never fills past full, however large the prompt', async () => {
    render(
      <ContextGauge
        promptTokens={99_999}
        model="qwen3:8b"
        getCatalog={catalog([row('ollama:qwen3:8b', 40_960)])}
      />,
    )
    await waitFor(() => expect(screen.getByTestId('context-gauge').querySelector('svg')).toBeTruthy())
    const arc = screen.getByTestId('context-gauge').querySelectorAll('circle')[1]
    // Offset 0 is a complete ring; a negative offset would draw past it.
    expect(Number(arc.getAttribute('stroke-dashoffset'))).toBe(0)
  })
})
