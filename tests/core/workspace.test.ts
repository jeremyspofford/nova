import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace } from '../../src/core/workspace.ts';

test('paths stay inside the workspace, including through a symlink planted in it', () => {
  const root = mkdtempSync(join(tmpdir(), 'nova-ws-'));
  const outside = join(root, 'outside');
  mkdirSync(outside);
  const ws = new Workspace(join(root, 'workspace'));
  assert.equal(ws.resolve('workspace:notes/a.md'), join(ws.root, 'notes', 'a.md'));
  assert.throws(() => ws.resolve('../outside/a.md'), /outside the workspace/);
  assert.throws(() => ws.resolve('workspace:'), /outside the workspace/);
  symlinkSync(outside, join(ws.root, 'door'));
  assert.throws(() => ws.resolve('door/a.md'), /leads outside the workspace/);
  assert.throws(() => ws.read('door/a.md'), /leads outside/);
});
