import assert from 'node:assert/strict';
import { mkdtempSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNova } from '/workspace/src/server.js';
import { loadConfig } from '/workspace/src/config.js';
import { startFakeOllama } from '/workspace/scripts/stand-ins/fake-ollama.js';
import { hubHardware } from '/workspace/tests/support/models.ts';
const home = mkdtempSync(join(tmpdir(), 'nova-review-vault-unavailable-'));
const runtime = await startFakeOllama({models: []});
const config = {...loadConfig({NOVA_HOME: home, NOVA_PORT: '0', NOVA_AGENT_CMD: 'example-unused-command', NOVA_AGENT_EGRESS: 'none', NOVA_TZ: 'UTC', NOVA_INSTANCE: 'development'}), commit: false};
const canary = 'synthetic-reviewed-vault-value-842a6a2c9be7';
const encoded = Buffer.from(canary).toString('base64');
let nova;
async function start() {
  nova = createNova(config, {secrets: () => null, models: {ollamaUrl: runtime.url, hardware: async () => hubHardware()}});
  await new Promise(resolve => nova.server.listen(0, '127.0.0.1', resolve));
}
async function download() {
  const res = await fetch(`http://127.0.0.1:${nova.server.address().port}/api/v1/diagnostics`);
  const body = await res.json();
  return {status: res.status, attachment: !!res.headers.get('content-disposition'), noStore: res.headers.get('cache-control') === 'no-store', warnings: body.redaction?.warnings?.length ?? null, canaryPresent: JSON.stringify(body).includes(encoded), format: body.format};
}
async function close() {
  if (!nova) return;
  nova.scheduler.stop();
  await new Promise((resolve, reject) => {nova.server.close(e => e ? reject(e) : resolve()); nova.server.closeAllConnections();});
  await nova.core.close();
  assert.equal(nova.server.listening, false);
  nova = undefined;
}
try {
  await start();
  const empty = await download();
  assert.equal(empty.status, 200); assert.equal(empty.warnings, 0);
  nova.core.vault.put('provider/REVIEW_CANARY', canary);
  nova.core.log.write('info', 'example', `encoded service detail ${encoded}`);
  const readable = await download();
  assert.equal(readable.canaryPresent, false);
  await close();
  // Only this new private fixture's key is moved; restart forces real vault enumeration.
  renameSync(join(home, 'vault', 'key'), join(home, 'vault', 'key.probe-held'));
  await start();
  assert.equal(nova.core.vault.status().ok, false);
  const unavailable = await download();
  console.log(JSON.stringify({empty, readable, unavailable}));
  assert.equal(unavailable.canaryPresent, false, 'Known vault credential must not survive download when vault enumeration is unavailable');
} finally {await close(); await runtime.close();}
