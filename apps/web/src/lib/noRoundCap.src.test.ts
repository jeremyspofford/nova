/// <reference types="vite/client" />
import { describe, it, expect } from 'vitest'

/**
 * No tool-round ceiling anywhere in the web app (2026-10-08, owner: "remove
 * the whole tool call limit entirely"). Core has no setting and no per-agent
 * rounds any more; a turn ends on its own or on the going-in-circles stop.
 * These read the source tree itself, so a field, a type member, a fixture
 * key or a comment that still names the ceiling fails here even when no
 * rendered test happens to reach it.
 *
 * Every name is spelled in pieces, so this file holds no literal of what it
 * looks for and the tree-wide check covers it too.
 */

// Every .ts/.tsx under src/, tests included, as raw text, keyed by
// package-relative path. (Vite leaves the importing file out of its own glob;
// the names below are spelled in pieces so this file is clean anyway.)
const globbed = import.meta.glob('/src/**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>
const files: Record<string, string> = {}
for (const [k, v] of Object.entries(globbed)) files[k.replace(/^\//, '')] = v

const KEY = ['max', 'tool', 'rounds'].join('_')
const SECTION = ['Tool', 'Rounds', 'Section'].join('')
/** What a reference to the ceiling looks like, in any case. */
const CEILING = new RegExp(
  [KEY, ['tool', 'rounds'].join(''), ['tool', 'rounds'].join('_'), ['tool', 'rounds?'].join(' '), ['max', 'tool', 'rounds'].join('')].join('|'),
  'i',
)

/** The lines of a file that match the ceiling, as `path:line: text`. */
function hits(path: string): string[] {
  return files[path]
    .split('\n')
    .flatMap((line, i) => (CEILING.test(line) ? [`${path}:${i + 1}: ${line.trim()}`] : []))
}

/** The body of `export interface <name> ... { ... }` in api.ts. */
function interfaceBody(name: string): string {
  const src = files['src/lib/api.ts']
  const start = src.search(new RegExp(`export interface ${name}\\b[^{]*\\{`))
  expect(start, `api.ts declares interface ${name}`).toBeGreaterThanOrEqual(0)
  const end = src.indexOf('\n}', start)
  return src.slice(start, end)
}

describe('no tool-round ceiling in the web source', () => {
  it('the glob really reads src/, tests included', () => {
    expect(files['src/lib/api.ts']).toBeTruthy()
    expect(files['src/pages/settings/SettingsPage.tsx']).toBeTruthy()
    expect(files['src/pages/settings/tabs.test.tsx']).toBeTruthy()
    expect(files['src/lib/manifest.test.ts']).toBeTruthy()
  })

  it('the settings section for the limit and its test are gone, and nothing imports from it', () => {
    expect(Object.keys(files).filter(f => f.includes(SECTION))).toEqual([])
    const names = [SECTION, ['TOOL', 'ROUNDS', 'KEY'].join('_'), ['Tool', 'Rounds', 'Api'].join('')]
    const importers = Object.entries(files)
      .filter(([, src]) => names.some(n => src.includes(n)))
      .map(([f]) => f)
    expect(importers).toEqual([])
  })

  it('the Agent and AgentWrite (spec) types carry no rounds, nor does the shared agent fixture', () => {
    expect(interfaceBody('Agent')).not.toMatch(/round/i)
    expect(interfaceBody('AgentWrite')).not.toMatch(/round/i)
    expect(files['src/pages/agents/agentFixture.ts']).not.toMatch(/round/i)
  })

  it("ChatPage's poll comment says a turn is any number of gateway calls, not a count it is capped at", () => {
    expect(hits('src/pages/chat/ChatPage.tsx')).toEqual([])
    expect(files['src/pages/chat/ChatPage.tsx']).toMatch(/any number of (them|gateway calls)/)
  })

  it('no file under src/ names the ceiling', () => {
    expect(Object.keys(files).flatMap(hits)).toEqual([])
  })
})
