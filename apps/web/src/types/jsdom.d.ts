// The one shape src/test-setup.ts needs from jsdom (a vitest environment
// dependency, not an app dependency), so tsc can check the setup file without
// pulling @types/jsdom in for a single constructor.
declare module 'jsdom' {
  export class JSDOM {
    constructor(html?: string, options?: { url?: string })
    readonly window: { localStorage: Storage }
  }
}
