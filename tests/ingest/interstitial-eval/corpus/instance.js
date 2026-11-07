// A private Nova for the Interstitial Research live evals: the real server and runner, started as
// src/server.js starts them, with two differences a test may make and the shipped start can't:
//   - web_fetch may reach the fixture corpus's own loopback address, and only that address
//     (fetchAllow; every other private or loopback address stays refused);
//   - the tool-step limit is NOVA_EVAL_MAX_STEPS (default 24), the same for the flag-on and
//     flag-off arms, so a full search matrix can run.
// Everything else comes from the environment exactly as for `npm start`: NOVA_HOME, NOVA_PORT,
// NOVA_FEATURE_INTERSTITIAL, NOVA_SEARCH_URL, NOVA_VAULT_KEY. Run it with the egress tripwire:
//   node --import ./tests/acceptance/egress-guard.ts tests/ingest/interstitial-eval/corpus/instance.js
// Never part of CI: it is for an owner-approved local eval run.
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../../../../src/config.js';
import { createNova } from '../../../../src/server.js';

const corpus = process.env.NOVA_EVAL_CORPUS_IP ?? '127.0.0.77';
const config = { ...loadConfig(), maxSteps: Number(process.env.NOVA_EVAL_MAX_STEPS ?? 24) };
if (!['127.0.0.1', 'localhost'].includes(config.host)) throw new Error('The eval instance listens on this machine only.');
const nova = createNova(config, { fetchAllow: (address) => address === corpus });
nova.helpers.recover();
nova.core.start();
nova.chatRun.recover();
nova.scheduler.start();
nova.server.listen(config.port, config.host, () => {
  writeFileSync(join(config.home, 'nova.pid'), String(process.pid));
  console.log(`Nova is ready at http://localhost:${nova.server.address().port} (eval instance; interstitial ${config.features.interstitial ? 'ON' : 'OFF'}; max steps ${config.maxSteps}; fetch allowed only to ${corpus})`);
  console.log(`Home: ${config.home}`);
});
const quit = async () => {
  rmSync(join(config.home, 'nova.pid'), { force: true });
  nova.scheduler.stop();
  for (const id of nova.runner.active.keys()) nova.runner.stop(id);
  nova.server.close();
  await nova.core.stopWork(2000);
  await nova.core.close();
  process.exit(0);
};
process.on('SIGINT', quit);
process.on('SIGTERM', quit);
