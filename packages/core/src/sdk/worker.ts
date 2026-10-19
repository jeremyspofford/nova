// The worker thread one extension runs in (FR-117; ADR-097 D3). It holds the extension's engine
// and only relays: the engine's requests and answers go to the Hub as messages, and the Hub's
// answers, invocations and the stop come back. The worker has its own heap limits and an empty
// environment; the Hub terminates it outright on disable, uninstall, a fault or shutdown. It runs
// under Node's type stripping, so it imports nothing but the engine.
import { parentPort, workerData } from 'node:worker_threads';
import { ExtensionEngine, type EngineLimits, type EngineStart } from './engine.ts';

export interface WorkerInit {
  start: EngineStart;
  limits: Partial<EngineLimits>;
}

export type FromWorker =
  | { type: 'send'; json: string }
  | { type: 'log'; level: string; text: string }
  | { type: 'fault'; kind: string; message: string };

export type ToWorker = { type: 'deliver'; json: string } | { type: 'start' };

const port = parentPort;
if (port) {
  const init = workerData as WorkerInit;
  const post = (m: FromWorker) => port.postMessage(m);
  let engine: ExtensionEngine | null = null;
  const queued: string[] = [];
  port.on('message', (m: ToWorker) => {
    if (m.type !== 'deliver') return;
    if (engine) engine.deliver(m.json);
    else queued.push(m.json);
  });
  ExtensionEngine.create(
    init.start,
    {
      send: (json) => post({ type: 'send', json }),
      log: (level, text) => post({ type: 'log', level, text }),
      fault: (kind, message) => post({ type: 'fault', kind, message }),
    },
    init.limits,
  ).then(
    (e) => {
      engine = e;
      e.start();
      for (const json of queued.splice(0)) e.deliver(json);
    },
    (err: unknown) =>
      post({
        type: 'fault',
        kind: 'crash',
        message: err instanceof Error ? err.message : 'the extension engine did not start',
      }),
  );
}
