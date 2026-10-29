// Nova's home: the standing files, memory, workspace and session logs.
// Seeded from templates/home on first run. Seeding never overwrites a file.
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join, resolve, sep } from 'node:path';

// Read into every conversation, in this order.
export const STANDING_FILES = ['AGENTS.md', 'SOUL.md', 'IDENTITY.md', 'USER.md', 'MEMORY.md'];

export function seedHome(home, templates) {
  const created = [];
  const walk = (rel) => {
    for (const name of readdirSync(join(templates, rel))) {
      const r = join(rel, name);
      const src = join(templates, r);
      const dst = join(home, r);
      if (statSync(src).isDirectory()) { mkdirSync(dst, { recursive: true }); walk(r); }
      else if (!existsSync(dst)) { cpSync(src, dst); created.push(r); }
    }
  };
  mkdirSync(home, { recursive: true });
  walk('.');
  for (const d of ['memory', 'workspace', 'sessions']) mkdirSync(join(home, d), { recursive: true });
  return created;
}

export function readStanding(home) {
  return STANDING_FILES.map((name) => {
    const p = join(home, name);
    return { name, text: existsSync(p) ? readFileSync(p, 'utf8').trim() : '' };
  });
}

// Resolve a tool path inside home. "~/x" and "x" both mean home/x.
export function inHome(home, p) {
  const rel = String(p ?? '').replace(/^~\/?/, '');
  const abs = resolve(home, rel);
  const root = resolve(home);
  if (abs !== root && !abs.startsWith(root + sep)) throw new Error(`${p} is outside Nova's home`);
  return abs;
}

// Git history is the audit trail: the home is a local repository, and every
// finished turn is a commit. Best-effort: Nova works without git installed.
// Memory, skills and connection secrets stay out of it, so forgetting a
// memory or removing a skill leaves no copy behind in old commits.
const git = (home, ...args) => new Promise((ok) => {
  execFile('git', ['-C', home, ...args], { timeout: 15_000 }, (err, stdout) => ok(err ? null : stdout));
});

// The core's database, logs and backups, and extension data, are runtime state, not history.
const UNTRACKED = ['MEMORY.md', 'memory/*.md', '!memory/README.md', 'memory/.rendered.json', 'skills/', 'connectors/', 'nova.db*', 'logs/', 'backups/', 'extensions/', 'exports/', 'kept/', 'workers/'];

function ignorePrivate(home) {
  const path = join(home, '.gitignore');
  const have = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const missing = UNTRACKED.filter((l) => !have.split('\n').includes(l));
  if (!missing.length) return false;
  const head = have.includes('# Nova:') ? '' : '# Nova: kept out of history, so forgetting and removing are final.\n';
  appendFileSync(path, `${have && !have.endsWith('\n') ? '\n' : ''}${head}${missing.join('\n')}\n`);
  return true;
}

const commit = (home, message) => git(home, '-c', 'user.name=Nova', '-c', 'user.email=nova@localhost', 'commit', '-q', '-m', message);

export async function ensureGit(home) {
  const changed = ignorePrivate(home);
  if (existsSync(join(home, '.git'))) {
    // A home from before these were untracked: stop tracking them from here on.
    if (changed) {
      await git(home, 'rm', '-r', '-q', '--cached', '--ignore-unmatch', 'MEMORY.md', 'memory', 'skills', 'connectors');
      await git(home, 'add', '-A');
      await commit(home, 'Nova: memory, skills and connections kept out of history');
    }
    return true;
  }
  if ((await git(home, 'init', '-q')) === null) return false;
  await git(home, 'add', '-A');
  await commit(home, 'Nova: home seeded');
  return true;
}

let queue = Promise.resolve();
export function commitHome(home, message) {
  queue = queue.then(async () => {
    if (!existsSync(join(home, '.git'))) return;
    await git(home, 'add', '-A');
    await commit(home, message);
  });
  return queue;
}
