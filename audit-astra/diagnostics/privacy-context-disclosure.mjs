// Audit-only: inspect what the production runner passes to a synthetic cloud-class agent.
// No request leaves this process; no real model or real credential is used.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNova } from '../../src/server.js';
import { loadConfig } from '../../src/config.js';

const home = mkdtempSync(join(tmpdir(), 'nova-astra-context-'));
const canary = 'AUDIT_SYNTHETIC_STANDING_PRIVATE_872145';
const seen = [];
const nova = createNova({ ...loadConfig({ NOVA_HOME: home, NOVA_TZ: 'UTC', NOVA_AGENT_CMD: 'audit-cloud-stand-in', NOVA_AGENT_EGRESS: 'remote' }), commit: false, port: 0 }, {
  agent: async ({ system, prompt }) => { seen.push({ system_has_private_file: system.includes(canary), prompt_has_private_file: prompt.includes(canary) }); return { text: 'Synthetic reply.', aborted: false }; },
});
try {
  nova.core.profile.set('privacy', 'default', 'cloud-allowed', 'settings');
  writeFileSync(join(home, 'USER.md'), `# User\nSynthetic private test note: ${canary}\n`);
  nova.runner.ensureMain();
  nova.runner.send('main', 'Hello');
  await nova.runner.idle('main');
  console.log(JSON.stringify({ baseline: 'd948aa0a442a9f930b86f4516eeea21981b76714', boundary: 'No remote request: synthetic injected agent inspects parameters only', classification: 'Expected data disclosure under current cloud-allowed mode; not itself proof of unauthorized access', calls: seen, receipt: nova.core.receipts.list({ session_id: 'main' }).map(({ egress, privacy_mode, context_items }) => ({ egress, privacy_mode, context_items: context_items.map(({ kind, ref }) => ({ kind, ref })) })) }, null, 2));
} finally {
  await nova.core.close();
  rmSync(home, { recursive: true, force: true });
}
