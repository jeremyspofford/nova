import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * The site-wide Content-Security-Policy on the one origin (T3).
 *
 * Read from apps/web/nginx.conf.template itself, the way manifest.test.ts
 * reads public/: a header that is not in the template is not on the wire.
 *
 * Two facts about nginx shape every assertion here:
 *
 * - An `add_header` inside a location REPLACES every add_header inherited
 *   from the server block. Most of nginx's own locations set Cache-Control,
 *   so a policy written once at server level silently vanishes from
 *   index.html. Each location that serves nginx's own files carries it.
 * - A location that proxies to core is core's to describe. Core states each
 *   response's own policy (T2: a download is `sandbox`, an image or PDF is
 *   inline), and a second policy from nginx would intersect with it. So the
 *   site policy is never on a proxied location, nor at server/http level
 *   where those locations would inherit it.
 *
 * What the policy must let through is what the BUILT app loads (inventoried
 * in the epic tracker's T3 Assumptions): the one inline first-frame script in
 * index.html, a runtime <style> element (theme-store), data: icons and
 * images, data: font subsets vite inlines, same-origin fetch streams, and a
 * same-origin PDF iframe. Nothing external.
 *
 * Paths are relative to the package root — vitest runs with apps/web as cwd.
 */

const template = readFileSync('nginx.conf.template', 'utf8')
const indexHtml = readFileSync('index.html', 'utf8')

// ── A small nginx parser: blocks and directives, comments dropped ────────

type Directive = { name: string; args: string[] }
type Block = { header: string[]; directives: Directive[]; children: Block[] }

function tokenize(src: string): string[] {
  const tokens: string[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i++
    } else if (/\s/.test(c)) {
      i++
    } else if (c === '{' || c === '}' || c === ';') {
      tokens.push(c)
      i++
    } else if (c === '"' || c === "'") {
      let j = i + 1
      let out = ''
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < src.length) {
          out += src[j + 1]
          j += 2
        } else {
          out += src[j++]
        }
      }
      tokens.push(`\u0000${out}`) // marks a quoted word
      i = j + 1
    } else {
      let j = i
      while (j < src.length && !/[\s{};]/.test(src[j])) j++
      tokens.push(src.slice(i, j))
      i = j
    }
  }
  return tokens
}

const unquote = (t: string) => (t.startsWith('\u0000') ? t.slice(1) : t)

function parse(src: string): Block {
  const tokens = tokenize(src)
  const root: Block = { header: [], directives: [], children: [] }
  const stack: Block[] = [root]
  let words: string[] = []
  for (const t of tokens) {
    const top = stack[stack.length - 1]
    if (t === ';') {
      if (words.length) top.directives.push({ name: words[0], args: words.slice(1).map(unquote) })
      words = []
    } else if (t === '{') {
      const child: Block = { header: words.map(unquote), directives: [], children: [] }
      top.children.push(child)
      stack.push(child)
      words = []
    } else if (t === '}') {
      stack.pop()
      words = []
    } else {
      words.push(t)
    }
  }
  return root
}

const conf = parse(template)
const server = conf.children.find(b => b.header[0] === 'server')!
const locations = server.children.filter(b => b.header[0] === 'location')
const where = (loc: Block) => loc.header.join(' ')
const proxies = (loc: Block) => loc.directives.some(d => d.name === 'proxy_pass')
const ownLocations = locations.filter(l => !proxies(l))
const proxiedLocations = locations.filter(proxies)

const isCsp = (d: Directive) =>
  d.name === 'add_header' && (d.args[0] ?? '').toLowerCase() === 'content-security-policy'

/** A `$var` value resolved through `set $var` in the location/server or a
 *  top-level `map … $var { default …; }` — so the policy may be written once. */
function resolve(value: string, scopes: Block[]): string | null {
  if (!value.startsWith('$')) return value
  const name = value.slice(1)
  for (const scope of scopes) {
    const set = scope.directives.find(d => d.name === 'set' && d.args[0] === `$${name}`)
    if (set) return set.args[1] ?? null
  }
  const map = conf.children.find(b => b.header[0] === 'map' && b.header[b.header.length - 1] === `$${name}`)
  const dflt = map?.directives.find(d => d.name === 'default')
  return dflt ? (dflt.args[0] ?? null) : null
}

function cspOf(loc: Block): { policy: string | null; always: boolean } | null {
  const d = loc.directives.find(isCsp)
  if (!d) return null
  return { policy: resolve(d.args[1] ?? '', [loc, server]), always: d.args.includes('always') }
}

/** The site policy as nginx serves it on the app document (location /,
 *  whose SPA fallback is index.html), or null when there is none. */
function sitePolicy(): string | null {
  const root = locations.find(l => where(l) === 'location /')
  return root ? (cspOf(root)?.policy ?? null) : null
}

type Policy = Map<string, string[]>

function parsePolicy(policy: string): Policy {
  const out: Policy = new Map()
  for (const part of policy.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/)
    if (name) out.set(name.toLowerCase(), sources)
  }
  return out
}

/** The sources a fetch directive actually allows, with CSP's fallback chain. */
function effective(p: Policy, directive: string): string[] | null {
  const chains: Record<string, string[]> = {
    'script-src': ['script-src', 'default-src'],
    'style-src': ['style-src', 'default-src'],
    'img-src': ['img-src', 'default-src'],
    'font-src': ['font-src', 'default-src'],
    'connect-src': ['connect-src', 'default-src'],
    'frame-src': ['frame-src', 'child-src', 'default-src'],
    'manifest-src': ['manifest-src', 'default-src'],
    'object-src': ['object-src', 'default-src'],
  }
  for (const name of chains[directive] ?? [directive]) {
    const sources = p.get(name)
    if (sources) return sources
  }
  return null
}

/** sha256 of each inline (no src) <script> in index.html, as CSP spells it.
 *  Vite copies a classic inline script byte for byte into dist/index.html. */
async function inlineScriptHashes(html: string): Promise<string[]> {
  const out: string[] = []
  for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(m[1])))
    out.push(`'sha256-${btoa(String.fromCharCode(...digest))}'`)
  }
  return out
}

function requirePolicy(): Policy {
  const policy = sitePolicy()
  expect(policy, 'location / (index.html) sends no Content-Security-Policy').not.toBeNull()
  return parsePolicy(policy!)
}

// ── Sanity: the parser sees the template it is meant to read ─────────────

describe('the nginx template parser', () => {
  it('finds the server block and both kinds of location', () => {
    expect(ownLocations.map(where)).toEqual(
      expect.arrayContaining(['location /', 'location /assets/', 'location = /healthz', 'location = /gate-page.html']),
    )
    expect(proxiedLocations.map(where)).toEqual(
      expect.arrayContaining(['location /api/', 'location = /api/v1/chat/stream', 'location /api/v1/agent/']),
    )
  })
})

// ── T3 ───────────────────────────────────────────────────────────────────

describe('the site Content-Security-Policy (T3)', () => {
  it('C1: every location serving nginx\'s own files sends it, with `always`', () => {
    const missing = ownLocations.filter(l => cspOf(l)?.policy == null).map(where)
    expect(missing, `no Content-Security-Policy on: ${missing.join(', ')}`).toEqual([])
    const notAlways = ownLocations.filter(l => cspOf(l) && !cspOf(l)!.always).map(where)
    expect(notAlways, `CSP without \`always\` (a 401/404 would drop it) on: ${notAlways.join(', ')}`).toEqual([])
  })

  it('C2: it is never on a location proxied to core, nor where those would inherit it', () => {
    requirePolicy()
    const onProxied = proxiedLocations.filter(l => l.directives.some(isCsp)).map(where)
    expect(onProxied, `nginx adds a CSP over core's own on: ${onProxied.join(', ')}`).toEqual([])
    expect(server.directives.some(isCsp), 'server-level CSP: every proxied location inherits it').toBe(false)
    expect(conf.directives.some(isCsp), 'http-level CSP: every proxied location inherits it').toBe(false)
  })

  it('C3: scripts are this origin plus the hash of index.html\'s first-frame script, nothing looser', async () => {
    const p = requirePolicy()
    const script = effective(p, 'script-src') ?? []
    const hashes = await inlineScriptHashes(indexHtml)
    expect(hashes.length, 'index.html has its inline first-frame script').toBe(1)
    expect(script).toContain("'self'")
    for (const h of hashes) expect(script, `the inline script's ${h} is not allowed`).toContain(h)
    expect(script).not.toContain("'unsafe-inline'")
    expect(script).not.toContain("'unsafe-eval'")
    const loose = script.filter(s => !s.startsWith("'") || s === '*')
    expect(loose, `script-src allows a host or scheme: ${loose.join(' ')}`).toEqual([])
  })

  it('C4: the lock-down directives — default self, no plugins, no base rewrite, no framing by others', () => {
    const p = requirePolicy()
    expect(p.get('default-src')).toEqual(["'self'"])
    expect(effective(p, 'object-src')).toEqual(["'none'"])
    expect(['self', 'none'].map(s => `'${s}'`)).toContain((p.get('base-uri') ?? [])[0])
    expect(p.get('base-uri')?.length).toBe(1)
    expect(['self', 'none'].map(s => `'${s}'`)).toContain((p.get('frame-ancestors') ?? [])[0])
    expect(p.get('frame-ancestors')?.length).toBe(1)
  })

  it('C5: it lets through everything the built app loads, and nothing external', () => {
    const p = requirePolicy()
    // theme-store writes a <style> at runtime; gate-page.html has an inline <style>
    expect(effective(p, 'style-src')).toEqual(expect.arrayContaining(["'self'", "'unsafe-inline'"]))
    // data: favicons/brand marks (app-icon.ts), the Select chevron, DocxView images; blob: previews
    expect(effective(p, 'img-src')).toEqual(expect.arrayContaining(["'self'", 'data:', 'blob:']))
    // vite inlines small woff2 subsets as data: URIs in the built CSS
    expect(effective(p, 'font-src')).toEqual(expect.arrayContaining(["'self'", 'data:']))
    // every fetch and chat stream is same-origin /api
    expect(effective(p, 'connect-src')).toContain("'self'")
    // the Files page previews a PDF in a same-origin iframe
    expect(effective(p, 'frame-src')).toContain("'self'")
    expect(effective(p, 'manifest-src')).toContain("'self'")
    const external = [...p.values()].flat().filter(s => /^(https?|wss?):|^\*$|^[a-z0-9.-]+\.[a-z]{2,}/i.test(s))
    expect(external, `the policy names an external source: ${external.join(' ')}`).toEqual([])
  })

  // COVERAGE: C5's external-source pattern misses a wildcard host
  // (`*.example.com`). Pin it the other way round: every source is a quoted
  // keyword or hash, or one of the two local schemes the app needs.
  it('C5: every source is a keyword, a hash, data: or blob: — no host in any shape', () => {
    const p = requirePolicy()
    const allowed = (s: string) => /^'[^']+'$/.test(s) || s === 'data:' || s === 'blob:'
    const other = [...p.values()].flat().filter(s => !allowed(s))
    expect(other, `the policy names a non-local source: ${other.join(' ')}`).toEqual([])
  })

  it('C6: it never upgrades requests — the origin is also served over plain http', () => {
    const p = requirePolicy()
    expect(p.has('upgrade-insecure-requests')).toBe(false)
    expect(p.has('block-all-mixed-content')).toBe(false)
  })

  it('C7: one policy — every location that sends it sends the same one', () => {
    requirePolicy()
    const policies = new Set(ownLocations.map(l => cspOf(l)?.policy).filter((x): x is string => !!x))
    expect(policies.size).toBe(1)
    expect(policies.has(sitePolicy()!)).toBe(true)
  })
})
