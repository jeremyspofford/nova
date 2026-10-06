// Finds Tailwind colour utilities whose colour name the theme does not define.
//
// Pure: takes the source text and the theme's `colors` object, reads nothing
// else. A class Tailwind does not know compiles to nothing, so an undefined
// colour token silently renders as no colour at all (R5 of the 2026-10-06 UI
// review: `border-line` fell back to the browser's currentColor outline).

// Utility prefixes whose suffix may be a colour. Longest first so
// `ring-offset-` wins over `ring-` and `placeholder-` is not read as `p-`.
const COLOR_PREFIXES = [
  'ring-offset',
  'placeholder',
  'decoration',
  'outline',
  'divide',
  'border',
  'stroke',
  'accent',
  'caret',
  'text',
  'fill',
  'ring',
  'from',
  'via',
  'bg',
  'to',
]

// Colour keywords Tailwind always defines, whatever the theme says.
const KEYWORDS = new Set(['white', 'black', 'transparent', 'current', 'inherit'])

// Suffixes that make the utility something other than a colour (Tailwind 3).
// A suffix starting with a digit (widths, sizes, offsets, percentages) is never
// a colour name either, unless the theme defines it (numeric scales are
// resolved under a colour name, e.g. `accent-500`, so they never reach here).
const SIDES = '(?:t|r|b|l|x|y|s|e|tl|tr|br|bl|ss|se|es|ee)'
const NON_COLOR: Record<string, RegExp> = {
  text: /^(?:xs|sm|base|lg|[2-9]?xl|left|center|right|justify|start|end|ellipsis|clip|wrap|nowrap|balance|pretty)$/,
  border: new RegExp(`^(?:${SIDES}(?:-\\d.*)?|solid|dashed|dotted|double|hidden|none|collapse|separate|spacing(?:-.*)?)$`),
  bg: /^(?:none|auto|cover|contain|fixed|local|scroll|center|top|bottom|left|right|left-top|left-bottom|right-top|right-bottom|repeat|no-repeat|repeat-x|repeat-y|repeat-round|repeat-space|clip-.*|origin-.*|gradient-to-.*|blend-.*)$/,
  ring: /^(?:inset|offset(?:-.*)?)$/,
  'ring-offset': /^$/,
  outline: /^(?:none|dashed|dotted|double|offset-.*)$/,
  divide: /^(?:x|y|x-.*|y-.*|solid|dashed|dotted|double|none)$/,
  decoration: /^(?:solid|double|dotted|dashed|wavy|auto|from-font|clone|slice)$/,
  fill: /^(?:none)$/,
  stroke: /^(?:none)$/,
  accent: /^(?:auto)$/,
  caret: /^$/,
  placeholder: /^(?:shown)$/,
  from: /^$/,
  via: /^$/,
  to: /^$/,
}

// variant chain (hover:, md:dark:, group-hover:, !), prefix, suffix, /opacity.
// Not preceded by a word char or dash, so `box-border` and `--nova-safe-top`
// never match; the suffix must start with [a-z0-9], so arbitrary values
// (`bg-[#fff]`, `text-[13px]`) never match.
const TOKEN = new RegExp(
  `(?<![\\w-])((?:[\\w-]+:)*!?)(${COLOR_PREFIXES.join('|')})-([a-z0-9][a-z0-9.-]*?)(?:\\/[\\w.]+)?(?![\\w\\-\\[])`,
  'g',
)

// Does `segs` (a dash-split colour path) name a colour in `node`? Tries every
// split point, so a key containing a dash (`card-hover`, `on-accent`) resolves.
function resolves(node: unknown, segs: string[]): boolean {
  if (segs.length === 0) {
    if (typeof node === 'string' || typeof node === 'function') return true
    return !!node && typeof node === 'object' && 'DEFAULT' in node
  }
  if (!node || typeof node !== 'object') return false
  const obj = node as Record<string, unknown>
  for (let i = 1; i <= segs.length; i++) {
    const key = segs.slice(0, i).join('-')
    if (key in obj && resolves(obj[key], segs.slice(i))) return true
  }
  return false
}

// `nonColor` adds non-colour suffixes per prefix that the theme defines (e.g.
// the theme's fontSize keys under `text`: `text-h1` is a size, not a colour).
export function findUndefinedColorTokens(
  source: string,
  colors: object,
  nonColor?: Record<string, string[]>,
): string[] {
  const found = new Set<string>()
  for (const m of source.matchAll(TOKEN)) {
    const [, variants, prefix, suffix] = m
    if (/^\d/.test(suffix)) continue
    if (NON_COLOR[prefix]?.test(suffix)) continue
    if (nonColor?.[prefix]?.includes(suffix)) continue
    if (KEYWORDS.has(suffix)) continue
    if (resolves(colors, suffix.split('-'))) continue
    found.add(`${variants}${prefix}-${suffix}`)
  }
  return [...found]
}

// Blanks text that is not a class list: `data-testid` values (test ids such as
// `from-notice` look like utilities) and attribute names written directly
// before `=` (`text-anchor="middle"`). Everything else is left as written.
export function stripNonClassText(source: string): string {
  return source
    .replace(/(data-testid=)(["'`])[^"'`]*\2/g, '$1$2$2')
    .replace(/(?<![\w-])[\w-]+(?==(?!=))/g, '')
}
