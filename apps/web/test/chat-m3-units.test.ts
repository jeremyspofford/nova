// Pure M3 chat helpers: segments, live calls, the approval reducer steps, mentions, formatting.
import { describe, expect, it, vi } from 'vitest';
import { expiryText, patternText, toAlwaysScope } from '../src/chat/ApprovalCard.tsx';
import { sourceHost } from '../src/chat/MessageItem.tsx';
import {
  fuzzyScore,
  filterMentions,
  groupMentions,
  mentionAt,
  rankMentions,
} from '../src/chat/mentions.ts';
import {
  PROGRESS_LIMIT,
  awaitsUser,
  initialThreadState,
  liveCallsByMessage,
  mergeCall,
  messageSegments,
  pendingApprovals,
  threadReducer,
  type ClientMessage,
  type LiveCall,
  type ThreadState,
} from '../src/chat/thread-state.ts';
import { formatDuration, toolSourceLabel } from '../src/chat/ToolCard.tsx';
import { createThreadBus } from '../src/services.tsx';
import { approvalView, toolPart } from './chat-m3-helpers.tsx';
import { thread } from './fakes.ts';

const reply = (over: Partial<ClientMessage> = {}): ClientMessage => ({
  id: 'r1',
  threadId: 't1',
  turnId: 'turn1',
  role: 'assistant',
  status: 'streaming',
  parts: [],
  model: null,
  usage: null,
  createdAt: '2026-10-01T12:00:00.000Z',
  ...over,
});

const live = (over: Partial<LiveCall> = {}): LiveCall => ({
  callId: 'c1',
  turnId: 'turn1',
  messageId: 'r1',
  tool: 'fs.read',
  source: 'builtin',
  status: 'running',
  argsPreview: '{}',
  resultPreview: null,
  error: null,
  approvalId: null,
  durationMs: null,
  progress: '',
  at: 0,
  seq: 0,
  ...over,
});

const kinds = (segs: ReturnType<typeof messageSegments>) =>
  segs.map((s) => (s.kind === 'text' ? s.text : s.kind === 'call' ? `[${s.call.callId}]` : '<a>'));

describe('messageSegments', () => {
  it('keeps stored parts in order and merges adjacent text', () => {
    const m = reply({
      status: 'complete',
      parts: [
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
        toolPart({ callId: 'x' }),
        { type: 'reasoning', text: 'hidden' },
        { type: 'artifact', artifactId: 'art', kind: 'code', title: null },
        { type: 'text', text: 'c' },
      ],
    });
    expect(kinds(messageSegments(m, undefined, []))).toEqual(['ab', '[x]', '<a>', 'c']);
  });

  it('splits streamed text where live calls started', () => {
    const segs = messageSegments(reply(), 'Looking. Found it.', [
      live({ callId: 'c2', at: 9, seq: 1 }),
      live({ callId: 'c1', at: 9, seq: 0 }),
    ]);
    expect(kinds(segs)).toEqual(['Looking. ', '[c1]', '[c2]', 'Found it.']);
  });

  it('places stored cards at their text offsets when the stream covers the stored text', () => {
    const m = reply({ parts: [{ type: 'text', text: 'One ' }, toolPart({ callId: 's1' })] });
    const segs = messageSegments(m, 'One two', [live({ callId: 's1', status: 'ok', at: 99 })]);
    expect(kinds(segs)).toEqual(['One ', '[s1]', 'two']);
    const call = segs.find((s) => s.kind === 'call');
    expect(call?.kind === 'call' && call.call.status).toBe('ok');
  });

  it('appends streamed text after stored parts it does not extend', () => {
    const m = reply({ parts: [{ type: 'text', text: 'stored' }] });
    expect(kinds(messageSegments(m, ' more', [live({ at: 0 })]))).toEqual([
      'stored',
      '[c1]',
      ' more',
    ]);
    // Offsets past the text clamp to its end.
    expect(kinds(messageSegments(reply(), 'ab', [live({ at: 50 })]))).toEqual(['ab', '[c1]']);
  });
});

describe('mergeCall', () => {
  it('lets a finished live state win over a stale stored part, and not the reverse', () => {
    const stored = toolPart({ status: 'running', resultPreview: null, durationMs: null });
    const merged = mergeCall(stored, live({ status: 'ok', resultPreview: 'done', durationMs: 7 }));
    expect([merged.status, merged.resultPreview, merged.durationMs]).toEqual(['ok', 'done', 7]);
    const kept = mergeCall(toolPart({ status: 'ok' }), live({ status: 'running', progress: 'p' }));
    expect(kept.status).toBe('ok');
    expect(kept.progress).toBe('p');
    expect(mergeCall(null, undefined).callId).toBe('');
  });
});

describe('liveCallsByMessage', () => {
  it('uses the stored part, then the known message, then the turn, then the newest reply; UI calls belong to no reply', () => {
    const a = reply({
      id: 'a',
      turnId: 't1',
      status: 'complete',
      parts: [toolPart({ callId: 'k' })],
    });
    const b = reply({ id: 'b', turnId: 't2' });
    const map = liveCallsByMessage({
      messages: [a, b],
      calls: {
        k: live({ callId: 'k', messageId: 'b', seq: 0 }),
        m: live({ callId: 'm', messageId: 'a', seq: 1 }),
        t: live({ callId: 't', messageId: 'gone', turnId: 't1', seq: 2 }),
        g: live({ callId: 'g', messageId: 'gone', turnId: 't9', seq: 3 }),
        // An MCP App's own call (no turn, no message): never shown as the model's.
        n: live({ callId: 'n', messageId: null, turnId: null, seq: 4 }),
      },
    });
    expect(map.get('a')?.map((c) => c.callId)).toEqual(['k', 'm', 't']);
    expect(map.get('b')?.map((c) => c.callId)).toEqual(['g']);
    expect(liveCallsByMessage({ messages: [], calls: { x: live() } }).size).toBe(0);
  });
});

describe('thread reducer, M3 steps', () => {
  const base = (): ThreadState => ({
    ...initialThreadState(thread({ id: 't1', state: 'waiting_approval' })),
    status: 'ready',
    messages: [reply()],
    turnRunning: true,
  });

  it('starts, streams, completes and denies calls', () => {
    let s = threadReducer(base(), {
      type: 'tool_started',
      callId: 'c1',
      tool: 'fs.read',
      source: 'builtin',
      argsPreview: '{}',
      turnId: 'turn1',
    });
    expect(s.calls.c1).toMatchObject({ messageId: 'r1', status: 'running', at: 0 });
    s = threadReducer(s, {
      type: 'tool_progress',
      callId: 'c1',
      chunk: 'x'.repeat(PROGRESS_LIMIT),
    });
    s = threadReducer(s, { type: 'tool_progress', callId: 'c1', chunk: 'END' });
    expect(s.calls.c1!.progress).toHaveLength(PROGRESS_LIMIT);
    expect(s.calls.c1!.progress.endsWith('END')).toBe(true);
    // Progress for a call never started is dropped.
    expect(threadReducer(s, { type: 'tool_progress', callId: 'zz', chunk: 'a' })).toBe(s);
    s = threadReducer(s, {
      type: 'tool_completed',
      callId: 'c1',
      status: 'ok',
      durationMs: 3,
      resultPreview: 'r',
      turnId: 'turn1',
    });
    expect(s.calls.c1).toMatchObject({ status: 'ok', durationMs: 3, resultPreview: 'r' });
    expect(threadReducer(s, { type: 'tool_progress', callId: 'c1', chunk: 'late' })).toBe(s);
    // A completion or denial for an unseen call creates it.
    s = threadReducer(s, {
      type: 'tool_denied',
      callId: 'c2',
      tool: 'fs.delete',
      reason: 'no',
      turnId: 'turn1',
    });
    expect(s.calls.c2).toMatchObject({ tool: 'fs.delete', status: 'denied', error: 'no', seq: 1 });
  });

  it('tracks approvals, links calls, and settles Needs input when all are answered', () => {
    let s = threadReducer(base(), {
      type: 'tool_started',
      callId: 'call1',
      tool: 'fs.write',
      source: 'builtin',
      argsPreview: '{}',
      turnId: 'turn1',
    });
    s = threadReducer(s, { type: 'approvals', items: [approvalView('t1')] });
    expect(s.calls.call1!.approvalId).toBe('ap1');
    expect(pendingApprovals(s).map((a) => a.id)).toEqual(['ap1']);
    expect(s.thread?.state).toBe('waiting_approval');
    expect(threadReducer(s, { type: 'approvals', items: [] })).toBe(s);

    // A hand-off keeps waiting until it is marked done.
    s = threadReducer(s, { type: 'approval_decided', approvalId: 'ap1', decision: 'handoff' });
    expect(awaitsUser(s.approvals.ap1!)).toBe(true);
    s = threadReducer(s, { type: 'handoff_done', approvalId: 'ap1' });
    expect(awaitsUser(s.approvals.ap1!)).toBe(false);
    expect(s.thread?.state).toBe('streaming');

    // A stale pending view never reopens a decided card; a timeout expires it.
    const decided = threadReducer(s, { type: 'approvals', items: [approvalView('t1')] });
    expect(decided.approvals.ap1!.handoffDone).toBe(true);
    const t = threadReducer(
      threadReducer(base(), { type: 'approvals', items: [approvalView('t1', { id: 'ap2' })] }),
      { type: 'approval_decided', approvalId: 'ap2', decision: 'timeout' },
    );
    expect(t.approvals.ap2!.status).toBe('expired');
    expect(
      threadReducer(t, { type: 'approval_decided', approvalId: 'nope', decision: 'deny_stop' }),
    ).toBe(t);
    expect(threadReducer(t, { type: 'handoff_done', approvalId: 'nope' })).toBe(t);
    // The turn ended while waiting: the chat is idle, not running.
    const idle = threadReducer(
      { ...t, turnRunning: false, thread: { ...t.thread!, state: 'waiting_approval' } },
      { type: 'turn', running: false },
    );
    expect(idle.thread?.state).toBe('idle');
  });

  it('treats a decided hand-off as waiting until it is marked done', () => {
    const a = { ...approvalView('t1'), status: 'decided' as const, decision: 'handoff' as const };
    expect(awaitsUser(a)).toBe(true);
    expect(awaitsUser({ ...a, handoffDone: true })).toBe(false);
    expect(awaitsUser({ ...a, decision: 'allow_once' })).toBe(false);
  });
});

describe('mentions', () => {
  it('finds the @token at the caret', () => {
    expect(mentionAt('see @rea', 8)).toEqual({ start: 4, end: 8, query: 'rea' });
    expect(mentionAt('@', 1)).toEqual({ start: 0, end: 1, query: '' });
    // The rest of the word after the caret is part of the token.
    expect(mentionAt('x @readme y', 5)).toEqual({ start: 2, end: 9, query: 're' });
    expect(mentionAt('mail me@example.com', 19)).toBeNull();
    expect(mentionAt('@a b', 4)).toBeNull();
    expect(mentionAt('', 0)).toBeNull();
  });

  it('scores prefix over substring over subsequence', () => {
    expect(fuzzyScore('', 'x')).toBe(0);
    expect(fuzzyScore('rea', 'README.md')).toBe(3);
    expect(fuzzyScore('me', 'README.md')!).toBeGreaterThan(1);
    expect(fuzzyScore('rdm', 'README.md')!).toBeLessThan(1);
    expect(fuzzyScore('zz', 'README.md')).toBeNull();
  });

  it('ranks, filters and groups candidates', () => {
    const items = [
      { kind: 'tool' as const, ref: 'tool:x', label: 'xyz', detail: null },
      { kind: 'file' as const, ref: 'file:/a/readme', label: 'readme', detail: null },
      { kind: 'skill' as const, ref: 'skill:r', label: 'rdx', detail: null },
    ];
    expect(rankMentions(items, 're').map((c) => c.label)).toEqual(['readme', 'xyz', 'rdx']);
    expect(filterMentions(items, 'rd').map((c) => c.label)).toEqual(['rdx', 'readme']);
    expect(groupMentions(items).map((g) => g.label)).toEqual(['Files', 'Tools', 'Skills']);
  });
});

describe('formatting', () => {
  it('formats durations and sources', () => {
    expect(formatDuration(null)).toBeNull();
    expect(formatDuration(-1)).toBeNull();
    expect(formatDuration(450)).toBe('450 ms');
    expect(formatDuration(12_000)).toBe('12 s');
    expect(formatDuration(120_000)).toBe('2 min');
    expect(toolSourceLabel('mcp:files/search', 'mcp')).toBe('MCP server files');
    expect(toolSourceLabel('mcp', 'mcp')).toBe('MCP server');
    expect(toolSourceLabel('x', 'page')).toBe('Web page');
  });

  it('formats approval expiry, prefix patterns and scopes', () => {
    const now = Date.parse('2026-10-01T12:00:00Z');
    expect(expiryText('2026-10-01T12:10:00Z', now)).toBe('Expires in 10 min');
    expect(expiryText('2026-10-01T14:00:00Z', now)).toBe('Expires in 2 h');
    expect(expiryText('2026-10-01T11:00:00Z', now)).toBe('Expired');
    expect(expiryText('soon', now)).toBe('');
    expect(patternText(['git', ['push', 'pull']])).toBe('git {push|pull}');
    expect(toAlwaysScope({ kind: 'tool', label: 'L', tool: 'fs.write' })).toEqual({
      kind: 'tool',
      tool: 'fs.write',
    });
  });

  it('extracts web source hosts and refuses unsafe URLs', () => {
    expect(sourceHost('https://www.example.com/a')).toBe('example.com');
    expect(sourceHost('http://sub.example.org')).toBe('sub.example.org');
    expect(sourceHost('javascript:alert(1)')).toBeNull();
    expect(sourceHost(null)).toBeNull();
    expect(sourceHost('https://')).toBeNull();
  });
});

describe('thread bus', () => {
  it('delivers to subscribers until they leave', () => {
    const bus = createThreadBus();
    const fn = vi.fn();
    const off = bus.subscribe(fn);
    const env = { id: '1', name: 'x', schemaVersion: 1, ts: '', actor: 'system', payload: {} };
    bus.emit(env);
    off();
    bus.emit(env);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
