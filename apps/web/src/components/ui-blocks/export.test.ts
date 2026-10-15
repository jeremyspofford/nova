import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { z } from 'zod'
import { exportRegistry } from './export'
import { UI_BLOCKS } from './index'
import { LIMITS, validateBlock } from './validate'
import { ICONS } from './tokens'
import type { BlockDef } from './types'

// The committed catalog core reads (services/core's build context is
// services/core, so the file lives there). npm test runs from apps/web.
const CATALOG = '../../services/core/app/ui_blocks.json'
const serialize = (v: unknown) => JSON.stringify(v, null, 2) + '\n'

describe('exportRegistry -> services/core/app/ui_blocks.json (S54a T11)', () => {
  it('T11-C1 carries exactly limits, icons and blocks; limits are LIMITS, icons the curated ICONS names sorted', () => {
    const out = exportRegistry()
    expect(Object.keys(out).sort()).toEqual(['blocks', 'icons', 'limits'])
    expect(out.limits).toEqual(LIMITS)
    expect(out.icons).toEqual(Object.keys(ICONS).sort())
  })

  it('T11-C2 one entry per registered block, in registry order, with its own type, describe and example', () => {
    const out = exportRegistry()
    const defs = Object.values(UI_BLOCKS)
    expect(out.blocks.map((b) => b.type)).toEqual(defs.map((d) => d.type))
    out.blocks.forEach((b, i) => {
      expect(Object.keys(b).sort()).toEqual(['describe', 'example', 'schema', 'type'])
      expect(b.describe).toBe(defs[i].describe)
      expect(b.example).toEqual(defs[i].example)
    })
  })

  it('T11-C3 each schema is plain JSON Schema data naming its own type as a const', () => {
    const blocks = exportRegistry().blocks
    expect(blocks.length).toBeGreaterThan(0)
    for (const b of blocks) {
      expect(JSON.parse(JSON.stringify(b.schema))).toEqual(b.schema)
      const props = b.schema.properties as Record<string, { const?: unknown }> | undefined
      expect(props?.type?.const).toBe(b.type)
    }
  })

  it('T11-C4 every exported example passes validateBlock against the live registry', () => {
    const out = exportRegistry()
    expect(out.blocks.length).toBe(Object.keys(UI_BLOCKS).length)
    for (const b of out.blocks) {
      const r = validateBlock(JSON.stringify(b.example), UI_BLOCKS)
      expect(r.ok, `${b.type}: ${r.ok ? '' : r.error}`).toBe(true)
    }
  })

  it('T11-C5 a test-only extra block appears in the export with no other edit', () => {
    const extra: BlockDef = {
      type: 'zz_test_block',
      schema: z.strictObject({ type: z.literal('zz_test_block'), text: z.string() }),
      describe: 'A test-only block that never ships.',
      example: { type: 'zz_test_block', text: 'hello' },
      Render: () => null,
    }
    const out = exportRegistry({ ...UI_BLOCKS, zz_test_block: extra })
    const got = out.blocks.find((b) => b.type === 'zz_test_block')
    expect(got?.describe).toBe(extra.describe)
    expect(got?.example).toEqual(extra.example)
    expect((got?.schema.properties as Record<string, { const?: unknown }>)?.type?.const).toBe('zz_test_block')
    expect(exportRegistry().blocks.some((b) => b.type === 'zz_test_block')).toBe(false)
  })

  it('T11-C6 the committed ui_blocks.json equals the regenerated export (UPDATE_UI_BLOCKS=1 rewrites it)', () => {
    const fresh = serialize(exportRegistry())
    if (process.env.UPDATE_UI_BLOCKS === '1') writeFileSync(CATALOG, fresh, 'utf8')
    expect(readFileSync(CATALOG, 'utf8')).toBe(fresh)
  })
})
