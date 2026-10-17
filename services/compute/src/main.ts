#!/usr/bin/env node
// nova-compute: the compute node CLI (FR-126). Usage:
//   nova-compute enroll --hub <url> --token <nve_...> --backend <url>
//                       [--backend-kind ollama|llamacpp|openai_compatible] [--name <n>]
//                       [--listen <host:port>] [--advertise <url>] [--max-jobs <n>]
//                       [--data-dir <dir>]
//   nova-compute run [--data-dir <dir>]
// Secrets (keys, credential, job token) stay in the 0600 state file and are never printed.
import { parseArgs } from 'node:util';
import { BACKEND_KINDS, type BackendKind } from './backend.ts';
import { ComputeNode, enroll } from './node.ts';
import { defaultDataDir, statePath } from './state.ts';

const USAGE = `Usage:
  nova-compute enroll --hub <url> --token <nve_...> --backend <url>
                      [--backend-kind ollama|llamacpp|openai_compatible] [--name <name>]
                      [--listen <host:port>] [--advertise <url>] [--max-jobs <n>]
                      [--data-dir <dir>]
  nova-compute run [--data-dir <dir>]
`;

function out(text: string): void {
  process.stdout.write(`${text}\n`);
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === 'enroll') {
    const { values } = parseArgs({
      args: rest,
      options: {
        hub: { type: 'string' },
        token: { type: 'string' },
        backend: { type: 'string' },
        'backend-kind': { type: 'string' },
        name: { type: 'string' },
        listen: { type: 'string' },
        advertise: { type: 'string' },
        'max-jobs': { type: 'string' },
        'data-dir': { type: 'string' },
      },
    });
    if (!values.hub || !values.token || !values.backend) {
      process.stderr.write(USAGE);
      return 2;
    }
    const kind = values['backend-kind'] ?? 'ollama';
    if (!(BACKEND_KINDS as readonly string[]).includes(kind)) {
      process.stderr.write(`unknown --backend-kind ${kind}\n${USAGE}`);
      return 2;
    }
    const dataDir = values['data-dir'] ?? defaultDataDir();
    const state = await enroll({
      hubUrl: values.hub,
      token: values.token,
      backendUrl: values.backend,
      backendKind: kind as BackendKind,
      dataDir,
      ...(values.name ? { name: values.name } : {}),
      ...(values.listen ? { listen: values.listen } : {}),
      ...(values.advertise ? { advertise: values.advertise } : {}),
      ...(values['max-jobs'] ? { maxConcurrentJobs: Number(values['max-jobs']) } : {}),
    });
    out(`Enrolled "${state.name}" as node ${state.enrollment?.nodeId ?? '?'}.`);
    out(`The Hub will call this node at ${state.endpoint}.`);
    out(`State: ${statePath(dataDir)} (keep it private).`);
    out(`Start it with: nova-compute run --data-dir ${dataDir}`);
    return 0;
  }
  if (command === 'run') {
    const { values } = parseArgs({ args: rest, options: { 'data-dir': { type: 'string' } } });
    const node = await ComputeNode.start({ dataDir: values['data-dir'] ?? defaultDataDir() });
    const stop = () => void node.stop();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    const reason = await node.done;
    if (reason === 'revoked') {
      process.stderr.write('This node was revoked by its Hub. Enroll it again with a new token.\n');
      return 3;
    }
    return 0;
  }
  process.stderr.write(USAGE);
  return command === undefined || command === 'help' || command === '--help' ? 0 : 2;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`nova-compute: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
