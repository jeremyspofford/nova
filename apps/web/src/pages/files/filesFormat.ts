/**
 * Pure presentation logic for the Files page, kept apart from the
 * component for the same reason activityFormat.ts is: each property this
 * page has to get right — a real size on a small file, a stated (never
 * guessed) reason a file's contents are not shown — is one function a
 * test can pin down without rendering anything.
 */

/** Most files Nova writes are a few hundred bytes to a few KB, so bytes
 * gets no decimal at all — "0 B" / "7 B" reads better than "0.0 B" for the
 * common case, and nothing here rounds a real size down to a fake zero. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`
}

/**
 * The message shown in place of a file's contents when core's
 * GET /file (services/core/app/workspace_api.py) answered with `text:
 * null` — binary or over the 256 KB preview cap. The real byte count is
 * always named (never dropped in favour of a vague "large file"), and the
 * two reasons are mutually exclusive by construction on the wire, so this
 * never has to choose between them.
 */
export function notShownMessage(detail: {
  size: number
  binary: boolean
  too_large: boolean
}): string {
  const reason = detail.too_large ? 'too large to preview' : 'binary'
  return `${detail.size} bytes, not shown (${reason}) — download to view`
}

export type PreviewKind = 'markdown' | 'image' | 'pdf' | 'docx' | 'word' | 'text'

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg'])

/**
 * How the detail view shows a file, from its extension alone. The image
 * and PDF sets match what core's /raw?inline=1 will serve inline
 * (INLINE_TYPES in services/core/app/workspace_api.py) — anything else
 * would come back as a download and never display. A name that is only a
 * dot-extension (`.md`) is a dotfile, not markdown.
 */
export function previewKind(path: string): PreviewKind {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return 'text'
  const ext = name.slice(dot + 1).toLowerCase()
  if (ext === 'md' || ext === 'markdown') return 'markdown'
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (ext === 'pdf') return 'pdf'
  // .docx is a zip of XML that DocxView reads; an old binary .doc is not.
  if (ext === 'docx') return 'docx'
  if (ext === 'doc') return 'word'
  return 'text'
}

// Extension -> highlight.js grammar name. Explicit rather than leaning on
// each grammar's alias list, so what highlights is readable here and the
// lazy grammars (EXTRA_GRAMMARS in components/Markdown.tsx) resolve by
// their canonical name. Prose, logs and plain .txt are deliberately absent:
// a wrong colouring is worse than none.
const CODE_EXTS: Record<string, string> = {
  py: 'python', pyi: 'python',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json',
  yml: 'yaml', yaml: 'yaml',
  go: 'go',
  sql: 'sql',
  html: 'xml', htm: 'xml', xml: 'xml', xhtml: 'xml', plist: 'xml',
  css: 'css', scss: 'scss', less: 'less',
  md: 'markdown', markdown: 'markdown',
  diff: 'diff', patch: 'diff',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  ini: 'ini', toml: 'ini', cfg: 'ini', conf: 'ini',
  rs: 'rust',
  java: 'java',
  c: 'c', h: 'c',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
  cs: 'csharp',
  rb: 'ruby',
  php: 'php',
  kt: 'kotlin', kts: 'kotlin',
  swift: 'swift',
  lua: 'lua',
  mk: 'makefile',
  ps1: 'powershell', psm1: 'powershell',
  r: 'r',
  pl: 'perl', pm: 'perl',
  scala: 'scala',
  dart: 'dart',
  ex: 'elixir', exs: 'elixir',
  hs: 'haskell',
  graphql: 'graphql', gql: 'graphql',
  proto: 'protobuf',
}

const CODE_NAMES: Record<string, string> = {
  dockerfile: 'dockerfile',
  containerfile: 'dockerfile',
  makefile: 'makefile',
  gnumakefile: 'makefile',
}

/** The grammar a file's contents highlight with, or undefined for none. */
export function codeLanguage(path: string): string | undefined {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  if (CODE_NAMES[name]) return CODE_NAMES[name]
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return undefined
  return CODE_EXTS[name.slice(dot + 1)]
}
