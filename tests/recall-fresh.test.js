// A-023: a turn recalled its notes once, before its steps, and gave the same snapshot to every model
// call. A note forgotten mid-conversation (between two steps) still went into the next prompt. Now
// the recalled notes are read again before every step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNova } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { ensureMark } from '../src/core/index.ts';

test('a note forgotten between two steps of a turn is not in the next prompt; an edited one reads as it is now', async () => {
  const home = mkdtempSync(join(tmpdir(), 'nova-recall-'));
  ensureMark(home);
  mkdirSync(join(home, 'workspace'), { recursive: true });
  writeFileSync(join(home, 'workspace', 'notes.md'), 'Example notes.\n');
  const prompts = [];
  let nova;
  let forget = null;
  const agent = async ({ prompt }) => {
    prompts.push(prompt);
    if (prompts.length === 1) {
      forget();
      return { text: 'Let me look.\n<tool_call name="read_file">{"path": "workspace/notes.md"}</tool_call>', aborted: false, usage: {} };
    }
    return { text: 'Done.', aborted: false, usage: {} };
  };
  nova = createNova(loadConfig({ NOVA_HOME: home, NOVA_AGENT_CMD: 'true', NOVA_AGENT_EGRESS: 'none', NOVA_TZ: 'UTC' }), { agent });
  try {
    const gone = nova.runner.memory.note({ text: 'The garage keypad code is kiwi lantern' });
    const kept = nova.runner.memory.note({ text: 'The garage door was serviced in March' });
    assert.ok(gone.ok && kept.ok);
    forget = () => {
      assert.equal(nova.runner.memory.forget(gone.id).length, 1, 'the note is forgotten mid-turn');
    };
    const session = nova.store.newId();
    nova.store.append(session, { type: 'session', id: session, title: 'Garage', v: 1 });
    nova.runner.send(session, 'What do you know about the garage keypad code and the garage door?');
    for (let i = 0; i < 400 && (nova.runner.active.size || prompts.length < 2); i++) await new Promise((r) => setTimeout(r, 25));
    assert.equal(prompts.length, 2, 'two steps: the tool call, then the answer');
    assert.match(prompts[0], /kiwi lantern/, 'the first step had the note');
    assert.doesNotMatch(prompts[1], /kiwi lantern/, 'the next step never sees a forgotten note');
    assert.match(prompts[1], /serviced in March/, 'a note still there stays recalled');
  } finally {
    nova.server.close();
    await nova.core.close();
  }
});
