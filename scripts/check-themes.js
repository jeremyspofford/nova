#!/usr/bin/env node
// Design-system package checks (DESIGN-SYSTEM §2 and §4, M3 §1): every package in
// design-systems/ is complete, every value has the right syntax for its token family, the
// contrast pairs pass in each mode, reduced motion is honoured, the orb's seven states are all
// there and no more, each different in more than colour with stopped unmistakable (DESIGN-SYSTEM
// §1), content rules only tighten, and extras are declared. The checks themselves live in
// src/core/design.ts, so this script, the API's validate route and apply all say the same thing.
// Usage: node scripts/check-themes.js [design-systems/x.json ...]
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { BUILTIN_DIR, ORB_STATES, contrast, validatePackage } from '../src/core/index.ts';

export { contrast };

export function checkPackage(pkg) {
  return validatePackage(pkg);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = process.argv.slice(2).length
    ? process.argv.slice(2)
    : readdirSync(BUILTIN_DIR).filter((f) => f.endsWith('.json')).sort().map((f) => join(BUILTIN_DIR, f));
  let failed = 0;
  for (const f of files) {
    let pkg;
    try { pkg = JSON.parse(readFileSync(f, 'utf8')); } catch (e) {
      failed++;
      console.log(`✗ ${relative('.', f)}: not valid JSON (${e.message})`);
      continue;
    }
    const { problems } = checkPackage(pkg);
    const modes = Object.keys(pkg.modes ?? {});
    if (problems.length) {
      failed++;
      console.log(`✗ ${basename(f)} (${pkg.name ?? '?'})`);
      for (const p of problems) console.log(`    ${p}`);
    } else {
      console.log(`✓ ${basename(f)} (${pkg.name}): complete, values well-formed, contrast passes${modes.length ? ` in default and ${modes.join(', ')} modes` : ''}, reduced motion honoured, the orb’s ${ORB_STATES.length} states distinct in more than colour`);
    }
  }
  if (!files.length) { console.log('✗ no design-system packages found'); process.exit(1); }
  process.exit(failed ? 1 : 0);
}
