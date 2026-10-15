// Test-only: the web app has no @types/node, and one test reads index.css off
// disk to check it names no hue (the vitest CSS pipeline hands imports of a
// stylesheet back empty, `?raw` included, which would make that check pass
// on nothing). Just the one call the test makes.
declare module 'node:fs' {
  export function readFileSync(path: string | URL, encoding: 'utf8'): string
  // The manifest test checks that every icon the manifest names is really in
  // public/ — a missing one degrades Add-to-Home-Screen silently.
  export function existsSync(path: string | URL): boolean
  // The ui-blocks export test rewrites services/core/app/ui_blocks.json when
  // UPDATE_UI_BLOCKS=1 (S54a T11).
  export function writeFileSync(path: string | URL, data: string, encoding: 'utf8'): void
}

// Test-only: the env var that tells the ui-blocks export test to rewrite the
// committed catalog instead of diffing it (S54a T11).
declare const process: { env: Record<string, string | undefined> }
