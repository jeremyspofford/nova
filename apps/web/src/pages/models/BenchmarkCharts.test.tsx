import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { BenchmarkCharts } from './BenchmarkCharts'
import type { CatalogRow } from '../../lib/api'

function row(overrides: Partial<CatalogRow> & { id: string }): CatalogRow {
  const [provider, ...rest] = overrides.id.split(':')
  return {
    provider,
    model: rest.join(':'),
    label: overrides.id,
    kind: 'cloud',
    sources: [{ key: 'provider-listing', fetched_at: '2026-09-07T12:00:00Z' }],
    facts: {},
    capabilities: {},
    suitability: {},
    actions: ['use'],
    ...overrides,
  }
}

const listed = (value: number) => ({ value, basis: 'declared' as const, source: 'provider-listing', note: 'OpenRouter benchmarks.artificial_analysis (third-party)' })

const MAX = row({ id: 'openrouter:qwen/qwen3.8-max', label: 'Qwen3.8 Max', suitability: { intelligence: listed(53), coding: listed(69), agentic: listed(50) } })
const FLASH = row({ id: 'openrouter:google/gemini-3.8-flash', label: 'Gemini 3.8 Flash', suitability: { intelligence: listed(41), coding: listed(76), agentic: listed(41) } })
// Coding only — no intelligence or agentic data, and an INFERRED coding tag that is not a score.
const ASTRA = row({ id: 'openrouter:openai/gpt-6-astra-pro', label: 'GPT-6 Astra Pro', suitability: { coding: listed(82) } })
const LOCAL = row({ id: 'ollama:qwen3:8b', label: 'Qwen3 8B', kind: 'local', installed: true, suitability: { 'coding:inferred': { value: true, basis: 'inferred', source: 'name' } } })

describe('BenchmarkCharts', () => {
  it('draws one chart per index with bar heights equal to the score, and names the models without data', () => {
    render(<BenchmarkCharts rows={[MAX, FLASH, ASTRA, LOCAL]} />)
    expect(screen.getByTestId('bench-intelligence-openrouter:qwen/qwen3.8-max').style.height).toBe('53%')
    expect(screen.getByTestId('bench-coding-openrouter:openai/gpt-6-astra-pro').style.height).toBe('82%')
    expect(screen.getByTestId('bench-agentic-openrouter:google/gemini-3.8-flash').style.height).toBe('41%')
    // No intelligence data for Astra: no bar, a footnote — never a zero bar.
    expect(screen.queryByTestId('bench-intelligence-openrouter:openai/gpt-6-astra-pro')).toBeNull()
    expect(screen.getByTestId('benchmark-missing-intelligence').textContent).toContain('GPT-6 Astra Pro has no intelligence data')
    expect(screen.getByTestId('benchmark-missing-agentic').textContent).toContain('GPT-6 Astra Pro has no agentic data')
    expect(screen.queryByTestId('benchmark-missing-coding')).toBeNull()
    // The local model has no index at all: not on any chart, not in a footnote.
    expect(screen.queryByTestId('bench-coding-ollama:qwen3:8b')).toBeNull()
    expect(screen.queryByText(/Qwen3 8B/)).toBeNull()
  })

  it('hovering a bar shows that model\'s three scores together', () => {
    render(<BenchmarkCharts rows={[MAX, FLASH]} />)
    fireEvent.mouseEnter(screen.getByLabelText('Qwen3.8 Max Intelligence 53'))
    const tip = screen.getByTestId('benchmark-tooltip')
    expect(within(tip).getByText('Qwen3.8 Max')).toBeTruthy()
    const cells = within(tip).getAllByRole('cell').map(c => c.textContent)
    expect(cells).toEqual(['Intelligence', '53', 'Coding', '69', 'Agentic', '50'])
  })

  it('says so when none of the models carries an index', () => {
    render(<BenchmarkCharts rows={[LOCAL]} />)
    expect(screen.getByTestId('benchmarks-empty').textContent).toContain('None of these models carries a benchmark index')
  })
})
