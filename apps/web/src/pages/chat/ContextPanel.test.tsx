import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ContextPanel } from './ContextPanel'
import { ContextGauge } from './ContextGauge'
import type { SystemResources } from '../../lib/api'

/**
 * The panel behind the gauge.
 *
 * Its one rule is the gauge's rule, one level down: EVERY FIGURE IS
 * MEASURED, and a figure that could not be measured says so rather than
 * rendering as a zero. "No free memory" and "we could not read free memory"
 * are opposite findings, and a dashboard that renders the second as the
 * first is the silence this codebase keeps hunting.
 */

const resources = (over: Partial<SystemResources> = {}): SystemResources => ({
  card: {
    free_gb: 16.1,
    total_gb: 24,
    used_gb: 7.6,
    utilisation_pct: 99,
    non_ollama_gb: 7.3,
    resident: [],
    reason: null,
  },
  machine: {
    memory: { total_mb: 32_768, available_mb: 18_000, reason: null },
    cpu: { cores: 16, load_1m: 2.4, reason: null },
    disk: { free_gb: 900, total_gb: 1800, reason: null },
  },
  throughput: {
    model: 'qwen3:8b',
    recent_tok_per_s: 99.7,
    baseline_tok_per_s: 100.2,
    recent_rounds: 3,
    baseline_rounds: 40,
    ratio: 1,
  },
  model: 'qwen3:8b',
  ...over,
})

const fetcher = (r: SystemResources) => vi.fn(async () => r) as never

describe('ContextPanel', () => {
  it('leads with the context window, as a fraction when the window is known', async () => {
    render(
      <ContextPanel
        promptTokens={10_000}
        contextWindow={40_960}
        onClose={() => {}}
        getResources={fetcher(resources())}
      />,
    )
    const panel = await screen.findByTestId('context-panel')
    expect(panel.textContent).toContain('Context window')
    expect(panel.textContent).toContain('24%')
  })

  it('shows the count with no fraction when no window is stated', async () => {
    render(
      <ContextPanel
        promptTokens={10_000}
        contextWindow={null}
        onClose={() => {}}
        getResources={fetcher(resources())}
      />,
    )
    await screen.findByTestId('context-panel')
    // Scoped to the row under test: other rows legitimately carry
    // percentages, and asserting on the whole panel measured those.
    const row = screen.getByTestId('panel-row-context-window')
    expect(row.textContent).toContain('no fraction to show')
    expect(row.textContent).not.toContain('%')
    // No bar at all — a dial without a denominator is a picture of a guess.
    expect(row.querySelector('[data-testid="panel-row-bar"]')).toBeNull()
  })

  it('shows free memory AND utilisation, because they fail in opposite directions', async () => {
    // THE 2026-09-16 CASE: 16.1 GB free and 99% busy. A panel showing only
    // the first describes that card as healthy; it could not answer "what
    // is 2+2" in under two minutes.
    render(
      <ContextPanel promptTokens={1} contextWindow={100} onClose={() => {}} getResources={fetcher(resources())} />,
    )
    const panel = await screen.findByTestId('context-panel')
    await waitFor(() => expect(panel.textContent).toContain('16.1 GB free of 24.0'))
    expect(panel.textContent).toContain('99%')
    expect(panel.textContent).toContain('saturated')
    // And the actionable half: what is holding it that is not ollama.
    expect(panel.textContent).toContain('7.3 GB is held by something that is not ollama')
  })

  it('states why a reading is missing instead of drawing it as zero', async () => {
    render(
      <ContextPanel
        promptTokens={1}
        contextWindow={100}
        onClose={() => {}}
        getResources={fetcher(
          resources({
            card: { reason: 'the gateway could not be asked — connection refused' },
            machine: { memory: { total_mb: null, available_mb: null, reason: '/proc/meminfo — denied' } },
          }),
        )}
      />,
    )
    const panel = await screen.findByTestId('context-panel')
    await waitFor(() => expect(panel.textContent).toContain('connection refused'))
    expect(panel.textContent).toContain('/proc/meminfo — denied')
    // Never a zero standing in for a reading nobody took.
    expect(panel.textContent).not.toContain('0.0 GB free of')
  })

  it('says nothing about throughput when nothing has been measured', async () => {
    // model_speed refuses a token count too small to be a measurement, so a
    // quiet day has nothing to say — and an invented zero would read as a
    // dead card.
    render(
      <ContextPanel
        promptTokens={1}
        contextWindow={100}
        onClose={() => {}}
        getResources={fetcher(resources({ throughput: null }))}
      />,
    )
    const panel = await screen.findByTestId('context-panel')
    await waitFor(() => expect(panel.textContent).toContain('Memory'))
    expect(panel.textContent).not.toContain('tok/s')
  })

  it('says so when the whole read fails, rather than showing an empty panel', async () => {
    render(
      <ContextPanel
        promptTokens={1}
        contextWindow={100}
        onClose={() => {}}
        getResources={vi.fn(async () => {
          throw new Error('core unreachable')
        }) as never}
      />,
    )
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('core unreachable'))
  })

  it('closes on Escape', async () => {
    const onClose = vi.fn()
    render(
      <ContextPanel promptTokens={1} contextWindow={100} onClose={onClose} getResources={fetcher(resources())} />,
    )
    await screen.findByTestId('context-panel')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })
})

describe('the gauge opens the panel', () => {
  it('is a button, and toggles the panel', async () => {
    render(
      <ContextGauge
        promptTokens={10_000}
        model="qwen3:8b"
        getCatalog={vi.fn(async () => ({ rows: [] }) as never)}
        getResources={fetcher(resources())}
      />,
    )
    const gauge = screen.getByTestId('context-gauge')
    // A label that reacts to clicks is a control nobody can find.
    expect(gauge.tagName).toBe('BUTTON')
    expect(gauge.getAttribute('aria-haspopup')).toBe('dialog')
    expect(screen.queryByTestId('context-panel')).toBeNull()

    fireEvent.click(gauge)
    expect(await screen.findByTestId('context-panel')).toBeTruthy()
    expect(gauge.getAttribute('aria-expanded')).toBe('true')

    fireEvent.click(gauge)
    await waitFor(() => expect(screen.queryByTestId('context-panel')).toBeNull())
  })
})
