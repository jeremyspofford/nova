#!/usr/bin/env node
// Design-system package checks (DESIGN-SYSTEM §2 and §4, M3 §1): every package in
// design-systems/ is complete, every value has the right syntax for its token family, the
// contrast pairs pass in each mode, reduced motion is honoured, content rules only tighten, and
// extras are declared, and the iPhone status bar is declared (§5). The checks themselves live in
// src/core/design.ts, so this script, the API's validate route and apply all say the same thing,
// with one difference: here, a package that doesn't declare ios_status_bar fails. Nova still
// applies such a package (iOS's own strip, the safe default: an older or hand-made package keeps
// working), but every package authored against this gate says what it wants.
// Usage: node scripts/check-themes.js [design-systems/x.json ...]
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { BUILTIN_DIR, contrast, iosStatusBar, validatePackage } from '../src/core/index.ts';

export { contrast };

export function checkPackage(pkg) {
  const v = validatePackage(pkg);
  if (pkg && typeof pkg === 'object' && pkg.ios_status_bar === undefined) {
    const problems = [...v.problems, 'ios_status_bar must be declared: translucent (a dark design draws behind the iPhone status bar), default (iOS keeps its own strip), or { light, dark } for a package with both looks.'];
    return { ok: false, problems, warnings: v.warnings.filter((w) => !w.startsWith('ios_status_bar isn’t declared')) };
  }
  return v;
}

// What the installed iPhone app's status bar is, in words for the check's line.
export function statusBarLine(pkg) {
  const b = iosStatusBar(pkg);
  return b.light === b.dark ? `iPhone status bar ${b.light}` : `iPhone status bar ${b.light} when light, ${b.dark} when dark`;
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
      console.log(`✓ ${basename(f)} (${pkg.name}): complete, values well-formed, contrast passes${modes.length ? ` in default and ${modes.join(', ')} modes` : ''}, reduced motion honoured, ${statusBarLine(pkg)}`);
    }
  }
  if (!files.length) { console.log('✗ no design-system packages found'); process.exit(1); }
  process.exit(failed ? 1 : 0);
}
