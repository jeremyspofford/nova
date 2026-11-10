// First run on the recommended path (F-043, F-044, F-045 ≡ A-085). No model is called anywhere here.
//   - The first chat under local-only with the default (cloud) chat command is still refused and sends
//     nothing, and it no longer dead-ends at config keys: it names the next step inside Nova and
//     carries it as a link (Settings › Models when there is no local model; Settings › Providers once
//     a local chat model is on).
//   - Setup's privacy question has three set answers, local-only recommended; a typed answer that
//     turns down local and asks for the cloud is asked again with nothing stored.
//   - Setup and the first-action card name the real import folder, inside Nova's home, for any home,
//     and a note put there is what the import reader finds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createNova } from '../../src/server.js';
import { loadConfig } from '../../src/config.js';
import { createCore, type Core } from '../../src/core/index.ts';

const root = join(import.meta.dirname, '..', '..');

test('F-043: the first chat under local-only with a cloud chat command is refused, sends nothing, and links the next step inside Nova', async () => {
  const home = mkdtempSync(join(tmpdir(), 'nova-first-chat-'));
  const called = join(home, 'model-was-called');
  const nova = createNova({ ...loadConfig({ NOVA_HOME: home, NOVA_AGENT_CMD: `touch ${called} && node ${join(root, 'scripts/fake-agent.js')}`, NOVA_TZ: 'UTC' }), port: 0 });
  await new Promise<void>((r) => nova.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(nova.server.address() as AddressInfo).port}`;
  try {
    const res = await fetch(`${base}/api/sessions`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-nova': '1' }, body: JSON.stringify({ text: 'hello' }) });
    const { id } = await res.json();
    let s: { live: unknown; session: { turns: { state: string; items: { kind: string; message?: string; detail?: string; next?: { label: string; href: string } }[] }[] } } | null = null;
    for (let i = 0; i < 200; i++) {
      s = await (await fetch(`${base}/api/sessions/${id}`)).json();
      if (s!.live === null && s!.session.turns[0]?.state) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const err = s!.session.turns[0]!.items.find((x) => x.kind === 'error')!;
    assert.equal(s!.session.turns[0]!.state, 'error');
    assert.match(err.message ?? '', /privacy setting is local-only.*runs in the cloud, so I haven't sent this anywhere/);
    assert.match(err.message ?? '', /There is no local chat model here yet\. Settings › Models recommends one for this computer.*choose it for chat in Settings › Providers/);
    assert.doesNotMatch(err.message ?? '', /agent_cmd|agent_egress/, 'no config keys in what the person reads');
    assert.match(err.detail ?? '', /agent_egress set to local/, 'the config route stays, in the details');
    assert.deepEqual(err.next, { label: 'Set up a local model', href: '/settings#models' });
    assert.equal(existsSync(called), false, 'the model command never ran');
  } finally {
    nova.server.close();
    await nova.core.close();
  }
});

async function core(home: string): Promise<Core> {
  return createCore({ home, version: '0.1.0', trustedOrigin: () => true });
}
async function toPrivacy(c: Core) {
  c.setup.view();
  for (const t of ['new', 'yes', 'yes', 'call me Sam', 'yes', 'keep', 'plainly']) await c.setup.answer(t);
  return c.setup.view();
}

test('F-044: the privacy step offers three set answers, local-only recommended; a mixed answer is asked again and nothing is stored', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nova-first-privacy-'));
  try {
    for (const [answer, mode] of [['Local-only', 'local-only'], ['Local first', 'local-preferred'], ['Cloud allowed', 'cloud-allowed'], ['no cloud', 'local-only'], ['keep it local', 'local-only']] as const) {
      const c = await core(join(dir, answer.replace(/\W+/g, '-')));
      try {
        const v = await toPrivacy(c);
        assert.equal(v.step, 'privacy');
        assert.deepEqual(v.options?.choices.map((x) => [x.label, x.selected]), [['Local-only', true], ['Local first', false], ['Cloud allowed', false]]);
        assert.match(v.options!.choices[0]!.note, /^Recommended\./);
        assert.match(v.question ?? '', /Local-only \(I recommend it\), Local first .*, or Cloud allowed/);
        await c.setup.answer(answer);
        assert.equal(c.profile.privacyDefault(), mode, answer);
        assert.equal(c.setup.view().step, 'discover', answer);
      } finally { await c.close(); }
    }
    const c = await core(join(dir, 'mixed'));
    try {
      await toPrivacy(c);
      const r = await c.setup.answer('not local, use the cloud');
      assert.match(r.reply, /I couldn’t tell which you meant, so nothing is set yet\. Local-only, Local first, or Cloud allowed\?/);
      assert.equal(c.setup.view().step, 'privacy', 'asked again');
      assert.equal(c.profile.get('privacy', 'default'), undefined, 'nothing stored');
      assert.equal(c.setup.view().options?.choices.length, 3, 'the three answers are offered again');
    } finally { await c.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('F-045: setup and the first-action card name the real import folder for any home, and a note put there is found', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nova-first-import-'));
  try {
    for (const home of [join(dir, 'Nova'), join(dir, 'elsewhere', 'my nova')]) {
      const c = await core(home);
      try {
        await toPrivacy(c);
        await c.setup.answer('Local-only');
        const said = (await c.setup.answer('no')).reply;
        const folder = join(home, 'workspace', 'import');
        assert.ok(said.includes(`You can put notes or exports in ${folder} on the hub, the computer Nova runs on, any time, and tell me.`), said);
        assert.doesNotMatch(said, /~\/workspace/);
        await c.setup.answer('no');
        const card = c.setup.view().first!.action;
        assert.equal(card.id, 'bring-notes');
        assert.ok(card.why.includes(`in ${folder} on the hub`), card.why);
        // A note at exactly the shown path is what the import reader finds.
        mkdirSync(folder, { recursive: true });
        writeFileSync(join(folder, 'about-me.md'), 'I like early mornings.\n');
        assert.deepEqual(c.self.imports().files.map((f) => join(home, f.path)), [join(folder, 'about-me.md')]);
      } finally { await c.close(); }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
