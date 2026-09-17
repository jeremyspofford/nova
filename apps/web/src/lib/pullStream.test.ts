import { describe, it, expect } from 'vitest'
import {
  STREAM_ENDED_QUIET,
  applyPullLine,
  formatBytes,
  initialPullState,
  preflightNote,
  settlePull,
} from './pullStream'

describe('pullStream — the one reducer every pull consumer runs', () => {
  it('formats bytes at the unit a person reads', () => {
    expect(formatBytes(5_225_388_164)).toBe('4.9 GB')
    expect(formatBytes(12 * 1024 ** 2)).toBe('12 MB')
    expect(formatBytes(2048)).toBe('2 KB')
  })

  it('a preflight line becomes one sentence, naming where the size came from', () => {
    expect(
      preflightNote({ status: 'preflight', required_gb: 4.7, free_gb: 412.6, ok: true, size_source: 'hf-hub' }, 'x'),
    ).toBe('4.7 GB needed, 412.6 GB free. (size from huggingface.co)')
    expect(
      preflightNote({ status: 'preflight', required_gb: 18, free_gb: 2, ok: false, size_source: 'ollama-registry' }, 'qwen3:8b'),
    ).toBe(
      'qwen3:8b needs about 18 GB and only 2 GB is free — the pull will probably fail. (size from registry.ollama.ai)',
    )
    // The gateway's own words win — an unknown size is said, not invented.
    expect(preflightNote({ status: 'preflight', note: "model size for 'foo' is unknown — skipping the free-space check" }, 'foo')).toBe(
      "model size for 'foo' is unknown — skipping the free-space check",
    )
  })

  it('folds progress and remembers the literal success line', () => {
    let s = initialPullState('qwen3:4b')
    s = applyPullLine(s, { status: 'preflight', required_gb: 2.5, free_gb: 100, ok: true })
    s = applyPullLine(s, { status: 'pulling sha256:ab', digest: 'sha256:ab', total: 1000, completed: 250 })
    expect(s.status).toBe('pulling sha256:ab')
    expect(s.completed).toBe(250)
    expect(s.total).toBe(1000)
    expect(s.sawSuccess).toBe(false)
    s = applyPullLine(s, { status: 'verifying sha256 digest' })
    expect(s.completed).toBe(250) // a line with no numbers keeps the last ones
    s = applyPullLine(s, { status: 'success' })
    expect(s.sawSuccess).toBe(true)
    expect(settlePull(s).done).toBe(true)
  })

  it('an error line wins, and a quiet end is a stated failure — never a finished download', () => {
    const errored = applyPullLine(initialPullState('x'), { error: 'the pull stream failed — ReadError' })
    expect(settlePull(errored).error).toBe('the pull stream failed — ReadError')
    expect(settlePull(errored).done).toBe(false)
    const quiet = applyPullLine(initialPullState('x'), { status: 'pulling manifest' })
    expect(settlePull(quiet).error).toBe(STREAM_ENDED_QUIET)
    expect(settlePull(quiet).done).toBe(false)
  })
})
