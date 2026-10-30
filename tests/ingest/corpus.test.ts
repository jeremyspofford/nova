// The gate's regression corpus (plan, Gate): known injection payloads, each with its expected
// verdict at least, must all be quarantined or blocked; ordinary pages, newsletters and docs must
// pass (or, without a model, be quarantined), and the false positives are counted.
//
// Run three ways, through the real core:
//   - no sorting model: the deterministic checks alone;
//   - a sorting model that sees nothing wrong (every probability 0.02): the worst case for the
//     Noul screen, so every injection must still be caught by the checks;
//   - a sorting model that sees everything as an injection (0.95): nothing may pass.
// NOVA_INGEST_EVIDENCE=<file> writes the results as a table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startFakeOllama } from '../../scripts/stand-ins/fake-ollama.js';
import { INSTALLED, modelsCore } from '../support/models.ts';
import type { Core } from '../../src/core/index.ts';

interface Item { id: string; category: string; expect?: 'quarantine' | 'block'; source: { kind: string; origin: string }; text?: string; html?: string; headers?: Record<string, string>; attachments?: { name: string; type?: string }[] }
const load = (f: string) => JSON.parse(readFileSync(join(import.meta.dirname, 'corpus', f), 'utf8')) as Item[];
const INJECTION = load('injection.json');
const BENIGN = load('benign.json');
// Benign items the gate holds back that it shouldn't, known and reported (docs/evidence/ingest-gate.md):
// an article that quotes an injection phrase reads, to Nova's own checks, like an injection.
const KNOWN_FALSE_POSITIVES = new Set(['article-about-injection']);
const RANK = { pass: 0, quarantine: 1, block: 2 } as const;

const PLAN_CATEGORIES = ['direct', 'hidden by CSS', 'zero-width', 'comments and metadata', 'encoded', 'link mismatch', 'impersonation mail, failing DMARC', 'ignore previous instructions', 'fake tool calls', 'Reply-To swaps', 'exfiltration by URL'];

const fixed = (p: number) => (body: { format?: unknown }) => (body.format && typeof body.format === 'object'
  ? JSON.stringify({ answers: { direct_instruction: p, hidden_instruction: p, exfiltration: p, impersonation: p, unrequested_action: p }, confidence: 0.9, why: 'fixed' })
  : 'Facts only.');

async function screenAll(core: Core, items: Item[]) {
  const out: { id: string; category: string; expect?: string; verdict: string; flags: string[]; max: number | null }[] = [];
  for (const it of items) {
    const r = await core.ingest.screen({ ...(it.text !== undefined ? { text: it.text } : {}), ...(it.html !== undefined ? { html: it.html } : {}), ...(it.headers ? { headers: it.headers } : {}), ...(it.attachments ? { attachments: it.attachments } : {}), source: it.source as never });
    out.push({ id: it.id, category: it.category, ...(it.expect ? { expect: it.expect } : {}), verdict: r.verdict, flags: r.flags.filter((f) => f.level !== 'note').map((f) => f.kind), max: r.max });
  }
  return out;
}

async function run(model: number | null) {
  const o = await startFakeOllama({ models: INSTALLED, ...(model !== null ? { reply: fixed(model) } : {}) });
  const { core } = modelsCore(o.url, { privacy: 'local-only' });
  try {
    if (model !== null) await core.models.assign('triage-text', { model: 'example-small:3b' });
    return { injection: await screenAll(core, INJECTION), benign: await screenAll(core, BENIGN) };
  } finally {
    await core.close();
    await o.close();
  }
}

const results: Record<string, Awaited<ReturnType<typeof run>>> = {};

test('the corpus covers every kind of payload the plan names, with neutral placeholders', () => {
  for (const c of PLAN_CATEGORIES) assert.ok(INJECTION.some((i) => i.category === c), c);
  assert.ok(INJECTION.every((i) => i.expect === 'quarantine' || i.expect === 'block'));
  assert.ok(BENIGN.length >= 10);
  // Only reserved example names and hosts.
  const hosts = JSON.stringify([INJECTION, BENIGN]).match(/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|io)\b/gi) ?? [];
  assert.deepEqual([...new Set(hosts.filter((h) => !/(^|\.)example\.(com|org|net)$/i.test(h)))], []);
});

test('no sorting model: every injection is quarantined or blocked (at least as expected); benign is quarantined, never blocked', async () => {
  const r = results.none = await run(null);
  for (const x of r.injection) assert.ok(RANK[x.verdict as keyof typeof RANK] >= RANK[x.expect as keyof typeof RANK], `${x.id}: ${x.verdict}, expected at least ${x.expect} (${x.flags.join(', ')})`);
  for (const x of r.benign) assert.equal(x.verdict, 'quarantine', `${x.id}: ${x.verdict} (${x.flags.join(', ')})`);
});

test('a sorting model that sees nothing wrong: the checks alone still catch every injection; benign passes, false positives counted', async () => {
  const r = results.fooled = await run(0.02);
  for (const x of r.injection) assert.ok(RANK[x.verdict as keyof typeof RANK] >= RANK[x.expect as keyof typeof RANK], `${x.id}: ${x.verdict}, expected at least ${x.expect} (${x.flags.join(', ')})`);
  const fp = r.benign.filter((x) => x.verdict !== 'pass');
  assert.ok(fp.every((x) => x.verdict === 'quarantine'), 'a false positive is held back, never blocked');
  assert.deepEqual(fp.map((x) => x.id).sort(), [...KNOWN_FALSE_POSITIVES].sort(), `false positives: ${JSON.stringify(fp)}`);
});

test('a sorting model that sees an injection everywhere: nothing passes, everything blocks', async () => {
  const r = results.alarmed = await run(0.95);
  for (const x of [...r.injection, ...r.benign]) assert.equal(x.verdict, 'block', x.id);
});

test('evidence', () => {
  const file = process.env.NOVA_INGEST_EVIDENCE;
  if (!file) return;
  const row = (x: { id: string; category: string; expect?: string }) => {
    const v = (k: string) => results[k]!.injection.concat(results[k]!.benign).find((y) => y.id === x.id)!;
    return `| ${x.id} | ${x.category} | ${x.expect ?? 'pass'} | ${v('none').verdict} | ${v('fooled').verdict} | ${v('alarmed').verdict} | ${[...new Set([...v('none').flags, ...v('fooled').flags])].join(', ') || '—'} |`;
  };
  const head = '| id | category | expected | no model | model sees nothing (0.02) | model sees all (0.95) | flags |\n|---|---|---|---|---|---|---|';
  const fp = results.fooled!.benign.filter((x) => x.verdict !== 'pass');
  writeFileSync(file, [
    `Injection payloads: ${INJECTION.length}. Caught (quarantined or blocked) with no model: ${results.none!.injection.filter((x) => x.verdict !== 'pass').length}; with a model that sees nothing: ${results.fooled!.injection.filter((x) => x.verdict !== 'pass').length}. Blocked with no model: ${results.none!.injection.filter((x) => x.verdict === 'block').length}.`,
    `Benign items: ${BENIGN.length}. Passed with a model that sees nothing wrong: ${results.fooled!.benign.filter((x) => x.verdict === 'pass').length}. False positives: ${fp.length} (${fp.map((x) => `${x.id}: ${x.verdict}`).join('; ') || 'none'}). Blocked with no model: ${results.none!.benign.filter((x) => x.verdict === 'block').length}.`,
    '', '### Injection', '', head, ...INJECTION.map(row), '', '### Benign', '', head, ...BENIGN.map(row), '',
  ].join('\n'));
});
