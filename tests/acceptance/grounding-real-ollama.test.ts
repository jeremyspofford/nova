// The grounding questions against a real local model (not CI): the same registry state and the same
// four questions as tests/acceptance/grounding.test.ts, asked through the real server and runner with
// the openai-compatible provider pointed at the Ollama on this machine as the chat model, local-only.
// Free and local; skipped unless NOVA_REAL_OLLAMA=1. Model: NOVA_REAL_MODEL (default gemma4:12b), at
// NOVA_REAL_OLLAMA_URL (default http://127.0.0.1:11434/v1). Never a cloud model.
// Writes the transcripts to docs/evidence/agent-grounding-live.md, with what each answer got right or
// wrong against the registry, as it happened. It asserts only that every call stayed local.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNova } from '../../src/server.js';
import { loadConfig } from '../../src/config.js';
import { startFakeScreenpipe } from '../../scripts/fake-screenpipe.js';
import { QUESTIONS } from './grounding-support.ts';

const on = process.env.NOVA_REAL_OLLAMA === '1';
const ROOT = join(import.meta.dirname, '..', '..');

type Item = { kind: string; name?: string; text?: string; args?: unknown; message?: string; result?: { ok: boolean; output: string } | null; approval?: { decision: string } | null };

test('grounding with a real local model: the four questions, transcripts kept', { skip: !on && 'set NOVA_REAL_OLLAMA=1 to run against the local Ollama', timeout: 3_600_000 }, async () => {
  const model = process.env.NOVA_REAL_MODEL ?? 'gemma4:12b';
  const base = process.env.NOVA_REAL_OLLAMA_URL ?? 'http://127.0.0.1:11434/v1';
  assert.match(new URL(base).hostname, /^(127\.0\.0\.1|localhost|::1)$/, 'only a model on this machine');
  const home = mkdtempSync(join(tmpdir(), 'nova-grounding-live-'));
  const sp = await startFakeScreenpipe();
  const nova = createNova({ ...loadConfig({ NOVA_HOME: home, NOVA_AGENT_CMD: 'example-model-command', NOVA_AGENT_EGRESS: 'none', NOVA_TZ: 'UTC', NOVA_INSTANCE: 'development' }), port: 0, commit: false } as ReturnType<typeof loadConfig>);
  const { core, runner } = nova;
  const started = Date.now();
  try {
    core.providers.configure('openai-compatible', { base_url: base, model });
    core.providers.enable('openai-compatible', { approved: true });
    core.providers.choose('chat', 'openai-compatible');
    // The registry, as in the scripted test: no OpenRouter; Screenpipe wants its key; one schedule;
    // a design system chosen.
    sp.requireKey('example-capture-key');
    const src = core.capture.addScreenpipe({ url: sp.base });
    core.capture.enable(src.id, { by: 'person' });
    await core.capture.pull(src.id);
    runner.schedules.set({ name: 'Morning summary', cron: '0 7 * * *', prompt: 'Summarize what is on today.' });
    core.design.apply('obsidian', { scope: 'user' });
    const detail = core.capture.source(src.id).detail ?? '';

    const checks: Record<keyof typeof QUESTIONS, (reply: string, tools: string[]) => { right: string[]; wrong: string[] }> = {
      provider: (r, t) => verdict([
        [t.some((n) => n.startsWith('nova_')), 'checked Nova’s registry with a status tool'],
        [/not (in|part of) (my|your|the) (current )?setup|not (set up|configured|connected)|isn’t (set up|configured|connected)|isn't (set up|configured|connected)|no openrouter/i.test(r), 'said OpenRouter isn’t in the current setup'],
        [/Settings › Providers|Settings > Providers|Providers/i.test(r), 'named the way to add it (Settings › Providers)'],
        [!/I run on|I can['’]t (connect|use|do)|as an AI/i.test(r), 'did not answer “I can’t, I run on X”'],
      ]),
      background: (r, t) => verdict([
        [t.includes('nova_schedules') || t.some((n) => n.startsWith('nova_')), 'checked schedules with a status tool'],
        [/Morning summary/i.test(r), 'named the real schedule, Morning summary'],
        [!/can['’]t (do|run|work) .*background|no ability|I don['’]t have the ability/i.test(r), 'did not deny background work'],
      ]),
      appearance: (r, t) => verdict([
        [t.some((n) => n.startsWith('nova_')), 'checked appearance with a status tool'],
        [/Obsidian/.test(r), 'named the active design system, Obsidian'],
        [/Settings › Appearance|Settings > Appearance|Appearance/i.test(r), 'pointed to Settings › Appearance'],
        [!/(I'?ve|I have) (switched|changed)|switched (you|it) to/i.test(r), 'did not claim to have switched it'],
      ]),
      capture: (r, t) => verdict([
        [t.includes('nova_capture'), 'checked capture with nova_capture'],
        [/API key|refused Nova|needs (a|the) key/i.test(r), 'quoted the real error (Screenpipe wants its API key)'],
        [!/firewall|restart your (computer|machine)|reinstall/i.test(r), 'no generic troubleshooting guesses about the machine'],
      ]),
    };

    const out: string[] = [];
    for (const [key, q] of Object.entries(QUESTIONS) as [keyof typeof QUESTIONS, string][]) {
      const id = runner.createSession(q);
      runner.send(id, q);
      for (let i = 0; i < 360_000 / 50; i++) {
        const live = runner.liveState(id);
        if (!live) break;
        // Nothing here should need an OK; anything that asks is declined and kept in the transcript.
        if (live.phase === 'approval') runner.decide(id, live.approval, 'deny');
        await new Promise((r) => setTimeout(r, 50));
      }
      await runner.idle(id);
      const turn = (runner.snapshot(id).session as { turns: { state: string; items: Item[] }[] }).turns[0]!;
      const tools = turn.items.filter((i) => i.kind === 'tool');
      const reply = turn.items.filter((i) => i.kind === 'text').map((i) => i.text).join('\n\n').trim();
      const v = checks[key](reply, tools.map((t) => t.name!));
      out.push(`### ${key}: “${q}”`, '');
      for (const t of tools) {
        out.push(`- **Tool:** \`${t.name}\` ${JSON.stringify(t.args)}${t.approval?.decision === 'deny' ? ' (declined)' : ''}`);
        if (t.result) out.push('', '```text', t.result.output.slice(0, 1800), '```', '');
      }
      if (!tools.length) out.push('- **Tool:** none used');
      const err = turn.items.find((i) => i.kind === 'error');
      if (err) out.push(`- **Error:** ${err.message}`);
      out.push('', '**Reply:**', '', reply ? reply.split('\n').map((l) => `> ${l}`).join('\n') : '> (no reply)', '');
      out.push(`**Checks:** ${[...v.right.map((x) => `✓ ${x}`), ...v.wrong.map((x) => `✗ ${x}`)].join('; ')}.`, '');
    }
    const receipts = core.receipts.list({ limit: 500 });
    const head = [
      '# Agent grounding — live local model',
      '',
      `Run ${new Date().toISOString()}, ${Math.round((Date.now() - started) / 1000)} s. Chat model: the \`openai-compatible\` provider → Ollama at ${base}, model \`${model}\`; privacy local-only. Not part of CI (\`NOVA_REAL_OLLAMA=1 node --test tests/acceptance/grounding-real-ollama.test.ts\`).`,
      '',
      `Registry: no OpenRouter provider; Screenpipe (stand-in) refusing Nova until its API key is set (“${detail}”); one schedule, Morning summary, every day at 7:00; Obsidian chosen out of the six installed design systems.`,
      '',
    ];
    mkdirSync(join(ROOT, 'docs', 'evidence'), { recursive: true });
    writeFileSync(join(ROOT, 'docs', 'evidence', 'agent-grounding-live.md'), [...head, ...out].join('\n'));
    console.log([...head, ...out].join('\n'));
    for (const r of receipts as { egress: string }[]) assert.equal(r.egress, 'local', 'every call stayed on this machine');
  } finally {
    nova.scheduler.stop();
    await core.close();
    await sp.close();
  }
});

function verdict(pairs: [boolean, string][]) {
  return { right: pairs.filter(([ok]) => ok).map(([, s]) => s), wrong: pairs.filter(([ok]) => !ok).map(([, s]) => s) };
}
