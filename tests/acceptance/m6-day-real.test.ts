// M6 gate evidence with the real local models (not CI): the same day as m6-day.test.ts, against
// the Ollama on this machine. Free and local; skipped unless NOVA_REAL_OLLAMA=1. The hardware is
// read for real, the roles are what the model manager recommends from what is installed, and it
// accepts them. Screenpipe is still the stand-in (none is installed here), and there is no standby.
// Writes docs/evidence/m6-day.md, also when a step fails part-way, so what happened is on record.
//
// Nova reaches the real Ollama (NOVA_REAL_OLLAMA_URL, default http://127.0.0.1:11434) through a
// loopback relay this test runs, which passes only reading and inference on and refuses anything
// else (no pull, no delete, no create): Ollama is only read and asked here. The midday outage is
// that relay closing, so the address Nova's local models are served from becomes a dead port;
// Ollama itself keeps running, untouched. What a model decides is recorded as it happened.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request, type Server } from 'node:http';
import { startFakeOpenAI } from '../../scripts/stand-ins/fake-openai.js';
import { startFakeScreenpipe } from '../../scripts/fake-screenpipe.js';
import { blank, stop, type Running } from './support.ts';
import { day, writeEvidence } from './m6-day-support.ts';

const on = process.env.NOVA_REAL_OLLAMA === '1';

// Reading and inference only.
const ALLOWED = new Set(['GET /api/version', 'GET /api/tags', 'GET /api/ps', 'POST /api/show', 'POST /api/chat', 'POST /api/generate', 'POST /api/embed', 'POST /api/embeddings', 'GET /v1/models', 'POST /v1/chat/completions']);

async function relay(target: string) {
  const to = new URL(target);
  const refused: string[] = [];
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (!ALLOWED.has(`${req.method} ${path}`)) {
      refused.push(`${req.method} ${path}`);
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'The gate’s relay only passes reading and inference to this Ollama.' }));
      return;
    }
    const up = request({ host: to.hostname, port: to.port || 80, method: req.method, path: req.url, headers: { ...req.headers, host: to.host } }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on('error', (e) => { if (!res.headersSent) res.writeHead(502); res.end(String(e.message)); });
    req.pipe(up);
  });
  const listen = (port: number) => new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve((server.address() as { port: number }).port); });
  });
  const port = await listen(0);
  return {
    url: `http://127.0.0.1:${port}`, port, refused,
    down: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
    up: async () => { await listen(port); },
    close: () => new Promise<void>((r) => { if (!server.listening) return r(); server.closeAllConnections(); server.close(() => r()); }),
  };
}

test('M6 evidence: the day in the life against the real local Ollama, local-only', { skip: !on && 'set NOVA_REAL_OLLAMA=1 to run against the local Ollama', timeout: 3_600_000 }, async () => {
  const target = process.env.NOVA_REAL_OLLAMA_URL ?? 'http://127.0.0.1:11434';
  const version = await fetch(`${target}/api/version`).then((r) => r.json() as Promise<{ version: string }>);
  const r = await relay(target);
  const cloud = await startFakeOpenAI({ model: 'cloud-model', reply: () => 'Answer from the cloud stand-in.' });
  const sp = await startFakeScreenpipe();
  const m = blank('nova-m6-real-');
  let nova: Running | null = null;
  const lines: string[] = [];
  let error: unknown = null;
  const started = Date.now();
  try {
    nova = await m.start({ NOVA_TEST_CLOCK: '1', NOVA_OLLAMA_URL: r.url, NOVA_MODELS_WATCH_MS: '1000', NOVA_CAPTURE_POLL_MS: '3600000' });
    const { failures } = await day({
      hub: m, standby: null, sp, cloud, strict: false, waitMs: 900_000, lines,
      outage: {
        how: `simulated, not a real crash: Nova reaches Ollama through a loopback relay (${r.url} → ${target}), and the relay stops listening, so the address the reasoner (and the sorting model, on the same runtime) is served from is a dead port. The real Ollama keeps running; at 13:30 the relay listens again on the same port.`,
        down: () => r.down(),
        up: () => r.up(),
      },
      title: 'M6 gate — a day in the life, local-only (real run)',
      intro: [
        `Run ${new Date().toISOString()} on this machine, with the real Ollama ${version.version} at ${target} (read and asked only: a relay in front of it refuses pull, delete and anything but reading and inference). The hardware was read for real; the roles are the model manager’s own recommendation from installed models, accepted as recommended. Screenpipe is the stand-in (it isn’t installed here) and there is no standby (the CI run, m6-day.test.ts, has one). Times in headings are capture’s test clock; durations are wall time. Not part of CI: \`NOVA_REAL_OLLAMA=1 node --test tests/acceptance/m6-day-real.test.ts\`.`,
      ],
    });
    lines.push('', `Model-dependent steps not as hoped: ${failures.length ? failures.length : 'none'}.`);
  } catch (e) {
    error = e;
    lines.push('', '## The run stopped here', '', `After ${((Date.now() - started) / 1000).toFixed(0)} s: ${(e as Error).message}`);
  } finally {
    if (nova) await stop(nova);
    await r.close();
    await cloud.close();
    await sp.close();
  }
  lines.push('', `The relay refused ${r.refused.length ? r.refused.join(', ') : 'nothing'} (nothing but reading and inference was asked of Ollama).`);
  writeEvidence(lines);
  console.log(lines.join('\n'));
  if (error) throw error;
  assert.deepEqual(r.refused, [], 'Nova asked Ollama for nothing but reading and inference');
});
