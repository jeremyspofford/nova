// M5 gate evidence with real Claude Code (not CI). The owner OK'd one small run on their
// subscription (2026-10-30). The same calc/ brief as tests/acceptance/m5-gate, sent to the
// `claude-code` provider running the real `claude` CLI in the task's own folder, cloud-allowed.
// Skipped unless NOVA_REAL_CLAUDE=1. The server gets the person's real HOME so the CLI finds its
// sign-in; Nova's own home is still a throwaway test folder. Writes docs/evidence/m5-claude-code.md.
// If Claude Code can't do it, that is recorded as it happened: a failed task with Nova's reason.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ROOT, blank, stop, until } from './support.ts';
import { calcTask, writeCalc } from '../support/providers.ts';

const on = process.env.NOVA_REAL_CLAUDE === '1';

test('M5 evidence: the calc/ brief done by real Claude Code through the envelope, verified by Nova', { skip: !on && 'set NOVA_REAL_CLAUDE=1 to run real Claude Code (uses the owner’s subscription)', timeout: 900_000 }, async () => {
  const m = blank('nova-m5-claude-');
  const nova = await m.start({ HOME: homedir() });
  const api = (p: string) => `/api/v1${p}`;
  const started = Date.now();
  try {
    writeCalc(join(m.home, 'workspace'));
    await m.send('PUT', api('/profile/privacy/default'), { value: 'cloud-allowed' });
    assert.equal((await m.send('PUT', api('/providers/claude-code/config'), { config: { command: 'claude' } })).status, 200);
    assert.equal((await m.send('POST', api('/providers/claude-code/enable'), { approved: true })).body.enabled, true);
    const created = await m.send('POST', api('/tasks'), calcTask('claude-code'));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.id as string;
    // Nova asks, after Claude Code has finished and showing what changed, before it runs the test
    // on that code; the OK is given here as the person would.
    let t: any;
    let asked = '';
    for (;;) {
      t = await until<any>(() => m.get(api(`/tasks/${id}`)), (x) => ['done', 'failed', 'cancelled', 'waiting'].includes(x.state), 32_000);
      if (t.state !== 'waiting') break;
      const ask = await m.send('GET', api(`/providers/tasks/${id}/test-run`));
      assert.equal(ask.status, 200, `waiting, but not for the test run: ${t.reason}`);
      asked = `${ask.body.files.map((f: { path: string }) => f.path).join(', ')} — “${ask.body.words}”`;
      await m.send('POST', api(`/providers/tasks/${id}/test-run`), {});
      await until<any>(() => m.get(api(`/tasks/${id}`)), (x) => x.state !== 'waiting', 400);
    }
    const receipts = await m.get(api(`/receipts?task_id=${id}`));
    const events = await m.get(api(`/tasks/${id}/events`));
    const lines = [
      '# M5 evidence — real Claude Code',
      '',
      `Run ${new Date().toISOString()}, ${Math.round((Date.now() - started) / 1000)} s. Provider \`claude-code\` → the real \`claude\` CLI (one small run, OK’d by the owner on their subscription), task privacy cloud-allowed. Not part of CI.`,
      '',
      `- **Brief:** ${t.title} (\`${calcTask('x').inputs.test_command}\`, evidence: test_result + file_diff).`,
      `- **Asked before running Claude Code's code:** ${asked || '(not asked)'}`,
      `- **Outcome:** ${t.state}${t.reason ? ` — ${String(t.reason).replace(/[.\s]+$/, '')}` : ''}.`,
      ...((t.verification?.checks ?? []) as { ok: boolean; why: string; requirement: { kind: string } }[]).map((c) => `- **${c.requirement.kind}:** ${c.ok ? 'passed' : 'failed'} — ${c.why}`),
      `- **Receipts:** ${receipts.map((r: { provider: string; egress: string }) => `${r.provider} (egress ${r.egress})`).join(', ')}.`,
      `- **Events:** ${events.map((e: { kind: string }) => e.kind).join(' → ')}.`,
      '',
    ];
    mkdirSync(join(ROOT, 'docs', 'evidence'), { recursive: true });
    writeFileSync(join(ROOT, 'docs', 'evidence', 'm5-claude-code.md'), lines.join('\n'));
    console.log(lines.join('\n'));
    assert.ok(receipts.length >= 1 && receipts.every((r: { egress: string }) => r.egress === 'remote:anthropic'), 'the receipt says where the data went');
    if (t.state === 'done') assert.match(readFileSync(join(m.home, 'workspace', 'calc', 'sum.mjs'), 'utf8'), /a \+ b/);
  } finally {
    await stop(nova);
  }
});
