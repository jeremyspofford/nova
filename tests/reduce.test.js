import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reduce, titleFrom } from '../ui/js/reduce.js';

const T = 't1';
const base = [
  { type: 'session', id: 's', title: 'Hi', ts: '2026-10-21T10:00:00Z' },
  { type: 'user', turn: T, text: 'hello', ts: '2026-10-21T10:00:01Z' },
];

test('a finished turn', () => {
  const s = reduce([...base, { type: 'assistant', turn: T, attempt: 0, id: 'a', text: 'hi' }, { type: 'done', turn: T, attempt: 0 }]);
  assert.equal(s.title, 'Hi');
  assert.equal(s.turns[0].state, 'done');
  assert.deepEqual(s.turns[0].items.map((i) => i.kind), ['text']);
});

test('tool calls pair with approvals and results', () => {
  const s = reduce([...base,
    { type: 'tool_call', turn: T, attempt: 0, id: 'x', name: 'exec', args: { command: 'ls' }, needs_approval: true },
    { type: 'approval', turn: T, attempt: 0, id: 'x', decision: 'allow', ts: 'z' },
    { type: 'tool_result', turn: T, attempt: 0, id: 'x', ok: true, output: 'a' },
  ]);
  const tool = s.turns[0].items[0];
  assert.equal(tool.approval.decision, 'allow');
  assert.equal(tool.result.output, 'a');
  assert.equal(s.turns[0].state, 'open'); // no 'done' yet: running, or interrupted
});

test('regenerating shows only the newest attempt; the log keeps both', () => {
  const events = [...base,
    { type: 'assistant', turn: T, attempt: 0, id: 'a', text: 'first' }, { type: 'done', turn: T, attempt: 0 },
    { type: 'attempt', turn: T, attempt: 1 },
    { type: 'assistant', turn: T, attempt: 0, id: 'late', text: 'stale' },
    { type: 'assistant', turn: T, attempt: 1, id: 'b', text: 'second' }, { type: 'done', turn: T, attempt: 1 },
  ];
  const t = reduce(events).turns[0];
  assert.equal(t.attempt, 1);
  assert.deepEqual(t.items.map((i) => i.text), ['second']);
});

test('stopped and error states', () => {
  assert.equal(reduce([...base, { type: 'stopped', turn: T, attempt: 0 }]).turns[0].state, 'stopped');
  const e = reduce([...base, { type: 'error', turn: T, attempt: 0, message: 'm', detail: 'd' }]).turns[0];
  assert.equal(e.state, 'error');
  assert.equal(e.items[0].message, 'm');
});

test('titles are short and cut at a word', () => {
  assert.equal(titleFrom('  hello   there '), 'hello there');
  const t = titleFrom('What should I focus on today given everything that is going on with the migration and the card?');
  assert.ok(t.length <= 61 && t.endsWith('…') && !t.includes('  '));
});
