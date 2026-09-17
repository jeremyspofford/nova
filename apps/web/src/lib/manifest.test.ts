import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'

/**
 * The web manifest, checked against the files it names.
 *
 * A manifest is uniquely easy to get silently wrong: every failure mode is
 * quiet. A missing icon, a typo'd path, a file vite did not copy — none of
 * them error. Add-to-Home-Screen just degrades to a bookmark with the
 * browser's default glyph, and nothing appears in a log the owner would
 * read. So the assertions here are against the filesystem, not against a
 * snapshot of the manifest's own text.
 */

// Paths are relative to the package root, the same way color-palettes.test.ts
// reads src/index.css — vitest runs with apps/web as the cwd.
const manifest = JSON.parse(readFileSync('public/manifest.webmanifest', 'utf8'))
const indexHtml = readFileSync('index.html', 'utf8')

describe('the web manifest', () => {
  it('names icons that actually exist in public/', () => {
    expect(manifest.icons.length).toBeGreaterThan(0)
    for (const icon of manifest.icons) {
      const path = `public${icon.src}`
      expect(existsSync(path), `${icon.src} is named by the manifest but not in public/`).toBe(true)
    }
  })

  it('ships a maskable icon, or Android crops the art into a circle', () => {
    const maskable = manifest.icons.filter((i: { purpose?: string }) =>
      (i.purpose ?? '').split(' ').includes('maskable'),
    )
    expect(maskable.length).toBeGreaterThan(0)
  })

  it('declares the fields that make it an app rather than a bookmark', () => {
    // Without display:standalone the icon opens a browser tab with chrome,
    // which is the thing Add-to-Home-Screen is supposed to avoid.
    expect(manifest.display).toBe('standalone')
    expect(manifest.name).toBeTruthy()
    expect(manifest.short_name).toBeTruthy()
    expect(manifest.start_url).toBe('/')
    expect(manifest.scope).toBe('/')
  })

  it('paints the same ground index.html paints on the first frame', () => {
    // index.html sets the pre-React background inline; if the manifest
    // disagrees, the splash flashes one colour and the app another.
    expect(indexHtml).toContain(manifest.background_color)
    expect(manifest.theme_color).toBe(manifest.background_color)
  })

  it('is linked from index.html, and iOS is given the metas it needs instead', () => {
    // iOS reads almost nothing from a manifest; standalone mode and the
    // home-screen title come from these two apple- metas.
    expect(indexHtml).toContain('rel="manifest"')
    expect(indexHtml).toContain('apple-mobile-web-app-capable')
    expect(indexHtml).toContain('apple-mobile-web-app-title')
  })

  it('is served with a content type nginx would otherwise not know', () => {
    // .webmanifest is absent from nginx's mime.types. Without an explicit
    // block the file is served as the default type, Chrome refuses to parse
    // it, and the failure is silent — so the conf must say so itself.
    const conf = readFileSync('nginx.conf.template', 'utf8')
    expect(conf).toContain('location = /manifest.webmanifest')
    expect(conf).toContain('application/manifest+json')
  })
})
