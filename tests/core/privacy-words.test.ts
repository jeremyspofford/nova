// What Nova says about privacy is true (F-025, F-027, A-006). "Local first" is a rule for Nova's own
// model work by role; a chat program that counts as the cloud is asked on every turn, and what each
// turn carries is said where the mode is chosen, before the first send: in setup, and in the chat
// words the hub gives Settings › Privacy, Settings › Models and the Providers chat line. The words
// are built from the chat model actually chosen. No model is called.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore } from '../../src/core/index.ts';
import { Db } from '../../src/core/db.ts';
import { Log } from '../../src/core/log.ts';
import { Ledger } from '../../src/core/ledger.ts';
import { Profile } from '../../src/core/profile.ts';
import { Setup, quietOnboarding } from '../../src/core/setup.ts';
import { Verifier } from '../../src/core/verify.ts';
import { Workspace, workspaceWorker } from '../../src/core/workspace.ts';
import type { Egress } from '../../src/core/workers.ts';

const CARRIES = /standing files[\s\S]*memory[\s\S]*day notes[\s\S]*conversation[\s\S]*file/;

function setup(chat?: { program: string; egress: Egress }) {
  const db = new Db(':memory:');
  db.migrate();
  const ws = new Workspace(join(mkdtempSync(join(tmpdir(), 'nova-privacy-words-')), 'workspace'));
  const profile = new Profile(db);
  const ledger = new Ledger({ db, log: new Log(db, null), verifier: new Verifier(ws), workers: [workspaceWorker(ws)], defaultPrivacy: () => profile.privacyDefault() });
  return { profile, setup: new Setup({ profile, ledger, detectedTimezone: 'Europe/Lisbon', onboarding: quietOnboarding({ os: 'linux' }), ...(chat ? { chat } : {}) }) };
}

async function toPrivacy(s: Setup): Promise<string> {
  s.view();
  let last = '';
  for (const t of ['new', 'yes', 'yes', 'call me Sam', 'yes', 'keep', 'plainly']) last = (await s.answer(t)).reply;
  return last;
}

test('setup: with a cloud chat program, the privacy question says where a cloud chat turn goes and what it carries', async () => {
  const { setup: s } = setup({ program: 'tee', egress: 'remote' });
  const ask = await toPrivacy(s);
  assert.match(ask, /every chat turn goes to tee without trying your devices first/);
  assert.match(ask, CARRIES);
  const reply = (await s.answer('allow cloud when needed')).reply;
  assert.match(reply, /local first for my own model work/);
  assert.match(reply, /Chat is the exception: every chat turn goes to tee, in the cloud, without trying your devices first/);
  assert.match(reply, CARRIES);
  assert.doesNotMatch(reply, /^Got it: local first, cloud only when local can’t do it/, 'no bare "cloud only when local can’t" for chat');
});

test('setup: a local chat program gets no cloud-chat words; local-only says chat stays off for a cloud one', async () => {
  const local = setup({ program: 'llama', egress: 'local' });
  await toPrivacy(local.setup);
  assert.doesNotMatch((await local.setup.answer('allow cloud when needed')).reply, /every chat turn/);
  const cloud = setup({ program: 'tee', egress: 'remote' });
  await toPrivacy(cloud.setup);
  const reply = (await cloud.setup.answer('keep it local-only')).reply;
  assert.match(reply, /Chat stays off until you add a local model: tee runs in the cloud/);
});

test('the hub’s chat words: a cloud chat command is asked on every turn in Local first, and the words say what it carries', async () => {
  const home = mkdtempSync(join(tmpdir(), 'nova-privacy-words-core-'));
  const core = createCore({ home, version: '0.1.0', trustedOrigin: () => true, agent: { command: 'tee /dev/null', egress: 'remote' } });
  try {
    const sends = core.providers.choices().chat.sends;
    assert.equal(sends.name, 'tee');
    assert.equal(sends.egress, 'remote');
    assert.equal(sends.role, null);
    assert.match(sends.modes['local-preferred'], /Chat goes to tee, off your devices, on every turn: it doesn’t try your devices first/);
    assert.match(sends.modes['local-preferred'], CARRIES);
    assert.match(sends.modes['cloud-allowed'], /on every turn/);
    assert.match(sends.modes['local-only'], /chat stays off and nothing is sent/);
    assert.doesNotMatch(Object.values(sends.modes).join(' '), /only when (they|local) can/, 'no "only when local can’t" for a chat program');
    assert.match(sends.turn, CARRIES);
  } finally { await core.close(); rmSync(home, { recursive: true, force: true }); }
});

test('the hub’s chat words: a chat command declared local says it is the installer’s word', async () => {
  const home = mkdtempSync(join(tmpdir(), 'nova-privacy-words-core-'));
  const core = createCore({ home, version: '0.1.0', trustedOrigin: () => true, agent: { command: 'llama-cli', egress: 'local' } });
  try {
    const sends = core.providers.choices().chat.sends;
    assert.equal(sends.egress, 'local');
    assert.match(sends.modes['local-preferred'], /Its setup says it stays on your devices; Nova takes that on trust/);
  } finally { await core.close(); rmSync(home, { recursive: true, force: true }); }
});
