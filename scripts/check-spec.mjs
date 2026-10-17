#!/usr/bin/env node
// Spec consistency check (docs/03, docs/17, tests/manifest.md, contracts/schemas, links, names).
// Usage: node scripts/check-spec.mjs   — exits non-zero on any failure.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const errors = [];
const fail = (msg) => errors.push(msg);

// 1. FR set: docs/03 defines; docs/17 index places each exactly once; manifest has one row each.
const frDefs = new Map(); // id -> milestone
for (const line of read('docs/03-functional-requirements.md').split('\n')) {
  const m = line.match(/^\| (FR-\d{3}) \| (P\d) \| ([^|]+?) \|/);
  if (!m) continue;
  if (frDefs.has(m[1])) fail(`docs/03: ${m[1]} defined twice`);
  frDefs.set(m[1], m[3].trim());
}
if (frDefs.size === 0) fail('docs/03: no FR rows found');

const indexPlacement = new Map(); // id -> [milestones]
const roadmap = read('docs/17-roadmap-and-milestones.md');
const indexStart = roadmap.indexOf('## Requirement → milestone index');
if (indexStart < 0) fail('docs/17: missing "Requirement → milestone index"');
const indexEnd = roadmap.indexOf('\n---', indexStart);
for (const line of roadmap.slice(indexStart, indexEnd < 0 ? undefined : indexEnd).split('\n')) {
  const m = line.match(/^\| ([^|]+?) \| ([^|]*FR-[^|]*) \|$/);
  if (!m) continue;
  const ms = m[1].replace(/\s*\(.*\)\s*$/, '').trim();
  for (const id of m[2].match(/FR-\d{3}/g) ?? []) {
    indexPlacement.set(id, [...(indexPlacement.get(id) ?? []), ms]);
  }
}
for (const [id, ms] of frDefs) {
  const placed = indexPlacement.get(id) ?? [];
  if (placed.length === 0) fail(`docs/17: ${id} missing from the milestone index`);
  else if (placed.length > 1) fail(`docs/17: ${id} placed in ${placed.join(', ')}`);
  else if (placed[0] !== ms)
    fail(`docs/17: ${id} indexed under ${placed[0]} but docs/03 says ${ms}`);
}
for (const id of indexPlacement.keys())
  if (!frDefs.has(id)) fail(`docs/17: ${id} not defined in docs/03`);

const manifestRows = new Map();
for (const line of read('tests/manifest.md').split('\n')) {
  const m = line.match(/^\| (FR-\d{3}) \|/);
  if (m) manifestRows.set(m[1], (manifestRows.get(m[1]) ?? 0) + 1);
}
for (const id of frDefs.keys()) {
  const n = manifestRows.get(id) ?? 0;
  if (n !== 1) fail(`tests/manifest.md: ${id} has ${n} rows (expected 1)`);
}
for (const id of manifestRows.keys())
  if (!frDefs.has(id)) fail(`tests/manifest.md: ${id} not defined in docs/03`);

// 2. JSON schemas parse.
const schemaDir = 'contracts/schemas';
for (const f of readdirSync(join(root, schemaDir)).filter((f) => f.endsWith('.json'))) {
  try {
    const s = JSON.parse(read(`${schemaDir}/${f}`));
    if (!s.$schema) fail(`${schemaDir}/${f}: missing $schema`);
  } catch (e) {
    fail(`${schemaDir}/${f}: ${e.message}`);
  }
}

// 3. Internal Markdown links resolve.
const mdFiles = [];
const walk = (dir) => {
  for (const name of readdirSync(join(root, dir))) {
    if (['node_modules', '.git', 'build', 'dist', 'private', '.claude', '.turbo'].includes(name))
      continue;
    const rel = dir === '.' ? name : `${dir}/${name}`;
    const st = statSync(join(root, rel));
    if (st.isDirectory()) walk(rel);
    else if (name.endsWith('.md')) mdFiles.push(rel);
  }
};
walk('.');
for (const file of mdFiles) {
  const text = read(file).replace(/```[\s\S]*?```/g, '');
  for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = m[1];
    if (/^(https?:|mailto:|#|nova:)/.test(target)) continue;
    const path = target.split('#')[0];
    if (!path) continue;
    const abs = resolve(root, dirname(file), path);
    if (!existsSync(abs)) fail(`${file}: broken link ${target}`);
  }
}

// 4. Reference-app names must not appear in the spec (docs/external is the evidence zone).
const banned = loadBannedNames();
for (const file of mdFiles.filter((f) => !f.startsWith('docs/external/'))) {
  const text = read(file);
  for (const name of banned) {
    // Proper nouns: match case-sensitively so ordinary words ("cursor") do not trip the check.
    const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    if (re.test(text)) fail(`${relative(root, join(root, file))}: reference-app name "${name}"`);
  }
}

function loadBannedNames() {
  // Reference-app identities are private (docs/19 §1.3), so their names are not committed.
  // They are read from docs/external/private/banned-names.txt (one name per line), looked up
  // in this checkout and then in the main checkout of a git worktree. The ambient-capture app
  // is named openly in docs/external, so it is listed here. SPEC_BANNED_NAMES adds more.
  const names = ['screenpipe', 'Screenpipe', 'screenpi.pe'];
  const candidates = [join(root, 'docs/external/private/banned-names.txt')];
  try {
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: root })
      .toString()
      .trim();
    candidates.push(join(resolve(root, common), '..', 'docs/external/private/banned-names.txt'));
  } catch {
    // not a git checkout
  }
  const file = candidates.find((c) => existsSync(c));
  if (file) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const name = line.replace(/#.*/, '').trim();
      if (name) names.push(name);
    }
  }
  for (const n of (process.env.SPEC_BANNED_NAMES ?? '').split(','))
    if (n.trim()) names.push(n.trim());
  return names;
}

if (errors.length) {
  console.error(`check-spec: ${errors.length} problem(s)`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`check-spec: ok (${frDefs.size} FRs, ${mdFiles.length} markdown files)`);
