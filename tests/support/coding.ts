// Throwaway repositories for the coding-through-chat tests (M10c). Everything is made under a new
// mkdtemp folder in the system's temp folder: a small project as the person's repository (with its
// branch checked out), and a bare repository beside it as its "remote" (made by cloning, so nothing
// is ever pushed). No test touches this checkout, any other one, or a real remote. The names in them
// are placeholders.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

export const ROOT = join(import.meta.dirname, '..', '..');
export const FAKE_CLAUDE = join(ROOT, 'scripts/stand-ins/fake-claude.js');
export const FAKE_CODEX = join(ROOT, 'scripts/stand-ins/fake-codex.js');

// The project: greet() is wrong, and its test says so; server.mjs serves it (the preview).
export const APP = "export const greet = (name) => `Hi ${name}`;\n";
export const APP_FIXED = "export const greet = (name) => `Hello, ${name}!`;\n";
export const APP_TEST = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { greet } from './app.mjs';\n\ntest('greets', () => assert.equal(greet('Sam'), 'Hello, Sam!'));\n";
export const SERVER = "import { createServer } from 'node:http';\nimport { greet } from './app.mjs';\nconst host = process.env.HOST || '127.0.0.1';\ncreateServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(greet('preview')); }).listen(Number(process.env.PORT), host);\n";

// Test-side git: none of the person's or this machine's settings, a placeholder identity.
export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Example Person', '-c', 'user.email=person@example.com', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgSign=false', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: cwd, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LC_ALL: 'C' },
  }).trim();
}

export interface Repos { dir: string; person: string; remote: string }

export function makeRepos(prefix = 'nova-coding-'): Repos {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const person = join(dir, 'project');
  mkdirSync(person);
  git(person, 'init', '--quiet', '-b', 'main');
  writeFileSync(join(person, 'app.mjs'), APP);
  writeFileSync(join(person, 'app.test.mjs'), APP_TEST);
  writeFileSync(join(person, 'server.mjs'), SERVER);
  writeFileSync(join(person, 'README.md'), '# Example project\n');
  git(person, 'add', '--all');
  git(person, 'commit', '--quiet', '-m', 'An example project');
  const remote = join(dir, 'remote.git');
  git(dir, 'clone', '--quiet', '--bare', '--no-hardlinks', person, remote);
  git(person, 'remote', 'add', 'origin', remote);
  git(person, 'fetch', '--quiet', 'origin');
  return { dir, person, remote };
}

// Every entry under a folder, .git and all, by path, type, mode and bytes (links by target): equal
// means byte-identical.
export function treeHash(root: string): string {
  const h = createHash('sha256');
  const go = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const abs = join(d, name);
      const st = lstatSync(abs);
      const rel = relative(root, abs);
      if (st.isDirectory()) { h.update(`d ${rel} ${st.mode}\n`); go(abs); }
      else if (st.isSymbolicLink()) h.update(`l ${rel} ${readlinkSync(abs)}\n`);
      else h.update(`f ${rel} ${st.mode} ${createHash('sha256').update(readFileSync(abs)).digest('hex')}\n`);
    }
  };
  go(root);
  return h.digest('hex');
}

// Scripts for the stand-in agents (scripts/stand-ins/script.js).
export function agentScript(kind: 'fix' | 'wrong' | 'tests' | 'gitdir' | 'link' | 'nothing' | 'readme', dir: string): string {
  const s = {
    fix: { steps: [{ say: 'Reading the test.' }, { read: 'app.test.mjs' }, { edit: { path: 'app.mjs', old: '`Hi ${name}`', new: '`Hello, ${name}!`' } }], result: 'greet() now says Hello, with the name and an exclamation mark.' },
    wrong: { steps: [{ edit: { path: 'app.mjs', old: '`Hi ${name}`', new: '`Hey ${name}`' } }], result: 'Fixed greet().' },
    tests: { steps: [{ edit: { path: 'app.test.mjs', old: "'Hello, Sam!'", new: "'Hi Sam'" } }], result: 'The test passes now.' },
    gitdir: { steps: [{ edit: { path: 'app.mjs', old: '`Hi ${name}`', new: '`Hello, ${name}!`' } }, { write: { path: '.git/hooks/post-commit', content: '#!/bin/sh\necho planted\n' } }], result: 'Fixed it.' },
    link: { steps: [{ edit: { path: 'app.mjs', old: '`Hi ${name}`', new: '`Hello, ${name}!`' } }, { run: 'ln -s /etc/hostname leak' }], result: 'Fixed it.' },
    nothing: { steps: [{ say: 'Looks fine.' }], result: 'Fixed greet() and the test passes.' },
    readme: { steps: [{ edit: { path: 'README.md', old: '# Example project', new: '# Example project\n\nA second line.' } }], result: 'Added a line to the README.' },
  }[kind];
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${kind}-${Math.random().toString(36).slice(2, 8)}.json`);
  writeFileSync(file, JSON.stringify(s));
  return file;
}
