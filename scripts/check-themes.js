#!/usr/bin/env node
// Design-system package checks (DESIGN-SYSTEM §2 and §4, M3 §1): every package in
// design-systems/ is complete, every value has the right syntax for its token family, the
// contrast pairs pass in each mode, reduced motion is honoured, the orb's seven states are all
// there and no more, each different in more than colour with stopped unmistakable (DESIGN-SYSTEM
// §1), content rules only tighten, extras are declared, and the iPhone status bar is declared
// (§5). The checks themselves live in src/core/design.ts, so this script, the API's validate
// route and apply all say the same thing, with one difference: here, a package that doesn't
// declare ios_status_bar fails. Nova still applies such a package (iOS's own strip, the safe
// default: an older or hand-made package keeps working), but every package authored against
// this gate says what it wants. (A package without the orb's states fails everywhere.)
// The designed scales (DESIGN-SYSTEM §0, §2.1) are warnings at runtime, so any package still
// applies; here a package at the bar (AT_THE_BAR, the lead first) fails when it leaves them, and
// every other package is listed as not yet at the bar, with what keeps it off.
// Usage: node scripts/check-themes.js [design-systems/x.json ...]
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { AT_THE_BAR, BUILTIN_DIR, LEAD_DESIGN_SYSTEM, ORB_STATES, contrast, iosStatusBar, packageScaleFindings, validatePackage } from '../src/core/index.ts';

export { contrast };

// Where a package stands against the design bar: at it, or not yet and why. A package named at
// the bar that leaves the scales is a problem.
export function barCheck(pkg) {
  const findings = packageScaleFindings(pkg ?? {});
  const named = AT_THE_BAR.includes(pkg?.id);
  return { named, at: named && findings.length === 0, findings, problems: named ? findings.map((f) => `At the design bar, so on the designed scales: ${f}`) : [] };
}

export function checkPackage(pkg) {
  const v = validatePackage(pkg);
  const bar = barCheck(pkg);
  if (bar.problems.length) return { ...v, ok: false, problems: [...v.problems, ...bar.problems] };
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
      const bar = barCheck(pkg);
      const where = bar.at ? `at the design bar${pkg.id === LEAD_DESIGN_SYSTEM ? ' (the lead)' : ''}` : `not yet at the design bar (${bar.findings.length} off the scales${bar.named ? '' : ', and not yet approved'})`;
      console.log(`✓ ${basename(f)} (${pkg.name}): complete, values well-formed, contrast passes${modes.length ? ` in default and ${modes.join(', ')} modes` : ''}, reduced motion honoured, the orb’s ${ORB_STATES.length} states distinct in more than colour, ${statusBarLine(pkg)}; ${where}`);
      if (process.env.NOVA_BAR_DETAIL) for (const x of bar.findings) console.log(`    · ${x}`);
    }
  }
  if (!files.length) { console.log('✗ no design-system packages found'); process.exit(1); }
  if (!process.argv.slice(2).length) {
    const ids = files.map((f) => { try { return JSON.parse(readFileSync(f, 'utf8')).id; } catch { return null; } });
    for (const id of AT_THE_BAR) if (!ids.includes(id)) { failed++; console.log(`✗ ${id} is named at the design bar, but there is no such package`); }
  }
  process.exit(failed ? 1 : 0);
}
