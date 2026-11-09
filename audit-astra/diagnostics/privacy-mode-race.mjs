// Audit-only synthetic probe. Both inference services bind loopback; no real model or external request.
import { createServer } from 'node:http';
import { rmSync } from 'node:fs';
import { modelsCore, say } from '../../tests/support/models.ts';
import { startFakeOpenAI } from '../../scripts/stand-ins/fake-openai.js';

async function scenario(initial, tighten) {
  let release;
  let started;
  const received = new Promise(r => { started = r; });
  const hold = new Promise(r => { release = r; });
  const local = createServer(async (req, res) => {
    for await (const chunk of req) { void chunk; }
    const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.url === '/api/version') return json(200, { version: '0.40.13' });
    if (req.url === '/api/tags') return json(200, { models: [{ name: 'example-mid:8b', size: 5e9, digest: 'a'.repeat(64), details: { parameter_size: '8B' }, capabilities: ['completion'] }] });
    if (req.url === '/api/show') return json(200, { capabilities: ['completion'] });
    if (req.url === '/api/ps') return json(200, { models: [] });
    if (req.url === '/api/chat') { started(); await hold; return json(500, { error: 'synthetic local failure after privacy switch' }); }
    return json(404, {});
  });
  await new Promise(r => local.listen(0, '127.0.0.1', r));
  const cloud = await startFakeOpenAI({ model: 'cloud-model', reply: () => 'Synthetic cloud-route response' });
  const { core, home } = modelsCore(`http://127.0.0.1:${local.address().port}`, { privacy: initial });
  try {
    await core.models.assign('reasoner', { model: 'example-mid:8b' });
    core.models.setCloud({ name: 'Audit cloud stand-in', base_url: cloud.url, model: 'cloud-model' }, true);
    const pending = core.models.infer({ role: 'reasoner', messages: say('Synthetic audit canary: cobalt pear'), purpose: 'privacy-race-audit' }).then(result => ({ result }), error => ({ error: error.message }));
    await received;
    if (tighten) core.profile.set('privacy', 'default', 'local-only', 'settings');
    release();
    const outcome = await pending;
    return {
      initial, tightened_while_local_inflight: tighten, live_mode_at_finish: core.profile.privacyDefault(),
      cloud_route_requests: cloud.requests.filter(r => r.method === 'POST').length,
      cloud_received_canary: cloud.requests.some(r => JSON.stringify(r.body).includes('cobalt pear')),
      ...outcome,
      receipts: core.receipts.list().filter(r => r.purpose === 'privacy-race-audit').map(({ provider, privacy_mode, egress }) => ({ provider, privacy_mode, egress })),
    };
  } finally {
    release();
    await core.close();
    await cloud.close();
    local.closeAllConnections();
    await new Promise(r => local.close(r));
    rmSync(home, { recursive: true, force: true });
  }
}
console.log(JSON.stringify({ baseline: 'd948aa0a442a9f930b86f4516eeea21981b76714', boundary: 'Disposable cores; only loopback stand-ins; no real model calls or external disclosure', control: await scenario('local-only', false), race: await scenario('local-preferred', true) }, null, 2));
