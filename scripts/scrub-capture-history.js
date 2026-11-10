// Removes what Nova captured (capture/) from the home's git history, deliberately, when the person
// runs it (the README's "Captured originals in old history"; owner ruling 2026-11-10: never
// automatic). It says what it will do and asks first, then says what it removed.
// Stop Nova first, then: node scripts/scrub-capture-history.js [home] [--yes]
//   (default home: NOVA_HOME, or ~/Nova. --yes skips the question, for someone who has read it.)
import { createInterface } from 'node:readline/promises';
import { loadConfig } from '../src/config.js';
import { captureInHistory, runningPid, scrubCaptureHistory } from '../src/home.js';

const args = process.argv.slice(2);
const yes = args.includes('--yes');
const home = args.find((a) => !a.startsWith('--')) ?? loadConfig().home;

const running = runningPid(home);
if (running) {
  console.error(`Nova is running this home (pid ${running}). Stop it first, then run this again. Nothing was changed.`);
  process.exit(1);
}
const found = await captureInHistory(home);
if (!found.commits) {
  console.log(`The history of ${home} holds nothing Nova captured. Nothing to do.`);
  process.exit(0);
}
console.log(`The history of ${home} still holds ${found.paths.length} captured ${found.paths.length === 1 ? 'file' : 'files'}, in ${found.commits} ${found.commits === 1 ? 'commit' : 'commits'}, saved before Nova kept capture out of it.

This will:
  - rewrite every commit in the home's history so none holds anything under capture/;
  - then delete git's own old copies (the history before the rewrite, the reflog), so they can't be got back.

It can't be undone. Your files on disk, including what Nova keeps under capture/ now, are not touched.
A copy of this home's .git made elsewhere (a clone, a backup of the folder) still holds them: delete
or replace those copies yourself.`);
if (!yes) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question('\nType "remove" to go ahead, anything else to stop: ')).trim();
  rl.close();
  if (answer !== 'remove') {
    console.log('Stopped. Nothing was changed.');
    process.exit(0);
  }
}
try {
  const r = await scrubCaptureHistory(home);
  console.log(`Removed ${r.paths.length} captured ${r.paths.length === 1 ? 'file' : 'files'} from the history (${r.paths.length === 1 ? 'it was' : 'they were'} in ${r.commits} ${r.commits === 1 ? 'commit' : 'commits'}):`);
  for (const p of r.paths.slice(0, 50)) console.log(`  - ${p}`);
  if (r.paths.length > 50) console.log(`  … and ${r.paths.length - 50} more`);
  console.log('The history no longer holds anything Nova captured. Start Nova again as usual.');
} catch (e) {
  console.error(`The history wasn't fully cleaned: ${e.message}`);
  process.exit(1);
}
