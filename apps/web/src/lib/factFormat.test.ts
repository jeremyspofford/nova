import { describe, expect, it } from 'vitest'
import { factLabel, factValue, formatFact } from './factFormat'
import { formatStamp } from './humanText'

// Verification report item 5 (2026-10-13): Inbox facts read like debug
// output — `snake_key: value` in mono, whole UUIDs, JSON arrays. A fact is
// formatted at the edge: the key as words, the value as a short reading, and
// the raw value kept in `full` so a title or "Details" can still show
// exactly what core wrote.

const UUID = '0b39fae3-5c1d-4e2a-9f6b-1a2b3c4d5e6f'
const UUID2 = '7d0e1f22-aaaa-4bbb-8ccc-0123456789ab'
const SHA = 'c00e7b31a4f9e2d8b7c6a5f4e3d2c1b0a9f8e7d6'

describe('C1 factLabel — a snake_key reads as words', () => {
  it('turns underscores into spaces and capitalises only the first word', () => {
    expect(factLabel('last_error')).toBe('Last error')
    expect(factLabel('paused_at')).toBe('Paused at')
    expect(factLabel('service')).toBe('Service')
  })

  it('writes the acronyms id, url and api in capitals', () => {
    expect(factLabel('timer_id')).toBe('Timer ID')
    expect(factLabel('base_url')).toBe('Base URL')
    expect(factLabel('api_key_name')).toBe('API key name')
  })

  it('collapses doubled, leading and trailing underscores', () => {
    expect(factLabel('_last__seen_')).toBe('Last seen')
  })
})

describe('C2 factValue — a list reads as a list, not JSON', () => {
  it('joins strings with commas', () => {
    expect(factValue(['list_timers', 'cancel_timer']).text).toBe('list_timers, cancel_timer')
  })

  it('formats each item by the same rules (ids shortened, booleans as words)', () => {
    expect(factValue([UUID, UUID2]).text).toBe('0b39fae3…, 7d0e1f22…')
    expect(factValue([true, false, 3]).text).toBe('yes, no, 3')
  })

  it('an empty list reads "none"', () => {
    expect(factValue([]).text).toBe('none')
  })

  it('more than five items shows the first five and how many more', () => {
    expect(factValue(['a', 'b', 'c', 'd', 'e', 'f', 'g']).text).toBe('a, b, c, d, e and 2 more')
    expect(factValue(['a', 'b', 'c', 'd', 'e']).text).toBe('a, b, c, d, e')
  })

  it('never shows brackets or quotes, even for a list inside a list', () => {
    const out = factValue([['x', 'y'], 'z'])
    expect(out.text).toMatch(/x.*y.*z/)
    expect(out.text).not.toMatch(/[[\]"]/)
  })
})

describe('C3 factValue — ids are shortened, the full id kept', () => {
  it('a UUID reads as its first eight characters and an ellipsis', () => {
    expect(factValue(UUID)).toEqual({ text: '0b39fae3…', full: UUID })
  })

  it('a long hex token (a commit, a digest) is shortened the same way', () => {
    expect(factValue(SHA)).toEqual({ text: 'c00e7b31…', full: SHA })
    expect(factValue('9f8e7d6c5b4a39281706f5e4d3c2b1a0')).toEqual({
      text: '9f8e7d6c…',
      full: '9f8e7d6c5b4a39281706f5e4d3c2b1a0',
    })
  })

  it('sixteen hex characters is the threshold: 16 is shortened, 15 is left whole', () => {
    expect(factValue('a1b2c3d4e5f60718')).toEqual({ text: 'a1b2c3d4…', full: 'a1b2c3d4e5f60718' })
    expect(factValue('a1b2c3d4e5f6071')).toEqual({ text: 'a1b2c3d4e5f6071' })
  })

  it('a short id, a word and a sentence are left whole', () => {
    expect(factValue('0b39fae3')).toEqual({ text: '0b39fae3' })
    expect(factValue('gateway')).toEqual({ text: 'gateway' })
    expect(factValue('could not reach dell after 3 tries')).toEqual({
      text: 'could not reach dell after 3 tries',
    })
  })
})

describe('C4 factValue — an object is summarised, never printed as JSON', () => {
  it('a small flat object reads as its fields in words with their values', () => {
    expect(factValue({ ok: 3, failed: 1 }).text).toBe('ok 3, failed 1')
    expect(factValue({ last_error: 'timed out' }).text).toBe('last error timed out')
  })

  it('three flat fields still read in words, each value by the same rules', () => {
    expect(factValue({ ok: 3, failed: 1, retried: true }).text).toBe('ok 3, failed 1, retried yes')
  })

  it('a nested or larger object reads as a field count', () => {
    expect(factValue({ a: { b: 1 }, c: 2 }).text).toBe('2 fields')
    expect(factValue({ a: 1, b: 2, c: 3, d: 4 }).text).toBe('4 fields')
  })

  it('an empty object reads "none"', () => {
    expect(factValue({}).text).toBe('none')
  })

  it('keeps the JSON in full and none of it in the text', () => {
    const v = { a: { b: 1 }, c: [1, 2] }
    const out = factValue(v)
    expect(out.text).not.toMatch(/[{}[\]"]/)
    expect(out.full).toBe(JSON.stringify(v))
  })
})

describe('C5 factValue — plain values read as words', () => {
  it('true and false read yes and no', () => {
    expect(factValue(true)).toEqual({ text: 'yes', full: 'true' })
    expect(factValue(false)).toEqual({ text: 'no', full: 'false' })
  })

  it('null and undefined read "none"', () => {
    expect(factValue(null).text).toBe('none')
    expect(factValue(undefined).text).toBe('none')
  })

  it('a number reads as itself', () => {
    expect(factValue(3)).toEqual({ text: '3' })
  })

  it('a timestamp or a date reads through humanText.formatStamp, raw kept', () => {
    const at = '2026-10-12T16:10:05.378391+00:00'
    expect(factValue(at)).toEqual({ text: formatStamp(at), full: at })
    expect(factValue('2026-09-11')).toEqual({ text: formatStamp('2026-09-11'), full: '2026-09-11' })
  })
})

describe('C6 nothing is lost — full carries the raw value whenever the text differs', () => {
  const samples: unknown[] = [
    UUID,
    SHA,
    'gateway',
    '0b39fae3',
    true,
    false,
    null,
    3,
    0,
    ['a', UUID],
    [],
    { ok: 3 },
    { a: { b: 1 } },
    '2026-10-12T16:10:05Z',
  ]

  it.each(samples.map(s => [JSON.stringify(s) ?? 'undefined', s]))('%s', (_name, value) => {
    const raw = typeof value === 'string' ? value : String(JSON.stringify(value))
    const out = factValue(value)
    expect(out.text).not.toBe('')
    if (out.text === raw) expect(out.full).toBeUndefined()
    else expect(out.full).toBe(raw)
  })

  it('formatFact is the key, its label and its value together', () => {
    expect(formatFact('timer_id', UUID)).toEqual({
      key: 'timer_id',
      label: 'Timer ID',
      text: '0b39fae3…',
      full: UUID,
    })
    expect(formatFact('service', 'gateway')).toEqual({ key: 'service', label: 'Service', text: 'gateway' })
  })
})

// Verification 2-7, T30 (VISUAL 2): the card face read "Turn ids", "Free gb",
// "Used pct" next to "Timer ID" and "URL". The rule (T30 Assumptions): a key
// segment on a fixed acronym list is written in capitals, its plural keeps a
// lowercase "s"; "pct" reads "%"; "ms" stays a lowercase unit. A segment is
// matched whole and case-blind, never as part of a longer word.
describe('T30 C1 factLabel — acronyms and their plurals in capitals', () => {
  it('writes units and machine acronyms in capitals', () => {
    expect(factLabel('free_gb')).toBe('Free GB')
    expect(factLabel('vram_mb')).toBe('VRAM MB')
    expect(factLabel('cpu_load')).toBe('CPU load')
    expect(factLabel('gpu_name')).toBe('GPU name')
    expect(factLabel('ip_address')).toBe('IP address')
    expect(factLabel('pid')).toBe('PID')
    expect(factLabel('size_kb')).toBe('Size KB')
    expect(factLabel('disk_tb')).toBe('Disk TB')
  })

  it('a plural acronym keeps a lowercase s', () => {
    expect(factLabel('turn_ids')).toBe('Turn IDs')
    expect(factLabel('urls')).toBe('URLs')
    expect(factLabel('gpu_uuids')).toBe('GPU UUIDs')
  })

  it('matches a segment whole and case-blind, never part of a word', () => {
    expect(factLabel('TURN_IDS')).toBe('Turn IDs')
    expect(factLabel('Free_GB')).toBe('Free GB')
    // Words that merely contain an acronym stay words.
    expect(factLabel('idle_since')).toBe('Idle since')
    expect(factLabel('gbit_rate')).toBe('Gbit rate')
    expect(factLabel('apiary')).toBe('Apiary')
  })
})

describe('T30 C2 factLabel — units read as units', () => {
  it('"pct" reads "%"', () => {
    expect(factLabel('used_pct')).toBe('Used %')
    expect(factLabel('cpu_pct')).toBe('CPU %')
  })

  it('"ms" stays a lowercase unit, even first', () => {
    expect(factLabel('duration_ms')).toBe('Duration ms')
    expect(factLabel('ms_waited')).toBe('ms waited')
  })
})

describe('T30 C3 factValue — an object summary names its keys by the same rule', () => {
  it('a flat object reads its keys with the acronyms and units', () => {
    expect(factValue({ free_gb: 38.2, used_pct: 91.4 }).text).toBe('free GB 38.2, used % 91.4')
    expect(factValue({ turn_ids: 3 }).text).toBe('turn IDs 3')
  })
})

describe('T30 C1/C2 (coverage) — the whole acronym list, and the units case-blind', () => {
  it('writes every acronym on the list in capitals, a listed word ending in s whole', () => {
    const list = [
      'id', 'url', 'uri', 'api', 'uuid', 'ip', 'cpu', 'gpu', 'ram', 'vram',
      'kb', 'mb', 'gb', 'tb', 'http', 'https', 'ssh', 'dns', 'tls', 'pid',
      'json', 'html', 'llm',
    ]
    for (const word of list) expect(factLabel(`x_${word}`)).toBe(`X ${word.toUpperCase()}`)
    // "https" is on the list itself: never read as the plural of "http".
    expect(factLabel('https_port')).toBe('HTTPS port')
    // A word that is not on the list keeps its s as a word.
    expect(factLabel('open_items')).toBe('Open items')
  })

  it('units are matched case-blind, first or last', () => {
    expect(factLabel('Duration_MS')).toBe('Duration ms')
    expect(factLabel('MS_waited')).toBe('ms waited')
    expect(factLabel('pct_used')).toBe('% used')
    expect(factLabel('USED_PCT')).toBe('Used %')
  })
})
