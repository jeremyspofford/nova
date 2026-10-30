// A factory reset and Era 2's side of the home (M7 amendment §2): the reset finishes before the
// home is seeded again, so Nova comes back with fresh standing files, no old conversations, and
// setup open. A throwaway home, passed explicitly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNova } from '../src/server.js';
import { loadConfig } from '../src/config.js';

const CONSOLE = { principal: { kind: 'console' }, listener: 'console', address: '127.0.0.1' };

test('after a reset Nova comes back seeded fresh: new standing files, no old conversations, setup open', async () => {
  const home = mkdtempSync(join(tmpdir(), 'nova-reset-s-'));
  const config = loadConfig({ NOVA_HOME: home, NOVA_AGENT_CMD: 'true', NOVA_AGENT_EGRESS: 'none', NOVA_VAULT_KEY: 'file' });
  let nova = createNova(config);
  writeFileSync(join(home, 'sessions', 'old.jsonl'), '{"type":"user","text":"hello"}\n');
  writeFileSync(join(home, 'USER.md'), 'Sam keeps the spare key under the doormat.\n');
  await nova.core.reset.stage({ confirm: true, who: CONSOLE }).done;
  await nova.core.close();
  nova = createNova(config);
  try {
    assert.ok(existsSync(join(home, 'AGENTS.md')), 'the standing files are seeded again');
    assert.ok(!readFileSync(join(home, 'USER.md'), 'utf8').includes('doormat'), 'fresh, not the old ones');
    assert.ok(!existsSync(join(home, 'sessions', 'old.jsonl')), 'no old conversations');
    assert.equal(nova.core.setup.view().done, false);
    assert.ok(nova.core.reset.report(), 'the result is kept for the first-run screen');
  } finally {
    await nova.core.close();
  }
});
