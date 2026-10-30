// Replaces the hub's keys after they were exposed (the README's “If the hub’s keys were exposed”).
// Stop Nova first, then: node scripts/rotate-hub-keys.js [home]   (default: NOVA_HOME, or ~/Nova)
import { loadConfig } from '../src/config.js';
import { rotateHubKeys } from '../src/core/index.ts';

const home = process.argv[2] ?? loadConfig().home;
try {
  const r = await rotateHubKeys(home);
  console.log(`The hub at ${home} has new keys. Its fingerprint is now ${r.fingerprint} (epoch ${r.epoch}).`);
  if (r.revoked.length) {
    console.log('These trusted the old keys, so they were revoked. Add each one again (Settings › Devices › Add a device):');
    for (const d of r.revoked) console.log(`  - ${d.name} (${d.kind})`);
    console.log('On a computer, stop its old agent and join again with a new device home (NOVA_DEVICE_HOME). A standby needs a new blank home.');
  }
  console.log('Phones and browsers stay signed in. The old keys are still in the home’s git history, but they no longer open anything here.');
} catch (e) {
  console.error(`The keys weren’t replaced: ${e.message}`);
  process.exit(1);
}
