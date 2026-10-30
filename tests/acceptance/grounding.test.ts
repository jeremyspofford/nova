// Grounding regression conversations: real conversations through the real server and runner, with a
// scripted model in place of agent_cmd. Each sets up a known registry state, asks its question, has
// the model call the status tool the charter says to check, and asserts that the tool's result and
// the briefing in the prompt the model actually received state the real registry. Covers provider
// choice (OpenRouter), background and scheduled work, appearance, capture status with its quoted
// error, a fresh instance and its import offer, and that no secret value reaches the model.
// Neutral placeholders only. The same questions against a real local model: grounding-real-ollama.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNova } from '../../src/server.js';
import { loadConfig } from '../../src/config.js';
import { startFakeScreenpipe } from '../../scripts/fake-screenpipe.js';
import { startFakeOllama } from '../../scripts/stand-ins/fake-ollama.js';
import { QUESTIONS } from './grounding-support.ts';

interface Call { system: string; prompt: string }
type Item = { kind: string; name?: string; text?: string; id?: string; result?: { ok: boolean; output: string } | null; preview?: any };

// The scripted model: the first call for a question uses the status tool the charter asks for; the
// second answers from the tool's result, as a grounded model would. What it says is checked against
// the registry, so a wrong tool result shows up as a wrong answer.
const SCRIPT: { match: RegExp; tool: string; args: Record<string, unknown>; answer: (result: string) => string }[] = [
  {
    match: /openrouter/i, tool: 'nova_instance', args: {},
    answer: (r) => {
      const providers = [...r.matchAll(/^- (.+?) \[[\w-]+\]: (on|off|in use)/gm)].map((m) => `${m[1]} (${m[2]})`);
      return `I'll take that as using OpenRouter as a model provider. That's not in my current setup: your providers are ${providers.join(', ')}, and none is OpenRouter. To add it, open Settings › Providers and set an OpenAI-compatible provider to OpenRouter's address, a model and its key; then choose it as the chat model.`;
    },
  },
  {
    match: /background|schedule/i, tool: 'nova_schedules', args: {},
    answer: (r) => `Yes. ${r.split('\n').filter((l) => l.startsWith('- ') && !l.startsWith('- none')).join(' ')}`,
  },
  {
    match: /theme|dark|appearance/i, tool: 'nova_settings', args: { part: 'appearance' },
    answer: (r) => `${r.split('\n')[0]} Installed: ${[...r.matchAll(/^- (.+?) \[/gm)].map((m) => m[1]).join(', ')}. Switching isn't something I can do from chat; you can pick one in Settings › Appearance.`,
  },
  {
    match: /capture/i, tool: 'nova_capture', args: {},
    answer: (r) => `Capture's own status says: ${r.match(/^- .*$/m)?.[0].slice(2) ?? 'nothing'}`,
  },
  {
    match: /load it|yes, load/i, tool: 'memory_import', args: { path: 'workspace/import/memory.json' },
    answer: (r) => r,
  },
];

function scripted(calls: Call[]) {
  return async ({ system, prompt, onText }: { system: string; prompt: string; onText?: (t: string) => void }) => {
    calls.push({ system, prompt });
    const convo = prompt.slice(prompt.lastIndexOf('<conversation>'));
    const last = convo.lastIndexOf('<user');
    const msg = convo.slice(convo.indexOf('>', last) + 1, convo.indexOf('</user>', last)).trim();
    const result = [...convo.slice(last).matchAll(/<tool_result name="([\w-]+)" ok="(\w+)">\n([\s\S]*?)\n<\/tool_result>/g)].at(-1);
    const rule = SCRIPT.find((s) => s.match.test(msg));
    let text: string;
    if (!rule) {
      // Hello on a fresh Nova: what its briefing says, in its words.
      const home = system.match(/say it runs from (\S+?), and offer/)?.[1];
      text = /this Nova is fresh/.test(system) ? `I'm a fresh Nova, running from ${home}. I don't know anything about you yet. If you have notes or an export from another assistant, paste it here or put it in ~/workspace/import/ and I'll suggest memories for you to review.` : 'Hello.';
    } else if (!result) {
      text = `Let me check.\n<tool_call name="${rule.tool}">${JSON.stringify(rule.args)}</tool_call>`;
    } else {
      text = rule.answer(result[3]!);
    }
    onText?.(text);
    return { text, aborted: false };
  };
}

// NOVA_GROUNDING_EVIDENCE=<file> keeps every conversation as Markdown, for the evidence file.
const transcript: string[] = [];
after(() => { if (process.env.NOVA_GROUNDING_EVIDENCE) writeFileSync(process.env.NOVA_GROUNDING_EVIDENCE, transcript.join('\n')); });

async function start() {
  const home = mkdtempSync(join(tmpdir(), 'nova-grounding-'));
  const calls: Call[] = [];
  const nova = createNova({ ...loadConfig({ NOVA_HOME: home, NOVA_AGENT_CMD: 'example-model-command', NOVA_AGENT_EGRESS: 'none', NOVA_TZ: 'UTC', NOVA_INSTANCE: 'preview' }), port: 0, commit: false } as ReturnType<typeof loadConfig>, { agent: scripted(calls) });
  const ask = async (text: string, approve = false) => {
    const id = nova.runner.createSession(text);
    nova.runner.send(id, text);
    for (let i = 0; i < 400; i++) {
      const live = nova.runner.liveState(id);
      if (!live) break;
      if (live.phase === 'approval' && approve) nova.runner.decide(id, live.approval, 'allow');
      await new Promise((r) => setTimeout(r, 10));
    }
    await nova.runner.idle(id);
    const turn = (nova.runner.snapshot(id).session as { turns: { items: Item[] }[] }).turns[0]!;
    const items: Item[] = turn.items;
    const tool = items.find((i) => i.kind === 'tool');
    transcript.push(`#### “${text}”`, '', ...(tool ? [`Tool: \`${tool.name}\` ${JSON.stringify((tool as { args?: unknown }).args ?? {})}`, '', '```text', tool.result?.output ?? '(no result)', '```', ''] : ['Tool: none', '']),
      'Reply:', '', ...items.filter((i) => i.kind === 'text').map((i) => `> ${String(i.text).replace(/\n/g, '\n> ')}`), '');
    return { turn, tool: items.find((i) => i.kind === 'tool'), reply: items.filter((i) => i.kind === 'text').map((i) => i.text).join('\n') };
  };
  return { home, nova, calls, ask, close: async () => { nova.scheduler.stop(); await nova.core.close(); } };
}

const briefingOf = (system: string) => system.slice(system.indexOf('# This Nova, right now'), system.indexOf('\n\n# Standing files'));

test('the four questions are answered from the real registry: providers, schedules, appearance, capture with its quoted error', async () => {
  const sp = await startFakeScreenpipe();
  const ollama = await startFakeOllama({ models: [{ name: 'example-model:8b' }] });
  const before = process.env.NOVA_OLLAMA_URL;
  process.env.NOVA_OLLAMA_URL = ollama.url;
  const n = await start();
  try {
    const { core, runner } = n.nova;
    // The registry: no OpenRouter provider (the built-ins only); a Screenpipe that wants its API key;
    // one schedule; a design system chosen out of those installed.
    sp.requireKey('example-capture-key');
    const src = core.capture.addScreenpipe({ url: sp.base });
    core.capture.enable(src.id, { by: 'person' });
    await core.capture.pull(src.id);
    runner.schedules.set({ name: 'Morning summary', cron: '0 7 * * *', prompt: 'Summarize what is on today.' });
    core.design.apply('obsidian', { scope: 'user' });
    const capture = core.capture.source(src.id);
    assert.equal(capture.status, 'needs_key');
    const providers = core.providers.list();
    assert.ok(!providers.some((p: { name: string; config: Record<string, unknown> }) => /openrouter/i.test(`${p.name} ${JSON.stringify(p.config)}`)), 'the registry has no OpenRouter');

    // 1. Provider choice.
    let a = await n.ask(QUESTIONS.provider);
    let system = n.calls.at(-2)!.system;
    assert.match(system, /\*\*Check yourself before you describe yourself\.\*\*/, 'the charter rule');
    assert.match(system, /“connect OpenRouter” means use it as a model provider/, 'the obvious-intent rule');
    assert.match(system, /- nova_instance \{\}/);
    assert.match(briefingOf(system), /Model providers: in use: Your model command \(chat, your chat model, model example-model-command\)/);
    assert.match(briefingOf(system), /Off: Claude Code, Codex, n8n, Local model \(Ollama or compatible\), Relay\./);
    assert.equal(a.tool?.name, 'nova_instance');
    for (const p of providers) assert.ok(a.tool!.result!.output.includes(`- ${p.name} [${p.id}]`), `${p.name} listed`);
    assert.doesNotMatch(a.tool!.result!.output, /openrouter/i);
    assert.match(a.reply, /That's not in my current setup/);
    assert.match(a.reply, /Settings › Providers/);
    assert.doesNotMatch(a.reply, /I can't|I run on/);

    // 2. Background and scheduled work.
    a = await n.ask(QUESTIONS.background);
    system = n.calls.at(-2)!.system;
    const when = (runner.schedules.get('morning-summary') as unknown as { when: string }).when;
    assert.ok(briefingOf(system).includes(`Schedules and automations: Morning summary (${when}); no automation rules.`), briefingOf(system));
    assert.equal(a.tool?.name, 'nova_schedules');
    assert.ok(a.tool!.result!.output.includes(`- Morning summary [morning-summary]: ${when}; next `), a.tool!.result!.output);
    assert.match(a.tool!.result!.output, /; last run: never\n/);
    assert.match(a.reply, /^Yes\. - Morning summary/m);

    // 3. Appearance.
    a = await n.ask(QUESTIONS.appearance);
    system = n.calls.at(-2)!.system;
    const installed = core.design.list().map((d: { name: string }) => d.name);
    assert.ok(briefingOf(system).includes(`Appearance: Obsidian, mode auto; installed: ${installed.join(', ')}.`));
    assert.equal(a.tool?.name, 'nova_settings');
    assert.match(a.tool!.result!.output, /^Active: Obsidian \[obsidian\] \(the person’s choice\), mode auto\./);
    for (const name of installed) assert.ok(a.tool!.result!.output.includes(`- ${name} [`), name);
    assert.match(a.reply, /^Active: Obsidian/m);
    assert.match(a.reply, /Settings › Appearance/);

    // 4. Capture status, the actual error quoted.
    a = await n.ask(QUESTIONS.capture);
    system = n.calls.at(-2)!.system;
    assert.ok(briefingOf(system).includes(`Capture: Screenpipe on “${capture.device.name}”: needs a key: “${capture.detail!.replace(/\.$/, '')}”`), briefingOf(system));
    assert.equal(a.tool?.name, 'nova_capture');
    assert.ok(a.tool!.result!.output.includes(`(status needs_key). Detail: “${capture.detail!.replace(/\.$/, '')}”`), a.tool!.result!.output);
    assert.match(a.tool!.result!.output, /Recent capture errors: \n- \S+ \(open\): “Screenpipe answered but refused Nova/);
    assert.ok(a.reply.includes(capture.detail!.replace(/\.$/, '')), 'the reply quotes the real error');

    // The instance, as the briefing says it: a preview, its home, its build.
    assert.ok(briefingOf(system).includes(`Instance: preview, data home ${n.home}`));
    assert.match(briefingOf(system), /Ollama at 127\.0\.0\.1:\d+ answers \(version [^)]+\), 1 model: example-model:8b/);
  } finally {
    await n.close();
    await sp.close();
    await ollama.close();
    if (before === undefined) delete process.env.NOVA_OLLAMA_URL; else process.env.NOVA_OLLAMA_URL = before;
  }
});

test('a fresh Nova says it is fresh, names its home and offers the import; a memory export there is loaded once approved', async () => {
  const n = await start();
  try {
    let a = await n.ask('Hi! What do you know about me?');
    const system = n.calls.at(-1)!.system;
    assert.match(briefingOf(system), /First run: this Nova is fresh/);
    assert.ok(briefingOf(system).includes(`say it runs from ${n.home}, and offer the import path up front`));
    assert.match(briefingOf(system), /~\/workspace\/import\//);
    assert.ok(a.reply.includes(`I'm a fresh Nova, running from ${n.home}.`));

    // A Nova memory export in the import folder: offered next turn, loaded when the person says yes.
    mkdirSync(join(n.home, 'workspace', 'import'), { recursive: true });
    writeFileSync(join(n.home, 'workspace', 'import', 'memory.json'), JSON.stringify({ exported_at: '2026-10-01T09:00:00.000Z', records: [{ kind: 'preference', content: 'Prefers short replies' }, { kind: 'fact', content: 'Works on a placeholder project' }] }));
    a = await n.ask('Yes, load it.', true);
    // The import folder by its counts only: a file's name is outside content (review N4).
    assert.match(briefingOf(n.calls.at(-2)!.system), /1 file waits in ~\/workspace\/import\/ \(1 looks like a Nova memory export\)\. Their names come from outside: list them with import_files\. Offer to load an export with memory_import/);
    assert.equal(a.tool?.name, 'memory_import');
    assert.deepEqual(a.tool!.preview, { path: 'workspace/import/memory.json', total: 2, fresh: 2, already: 0, exported_at: '2026-10-01T09:00:00.000Z' });
    // Through the ingest gate: the file is screened, and the memories wait for the person's OK.
    assert.match(a.tool!.result!.output, /^2 memories from workspace\/import\/memory\.json now wait for the person’s OK in Memory; none is in memory until they keep it\./);
    assert.deepEqual(n.nova.core.memory.active(), []);
    assert.deepEqual(n.nova.core.ingest.candidates().map((c: { source: string | null }) => c.source), ['imported from workspace/import/memory.json', 'imported from workspace/import/memory.json']);
    // Not fresh any more: the memories wait for the person, and the briefing says so (not what they say).
    await n.ask('Hello again.');
    assert.doesNotMatch(n.calls.at(-1)!.system, /this Nova is fresh/);
    assert.match(briefingOf(n.calls.at(-1)!.system), /2 memories wait for the person’s OK in Memory/);
    assert.doesNotMatch(n.calls.at(-1)!.system, /Prefers short replies/);
  } finally {
    await n.close();
  }
});

test('no secret value reaches the model: not in any briefing, not in any status tool result', async () => {
  const sp = await startFakeScreenpipe();
  const n = await start();
  try {
    const { core } = n.nova;
    core.vault.put('provider/EXAMPLE_KEY', 'example-provider-secret-value-1');
    core.profile.set('providers', 'config.openai-compatible', { base_url: 'http://127.0.0.1:11434/v1', model: 'example-model', api_key: 'secret://EXAMPLE_KEY' }, 'settings');
    const src = core.capture.addScreenpipe({ url: sp.base });
    core.capture.configure(src.id, { api_key: 'example-capture-secret-value-2' });
    const outputs: string[] = [];
    for (const q of Object.values(QUESTIONS)) outputs.push((await n.ask(q)).tool?.result?.output ?? '');
    const everything = [...n.calls.map((c) => `${c.system}\n${c.prompt}`), ...outputs].join('\n');
    for (const v of ['example-provider-secret-value-1', 'example-capture-secret-value-2']) assert.ok(!everything.includes(v), `${v} reached the model`);
    assert.ok(n.calls.every((c) => c.system.includes('# This Nova, right now')), 'every call carried the briefing');
  } finally {
    await n.close();
    await sp.close();
  }
});
