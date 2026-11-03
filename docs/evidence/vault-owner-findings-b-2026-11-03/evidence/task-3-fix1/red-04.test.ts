// Task 3 review I1: real legacy-source discovery in private synthetic homes, including Node permissions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startBroker } from '../../src/broker/spawn.ts';
import { Vault } from '../../src/core/vault.ts';
import { C, Person, coreSim, inProcess, tmp } from '../support/broker-support.ts';

const stage = { source: { migrate: 'stage' } };
const commit = { source: { migrate: 'commit' } };
const name = 'provider/INSPECTION';
const value = C('source-inspection');
const gmailValue = JSON.stringify({ refresh_token: C('source-inspection-gmail') });

async function fresh(permission: boolean) {
  const home = tmp('nova-migration-inspection-');
  const dir = join(home, 'broker');
  const old = new Vault({ home, mode: 'file' });
  old.put(name, value);
  if (permission) {
    const b = await startBroker(dir, { keyMode: 'file' });
    const core = coreSim(b.socket, b.tokens.core);
    const p = new Person(core.call);
    await p.setup();
    return { home, old, call: core.call, p, close: () => { core.stop(); b.child.kill(); } };
  }
  const b = inProcess(dir);
  const p = new Person(b.call);
  await p.setup();
  return { home, old, call: b.call, p, close: () => b.broker.lock() };
}

function gmail(home: string) {
  const dir = join(home, 'connectors/gmail');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, 'token.json');
  writeFileSync(file, gmailValue, { mode: 0o600 });
  return { dir, file };
}

function uncertain(g: ReturnType<typeof gmail>, kind: 'dangling' | 'inaccessible') {
  if (kind === 'dangling') {
    rmSync(g.file);
    symlinkSync(join(g.dir, 'missing-target'), g.file);
  } else chmodSync(g.dir, 0o000);
}

for (const permission of [false, true]) {
  const context = permission ? 'permission IPC' : 'in-process';
  for (const missing of ['connectors-directory', 'gmail-directory', 'gmail-files']) {
    test(`I1 confirmed absent ${missing} permits migration (${context})`, async () => {
      const b = await fresh(permission);
      try {
        if (missing === 'gmail-directory') mkdirSync(join(b.home, 'connectors'));
        if (missing === 'gmail-files') mkdirSync(join(b.home, 'connectors/gmail'), { recursive: true });
        const staged = await b.call('create', stage);
        assert.equal(staged.ok, true, JSON.stringify(staged));
        assert.equal(staged.outcome.staged, 1);
        const result = await b.p.approve('create', commit);
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.equal(result.outcome.removed, 1);
        assert.equal(new Vault({ home: b.home, mode: 'file' }).get(name), null);
      } finally { b.close(); }
    });
  }

  for (const ancestor of ['connectors', 'gmail']) {
    test(`I1 dangling ${ancestor} ancestor is not confirmed absence (${context})`, async () => {
      const b = await fresh(permission);
      try {
        const root = join(b.home, 'connectors');
        if (ancestor === 'gmail') mkdirSync(root);
        symlinkSync(join(b.home, 'missing-directory'), ancestor === 'gmail' ? join(root, 'gmail') : root);
        const before = readFileSync(join(b.home, 'vault/secrets.json'));
        assert.equal((await b.call('create', stage)).error, 'failed');
        assert.equal((await b.call('create', commit)).error, 'failed');
        assert.deepEqual(readFileSync(join(b.home, 'vault/secrets.json')), before);
        assert.equal((await b.call('list_refs')).refs.length, 0);
      } finally { b.close(); }
    });
  }

  for (const kind of ['dangling', 'inaccessible'] as const) {
    for (const when of ['stage', 'restage', 'finish']) {
      test(`I1 ${kind} Gmail source refuses ${when} and preserves source authority (${context})`, async () => {
        const b = await fresh(permission);
        const g = gmail(b.home);
        try {
          const before = readFileSync(join(b.home, 'vault/secrets.json'));
          let challenge;
          if (when !== 'stage') {
            assert.equal((await b.call('create', stage)).outcome.staged, 2);
            challenge = (await b.call('create', commit)).challenge;
          }
          uncertain(g, kind);
          if (when === 'finish') {
            const result = await b.call('create', { ...commit, approval: b.p.approval(challenge) });
            assert.equal(result.error, 'failed', 'uncertain discovery must refuse the whole cleanup');
            assert.match(result.words, /copies.*removals.*may.*review.*resume/i);
            assert.equal((await b.call('list_refs')).refs.length, 2, 'approved staged copies already exist');
            assert.doesNotMatch(result.words, /token\.json|connectors|provider\/INSPECTION|canary-/);
          } else {
            const result = await b.call('create', stage);
            assert.equal(result.error, 'failed', 'uncertain discovery is not confirmed absence');
            assert.doesNotMatch(result.words, /token\.json|connectors|provider\/INSPECTION|canary-/);
            const denied = await b.call('create', { ...commit, ...(challenge ? { approval: b.p.approval(challenge) } : {}) });
            assert.equal(denied.error, 'failed', 'failed restage leaves no earlier approved values usable');
            assert.equal((await b.call('list_refs')).refs.length, 0);
          }
          assert.deepEqual(readFileSync(join(b.home, 'vault/secrets.json')), before, 'no legacy rewrite or removal on uncertainty');
          assert.equal(new Vault({ home: b.home, mode: 'file' }).get(name), value);
          chmodSync(g.dir, 0o700);
          if (kind === 'inaccessible') assert.equal(readFileSync(g.file, 'utf8'), gmailValue);
          else assert.equal(existsSync(join(g.dir, 'missing-target')), false);
        } finally { chmodSync(g.dir, 0o700); b.close(); }
      });
    }
  }
}
