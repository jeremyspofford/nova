// I1: the real Core -> wireIngest -> Screen outbound path must never treat a failed vault scan
// as an empty vault. Private homes, real Vault ciphertext and injected key stores only.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore, Vault, type KeyStore } from '../../src/core/index.ts';
import { Ingest } from '../../src/core/ingest/screen.ts';
import type { OutboundResult } from '../../src/core/ingest/outbound.ts';

const FIRST = 'synthetic-vault-first-canary-22c04';
const SECOND = 'synthetic-vault-second-canary-2a09b';
const PRIVATE_PATH = '/private/synthetic-vault-home/vault/key';
const DIAGNOSTIC = 'synthetic-private-keychain-diagnostic-28f36';
const DETAIL = `${DIAGNOSTIC} ${PRIVATE_PATH} ${SECOND}`;
const BENIGN = 'bread recipes';

function fixture(t: TestContext, coldUnavailable = false) {
  const home = mkdtempSync(join(tmpdir(), 'nova-outbound-vault-'));
  const keys = new Map<string, Buffer>();
  const state = { up: true, reads: 0, failAt: 0, clearAt: 0 };
  let writer: Vault;
  const keychain = (account: string): KeyStore => ({
    kind: 'keychain', name: 'synthetic keychain',
    available: () => ({ ok: state.up, detail: DETAIL }),
    read: () => {
      state.reads++;
      if (state.reads === state.failAt) throw new Error(DETAIL);
      if (state.reads === state.clearAt) writer.clear();
      return keys.get(account) ?? null;
    },
    write: (key) => { keys.set(account, Buffer.from(key)); },
    remove: () => { keys.delete(account); },
  });
  writer = new Vault({ home, mode: 'auto', keychain });
  writer.put('provider/A', FIRST);
  writer.put('provider/B', SECOND);
  state.up = !coldUnavailable;
  // Sandbox avoids startup discovery/refresh. Core's actual collector and wireIngest are used.
  const core = createCore({ home, version: '0.1.0', trustedOrigin: () => true, sandbox: true, vault: { mode: 'auto', keychain } });
  t.after(async () => { await core.close(); rmSync(home, { recursive: true, force: true }); });
  const check = (text: string, tainted: boolean) => core.ingest.outbound({ text }, { tainted });
  return { home, core, writer, state, check };
}

function unavailable(result: OutboundResult) {
  assert.equal(result.ok, false, 'incomplete safety checks must refuse outbound');
  assert.ok(result.matched.length > 0, 'the caller receives a reason for refusal');
  assert.match(result.matched.map((m) => m.words).join(' '), /couldn’t check.*vault/i);
  for (const privateText of [FIRST, SECOND, DIAGNOSTIC, PRIVATE_PATH]) assert.equal(JSON.stringify(result).includes(privateText), false);
}

for (const tainted of [false, true]) {
  test(`Core outbound refuses warm keychain loss and recovers without leaking saved secrets (tainted=${tainted})`, async (t) => {
    const f = fixture(t);
    assert.equal(f.core.vault.get('provider/B'), SECOND);
    assert.deepEqual(f.check(BENIGN, tainted), { ok: true, matched: [] });
    assert.equal(f.check(SECOND, tainted).ok, false);
    f.state.up = false;
    assert.throws(() => f.core.vault.get('provider/B'), /isn’t answering/, 'fresh Vault reads cannot use stale plaintext');
    unavailable(f.check(SECOND, tainted));
    unavailable(f.check(BENIGN, tainted));
    f.state.up = true;
    assert.deepEqual(f.check(BENIGN, tainted), { ok: true, matched: [] });
    for (const text of [FIRST, SECOND, Buffer.from(SECOND).toString('base64'), Buffer.from(SECOND).toString('hex')]) {
      assert.deepEqual(f.check(text, tainted).matched.map((m) => m.kind), ['secret']);
    }
    const log = readFileSync(join(f.home, 'logs/nova.log'), 'utf8');
    for (const privateText of [FIRST, SECOND, DIAGNOSTIC, PRIVATE_PATH]) assert.equal(log.includes(privateText), false, 'guard logs do not echo secrets or keychain diagnostics');
  });

  test(`Core outbound refuses an unavailable cold scan, including benign payloads (tainted=${tainted})`, (t) => {
    const f = fixture(t, true);
    unavailable(f.check(BENIGN, tainted));
    unavailable(f.check(SECOND, tainted));
    f.state.up = true;
    assert.deepEqual(f.check(BENIGN, tainted), { ok: true, matched: [] });
    assert.deepEqual(f.check(SECOND, tainted).matched.map((m) => m.kind), ['secret']);
  });

  test(`Core outbound refuses a key-store error after an earlier entry was read (tainted=${tainted})`, (t) => {
    const f = fixture(t);
    assert.deepEqual(f.core.vault.list(), ['provider/A', 'provider/B']);
    // list succeeds, A succeeds, B's real Vault key lookup throws. No copied collector or mocked get.
    for (const text of [SECOND, BENIGN]) {
      f.state.reads = 0;
      f.state.failAt = 3;
      const result = f.check(text, tainted);
      assert.equal(f.state.reads, 3, 'the fault occurs after list and the first entry');
      unavailable(result);
    }
    f.state.failAt = 0;
    assert.deepEqual(f.check(BENIGN, tainted), { ok: true, matched: [] });
    assert.deepEqual(f.check(SECOND, tainted).matched.map((m) => m.kind), ['secret']);
    const log = readFileSync(join(f.home, 'logs/nova.log'), 'utf8');
    for (const privateText of [FIRST, SECOND, DIAGNOSTIC, PRIVATE_PATH]) assert.equal(log.includes(privateText), false);
  });

  test(`Core outbound refuses a partial scan when a listed entry disappears (tainted=${tainted})`, (t) => {
    const f = fixture(t), committed = readFileSync(f.writer.file);
    // Another cooperating Vault clears the file during A's lookup; B subsequently returns null.
    for (const text of [SECOND, BENIGN]) {
      f.state.reads = 0;
      f.state.clearAt = 2;
      unavailable(f.check(text, tainted));
      assert.equal(f.core.vault.get('provider/B'), null);
      f.state.clearAt = 0;
      writeFileSync(f.writer.file, committed);
    }
    assert.deepEqual(f.check(BENIGN, tainted), { ok: true, matched: [] });
    assert.deepEqual(f.check(SECOND, tainted).matched.map((m) => m.kind), ['secret']);
  });
}

for (const source of ['memory', 'standing'] as const) {
  test(`Screen refuses unavailable ${source} on tainted outbound without exposing error details`, () => {
    let up = false, reads = 0;
    const ingest = new Ingest({ db: null, secrets: () => [], [source]: () => { reads++; if (!up) throw new Error(DETAIL); return []; } });
    const result = ingest.outbound({ text: BENIGN }, { tainted: true });
    assert.equal(result.ok, false);
    assert.deepEqual(result.matched.map((m) => m.kind), ['memory']);
    assert.match(result.matched[0]!.words, /couldn’t check/i);
    for (const privateText of [SECOND, DIAGNOSTIC, PRIVATE_PATH]) assert.equal(JSON.stringify(result).includes(privateText), false);
    const before = reads;
    assert.deepEqual(ingest.outbound({ text: BENIGN }, { tainted: false }), { ok: true, matched: [] }, 'untainted policy still checks only secrets');
    assert.equal(reads, before, 'untainted outbound must not read memory or standing files');
    up = true;
    assert.deepEqual(ingest.outbound({ text: BENIGN }, { tainted: true }), { ok: true, matched: [] }, 'restored source permits benign outbound');
  });
}
