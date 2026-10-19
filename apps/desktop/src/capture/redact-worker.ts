// The redaction worker: an Electron utility process in the app, a forked Node child in tests. It
// answers `{id, title, text}` with the redacted job; the main process kills it on a timeout.
import { redactJob, type RedactJob } from './redact.ts';

interface Port {
  on(event: 'message', listener: (m: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}

function answer(msg: unknown): unknown {
  const m = msg as Partial<RedactJob & { id: number }> | null;
  if (!m || typeof m.id !== 'number' || typeof m.title !== 'string')
    return { id: -1, error: 'bad job' };
  const text = typeof m.text === 'string' ? m.text : null;
  return { id: m.id, ...redactJob({ title: m.title, text }) };
}

const parentPort = (process as unknown as { parentPort?: Port }).parentPort;
if (parentPort) parentPort.on('message', (m) => parentPort.postMessage(answer(m.data)));
else process.on('message', (m) => process.send?.(answer(m)));
