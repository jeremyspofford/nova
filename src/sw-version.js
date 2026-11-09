// The service worker's cache name (ui/sw.js, VERSION) is a content hash of what it serves: the worker
// itself and every file in its SHELL list. The server works it out when it starts and writes it into
// /sw.js in place of SHELL_HASH, so nobody bumps a number by hand. When any of those files changes,
// even in a local checkout, the name changes, the browser installs the new worker, and its activate
// step deletes the old cache. When nothing changed, restarts give the same name and nothing is
// reinstalled. The worker's own text is in the hash so a change to what it never keeps (its NEVER
// list) also retires the old cache, as a manual bump used to.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const SHELL_HASH = '__SHELL_HASH__';

// The paths in sw.js's `const SHELL = [...]`.
export function shellPaths(sw) {
  const list = /const SHELL = \[([\s\S]*?)\];/.exec(sw);
  if (!list) throw new Error('ui/sw.js has no SHELL list');
  return [...list[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

// '/' is the app page, which the server answers with ui/index.html.
const fileFor = (ui, path) => join(ui, path === '/' ? 'index.html' : path.slice(1));

// 12 hex characters of a SHA-256 over sw.js and each SHELL file, each with its path and length so
// that moving bytes between files changes it too. A missing file is hashed as missing: the worker's
// install would fail on it, which is the bug to fix, not a reason for the server not to start.
export function shellHash(ui) {
  const sw = readFileSync(join(ui, 'sw.js'));
  const h = createHash('sha256');
  h.update(`/sw.js\0${sw.length}\0`).update(sw);
  for (const path of shellPaths(sw.toString('utf8'))) {
    let body = null;
    try { body = readFileSync(fileFor(ui, path)); } catch { /* hashed as missing */ }
    h.update(body ? `\0${path}\0${body.length}\0` : `\0${path}\0missing\0`);
    if (body) h.update(body);
  }
  return h.digest('hex').slice(0, 12);
}

// sw.js as served: SHELL_HASH replaced by `hash` (tests/sw-version.test.js checks it is there).
export const withShellHash = (sw, hash) => sw.replaceAll(SHELL_HASH, hash);
