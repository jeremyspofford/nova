// The accessibility advisory (UX review 1, F5): axe's default rules over every view at the
// review's ten postures, against a seeded Nova, reported per rule and per view. It is advisory:
// it prints, writes the job summary ($GITHUB_STEP_SUMMARY) and a JSON record ($NOVA_AXE_OUT), and
// always exits 0, so regrowth shows on the PR without ever failing the build or the gate.
//   node tests/ui/axe-advisory.ts                 the whole sweep
//   NOVA_AXE_POSTURES=laptop-1366,iphone node …    some postures
import { appendFileSync, writeFileSync } from 'node:fs';
import { stop } from '../acceptance/support.ts';
import { browser } from './support.ts';
import { POSTURES, markdown, reviewProfile, sweep, tally } from './axe-support.ts';

async function main() {
  const b = await browser();
  if (typeof b === 'string') { console.log(`axe advisory: no browser (${b}); nothing checked.`); return; }
  const { m, nova } = await reviewProfile('nova-axe-');
  try {
    const postures = process.env.NOVA_AXE_POSTURES ? process.env.NOVA_AXE_POSTURES.split(',').filter((p) => p in POSTURES) : undefined;
    const results = await sweep(b, m.base, postures ? { postures } : {});
    const md = markdown(results);
    console.log(md);
    const { total, byRule, byView } = tally(results);
    console.log(JSON.stringify({ total, byRule, byView }));
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
    if (process.env.NOVA_AXE_OUT) writeFileSync(process.env.NOVA_AXE_OUT, JSON.stringify(results, null, 1));
  } finally {
    await b.close();
    await stop(nova);
  }
}

// Advisory: whatever happens, the step passes; a failure to run says so in the log and summary.
try { await main(); } catch (e) {
  const why = `axe advisory couldn’t run: ${(e as Error).message}`;
  console.log(why);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Accessibility (advisory)\n\n${why}\n`);
}
process.exit(0);
