#!/usr/bin/env node
// npm run dev:follow: run the hot-reload dev server and keep this checkout
// fast-forwarded to its upstream branch, so pushed changes appear on their own.
// It never merges, rebases or touches local edits: if the tree is dirty or the
// branch has diverged, it says so and waits.
import { spawn, execFileSync } from 'node:child_process';

const every = Number(process.env.FOLLOW_SECONDS ?? 5) * 1000;
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
const upstream = (() => { try { return git('rev-parse', '--abbrev-ref', '@{u}'); } catch { return null; } })();
if (!upstream) {
  console.error(`dev:follow: ${branch} has no upstream. Run: git branch --set-upstream-to=origin/${branch}`);
  process.exit(1);
}
const [remote, ...rest] = upstream.split('/');
const remoteBranch = rest.join('/');

const server = spawn('npm', ['run', 'dev'], { stdio: 'inherit' });
server.on('exit', (code) => process.exit(code ?? 0));
process.on('SIGINT', () => server.kill('SIGINT'));

let warned = '';
const say = (msg) => { if (msg !== warned) { console.log(`dev:follow: ${msg}`); warned = msg; } };

function tick() {
  try {
    git('fetch', '--quiet', remote, remoteBranch);
    const behind = Number(git('rev-list', '--count', `HEAD..${upstream}`));
    if (!behind) return;
    if (git('status', '--porcelain', '--untracked-files=no')) return say('local edits present; not pulling until they are committed or stashed.');
    if (Number(git('rev-list', '--count', `${upstream}..HEAD`))) return say(`${branch} has diverged from ${upstream}; not pulling.`);
    const before = git('rev-parse', '--short', 'HEAD');
    git('merge', '--ff-only', '--quiet', upstream);
    const lockChanged = git('diff', '--name-only', before, 'HEAD').split('\n').some((f) => f === 'package-lock.json' || f === 'package.json');
    console.log(`dev:follow: pulled ${behind} commit${behind === 1 ? '' : 's'} (${before} → ${git('rev-parse', '--short', 'HEAD')})`);
    if (lockChanged) console.log('dev:follow: dependencies changed; run npm install when convenient.');
    warned = '';
  } catch (e) {
    say(`couldn't check ${upstream}: ${e.message.split('\n')[0]}`);
  }
}
setInterval(tick, every);
tick();
