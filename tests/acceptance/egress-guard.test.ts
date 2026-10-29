// The egress tripwire has to fire, or its silence in the fresh-user test proves nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const GUARD = join(import.meta.dirname, 'egress-guard.ts');

test('the egress guard records and refuses a connection off this machine, and lets loopback through', () => {
  const log = join(mkdtempSync(join(tmpdir(), 'nova-egress-')), 'egress.log');
  writeFileSync(log, '');
  const script = `
    const net = await import('node:net');
    const server = net.createServer((s) => s.end()).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    await new Promise((ok, fail) => net.connect(server.address().port, '127.0.0.1', ok).on('error', fail));
    server.close();
    try { net.connect(443, '203.0.113.7'); console.log('allowed'); } catch (e) { console.log(e.message); }
    try { await fetch('http://192.0.2.1/'); console.log('allowed'); } catch (e) { console.log('fetch refused'); }
  `;
  const out = execFileSync(process.execPath, ['--import', GUARD, '--input-type=module', '-e', script], { env: { ...process.env, NOVA_EGRESS_LOG: log }, encoding: 'utf8' });
  assert.match(out, /egress refused: 203\.0\.113\.7/);
  assert.match(out, /fetch refused/);
  assert.doesNotMatch(out, /allowed/);
  const lines = readFileSync(log, 'utf8').trim().split('\n');
  assert.ok(lines.some((l) => l.includes('203.0.113.7:443')), lines.join('\n'));
  assert.ok(lines.some((l) => l.includes('192.0.2.1')), lines.join('\n'));
});
