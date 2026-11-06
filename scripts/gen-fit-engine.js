#!/usr/bin/env node
// The fit engine for the browser: src/core/models/fit.ts with its types erased, nothing else.
// The Models screen's styleguide composition runs the real engine, so its verdicts and numbers are
// the engine's own and recompute live as quant and context change. fit.ts is pure and imports only
// types, so erasing them leaves a module a browser can load. Never edit ui/js/fit-engine.js by hand:
// run this, and tests/fit-engine-copy.test.js fails whenever the copy and fit.ts drift apart.
// Usage: node scripts/gen-fit-engine.js
import { readFileSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

export const SOURCE = 'src/core/models/fit.ts';
export const TARGET = 'ui/js/fit-engine.js';
const HEADER = `// GENERATED from ${SOURCE} by scripts/gen-fit-engine.js: its types erased, nothing else.\n// Do not edit; change fit.ts and run the script (tests/fit-engine-copy.test.js checks they match).\n`;

export const engineModule = (ts = readFileSync(SOURCE, 'utf8')) => HEADER + stripTypeScriptTypes(ts, { mode: 'strip' });

if (import.meta.url === `file://${process.argv[1]}`) {
  writeFileSync(TARGET, engineModule());
  console.log(`wrote ${TARGET}`);
}
