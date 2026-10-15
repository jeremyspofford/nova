// ui-blocks/UiBlock.tsx — one ```nova-ui fence: the component, or the code plus a visible reason (S54a T9).
//
// The fence text is model-written. It is parsed as JSON (never evaluated) and
// checked against the registry's zod schemas; only a block that passes is
// drawn, by the registry's own Render. Anything else shows the original text
// as code with one line saying why — a bad block is never blank and never a
// crash. While her reply is still streaming, a fence that does not parse yet
// is just code still arriving, so the reason is held back until it ends.
import { useContext, useMemo, type ReactNode } from 'react'
import { UI_BLOCKS } from './index'
import { UiBlocksContext } from './context'
import { validateBlock } from './validate'

const PRE =
  'overflow-x-auto rounded-md bg-neutral-900 dark:bg-neutral-950 dark:border dark:border-border text-neutral-200 p-3 font-mono text-mono-sm leading-relaxed'

export function UiBlock({ source, fallback }: { source: string; fallback?: ReactNode }) {
  const ctx = useContext(UiBlocksContext)
  const result = useMemo(() => validateBlock(source, UI_BLOCKS), [source])

  if (result.ok) {
    // validateBlock only returns ok for a type that is an own key of UI_BLOCKS.
    const def = UI_BLOCKS[result.block.type]
    return (
      <div className="my-3 min-w-0">
        <def.Render {...result.block} />
      </div>
    )
  }

  const code = fallback ?? (
    <pre className={PRE}>
      <code>{source}</code>
    </pre>
  )
  if (ctx?.streaming) return <>{code}</>
  return (
    <div className="my-2">
      {code}
      <p className="mt-1 text-caption text-content-tertiary">couldn't draw this block: {result.error}</p>
    </div>
  )
}
