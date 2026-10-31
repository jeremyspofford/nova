// No ad hoc provider calls (ADR §7). Subsystems ask the Decision Service for a template; nothing
// else reaches a decision model. Checked over every source file under src/:
//   1. outside src/core/decision-service/, the only file of the service anything imports is its
//      index.ts (no seat, no wire client, no chunker, no template module directly);
//   2. the endpoint /v1/systemone appears in exactly one source file: the service's wire.ts;
//   3. neither the service's index.ts nor the core's index.ts exports a seat or the wire client;
//   4. Part 1's old folder, src/core/jev/, is gone.
// Each check has a negative control: a planted violation it must catch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');
const SRC = join(ROOT, 'src');
const SERVICE = join(SRC, 'core', 'decision-service');
const SEAT_NAMES = ['Tev1Seat', 'JevSeat', 'StubSeat', 'LegacySeat', 'SystemOne', 'askChunked', 'readAnswer', 'wireQuestions'];

export interface SourceFile { path: string; text: string }

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? (n === 'node_modules' ? [] : walk(p)) : /\.(?:ts|js|mjs|cjs)$/.test(n) ? [p] : [];
  });
}

// Every module specifier a file names: static and dynamic imports, re-exports, require().
export function specifiers(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\b(?:import|export)\s[^'"`;]*?\sfrom\s*['"]([^'"]+)['"]/g)) out.push(m[1]!);
  for (const m of text.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)) out.push(m[1]!);
  for (const m of text.matchAll(/\bimport\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g)) out.push(m[1]!);
  for (const m of text.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]!);
  return out;
}

export function violations(files: SourceFile[], service = SERVICE): string[] {
  const out: string[] = [];
  const inside = (p: string) => p === service || p.startsWith(service + sep);
  const allowed = join(service, 'index.ts');
  for (const f of files) {
    if (!inside(f.path)) {
      for (const s of specifiers(f.text)) {
        if (!s.startsWith('.')) continue;
        const target = resolve(dirname(f.path), s);
        if (inside(target) && target !== allowed) out.push(`${relative(ROOT, f.path)} imports ${s}: outside the Decision Service, only its index.ts may be imported`);
      }
    }
    if (f.text.includes('/v1/systemone') && f.path !== join(service, 'wire.ts')) out.push(`${relative(ROOT, f.path)} names the decision endpoint: only the service’s wire.ts may`);
  }
  return out;
}

const sources = (): SourceFile[] => walk(SRC).map((p) => ({ path: p, text: readFileSync(p, 'utf8') }));

test('no file outside the Decision Service reaches a seat or the wire client, and only wire.ts names the endpoint', () => {
  const files = sources();
  assert.ok(files.length > 100, `scanned ${files.length} source files`);
  assert.ok(files.some((f) => f.path === join(SERVICE, 'wire.ts') && f.text.includes('/v1/systemone')), 'the endpoint lives in wire.ts');
  assert.deepEqual(violations(files), []);
});

test('negative controls: each planted violation is caught', () => {
  const fake = (rel: string, text: string): SourceFile => ({ path: join(SRC, rel), text });
  const planted = [
    fake('core/ingest/sneaky.ts', `import { Tev1Seat } from '../decision-service/seats/tev1.ts';`),
    fake('core/browser/also.ts', `export { SystemOne } from '../decision-service/wire.ts';`),
    fake('server-ish.js', `const m = await import('./core/decision-service/seats/jev.ts');`),
    fake('core/capture/direct.ts', `await fetch(url + '/v1/systemone', { method: 'POST' });`),
    fake('core/models/template.ts', `import { INGEST_SCREEN_V1 } from '../decision-service/templates/ingest-screen.ts';`),
  ];
  const v = violations(planted);
  assert.equal(v.length, 5, v.join('\n'));
  assert.match(v[0]!, /sneaky\.ts imports \.\.\/decision-service\/seats\/tev1\.ts/);
  assert.match(v[1]!, /also\.ts imports \.\.\/decision-service\/wire\.ts/);
  assert.match(v[2]!, /server-ish\.js imports \.\/core\/decision-service\/seats\/jev\.ts/);
  assert.match(v[3]!, /direct\.ts names the decision endpoint/);
  assert.match(v[4]!, /template\.ts imports/);
  // The allowed form passes.
  assert.deepEqual(violations([fake('core/ingest/fine.ts', `import { createDecisionService } from '../decision-service/index.ts';`)]), []);
});

test('the service’s index.ts and the core’s index.ts export no seat and no wire client', async () => {
  const svc = await import('../../src/core/decision-service/index.ts');
  for (const n of SEAT_NAMES) assert.ok(!(n in svc), `the service exports ${n}`);
  assert.equal(typeof svc.createDecisionService, 'function');
  assert.doesNotMatch(readFileSync(join(SERVICE, 'index.ts'), 'utf8'), /export\s[^;]*from\s*['"]\.\/(?:seats\/|wire\.ts|chunk\.ts)/);
  const core = await import('../../src/core/index.ts');
  for (const n of SEAT_NAMES) assert.ok(!(n in core), `the core exports ${n}`);
  // Negative control: the export check sees a planted re-export.
  assert.match(`export { Tev1Seat } from './seats/tev1.ts';`, /export\s[^;]*from\s*['"]\.\/(?:seats\/|wire\.ts|chunk\.ts)/);
});

test('Part 1’s old folder is gone: its code lives in the service', () => {
  assert.equal(existsSync(join(SRC, 'core', 'jev')), false);
  for (const f of ['wire.ts', 'seats/tev1.ts', 'verdicts.ts', 'eval.ts', 'tev1-verdicts.json', 'templates/ingest-screen.ts']) assert.ok(existsSync(join(SERVICE, f)), f);
});
