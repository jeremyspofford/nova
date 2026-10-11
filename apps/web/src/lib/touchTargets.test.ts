import { describe, it, expect } from 'vitest'
import postcss from 'postcss'
import tailwindcss from 'tailwindcss'
// @ts-expect-error -- plain JS config, no declaration file
import config from '../../tailwind.config.js'

// UI review R9, 2026-10-11: on a touch screen the small controls were 22-28px
// tall (Button sm h-7, Clear 30x22, the model chip, the copy button). The
// `touch:` variant is `@media (pointer: coarse)` — keyed on the INPUT, not
// the width, so a touch laptop gets the larger targets and a narrow desktop
// window does not.

const SOURCES = import.meta.glob(
  [
    '/src/components/ui/Button.tsx',
    '/src/components/Markdown.tsx',
    '/src/pages/chat/ChatControls.tsx',
    '/src/pages/chat/ModelSelector.tsx',
    '/src/pages/chat/ContextGauge.tsx',
  ],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>

describe('the touch: variant', () => {
  it('compiles to a pointer: coarse media query', async () => {
    const out = await postcss([
      tailwindcss({ ...config, content: [{ raw: '<b class="touch:h-9 touch:p-2">', extension: 'html' }] }),
    ]).process('@tailwind utilities;', { from: undefined })
    expect(out.css).toMatch(/@media \(pointer: coarse\)\s*\{\s*\.touch\\:h-9\s*\{\s*height: 2\.25rem/)
  })
})

describe('the small controls grow on touch', () => {
  it('Button sm is 36px tall on touch', () => {
    expect(SOURCES['/src/components/ui/Button.tsx']).toMatch(/sm: 'h-7 touch:h-9/)
  })

  it('the copy button, Clear, the model chip and the context gauge pad out on touch', () => {
    expect(SOURCES['/src/components/Markdown.tsx']).toMatch(/const COPY_BUTTON =\s*'[^']*touch:p-2/)
    expect(SOURCES['/src/pages/chat/ChatControls.tsx']).toMatch(/data-testid="chat-clear"[\s\S]{0,200}touch:py-2/)
    expect(SOURCES['/src/pages/chat/ModelSelector.tsx']).toMatch(/data-testid="chat-model-trigger"[\s\S]{0,600}touch:py-2/)
    expect(SOURCES['/src/pages/chat/ContextGauge.tsx']).toMatch(/data-testid="context-gauge"[\s\S]{0,300}touch:py-2/)
  })
})
