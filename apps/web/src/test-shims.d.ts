// Test-only: the web app has no @types/node, and one test reads index.css off
// disk to check it names no hue (the vitest CSS pipeline hands imports of a
// stylesheet back empty, `?raw` included, which would make that check pass
// on nothing). Just the one call the test makes.
declare module 'node:fs' {
  export function readFileSync(path: string | URL, encoding: 'utf8'): string
  // The manifest test checks that every icon the manifest names is really in
  // public/ — a missing one degrades Add-to-Home-Screen silently.
  export function existsSync(path: string | URL): boolean
}
