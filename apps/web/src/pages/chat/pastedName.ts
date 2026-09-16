/**
 * Naming a file that arrived without one (S28).
 *
 * A screenshot pasted from the clipboard has no filename — the browser hands
 * over a Blob whose `name` is empty or the generic "image.png" every paste
 * shares. Left alone, a conversation fills with a dozen files called
 * image.png and the one he means is unfindable; core would keep them apart
 * (image-2.png, image-3.png) but that is a disambiguator, not a name.
 *
 * So a pasted file is named for WHEN it was pasted, which is the only thing
 * that distinguishes it from the others and the thing he actually remembers.
 */

/** The extension for a clipboard type. The map is small on purpose: these
 * are the types a clipboard actually produces. Anything else keeps whatever
 * the browser called it. */
const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
}

function stamp(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ` +
    `at ${pad(at.getHours())}.${pad(at.getMinutes())}.${pad(at.getSeconds())}`
  )
}

/**
 * What to call a pasted or dropped file.
 *
 * A file that came with a real name of its own keeps it — dragging
 * `invoice.pdf` in should not rename it. Only the nameless and the
 * generically-named get a stamp, because those are the ones that collide.
 */
export function pastedName(file: { name?: string; type?: string }, now = new Date()): string {
  const given = (file.name ?? '').trim()
  const generic = given === '' || /^(image|screenshot|clipboard)\.[a-z0-9]+$/i.test(given)
  if (!generic) return given
  const type = (file.type ?? '').toLowerCase()
  const fallback = given.includes('.') ? given.split('.').pop()! : 'png'
  const extension = EXTENSIONS[type] ?? fallback
  const noun = type.startsWith('image/') ? 'Pasted image' : 'Pasted file'
  return `${noun} ${stamp(now)}.${extension}`
}
