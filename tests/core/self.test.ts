// Grounding (src/core/self.ts): the briefing and the status tools say what this Nova really is, read
// from the core's own registries in process; never a secret, never a memory's or a capture's words;
// a fresh Nova says so and offers the way in; a Nova memory export in ~/workspace/import/ is found
// and loaded as memories the person reviews. Neutral placeholders only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startFakeScreenpipe } from '../../scripts/fake-screenpipe.js';
import { startFakeOllama } from '../../scripts/stand-ins/fake-ollama.js';
import { hub } from './mesh-support.ts';

type Hub = Awaited<ReturnType<typeof hub>>;

async function withHub(fn: (h: Hub) => Promise<void>, core: Record<string, unknown> = {}) {
  const h = await hub({ mesh: false, core: { models: { ollamaUrl: 'http://127.0.0.1:9' }, ...core } });
  try { await fn(h); } finally { await h.stop(); }
}

const exportPack = (records: { kind: string; content: string }[]) => JSON.stringify({ exported_at: '2026-10-01T09:00:00.000Z', records: records.map((r, i) => ({ id: `m${i}`, observed_at: '2026-09-30T09:00:00.000Z', recorded_by: 'person', user_state: 'confirmed', ...r })) });

test('the briefing states the registry as it is: instance, person, models, capture, devices, schedules, approvals, appearance', async () => {
  const ollama = await startFakeOllama({ models: [{ name: 'example-model:8b' }], version: '0.9.9' });
  const sp = await startFakeScreenpipe();
  try {
    await withHub(async (h) => {
      const { core } = h;
      core.profile.set('user', 'name', 'Sam', 'settings');
      core.profile.set('user', 'timezone', 'Europe/Lisbon', 'settings');
      core.design.apply('obsidian', { scope: 'user' });
      sp.requireKey('example-capture-key');
      const src = core.capture.addScreenpipe({ url: sp.base });
      core.capture.enable(src.id, { by: 'person' });
      await core.capture.pull(src.id);
      core.self.attach({
        schedules: () => [{ id: 'morning-summary', name: 'Morning summary', when: 'Every day at 7:00', next: 'tomorrow at 07:00', last: { ts: new Date(h.clock.t - 3_600_000).toISOString(), ok: false, error: 'The model command exited with code 1.' } }],
        permissions: () => [{ id: 'commands', label: 'Run commands on this computer', yes: false }, { id: 'schedules', label: 'Set up, change and remove schedules', yes: true }],
      });
      const b = await core.self.briefing();
      assert.match(b, /^# This Nova, right now/);
      assert.match(b, /check with the nova_ tools before you answer/);
      assert.ok(b.includes(`development, data home ${h.home}`), b);
      assert.match(b, /Nova 0\.1\.0/);
      assert.match(b, /Privacy setting: local-only/);
      assert.match(b, /Person: Sam; timezone Europe\/Lisbon/);
      assert.match(b, /Model providers: in use: Your model command \(chat, your chat model/);
      assert.match(b, /Off: Claude Code, Codex, n8n, Local model \(Ollama or compatible\), Relay\./);
      assert.ok(b.includes(`Ollama at ${new URL(ollama.url).host} answers (version 0.9.9), 1 model: example-model:8b`), b);
      assert.match(b, /Capture: Screenpipe on [^:]+: needs a key: “Screenpipe answered but refused Nova; it needs the API key from Screenpipe’s Settings > Privacy”/);
      assert.match(b, /Devices: only this hub; no other devices paired/);
      assert.match(b, /Morning summary \(Every day at 7:00, last run failed 60 min ago: “The model command exited with code 1”\)/);
      assert.match(b, /Approvals: asks first to run commands on this computer\. Goes ahead without asking to set up, change and remove schedules\./);
      assert.match(b, /Appearance: Obsidian, mode auto; installed: Aurora, Companion Light, Nova, Obsidian, Orb Teal, Paper/);
      assert.match(b, /Open problems: 1; latest: capture: “Screenpipe answered but refused Nova/);
      assert.match(b, /OpenRouter included/, 'the way to add a provider is named');
      assert.match(b, /OpenRouter included\) goes in Settings › Providers as the "Local model \(Ollama or compatible\)" provider/);
      assert.match(b, /Never ask for a key, token or password in chat or in a file/);
    }, { instance: 'development', models: { ollamaUrl: ollama.url } });
  } finally {
    await sp.close();
    await ollama.close();
  }
});

test('a runtime that doesn’t answer is said with its actual error; a provider never checked is checked by nova_instance', async () => {
  await withHub(async (h) => {
    const b = await h.core.self.briefing();
    assert.match(b, /Local models: Ollama at 127\.0\.0\.1:9 doesn’t answer: “[^”]+”/);
    const out = await h.core.self.instance();
    assert.match(out, /Local model \(Ollama or compatible\) \[openai-compatible\]: off; chat at 127\.0\.0\.1:11434/);
    assert.match(out, /Health: Not configured/);
  });
});

test('nothing secret reaches the briefing or a tool: vault values, a capture key, a provider key, token settings', async () => {
  const sp = await startFakeScreenpipe();
  try {
    await withHub(async (h) => {
      const { core } = h;
      core.vault.put('provider/EXAMPLE_KEY', 'example-provider-secret-value-1');
      core.profile.set('providers', 'config.openai-compatible', { base_url: 'http://127.0.0.1:11434/v1', model: 'example-model', api_key: 'secret://EXAMPLE_KEY' }, 'settings');
      core.profile.set('backups', 'token', 'example-plain-token-value-2', 'settings');
      const src = core.capture.addScreenpipe({ url: sp.base });
      core.capture.configure(src.id, { api_key: 'example-capture-secret-value-3' });
      core.self.attach({ schedules: () => [], permissions: () => [] });
      const said = [await core.self.briefing(), await core.self.instance(), core.self.capture(), core.self.devices(), core.self.schedules(),
        ...['appearance', 'permissions', 'privacy', 'providers', 'backups', 'capture', 'models', 'user'].map((p) => core.self.settings(p))].join('\n');
      for (const v of ['example-provider-secret-value-1', 'example-plain-token-value-2', 'example-capture-secret-value-3']) assert.ok(!said.includes(v), `${v} leaked`);
      assert.match(core.self.settings('providers'), /"api_key":"\(set\)"/);
      assert.match(core.self.settings('backups'), /- token: \(set\)/);
      assert.match(core.self.capture(), /API key saved/);
    });
  } finally {
    await sp.close();
  }
});

test('memory contents and capture text never reach the briefing', async () => {
  const sp = await startFakeScreenpipe();
  try {
    await withHub(async (h) => {
      const { core } = h;
      core.memory.remember({ kind: 'fact', content: 'Example private fact about a placeholder', recorded_by: 'person' });
      sp.add({ at: new Date(h.clock.t - 60_000).toISOString(), app: 'Editor', window: 'notes.txt', text: 'Example captured words' });
      const src = core.capture.addScreenpipe({ url: sp.base });
      core.capture.enable(src.id, { by: 'person', since: new Date(h.clock.t - 600_000).toISOString() });
      await core.capture.pull(src.id);
      const b = await core.self.briefing();
      assert.match(b, /Memory: 1 memory\./);
      assert.ok(!b.includes('Example private fact') && !b.includes('Example captured words'));
      assert.ok(!core.self.capture().includes('Example captured words'));
    });
  } finally {
    await sp.close();
  }
});

test('a fresh Nova says it is fresh, names its home, and offers the import path; a memory ends that', async () => {
  await withHub(async (h) => {
    const b = await h.core.self.briefing();
    assert.match(b, /First run: this Nova is fresh/);
    assert.ok(b.includes(`it runs from ${h.home}`));
    assert.match(b, /put a file \(notes, an export from another assistant, or a Nova memory export\) in ~\/workspace\/import\//);
    h.core.memory.remember({ kind: 'preference', content: 'Example preference', recorded_by: 'person' });
    assert.doesNotMatch(await h.core.self.briefing(), /First run/);
  });
});

test('a Nova memory export in ~/workspace/import/ is offered, screened, and its memories wait for the person (the ingest gate), never twice', async () => {
  await withHub(async (h) => {
    const { core } = h;
    const dir = join(h.home, 'workspace', 'import', 'memory-2026-10-01');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'memory.json'), exportPack([{ kind: 'preference', content: 'Prefers short replies' }, { kind: 'fact', content: 'Works on a placeholder project' }, { kind: 'odd', content: 'An unknown kind becomes a fact' }]));
    writeFileSync(join(h.home, 'workspace', 'import', 'notes.md'), '# Example notes\n');
    const b = await core.self.briefing();
    // By their counts only: a file's name is outside content (review N4); import_files lists them.
    assert.match(b, /2 files wait in ~\/workspace\/import\/ \(1 looks like a Nova memory export\)\. Their names come from outside: list them with import_files\. Offer to load an export with memory_import; the person approves, and the memories wait for their OK in Memory/);
    assert.doesNotMatch(b, /memory-2026-10-01|notes\.md/);
    core.memory.remember({ kind: 'preference', content: 'Prefers short replies', recorded_by: 'person' });
    const plan = core.self.planImport('workspace/import/memory-2026-10-01/memory.json');
    assert.deepEqual([plan.total, plan.fresh, plan.already], [3, 2, 1]);
    const r = await core.self.importPack('~/workspace/import/memory-2026-10-01/memory.json');
    assert.deepEqual([r.waiting, r.skipped], [2, 1]);
    // Outside content of unknown provenance: nothing goes into memory; each waits for the person.
    assert.deepEqual(core.memory.active().filter((m) => m.recorded_by === 'import'), []);
    const waiting = core.ingest.candidates();
    assert.deepEqual(waiting.map((c) => [c.kind, c.source]).sort(), [['fact', 'imported from workspace/import/memory-2026-10-01/memory.json'], ['fact', 'imported from workspace/import/memory-2026-10-01/memory.json']]);
    assert.equal((await core.self.importPack('workspace/import/memory-2026-10-01/memory.json')).waiting, 0, 'never twice');
    assert.throws(() => core.self.planImport('workspace/import/notes.md'), /isn’t a Nova memory export/);
  });
});

test('only a plain file inside ~/workspace/import/ can be loaded', async () => {
  await withHub(async (h) => {
    const imp = join(h.home, 'workspace', 'import');
    mkdirSync(imp, { recursive: true });
    writeFileSync(join(h.home, 'workspace', 'elsewhere.json'), exportPack([{ kind: 'fact', content: 'x' }]));
    symlinkSync(join(h.home, 'workspace', 'elsewhere.json'), join(imp, 'linked.json'));
    for (const p of ['workspace/elsewhere.json', 'workspace/import/../elsewhere.json', 'workspace/import/linked.json', '/etc/passwd', '', 'workspace/import/missing.json']) {
      await assert.rejects(h.core.self.importPack(p), /workspace\/import|path is the file/, p);
    }
    assert.deepEqual(h.core.self.imports().packs, [], 'a link is never offered either');
  });
});

test('nova_settings lists its parts, refuses an unknown one, and shows appearance and approvals in words', async () => {
  await withHub(async (h) => {
    h.core.self.attach({ permissions: () => [{ id: 'commands', label: 'Run commands on this computer', yes: false }] });
    assert.match(h.core.self.settings(), /^Settings parts: appearance, permissions, privacy, identity, user/);
    assert.throws(() => h.core.self.settings('vault'), /no settings part called vault/);
    assert.throws(() => h.core.self.settings('setup'), /no settings part called setup/);
    assert.match(h.core.self.settings('appearance'), /Active: Orb Teal \[orb-teal\] \(the default\), mode auto\.[\s\S]*- Paper \[paper\][\s\S]*no chat tool for it/);
    assert.match(h.core.self.settings('permissions'), /- Run commands on this computer \[commands\]: asks first/);
    assert.match(h.core.self.settings('privacy'), /Privacy setting: local-only/);
  });
});
