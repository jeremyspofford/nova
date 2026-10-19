// A stand-in for an extension's worker that speaks the protocol directly (tests only): it sends
// the raw messages listed in its `script.js` source (JSON) and reports every message the Hub
// delivers as a console line, so a test can check how the host answers malformed or hostile
// requests that the real engine's prelude would never produce.
import { parentPort, workerData } from 'node:worker_threads';

const port = parentPort;
if (port) {
  const data = workerData as { start: { sources: Record<string, string> } };
  const script = JSON.parse(data.start.sources['script.js'] ?? '[]') as unknown[];
  port.on('message', (m: { type: string; json?: string }) => {
    if (m.type === 'deliver')
      port.postMessage({ type: 'log', level: 'info', text: `got ${m.json}` });
  });
  for (const msg of script) port.postMessage(msg);
}
