// The worker thread a script runs in (FR-202): one script per worker, so the engine never
// shares the Hub's event loop, stack or heap, and the Hub can terminate it outright. The
// worker only relays: nested calls go to the parent as messages and their answers come back.
// It runs under Node's type stripping, so it imports nothing but the engine.
import { parentPort, workerData } from 'node:worker_threads';
import { runScript, type BridgeAnswer, type ScriptLimits } from './vm.ts';

interface Start {
  code: string;
  inputJson: string;
  names: string[];
  limits: ScriptLimits;
}

const port = parentPort;
if (port) {
  const start = workerData as Start;
  const waiting = new Map<number, (a: BridgeAnswer) => void>();
  let next = 1;
  port.on('message', (m: { type: 'answer'; id: number; answer: BridgeAnswer }) => {
    if (m.type !== 'answer') return;
    const resolve = waiting.get(m.id);
    waiting.delete(m.id);
    resolve?.(m.answer);
  });
  void runScript(
    { code: start.code, inputJson: start.inputJson, names: start.names, limits: start.limits },
    {
      call: (name, argsJson) =>
        new Promise<BridgeAnswer>((resolve) => {
          const id = next++;
          waiting.set(id, resolve);
          port.postMessage({ type: 'call', id, name, argsJson });
        }),
    },
  ).then((outcome) => {
    port.postMessage({ type: 'done', outcome });
  });
}
