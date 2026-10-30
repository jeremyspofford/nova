// M5 gate evidence with a real model (not CI): the same calc/ brief as tests/acceptance/m5-gate,
// sent to the Ollama on this machine through the openai-compatible provider, local-only. Free and
// local; skipped unless NOVA_REAL_OLLAMA=1. Model: NOVA_REAL_MODEL (default qwen3-coder:30b), at
// NOVA_REAL_OLLAMA_URL (default http://127.0.0.1:11434/v1). Writes docs/evidence/m5-ollama.md.
// If the model can't do it, that is recorded as it happened: a failed task with Nova's reason.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, blank, stop, until } from './support.ts';
import { FIXED_SUM, calcTask, writeCalc } from '../support/providers.ts';

const on = process.env.NOVA_REAL_OLLAMA === '1';

test('M5 evidence: the calc/ brief done by a real local model through the envelope, verified by Nova', { skip: !on && 'set NOVA_REAL_OLLAMA=1 to run against the local Ollama', timeout: 900_000 }, async () => {
  const model = process.env.NOVA_REAL_MODEL ?? 'qwen3-coder:30b';
  const base = process.env.NOVA_REAL_OLLAMA_URL ?? 'http://127.0.0.1:11434/v1';
  const m = blank('nova-m5-ollama-');
  const nova = await m.start();
  const api = (p: string) => `/api/v1${p}`;
  const started = Date.now();
  try {
    writeCalc(join(m.home, 'workspace'));
    await m.send('PUT', api('/providers/openai-compatible/config'), { config: { base_url: base, model } });
    assert.equal((await m.send('POST', api('/providers/openai-compatible/enable'), { approved: true })).body.enabled, true);
    const created = await m.send('POST', api('/tasks'), calcTask('openai-compatible', { privacy_mode: 'local-only' }));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.id as string;
    await until<any>(() => m.get(api(`/tasks/${id}`)), (t) => t.state === 'waiting', 400);
    await m.send('POST', api(`/tasks/${id}/approve`), {});
    const t = await until<any>(() => m.get(api(`/tasks/${id}`)), (x) => ['done', 'failed', 'cancelled'].includes(x.state), 32_000);
    const receipts = await m.get(api(`/receipts?task_id=${id}`));
    const events = await m.get(api(`/tasks/${id}/events`));
    const lines = [
      '# M5 evidence — a real local model',
      '',
      `Run ${new Date().toISOString()}, ${Math.round((Date.now() - started) / 1000)} s. Provider \`openai-compatible\` → Ollama at ${base}, model \`${model}\`, task privacy local-only. Not part of CI.`,
      '',
      `- **Brief:** ${t.title} (\`${calcTask('x').inputs.test_command}\`, evidence: test_result + file_diff).`,
      `- **Outcome:** ${t.state}${t.reason ? ` — ${t.reason}` : ''}.`,
      ...((t.verification?.checks ?? []) as { ok: boolean; why: string; requirement: { kind: string } }[]).map((c) => `- **${c.requirement.kind}:** ${c.ok ? 'passed' : 'failed'} — ${c.why}`),
      `- **Receipts:** ${receipts.map((r: { provider: string; egress: string }) => `${r.provider} (egress ${r.egress})`).join(', ')}.`,
      `- **Events:** ${events.map((e: { kind: string }) => e.kind).join(' → ')}.`,
      `- **Egress tripwire:** ${readFileSync(m.egress, 'utf8') === '' ? 'nothing tried to leave this machine' : 'something tried to leave this machine'}.`,
      '',
    ];
    mkdirSync(join(ROOT, 'docs', 'evidence'), { recursive: true });
    writeFileSync(join(ROOT, 'docs', 'evidence', 'm5-ollama.md'), lines.join('\n'));
    console.log(lines.join('\n'));
    assert.ok(receipts.length >= 1 && receipts.every((r: { egress: string }) => r.egress === 'local'), 'every call stayed local');
    assert.equal(readFileSync(m.egress, 'utf8'), '');
    if (t.state === 'done') assert.equal(readFileSync(join(m.home, 'workspace', 'calc', 'sum.mjs'), 'utf8').replace(/\s+$/, ''), FIXED_SUM.replace(/\s+$/, ''), 'or an equivalent fix');
  } finally {
    await stop(nova);
  }
});
