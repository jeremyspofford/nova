import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../../src/core/db.ts';
import { Extensions, satisfies, validateManifest } from '../../src/core/extensions.ts';
import { sampleManifest } from './fixtures.ts';

function host() {
  const home = mkdtempSync(join(tmpdir(), 'nova-ext-'));
  const db = new Db(':memory:');
  db.migrate();
  return { home, db, x: new Extensions({ db, home, novaVersion: '0.1.0' }) };
}

test('a manifest missing contract fields is refused with every problem listed', () => {
  assert.throws(() => validateManifest({ id: 'Bad ID', version: '1', kind: 'toy' }), (e: Error & { details?: string[] }) => {
    assert.ok((e.details ?? []).length >= 8, (e.details ?? []).join('\n'));
    return true;
  });
  assert.throws(() => validateManifest(sampleManifest({ secrets: ['sk-live-1234'] })), /isn’t valid/);
  assert.throws(() => validateManifest(sampleManifest({ permissions: [{ kind: 'network', target: 'x', why: '' }] })), /isn’t valid/);
  assert.throws(() => validateManifest(sampleManifest({ on_remove: { delete: ['../../etc'], keep: [], export: [] } })), /isn’t valid/);
});

test('version ranges', () => {
  assert.equal(satisfies('0.1.0', '>=0.1.0 <1.0.0'), true);
  assert.equal(satisfies('1.0.0', '>=0.1.0 <1.0.0'), false);
  assert.equal(satisfies('0.1.0', '0.1.0'), true);
  assert.equal(satisfies('0.1.0', '>0.1.0'), false);
  assert.equal(satisfies('0.1.0', ''), false);
});

test('install starts disabled with a plain-language review; enabling needs an OK on permissions', () => {
  const { x } = host();
  const { extension, review } = x.install(sampleManifest());
  assert.equal(extension.state, 'installed');
  assert.deepEqual(review, ['Connect to api.weather.example: to fetch the forecast', 'Uses a secret you provide (WEATHER_API_KEY); Nova keeps the values, the extension never sees where.']);
  assert.throws(() => x.enable('example.weather'), /needs your OK/);
  assert.equal(x.enable('example.weather', { approved: true }).state, 'enabled');
  assert.equal(x.disable('example.weather').state, 'disabled');
  assert.throws(() => x.install(sampleManifest()), /already installed/);
  assert.throws(() => x.install(sampleManifest({ id: 'example.future', nova_compat: '>=2.0.0' })), /needs Nova >=2.0.0/);
});

test('remove follows on_remove: exports what it promised, deletes the rest, leaves no record', () => {
  const { x, home } = host();
  x.install(sampleManifest());
  const data = x.dataDir('example.weather');
  writeFileSync(join(data, 'history.json'), '{"days":3}');
  writeFileSync(join(data, 'cache'), 'tmp');
  const out = x.remove('example.weather');
  assert.equal(existsSync(data), false);
  assert.deepEqual(x.list(), []);
  assert.equal(out.exported.length, 1);
  assert.ok(out.exported[0]!.startsWith(join(home, 'exports')));
  assert.equal(readFileSync(out.exported[0]!, 'utf8'), '{"days":3}');
  assert.deepEqual(out.kept, []);
  assert.throws(() => x.get('example.weather'), /No extension/);
  x.install(sampleManifest());
  assert.equal(x.get('example.weather').state, 'installed', 'reinstalling after removal starts clean');
});
