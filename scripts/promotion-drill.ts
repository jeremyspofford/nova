#!/usr/bin/env node
// The promotion drill (M10g, docs/plans/M10g.md §6), runnable: two Nova homes in temp folders on this
// machine, real processes on loopback, a stand-in computer and phone, a stand-in stable name and a
// backup folder. Nothing outside the temp folders is touched. It runs the same cases as
// tests/acceptance/m10g-drill.test.ts and prints its record; with --record <file> it also writes the
// record there as Markdown (the gate evidence keeps one).
//
//   node scripts/promotion-drill.ts [--record <file>]
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const i = process.argv.indexOf('--record');
const out = i > 0 ? process.argv[i + 1] : null;
// Its own temp folder, removed after, as the test runner does (scripts/test.sh).
const tmp = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'nova-promotion-drill-'));
process.env.TMPDIR = tmp;
const { runDrill } = await import('../tests/acceptance/m10g-drill.ts');
const lines: string[] = [];
const started = new Date();
let code = 0;
try {
  const r = await runDrill({ say: (l) => { lines.push(l); console.log(l); } });
  const md = [
    `# Promotion drill run`,
    '',
    `Run ${started.toISOString()} on ${process.platform} (Node ${process.versions.node}), in ${r.seconds} s. Every case asserts as it runs: this record exists only if each one held.`,
    '',
    ...r.steps.flatMap((s) => [`**Case ${s.case}.** ${s.what} (${(s.ms / 1000).toFixed(1)} s)`, ...s.facts.map((f) => `- ${f}`), '']),
    `**Write probe:** ${r.probes.ticks} ticks; N1 took a change in ${r.probes.n1}, N2 in ${r.probes.n2}, both in the same tick in ${r.probes.both}.`,
    '',
    `**Key files** (SHA-256 before and after): ${Object.entries(r.keys.files).map(([k, v]) => `${k} ${v.before.slice(0, 16)}… → ${v.after.slice(0, 16)}…`).join('; ')}. Scanned ${r.keys.scanned.files} files (${Math.round(r.keys.scanned.bytes / 1024)} KB) and ${r.keys.scanned.tapped} tapped messages; private keys found outside their own key file: ${r.keys.found.length}.`,
    '',
  ].join('\n');
  if (out) writeFileSync(out, md);
  console.log(out ? `\nRecorded in ${out}.` : '\nThe drill passed.');
} catch (e) {
  console.error(`\nThe drill failed: ${(e as Error).stack ?? e}`);
  code = 1;
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
process.exit(code);
