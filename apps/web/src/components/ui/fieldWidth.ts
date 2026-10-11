/**
 * A form field's width belongs to its WRAPPER (UI review R7). Input and
 * Select each wrap their control in a block that was always `w-full`, so a
 * width passed in `className` either sized the inner control while the
 * wrapper still filled the card (Input), or sat beside `w-full` on the same
 * element where the stylesheet's order picked the winner (Select). This
 * moves width-type classes to the wrapper and keeps `w-full` only when no
 * width was asked for, so every existing `className="w-28"` works as read.
 */
const WIDTH = /^(?:[a-z0-9-]+:)*(?:w-|max-w-|min-w-|flex-|basis-|shrink|grow)/

export function splitWidth(className?: string): { wrapper: string; field: string } {
  const tokens = (className ?? '').split(/\s+/).filter(Boolean)
  const width = tokens.filter(t => WIDTH.test(t))
  const field = tokens.filter(t => !WIDTH.test(t))
  const hasWidth = width.some(t => /^(?:[a-z0-9-]+:)*w-/.test(t))
  return {
    wrapper: [...(hasWidth ? [] : ['w-full']), ...width].join(' '),
    field: field.join(' '),
  }
}
