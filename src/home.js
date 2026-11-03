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

// Folders in the home that hold secrets: the vault (and its key file), the mesh's device and
// identity keys, and Era 2's connection secrets. No file tool reads or writes them and no helper
// is handed them; they are also untracked (UNTRACKED) and not journalled (mesh/sync.ts).
// broker/ is the Credential Broker's store (src/broker): ciphertext, its header and, without a
// keychain, its device key. No file tool reads it.
export const SECRET_DIRS = ['vault', 'mesh', 'connectors', 'broker'];
export const inSecretDir = (rel) => SECRET_DIRS.find((d) => rel === d || rel.startsWith(`${d}/`) || rel.startsWith(`${d}\\`)) ?? null;

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
// mesh/ holds this node's private keys (0600 on disk); git would keep a copy anyone who can read
// the folder could read, for good. vault/ holds connection secrets (encrypted) and, without a
// system keychain, their key: a copy in history would outlive revoking them.
const UNTRACKED = ['MEMORY.md', 'memory/*.md', '!memory/README.md', 'memory/.rendered.json', 'skills/', 'connectors/', 'nova.db*', 'logs/', 'backups/', 'extensions/', 'exports/', 'kept/', 'workers/', 'mesh/', 'vault/', 'broker/', 'nova.pid',
  // Checkpoints hold the identity and the vault key; the home's mark holds the key that seals a
  // factory reset (M7 amendment). A reset's marker and report are this machine's alone too.
  'checkpoints/', '.nova-home', '.nova-home.tmp', 'factory-reset.json*', 'reset-report.json'];

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

// Whether any commit (or the reflog) still holds this node's current private key: homes from
// before mesh/ was untracked committed it with everything else. Keys replaced since (README) are
// in the history too, but no longer open anything, so only the current one counts.
export async function keysInHistory(home) {
  if (!existsSync(join(home, '.git'))) return false;
  let key = null;
  try { key = JSON.parse(readFileSync(join(home, 'mesh', 'identity.json'), 'utf8')).ed25519?.private ?? null; } catch { /* no identity yet */ }
  const out = await git(home, 'log', '--all', '--reflog', '-p', '--format=', '--', 'mesh/identity.json');
  if (!out?.trim()) return false;
  // An identity file Nova can't read: be safe and say it was exposed.
  return key ? out.includes(key) : true;
}

export const KEYS_IN_HISTORY = 'This Nova’s private keys (mesh/identity.json) were saved in its home folder’s git history before Nova kept them out of it. Anyone who can read that folder’s .git can read them, so treat them as exposed. New commits leave them out; old ones still have them. Replace the keys: the README’s “If the hub’s keys were exposed” says how, and which devices to add again.';

// `problem`: told, in plain words, when the history already holds this node's keys. It is said
// at every start until the keys are replaced. `resolved`: told when it no longer does, so the
// warning closes by itself once the keys are new.

// Whether a Nova server is running this home right now (its nova.pid names a live process).
export function runningPid(home) {
  let pid = 0;
  try { pid = Number(readFileSync(join(home, 'nova.pid'), 'utf8')); } catch { return null; }
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try { process.kill(pid, 0); return pid; } catch (e) { return e.code === 'EPERM' ? pid : null; }
}
export async function ensureGit(home, o = {}) {
  const changed = ignorePrivate(home);
  if (existsSync(join(home, '.git'))) {
    // A home from before these were untracked: stop tracking them from here on. mesh/ is checked
    // every time, not only when .gitignore changed, since its keys must never be committed again.
    const meshTracked = !!(await git(home, 'ls-files', '--', 'mesh', 'vault'))?.trim();
    if (changed || meshTracked) {
      await git(home, 'rm', '-r', '-q', '--cached', '--ignore-unmatch', 'MEMORY.md', 'memory', 'skills', 'connectors', 'mesh', 'vault');
      await git(home, 'add', '-A');
      await commit(home, 'Nova: memory, skills, connections and keys kept out of history');
    }
    if (await keysInHistory(home)) o.problem?.(KEYS_IN_HISTORY);
    else o.resolved?.(KEYS_IN_HISTORY);
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
