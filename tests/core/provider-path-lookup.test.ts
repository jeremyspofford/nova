// A command-line provider's health (claude-code, codex, custom-cli) never looks its program up on
// PATH while Nova serves a request (#428 follow-up). The health check asks every enabled provider for
// it, and so does the providers page; on a WSL PATH of slow /mnt/c folders one synchronous lookup
// held the event loop for up to a second and a half, long enough for a canary's health probe to time
// out. Health is a synchronous answer, so the proof is a count, not a clock: no synchronous stat of a
// PATH folder while it answers (fs.accessSync is spied on), and the answer still arrives once Nova's
// own lookup, made without holding the loop, comes back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createCore } from '../../src/core/index.ts';

const FOLDERS = 5000;

test('a CLI provider’s health (the health check, GET /providers) makes no synchronous PATH lookup, and still finds the program or says it is missing', { timeout: 60_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'nova-provider-path-'));
  const root = mkdtempSync(join(tmpdir(), 'nova-long-path-'));
  const bin = mkdtempSync(join(tmpdir(), 'nova-provider-bin-'));
  writeFileSync(join(bin, 'nova-example-claude'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(bin, 'nova-example-claude'), 0o755);
  const missing = Array.from({ length: FOLDERS }, (_, i) => join(root, `missing-${i}`));
  const realPath = process.env.PATH;
  const realAccess = fs.accessSync;
  let scans = 0;
  fs.accessSync = ((p: fs.PathLike, mode?: number) => { if (String(p).startsWith(root)) scans++; return realAccess(p, mode); }) as typeof fs.accessSync;
  syncBuiltinESMExports();
  const core = createCore({ home, version: '0.1.0', trustedOrigin: () => true, secrets: () => null });
  try {
    core.profile.set('privacy', 'default', 'cloud-allowed', 'settings');
    process.env.PATH = [...missing, bin].join(delimiter);
    core.providers.configure('claude-code', { command: 'nova-example-claude' }, { confirm: true });
    core.providers.enable('claude-code', { approved: true });

    // What a request sees: the health check and the providers page.
    scans = 0;
    let started = performance.now();
    const health = core.health() as { checks: { workers: { workers: { id: string; health: { ok: boolean; detail: string } }[] } } };
    const listed = core.providers.list().find((p) => p.id === 'claude-code')!;
    const held = Math.round(performance.now() - started);
    console.log(`health check and GET /providers: ${scans} synchronous PATH stats over a ${FOLDERS}-folder PATH, held the loop ${held} ms`);
    assert.equal(scans, 0, `the health check and GET /providers stat ${scans} PATH folders synchronously`);
    assert.ok(health.checks.workers.workers.find((w) => w.id === 'claude-code')!.health.ok, 'still looking is not a failed health check');
    assert.ok(['unchecked', 'ready'].includes(listed.health.state), listed.health.words);

    // The answer arrives once Nova's own lookup comes back. wait: on the provider's health leaving
    // "still looking", the product's own signal; setImmediate yields to the loop, no clock.
    const settled = async () => {
      for (let i = 0; i < 1_000_000; i++) {
        const h = core.providers.health('claude-code');
        if (!/looking for its program/.test(h.words)) return h;
        await new Promise((r) => setImmediate(r));
      }
      return core.providers.health('claude-code');
    };
    started = performance.now();
    scans = 0;
    const found = await settled();
    console.log(`found after ${Math.round(performance.now() - started)} ms with ${scans} synchronous PATH stats: ${found.state} (${found.words})`);
    assert.equal(found.state, 'ready', found.words);
    assert.equal(scans, 0);

    // A program that isn't there is still said to be missing, by name.
    core.providers.configure('claude-code', { command: 'nova-example-nowhere' }, { confirm: true });
    scans = 0;
    const gone = await settled();
    assert.equal(gone.state, 'not_installed', gone.words);
    assert.match(gone.words, /Nova can’t find `nova-example-nowhere` on this computer/);
    assert.equal(scans, 0);
  } finally {
    process.env.PATH = realPath;
    fs.accessSync = realAccess;
    syncBuiltinESMExports();
    await core.close();
  }
});
