// Measures how long each UI test file takes in CI and writes scripts/ui-timings.json, which
// scripts/ui-shard.js reads to balance the UI gate's shards. CI only ever reads the committed JSON, so
// every shard of a run deals the same files from the same numbers; nothing is fetched mid-run.
//
// Source: the UI-gate job logs of the last N successful pushes to main (GitHub API). Node's spec
// reporter prints no file names, so each top-level `✔ title (NNNms)` line is matched to the test file
// whose test() title fits it (template ${…} parts match anything), in the order the files ran (sorted,
// one at a time). A file's time is wall clock, from the previous file's last result to its own last
// result, so process start, browser launch and hooks count too. A run is used only if its shards
// account for every UI file exactly once and their sums match the runner's own duration_ms.
// Each file's number is the median over the runs; the accessibility advisory's step time likewise.
//
// Usage: npm run ui:timings [-- --runs 10 --cache DIR]
// Token: $GITHUB_TOKEN or $GH_TOKEN, else `git credential fill` for github.com. Never printed.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const OUT = fileURLToPath(new URL('./ui-timings.json', import.meta.url));
const UI = 'tests/ui';

// The test() titles in one file's source, each as a matcher for a reported title.
export function titleMatchers(source) {
  const out = [];
  const re = /\b(?:test|it)(?:\.(?:only|skip|todo))?\(\s*(['"`])((?:\\.|(?!\1)[^\\])*?)\1/g;
  for (const m of source.matchAll(re)) {
    const parts = m[1] === '`' ? m[2].split(/\$\{[^}]*\}/) : [m[2]];
    const literal = parts.map((p) => p.replace(/\\(.)/g, '$1'));
    // A title that is mostly ${…} would match anything, which is worse than no match.
    if (literal.join('').trim().length < 8) continue;
    const esc = literal.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    out.push(new RegExp(`^${esc.join('[^]+?')}$`));
  }
  return out;
}

const stamp = (line) => Date.parse(line.slice(0, line.indexOf(' ')));

// One shard job's log → { files: {name: seconds}, tests, unmatched, total, reported }.
// files: the sorted UI files present at that commit; matchers: name → titleMatchers().
export function parseJob(log, files, matchers) {
  const lines = log.split(/\r?\n/).map((l) => l.replace(/^﻿/, ''));
  const startAt = lines.find((l) => /no-Kubernetes tripwire: armed|> f=\$\(node scripts\/ui-shard\.js/.test(l));
  const endAt = lines.find((l) => /^\S+ ℹ duration_ms /.test(l));
  if (!startAt || !endAt) return null;
  const results = [];
  for (const l of lines) {
    const m = /^(\S+) [✔✖] (.*) \(\d+(?:\.\d+)?ms\)$/.exec(l);
    if (m) results.push({ at: stamp(l), title: m[2] });
  }
  let cur = -1;
  let unmatched = 0;
  const owner = [];
  for (const r of results) {
    let next = -1;
    for (let i = Math.max(cur, 0); i < files.length; i++) {
      if (matchers[files[i]].some((re) => re.test(r.title))) { next = i; break; }
    }
    if (next === -1) unmatched++;
    else cur = next;
    owner.push(cur);
  }
  // Tests before the first match belong to the first file matched.
  const first = owner.find((o) => o >= 0);
  for (let i = 0; i < owner.length && owner[i] < 0; i++) owner[i] = first;
  const out = {};
  let prev = stamp(startAt);
  for (let i = 0; i < results.length; i++) {
    if (owner[i + 1] === owner[i] && i + 1 < results.length) continue;
    const f = files[owner[i]];
    out[f] = (out[f] ?? 0) + (results[i].at - prev) / 1000;
    prev = results[i].at;
  }
  const end = stamp(endAt);
  const last = files[owner.at(-1)];
  if (last) out[last] += (end - prev) / 1000;
  const reported = Number(/duration_ms ([\d.]+)/.exec(endAt)[1]) / 1000;
  return { files: out, tests: results.length, unmatched, total: (end - stamp(startAt)) / 1000, reported };
}

export const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
};

function token() {
  if (process.env.GITHUB_TOKEN || process.env.GH_TOKEN) return process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const out = execFileSync('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8' });
  const t = /^password=(.*)$/m.exec(out)?.[1];
  if (!t) throw new Error('no GitHub token: set GITHUB_TOKEN or store one for github.com in git');
  return t;
}

function repo() {
  const url = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
  return /github\.com[:/](.+?)(?:\.git)?$/.exec(url)[1];
}

async function main() {
  const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
  const want = Number(arg('--runs', 10));
  const cache = arg('--cache');
  if (cache) mkdirSync(cache, { recursive: true });
  const auth = { Authorization: `Bearer ${token()}`, Accept: 'application/vnd.github+json' };
  const api = `https://api.github.com/repos/${repo()}`;
  const get = async (path, text) => {
    const file = cache && join(cache, path.replace(/[^\w.-]+/g, '_'));
    if (file && existsSync(file)) return text ? readFileSync(file, 'utf8') : JSON.parse(readFileSync(file, 'utf8'));
    const res = await fetch(api + path, { headers: auth });
    if (!res.ok) throw new Error(`${res.status} ${path}`);
    const body = await res.text();
    if (file) writeFileSync(file, body);
    return text ? body : JSON.parse(body);
  };
  const git = (...a) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 64 << 20 });

  const { workflow_runs: runs } = await get('/actions/workflows/ci.yml/runs?branch=main&event=push&status=success&per_page=40');
  const used = [];
  const perFile = {};
  const axe = [];
  for (const run of runs) {
    if (used.length >= want) break;
    const { jobs } = await get(`/actions/runs/${run.id}/jobs?per_page=100`);
    const ui = jobs.filter((j) => /^UI gate .* \d+\/\d+$/.test(j.name));
    if (!ui.length || ui.some((j) => j.conclusion !== 'success')) continue;
    try { git('cat-file', '-e', `${run.head_sha}^{commit}`); } catch {
      console.warn(`run ${run.id}: commit ${run.head_sha.slice(0, 8)} not here (git fetch?), skipped`);
      continue;
    }
    const files = git('ls-tree', '--name-only', `${run.head_sha}:${UI}`).split('\n').filter((f) => f.endsWith('.test.ts')).sort();
    const matchers = Object.fromEntries(files.map((f) => [f, titleMatchers(git('show', `${run.head_sha}:${UI}/${f}`))]));
    const seen = {};
    let ok = true;
    let tests = 0;
    let unmatched = 0;
    for (const j of ui) {
      const parsed = parseJob(await get(`/actions/jobs/${j.id}/logs`, true), files, matchers);
      if (!parsed) { ok = false; break; }
      tests += parsed.tests;
      unmatched += parsed.unmatched;
      // The parse must account for the runner's own clock to within a few seconds.
      if (Math.abs(parsed.total - parsed.reported) > 15) ok = false;
      for (const [f, s] of Object.entries(parsed.files)) {
        if (f in seen) ok = false;
        seen[f] = s;
      }
      const step = j.steps?.find((s) => s.name.startsWith('accessibility'));
      if (step?.conclusion === 'success') axe.push((Date.parse(step.completed_at) - Date.parse(step.started_at)) / 1000);
    }
    const missing = files.filter((f) => !(f in seen));
    if (!ok || missing.length) {
      console.warn(`run ${run.id}: shards don't account for every file once (missing ${missing.length}), skipped`);
      continue;
    }
    console.log(`run ${run.id} (${run.head_sha.slice(0, 8)}): ${files.length} files, ${tests} tests, ${unmatched} titles matched by position`);
    used.push(run.id);
    for (const [f, s] of Object.entries(seen)) (perFile[f] ??= []).push(s);
  }
  if (used.length < Math.min(3, want)) throw new Error(`only ${used.length} usable runs; not writing ${OUT}`);
  const seconds = Object.fromEntries(Object.entries(perFile).sort(([a], [b]) => a.localeCompare(b))
    .map(([f, xs]) => [f, Math.round(median(xs))]));
  const json = {
    note: 'Generated by scripts/ui-timings.js (npm run ui:timings). Do not edit by hand.',
    generated: new Date().toISOString(),
    runs: used,
    advisorySeconds: axe.length ? Math.round(median(axe)) : undefined,
    seconds,
  };
  writeFileSync(OUT, `${JSON.stringify(json, null, 2)}\n`);
  console.log(`wrote ${OUT}: ${Object.keys(seconds).length} files from ${used.length} runs`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
