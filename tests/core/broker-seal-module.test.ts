// Fixed public helper through the actual server, then browser WebCrypto → real broker → bound
// synthetic program. This does not switch app forms or claim Core's legacy plaintext is gone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { createNova } from '../../src/server.js';
import { loadConfig } from '../../src/config.js';
import { ensureMark } from '../../src/core/index.ts';
import { BrokerClient } from '../../src/core/broker/client.ts';
import { startBroker, stopBroker, type Started } from '../../src/broker/spawn.ts';
import { fileSha256 } from '../../src/broker/origin.ts';
import { Person, anyForm } from '../support/broker-support.ts';

test('person-only served seal module loads in a browser and its envelope is consumed by the real broker', { timeout: 30000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'nova-served-seal-')), home = join(root, 'home');
  let b: Started | undefined, client: BrokerClient | undefined, browser: Browser | undefined, nova: ReturnType<typeof createNova> | undefined;
  const canary = 'Task6-browser-only-private-canary-a84d0e7319';
  try {
    ensureMark(home);
    b = await startBroker(join(home, 'broker'), { keyMode: 'file', pipe: true });
    client = new BrokerClient({ socket: b.socket, token: b.tokens.core });
    const config = loadConfig({ NOVA_HOME: home, NOVA_AGENT_CMD: 'true', NOVA_AGENT_EGRESS: 'none', NOVA_VAULT_KEY: 'file', NOVA_MESH_URL: 'http://127.0.0.1:0', NOVA_MESH_TRANSPORT: 'network' });
    nova = createNova(config, { broker: client });
    await new Promise<void>((r) => nova!.server.listen(0, '127.0.0.1', r));
    await new Promise<void>((r) => nova!.mesh!.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(nova.server.address() as any).port}`, mesh = `http://127.0.0.1:${(nova.mesh!.address() as any).port}`;
    const moduleResponse = await fetch(`${base}/api/v1/broker/seal.js`);
    assert.equal(moduleResponse.status, 200);
    assert.match(moduleResponse.headers.get('content-type')!, /^text\/javascript/);
    assert.equal(moduleResponse.headers.get('cache-control'), 'no-store');
    const source = await moduleResponse.text();
    assert.equal(anyForm(source, canary), null);
    assert.equal((await fetch(`${mesh}/api/v1/broker/seal.js`)).status, 401);
    assert.equal((await fetch(`${base}/api/v1/broker/main.ts`)).status, 404);
    assert.equal(await (await fetch(`${base}/api/v1/broker/seal.js?file=main.ts`)).text(), source, 'query cannot select another source file');
    const person = new Person((m, f = {}) => client!.call(m, f)); await person.setup();
    const program = join(root, 'consume.py');
    writeFileSync(program, `#!/usr/bin/python3\nimport os\nprint('MATCH' if os.environ['SYNTHETIC_VALUE']==${JSON.stringify(canary)} else 'MISMATCH')\n`, { mode: 0o755 });
    const target = { kind: 'process' as const, path: program, sha256: fileSha256(program) };
    const fields = { meta: { name: 'test/BROWSER_MODULE', kind: 'secret', class: 'standard' }, source: 'sealed', bind: [{ target, inject: { how: 'env', env: 'SYNTHETIC_VALUE' }, consent: {} }] };
    const challenge = await client.call('create', fields) as any;
    assert.equal(challenge.refused, 'needs_approval');
    const state = await client.state();
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.goto(`${base}/api/v1/setup`);
    const envelope = await page.evaluate(async ({ key, digest, value }) => {
      const modulePath = '/api/v1/broker/seal.js';
      const publicModule = await import(modulePath);
      return publicModule.sealValue(key, digest, value);
    }, { key: String(state.entry_key), digest: challenge.challenge.digest, value: canary });
    assert.equal(anyForm(JSON.stringify(envelope), canary), null);
    const created = await client.call('create', { ...fields, source: { sealed: envelope }, approval: person.approval(challenge.challenge) });
    assert.equal(created.ok, true);
    const used = await client.use(String(created.ref), target, { argv: [], timeout_ms: 2000 }) as any;
    assert.equal(used.ok, true); assert.equal(used.outcome.stdout.trim(), 'MATCH');
    assert.equal(anyForm(JSON.stringify(used), canary), null);
  } finally {
    await browser?.close();
    if (nova) {
      for (const server of [nova.server, nova.mesh]) if (server?.listening) await new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); });
      await nova.core.close();
    }
    client?.close(); if (b) await stopBroker(b); rmSync(root, { recursive: true, force: true });
  }
});
