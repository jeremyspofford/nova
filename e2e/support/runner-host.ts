// The cloud runner (services/runner) for J9 where no sandbox substrate works: the runner's own
// server (`buildRunnerServer`, the same one `nova-runner` starts) with the host test double of
// services/runner/test/host-substrate.ts as its sandbox, which runs commands on this machine
// without isolation. The Playwright container has neither bubblewrap nor a container runtime;
// where bubblewrap works, e2e/support/m7.ts starts the real `nova-runner` CLI instead.
// Usage: node e2e/support/runner-host.ts <data-dir> <token-file> <local-repos-dir>
import { mkdirSync } from 'node:fs';
import { buildRunnerServer, readTokenFile, streamLog } from '../../services/runner/src/index.ts';
import { HostSubstrate } from '../../services/runner/test/host-substrate.ts';

const [dataDir, tokenFile, localRepos] = process.argv.slice(2);
if (!dataDir || !tokenFile || !localRepos) {
  process.stderr.write('usage: runner-host.ts <data-dir> <token-file> <local-repos-dir>\n');
  process.exit(2);
}
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const server = await buildRunnerServer({
  dataDir,
  tokens: () => readTokenFile(tokenFile),
  substrate: new HostSubstrate(),
  localRepoRoots: [localRepos],
  log: streamLog(),
});
const address = await server.app.listen({ host: '127.0.0.1', port: 0 });
process.stdout.write(`Nova runner listening on ${address} (host test double)\n`);
const stop = () => {
  void server.close().then(() => process.exit(0));
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
