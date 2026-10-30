// M6 gate (ROADMAP-AND-GATES, M6 plan §3): a full day in the life, local-only from setup to night,
// on hub-class hardware. CI's run, with stand-ins only: a fixed hub-class hardware reading, the
// stand-in Ollama (its installed models, answers shaped by the caller), the stand-in Screenpipe,
// an OpenAI-compatible stand-in as the cloud model that must never be asked, and two real Nova
// processes (a hub and a standby enrolled with the real command, M4's helpers), each with the
// egress tripwire preloaded. The day itself is m6-day-support.ts; here every step is asserted,
// what a model decides included. NOVA_EVIDENCE=1 writes the step transcript to
// docs/evidence/m6-day.md (the committed file is the real run's; see m6-day-real.test.ts).
import { test } from 'node:test';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { startFakeOllama, fromSchema } from '../../scripts/stand-ins/fake-ollama.js';
import { filesReply, startFakeOpenAI } from '../../scripts/stand-ins/fake-openai.js';
import { startFakeScreenpipe } from '../../scripts/fake-screenpipe.js';
import { CONTRACT_SYSTEM } from '../../src/core/providers/prompt.ts';
import { INSTALLED, hardwareFile } from '../support/models.ts';
import { FIXED_SUM } from '../support/providers.ts';
import { stop, type Running } from './support.ts';
import { setup } from './m4c-support.ts';
import { SENTINEL, day, writeEvidence } from './m6-day-support.ts';

// The stand-in model: a structured decision gets an answer that fits its schema (a capture is worth
// remembering only when it is one of the day's two facts); the calc brief gets the real fix; chat
// gets a plain sentence.
type Req = { messages?: { role: string; content: string }[]; format?: unknown };
function reply(req: Req): string {
  const schema = req.format && typeof req.format === 'object' ? req.format as { properties?: { answers?: { properties?: Record<string, unknown> } } } : null;
  if (schema) {
    const user = req.messages?.at(-1)?.content ?? '';
    if (schema.properties?.answers?.properties && 'remember' in schema.properties.answers.properties) {
      const yes = user.includes(SENTINEL.fact) || user.includes(SENTINEL.outage);
      return JSON.stringify({ answers: { remember: yes ? 0.93 : 0.08 }, confidence: 0.9, why: yes ? 'A dated commitment worth keeping.' : 'Passing activity.' });
    }
    return JSON.stringify(fromSchema(schema));
  }
  if (req.messages?.[0]?.content === CONTRACT_SYSTEM) return filesReply([{ path: 'calc/sum.mjs', content: FIXED_SUM }], 'sum subtracted; it adds now.');
  return 'Start with the quarterly plan draft while the morning is quiet.';
}

test('M6 gate: a day in the life, local-only from setup to night, on hub-class hardware (stand-ins)', { timeout: 240_000 }, async () => {
  let ollama = await startFakeOllama({ models: INSTALLED, reply });
  const port = ollama.port;
  const cloud = await startFakeOpenAI({ model: 'cloud-model', reply: () => 'Answer from the cloud stand-in.' });
  const sp = await startFakeScreenpipe();
  const hw = hardwareFile(mkdtempSync(join(tmpdir(), 'nova-m6-hw-')));
  const s = await setup('nova-m6-day', () => {}, {
    NOVA_TEST_CLOCK: '1', NOVA_OLLAMA_URL: ollama.url, NOVA_HARDWARE_FILE: hw, NOVA_MODELS_WATCH_MS: '150',
    // Capture's own pass is left to the day's clock (POST /capture/tick).
    NOVA_CAPTURE_POLL_MS: '3600000',
  });
  let standbyProc: Running | null = null;
  try {
    standbyProc = await s.standby.start(s.env(s.standbyMesh));
    const lines: string[] = [];
    await day({
      lines,
      hub: s.hub, standby: s.standby, sp, cloud, strict: true, waitMs: 30_000,
      outage: {
        how: 'the stand-in Ollama is stopped (its port refuses connections), then started again on the same port.',
        down: () => ollama.close(),
        up: async () => { ollama = await startFakeOllama({ models: INSTALLED, port, reply }); },
      },
      title: 'M6 gate — a day in the life, local-only (stand-in run)',
      intro: [
        `Run ${new Date().toISOString()}. CI’s run: a fixed hub-class hardware reading, the stand-in Ollama, the stand-in Screenpipe, a hub and a standby as two real Nova processes, the egress tripwire on both. Times are capture’s test clock.`,
      ],
    });
    if (process.env.NOVA_EVIDENCE === '1') writeEvidence(lines);
  } finally {
    if (standbyProc) await stop(standbyProc);
    await stop(s.hubProc);
    await ollama.close();
    await cloud.close();
    await sp.close();
  }
});
