// Per-merge ledger entries (docs/ledger/, from 2026-11-06): each file is one entry, named by date and
// branch so two pull requests never write the same file, and keeps the four parts the owner reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(import.meta.dirname, '..', 'docs', 'ledger');
const PARTS = ['- What changed:', '- What you can now do:', '- Still unfinished:', '- Checked:'];

test('every ledger entry file is named by date and branch and has its four parts', () => {
  const files = readdirSync(DIR).filter((f) => f !== 'README.md');
  assert.ok(files.length > 0, 'there is at least one entry');
  for (const f of files) {
    assert.match(f, /^\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9.-]*\.md$/, `${f}: name is YYYY-MM-DD-<branch>.md`);
    const s = readFileSync(join(DIR, f), 'utf8');
    assert.match(s, /^\*\*\d{4}-\d{2}-\d{2} · [^·\n]+ · [^\n]+\*\*\n/, `${f}: starts with **date · area · headline**`);
    for (const part of PARTS) assert.ok(s.includes(`\n${part} `), `${f}: has "${part}"`);
  }
});
