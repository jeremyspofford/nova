// X-002: logs/nova.log had no size limit. Past its cap it is moved to nova.log.1 (the older ones move
// up one), only `keep` old files stay, and nothing logged is lost on the way: each line is whole in
// exactly one file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../../src/core/db.ts';
import { LOG_KEEP, LOG_MAX_BYTES, Log } from '../../src/core/log.ts';

test('nova.log rotates at its cap, keeps a bounded number of old files, and every line stays whole', () => {
  const db = new Db(':memory:');
  db.migrate();
  const file = join(mkdtempSync(join(tmpdir(), 'nova-log-')), 'logs', 'nova.log');
  const log = new Log(db, file, () => new Date('2026-11-10T12:00:00Z'), { maxBytes: 2_000, keep: 3 });
  for (let i = 0; i < 200; i++) log.info('test', `line ${i} ${'x'.repeat(40)}`);
  for (const f of [file, `${file}.1`, `${file}.2`, `${file}.3`]) {
    assert.ok(existsSync(f), `${f} is there`);
    assert.ok(statSync(f).size <= 2_000, `${f} is within the cap`);
  }
  assert.equal(existsSync(`${file}.4`), false, 'only three old files stay');
  // The newest lines are in nova.log, in order, each one whole JSON.
  const lines = [file, `${file}.1`, `${file}.2`, `${file}.3`].reverse().flatMap((f) => readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l).msg as string));
  const nums = lines.map((m) => Number(/^line (\d+)/.exec(m)![1]));
  assert.deepEqual(nums, [...nums].sort((a, b) => a - b), 'in order across the files');
  assert.equal(nums.at(-1), 199);
  // A log that already exists is counted from its size when Nova starts again.
  writeFileSync(file, 'y'.repeat(1_990));
  const again = new Log(db, file, () => new Date(), { maxBytes: 2_000, keep: 3 });
  again.info('test', 'after a restart');
  assert.match(readFileSync(file, 'utf8'), /after a restart/);
  assert.match(readFileSync(`${file}.1`, 'utf8'), /^y+$/, 'the full file moved aside first');
  // The real defaults.
  assert.equal(LOG_MAX_BYTES, 10 * 1024 * 1024);
  assert.equal(LOG_KEEP, 5);
});
