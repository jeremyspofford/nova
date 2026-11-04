// B6: a backup folder on another Windows drive is outside Nova's home. relative() between drives is
// an absolute path, which the old check read as "inside", so every nightly backup failed even
// though Settings had accepted the folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { win32, posix } from 'node:path';
import { inside } from '../../src/core/resilience/backup.ts';

test('a folder on another Windows drive is not inside Nova’s home', () => {
  assert.equal(inside('D:\\backups', 'C:\\Users\\placeholder\\Nova', win32), false);
  assert.equal(inside('C:\\Users\\placeholder\\Nova\\backups', 'C:\\Users\\placeholder\\Nova', win32), true);
  assert.equal(inside('C:\\Users\\placeholder\\Nova', 'C:\\Users\\placeholder\\Nova', win32), true);
  assert.equal(inside('C:\\Users\\placeholder\\Nova-copies', 'C:\\Users\\placeholder\\Nova', win32), false);
});

test('inside() keeps its POSIX answers', () => {
  assert.equal(inside('/srv/backups', '/home/placeholder/Nova', posix), false);
  assert.equal(inside('/home/placeholder/Nova/backups', '/home/placeholder/Nova', posix), true);
  assert.equal(inside('/home/placeholder/Nova/../Nova/x', '/home/placeholder/Nova', posix), true);
  assert.equal(inside('/home/placeholder/..x', '/home/placeholder', posix), true, 'a child named ..x is inside');
});
