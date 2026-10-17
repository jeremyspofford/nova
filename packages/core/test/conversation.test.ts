// M2 conversation engine: steering and queued follow-ups (FR-019), message versions and delete
// (FR-020), branches (FR-033), side chats (FR-026) and temporary chats (FR-027).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatRequest } from '@nova/providers';
import { ChatService, MemoryEventSink } from '../src/index.ts';
import { ACCOUNT, b64, makeEnv, waitFor, type Env } from './helpers.ts';

let env: Env;
afterEach(() => env.close());

const words = (n: number, w = 'w') => Array.from({ length: n }, (_, i) => `${w}${i}`).join(' ');
const texts = (req: ChatRequest | undefined) =>
  (req?.messages ?? []).map((m) => [
    m.role,
    m.content.map((p) => (p.type === 'text' ? p.text : p.type)).join('|'),
  ]);
const count = (sql: string, ...args: string[]) =>
  (env.db.raw.prepare(sql).get(...args) as { n: number }).n;
const roles = async (threadId: string) =>
  (await env.threads.detail(ACCOUNT, threadId)).messages.map((m) => m.role);

describe('steering (FR-019)', () => {
  it('applies steering input at the next model step, in a new assistant message of the same turn', async () => {
    env = await makeEnv({ mock: { timing: { chunkDelayMs: 10 } } });
    const t = await env.threads.create(ACCOUNT, {});
    const first = await env.chat.send(ACCOUNT, t.id, { text: words(30) });
    await waitFor(() => env.events.names().includes('chat.delta'));
    const steer = await env.chat.send(ACCOUNT, t.id, { text: 'focus on w3', inputMode: 'steer' });
    expect(steer).toEqual({
      disposition: 'steered',
      turnId: first.turnId,
      userMessageId: expect.any(String),
      assistantMessageId: null,
    });
    await env.chat.idle();

    const detail = await env.threads.detail(ACCOUNT, t.id);
    expect(detail.messages.map((m) => [m.role, m.turnId, m.provenance])).toEqual([
      ['user', first.turnId, 'typed'],
      ['assistant', first.turnId, undefined],
      ['user', first.turnId, 'steer'],
      ['assistant', first.turnId, undefined],
    ]);
    expect(detail.messages[2]!.id).toBe(steer.userMessageId);
    expect(detail.messages[3]!.parts).toEqual([{ type: 'text', text: 'You said: focus on w3' }]);
    // The second step saw the first answer and the steering input.
    expect(env.mock.requests).toHaveLength(2);
    expect(texts(env.mock.requests[1]).slice(1)).toEqual([
      ['user', words(30)],
      ['assistant', `You said: ${words(30)}`],
      ['user', 'focus on w3'],
    ]);
    const turn = env.db.raw.prepare('SELECT * FROM turn WHERE id = ?').get(first.turnId) as {
      step_count: number;
      status: string;
    };
    expect(turn).toMatchObject({ step_count: 2, status: 'completed' });
    expect(count('SELECT count(*) AS n FROM usage_event WHERE turn_id = ?', first.turnId!)).toBe(2);
    const created = env.events.events.filter(
      (e) => e.name === 'chat.message.created' && e.payload.provenance === 'steer',
    );
    expect(created).toHaveLength(1);
    expect(env.events.events.find((e) => e.name === 'turn.completed')!.payload.steps).toBe(2);
  });

  it('runs the steering step even after a failed step; the last step decides the turn', async () => {
    env = await makeEnv({
      mock: {
        scripts: [
          {
            when: 'flaky start',
            once: true,
            steps: [
              { type: 'text_delta', text: 'partial' },
              { delayMs: 60 },
              {
                type: 'stop',
                reason: 'error',
                error: { code: 'network', message: 'dropped', retryable: true },
              },
            ],
          },
        ],
      },
    });
    const t = await env.threads.create(ACCOUNT, {});
    const first = await env.chat.send(ACCOUNT, t.id, { text: 'flaky start' });
    await waitFor(() => env.events.names().includes('chat.delta'));
    await env.chat.send(ACCOUNT, t.id, { text: 'try again', inputMode: 'steer' });
    await env.chat.idle();
    const msgs = (await env.threads.detail(ACCOUNT, t.id)).messages;
    expect(msgs.map((m) => [m.role, m.status])).toEqual([
      ['user', 'complete'],
      ['assistant', 'error'],
      ['user', 'complete'],
      ['assistant', 'complete'],
    ]);
    const turn = env.db.raw
      .prepare('SELECT status, step_count FROM turn WHERE id = ?')
      .get(first.turnId);
    expect(turn).toEqual({ status: 'completed', step_count: 2 });
    expect((await env.threads.view(ACCOUNT, t.id)).state).toBe('idle');
  });

  it('uses the general.followUp setting when the request does not say', async () => {
    env = await makeEnv({ mock: { timing: { chunkDelayMs: 10 } } });
    env.settings.followUp = 'steer';
    const t = await env.threads.create(ACCOUNT, {});
    await env.chat.send(ACCOUNT, t.id, { text: words(20) });
    expect((await env.chat.send(ACCOUNT, t.id, { text: 'more' })).disposition).toBe('steered');
    await env.chat.idle();
    expect(await roles(t.id)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });

  it('leaves steering unanswered when the step is cancelled, and validates input', async () => {
    env = await makeEnv({ mock: { timing: { chunkDelayMs: 15 } } });
    const t = await env.threads.create(ACCOUNT, {});
    await env.chat.send(ACCOUNT, t.id, { text: words(40) });
    await expect(
      env.chat.send(ACCOUNT, t.id, { text: '  ', inputMode: 'steer' }),
    ).rejects.toMatchObject({ code: 'validation', details: { reason: 'empty' } });
    await env.chat.send(ACCOUNT, t.id, { text: 'stop soon', inputMode: 'steer' });
    await env.chat.cancel(ACCOUNT, t.id);
    await env.chat.idle();
    expect(env.mock.requests).toHaveLength(1);
    expect(await roles(t.id)).toEqual(['user', 'assistant', 'user']);
    expect(env.events.names()).toContain('turn.interrupted');
  });

  it('a steer with attachments stores them on the steering message', async () => {
    env = await makeEnv({ mock: { timing: { chunkDelayMs: 10 } } });
    const t = await env.threads.create(ACCOUNT, {});
    await env.chat.send(ACCOUNT, t.id, { text: words(20) });
    await env.chat.send(ACCOUNT, t.id, {
      text: 'see this',
      inputMode: 'steer',
      attachments: [{ name: 'n.txt', mime: 'text/plain', data: b64('steer file body') }],
    });
    await env.chat.idle();
    const last = env.mock.requests.at(-1)!.messages.at(-1)!;
    expect(last.content.map((p) => (p.type === 'text' ? p.text : '')).join('')).toContain(
      'steer file body',
    );
  });
});

describe('queued follow-ups (FR-019)', () => {
  it('queues in order, reports positions, and runs each as its own turn', async () => {
    env = await makeEnv({ mock: { timing: { chunkDelayMs: 10 } } });
    const t = await env.threads.create(ACCOUNT, {});
    await env.chat.send(ACCOUNT, t.id, { text: words(10) });
    const b = await env.chat.send(ACCOUNT, t.id, { text: 'second' });
    const c = await env.chat.send(ACCOUNT, t.id, {
      text: 'third',
      attachments: [{ name: 'a.txt', mime: 'text/plain', data: b64('queued file') }],
    });
    expect([b.queuePosition, c.queuePosition]).toEqual([1, 2]);
    const queue = await env.chat.listQueue(ACCOUNT, t.id);
    expect(queue.map((q) => [q.text, q.position, q.attachmentCount])).toEqual([
      ['second', 1, 0],
      ['third', 2, 1],
    ]);
    expect((await env.threads.detail(ACCOUNT, t.id)).queue).toHaveLength(2);
    await env.chat.idle();

    const detail = await env.threads.detail(ACCOUNT, t.id);
    const users = detail.messages.filter((m) => m.role === 'user');
    expect(
      users.map((m) => [m.parts[0]?.type === 'text' ? m.parts[0].text : '', m.provenance]),
    ).toEqual([
      [words(10), 'typed'],
      ['second', 'queued'],
      ['third', 'queued'],
    ]);
    // The queued id becomes the user message id.
    expect(users[1]!.id).toBe(b.userMessageId);
    expect(users[2]!.parts.some((p) => p.type === 'file')).toBe(true);
    expect(detail.queue).toEqual([]);
    expect(count('SELECT count(*) AS n FROM turn WHERE thread_id = ?', t.id)).toBe(3);
    const names = env.events.names();
    expect(names.filter((n) => n === 'chat.followup.queued')).toHaveLength(2);
    expect(names.filter((n) => n === 'chat.followup.started')).toHaveLength(2);
    const started = env.events.events.find((e) => e.name === 'chat.followup.started')!;
    expect(started.payload).toMatchObject({ threadId: t.id, queuedId: b.userMessageId });
  });

  it('still runs the queue after a cancel', async () => {
    env = await makeEnv({ mock: { timing: { chunkDelayMs: 15 } } });
    const t = await env.threads.create(ACCOUNT, {});
    await env.chat.send(ACCOUNT, t.id, { text: words(40) });
    await env.chat.send(ACCOUNT, t.id, { text: 'after the stop' });
    await waitFor(() => env.events.names().includes('chat.delta'));
    await env.chat.cancel(ACCOUNT, t.id);
    await env.chat.idle();
    const msgs = (await env.threads.detail(ACCOUNT, t.id)).messages;
    expect(msgs.map((m) => m.status)).toEqual(['complete', 'incomplete', 'complete', 'complete']);
    expect(msgs[3]!.parts).toEqual([{ type: 'text', text: 'You said: after the stop' }]);
  });

  it('survives a restart: pending input starts on recovery', async () => {
    env = await makeEnv({ mock: { timing: { chunkDelayMs: 15 } } });
    const t = await env.threads.create(ACCOUNT, {});
    await env.chat.send(ACCOUNT, t.id, { text: words(40) });
    await env.chat.send(ACCOUNT, t.id, { text: 'waiting for a restart' });
    await waitFor(() => env.events.names().includes('chat.delta'));
    // Shutdown stops the turn and leaves the queue pending, like a process exit.
    await env.chat.shutdown();
    expect(count("SELECT count(*) AS n FROM queued_input WHERE status = 'pending'")).toBe(1);
    const events = new MemoryEventSink();
    const restarted = new ChatService({
      db: env.db,
      router: env.router,
      threads: env.threads,
      events,
      dataDir: join(env.dir, 'data'),
      deltaIntervalMs: 0,
    });
    await restarted.recoverOnStartup();
    await restarted.idle();
    const msgs = (await env.threads.detail(ACCOUNT, t.id)).messages;
    expect(msgs.at(-1)!.parts).toEqual([{ type: 'text', text: 'You said: waiting for a restart' }]);
    expect(events.names()).toContain('chat.followup.started');
    expect(count("SELECT count(*) AS n FROM queued_input WHERE status = 'pending'")).toBe(0);
    await restarted.shutdown();
  });

  it('cancels a queued message before it starts; a started one is not found', async () => {
    env = await makeEnv({ mock: { timing: { chunkDelayMs: 10 } } });
    const t = await env.threads.create(ACCOUNT, {});
    await env.chat.send(ACCOUNT, t.id, { text: words(20) });
    const q = await env.chat.send(ACCOUNT, t.id, {
      text: 'never mind',
      attachments: [{ name: 'only-here.txt', mime: 'text/plain', data: b64('unique bytes 42') }],
    });
    const blob = env.db.raw
      .prepare('SELECT attachments FROM queued_input WHERE id = ?')
      .get(q.userMessageId) as { attachments: string };
    const path = join(
      env.dir,
      'data',
      (JSON.parse(blob.attachments) as { blobPath: string }[])[0]!.blobPath,
    );
    expect(existsSync(path)).toBe(true);
    await env.chat.cancelQueued(ACCOUNT, t.id, q.userMessageId);
    expect(existsSync(path)).toBe(false);
    await expect(env.chat.cancelQueued(ACCOUNT, t.id, q.userMessageId)).rejects.toMatchObject({
      code: 'not_found',
    });
    await env.chat.idle();
    expect(await roles(t.id)).toEqual(['user', 'assistant']);
    expect(env.events.names()).toContain('chat.followup.cancelled');
  });

  it('rejects an unknown model for queued input and cancels input that cannot start', async () => {
    env = await makeEnv({ mock: { timing: { chunkDelayMs: 10 } } });
    const t = await env.threads.create(ACCOUNT, {});
    await env.chat.send(ACCOUNT, t.id, { text: words(20) });
    await expect(
      env.chat.send(ACCOUNT, t.id, { text: 'x', model: 'nope/model' }),
    ).rejects.toMatchObject({ details: { reason: 'unknown_model' } });
    await env.chat.send(ACCOUNT, t.id, { text: 'will fail' });
    // The provider goes away before the queued input starts.
    await env.registry.remove(ACCOUNT, env.mockAccountId);
    await env.chat.idle();
    expect(count("SELECT count(*) AS n FROM queued_input WHERE status = 'cancelled'")).toBe(1);
    const cancelled = env.events.events.find((e) => e.name === 'chat.followup.cancelled')!;
    expect(cancelled.payload).toMatchObject({ reason: 'failed' });
  });
});

describe('versions: edit, regenerate, select, delete (FR-020)', () => {
  it('edit adds a sibling version and keeps the old one and its replies', async () => {
    env = await makeEnv();
    const t = await env.threads.create(ACCOUNT, {});
    const a = await env.chat.send(ACCOUNT, t.id, { text: 'first' });
    await env.chat.idle();
    await env.chat.send(ACCOUNT, t.id, { text: 'second' });
    await env.chat.idle();
    const before = env.db.raw.prepare('SELECT id, updated_at FROM message ORDER BY id').all();

    const edited = await env.chat.edit(ACCOUNT, t.id, a.userMessageId, { text: 'first, edited' });
    expect(edited.disposition).toBe('started');
    await env.chat.idle();
    // Nothing that existed was changed (FR-020: prior turns are never mutated).
    const after = env.db.raw.prepare('SELECT id, updated_at FROM message ORDER BY id').all();
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after).toHaveLength(before.length + 2);

    const detail = await env.threads.detail(ACCOUNT, t.id);
    expect(detail.messages.map((m) => m.id)).toEqual([
      edited.userMessageId,
      edited.assistantMessageId,
    ]);
    expect(detail.messages[0]!.siblingIds).toEqual([a.userMessageId, edited.userMessageId]);
    expect(detail.messages[1]!.siblingIds).toBeUndefined();
    expect(texts(env.mock.requests.at(-1)).slice(1)).toEqual([['user', 'first, edited']]);

    // Back to the first version: the path continues to its newest descendant.
    const back = await env.chat.selectVersion(ACCOUNT, t.id, a.userMessageId);
    expect(back.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(back.messages[0]!.id).toBe(a.userMessageId);
    // The next message continues the selected path.
    await env.chat.send(ACCOUNT, t.id, { text: 'third' });
    await env.chat.idle();
    expect(
      texts(env.mock.requests.at(-1))
        .slice(1)
        .map((x) => x[1]),
    ).toEqual(['first', 'You said: first', 'second', 'You said: second', 'third']);
  });

  it('edit copies the attachments of the edited message', async () => {
    env = await makeEnv();
    const t = await env.threads.create(ACCOUNT, {});
    const a = await env.chat.send(ACCOUNT, t.id, {
      text: 'read this',
      attachments: [{ name: 'doc.md', mime: 'text/markdown', data: b64('# kept') }],
    });
    await env.chat.idle();
    const e = await env.chat.edit(ACCOUNT, t.id, a.userMessageId, { text: 'read this again' });
    await env.chat.idle();
    const msg = (await env.threads.detail(ACCOUNT, t.id)).messages[0]!;
    expect(msg.id).toBe(e.userMessageId);
    expect(msg.parts.filter((p) => p.type === 'file')).toMatchObject([{ name: 'doc.md' }]);
  });

  it('regenerate adds a sibling reply to the same user message', async () => {
    env = await makeEnv({
      mock: {
        scripts: [
          { when: 'hello', once: true, steps: [{ type: 'text_delta', text: 'one' }] },
          { when: 'hello', steps: [{ type: 'text_delta', text: 'two' }] },
        ],
      },
    });
    const t = await env.threads.create(ACCOUNT, {});
    const a = await env.chat.send(ACCOUNT, t.id, { text: 'hello' });
    await env.chat.idle();
    const r = await env.chat.regenerate(ACCOUNT, t.id, a.assistantMessageId!);
    expect(r.userMessageId).toBe(a.userMessageId);
    await env.chat.idle();
    const detail = await env.threads.detail(ACCOUNT, t.id);
    expect(detail.messages.map((m) => m.id)).toEqual([a.userMessageId, r.assistantMessageId]);
    expect(detail.messages[1]!.parts).toEqual([{ type: 'text', text: 'two' }]);
    expect(detail.messages[1]!.siblingIds).toEqual([a.assistantMessageId, r.assistantMessageId]);
    expect(detail.messages[1]!.parentId).toBe(a.userMessageId);
    expect(texts(env.mock.requests.at(-1)).slice(1)).toEqual([['user', 'hello']]);
    const back = await env.chat.selectVersion(ACCOUNT, t.id, a.assistantMessageId!);
    expect(back.messages[1]!.parts).toEqual([{ type: 'text', text: 'one' }]);

    await expect(env.chat.regenerate(ACCOUNT, t.id, a.userMessageId)).rejects.toMatchObject({
      code: 'validation',
    });
    await expect(env.chat.regenerate(ACCOUNT, t.id, 'missing')).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(
      env.chat.edit(ACCOUNT, t.id, a.assistantMessageId!, { text: 'x' }),
    ).rejects.toMatchObject({ code: 'validation' });
    await expect(env.chat.selectVersion(ACCOUNT, t.id, 'missing')).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('refuses edit, regenerate, select and delete while a turn runs (409)', async () => {
    env = await makeEnv({ mock: { timing: { chunkDelayMs: 10 } } });
    const t = await env.threads.create(ACCOUNT, {});
    const a = await env.chat.send(ACCOUNT, t.id, { text: 'hi' });
    await env.chat.idle();
    await env.chat.send(ACCOUNT, t.id, { text: words(20) });
    const conflict = { code: 'conflict' };
    await expect(
      env.chat.edit(ACCOUNT, t.id, a.userMessageId, { text: 'x' }),
    ).rejects.toMatchObject(conflict);
    await expect(env.chat.regenerate(ACCOUNT, t.id, a.assistantMessageId!)).rejects.toMatchObject(
      conflict,
    );
    await expect(env.chat.selectVersion(ACCOUNT, t.id, a.userMessageId)).rejects.toMatchObject(
      conflict,
    );
    await expect(env.chat.deleteMessage(ACCOUNT, t.id, a.userMessageId)).rejects.toMatchObject(
      conflict,
    );
    await env.chat.idle();
  });

  it('delete hides a user message and its reply from the detail, the context and search', async () => {
    env = await makeEnv();
    const t = await env.threads.create(ACCOUNT, {});
    const a = await env.chat.send(ACCOUNT, t.id, { text: 'zebra stripes' });
    await env.chat.idle();
    await env.chat.send(ACCOUNT, t.id, { text: 'lion mane' });
    await env.chat.idle();
    expect(env.threads.search(ACCOUNT, 'zebra')).toHaveLength(2);
    await env.chat.deleteMessage(ACCOUNT, t.id, a.userMessageId);
    expect(env.threads.search(ACCOUNT, 'zebra')).toEqual([]);
    const detail = await env.threads.detail(ACCOUNT, t.id);
    expect(detail.messages.map((m) => m.parts[0])).toEqual([
      { type: 'text', text: 'lion mane' },
      { type: 'text', text: 'You said: lion mane' },
    ]);
    await env.chat.send(ACCOUNT, t.id, { text: 'tiger' });
    await env.chat.idle();
    expect(
      texts(env.mock.requests.at(-1))
        .slice(1)
        .map((x) => x[1]),
    ).toEqual(['lion mane', 'You said: lion mane', 'tiger']);
    const deleted = env.events.events.filter((e) => e.name === 'chat.message.deleted');
    expect(deleted.map((e) => e.payload.messageId)).toEqual([
      a.userMessageId,
      a.assistantMessageId,
    ]);
    await expect(env.chat.deleteMessage(ACCOUNT, t.id, a.userMessageId)).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('deleting the last reply moves the active path to the message before it', async () => {
    env = await makeEnv();
    const t = await env.threads.create(ACCOUNT, {});
    const a = await env.chat.send(ACCOUNT, t.id, { text: 'one' });
    await env.chat.idle();
    await env.chat.deleteMessage(ACCOUNT, t.id, a.assistantMessageId!);
    const row = await env.threads.row(ACCOUNT, t.id);
    expect(row.activeLeafId).toBe(a.userMessageId);
    expect(await roles(t.id)).toEqual(['user']);
  });
});

describe('branches (FR-020, FR-033)', () => {
  it('inherits the parent path up to the branch point without copying rows', async () => {
    env = await makeEnv();
    const parent = await env.threads.create(ACCOUNT, { title: 'Plans' });
    const a = await env.chat.send(ACCOUNT, parent.id, { text: 'alpha' });
    await env.chat.idle();
    await env.chat.send(ACCOUNT, parent.id, { text: 'beta' });
    await env.chat.idle();
    const messagesBefore = count('SELECT count(*) AS n FROM message');

    const branch = await env.threads.branch(ACCOUNT, parent.id, {
      fromMessageId: a.assistantMessageId!,
    });
    expect(branch).toMatchObject({
      title: 'Branch: Plans',
      parentThreadId: parent.id,
      branchFromMessageId: a.assistantMessageId,
      side: false,
    });
    expect(count('SELECT count(*) AS n FROM message')).toBe(messagesBefore);
    const inherited = await env.threads.detail(ACCOUNT, branch.id);
    expect(inherited.messages.map((m) => [m.id, m.threadId])).toEqual([
      [a.userMessageId, parent.id],
      [a.assistantMessageId, parent.id],
    ]);

    await env.chat.send(ACCOUNT, branch.id, { text: 'gamma' });
    await env.chat.idle();
    expect(
      texts(env.mock.requests.at(-1))
        .slice(1)
        .map((x) => x[1]),
    ).toEqual(['alpha', 'You said: alpha', 'gamma']);
    const detail = await env.threads.detail(ACCOUNT, branch.id);
    expect(detail.messages.map((m) => m.threadId)).toEqual([
      parent.id,
      parent.id,
      branch.id,
      branch.id,
    ]);
    expect(count('SELECT count(*) AS n FROM message WHERE thread_id = ?', branch.id)).toBe(2);
    // The parent is untouched.
    expect(await roles(parent.id)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(env.events.events.find((e) => e.name === 'chat.branch.created')!.payload).toEqual({
      threadId: branch.id,
      parentId: parent.id,
      fromMessageId: a.assistantMessageId,
    });
    // Branches are chats of their own in the list.
    expect((await env.threads.list(ACCOUNT)).items.map((x) => x.id)).toContain(branch.id);

    const tree = await env.threads.tree(ACCOUNT, branch.id);
    expect(tree.rootThreadId).toBe(parent.id);
    expect(tree.nodes.map((n) => [n.threadId, n.parentThreadId, n.messageCount])).toEqual([
      [parent.id, null, 4],
      [branch.id, parent.id, 2],
    ]);
  });

  it('keeps inherited messages visible after the parent chat is deleted', async () => {
    env = await makeEnv();
    const parent = await env.threads.create(ACCOUNT, {});
    const a = await env.chat.send(ACCOUNT, parent.id, { text: 'root idea' });
    await env.chat.idle();
    const branch = await env.threads.branch(ACCOUNT, parent.id, {
      fromMessageId: a.assistantMessageId!,
      title: 'Mine',
    });
    expect(branch.title).toBe('Mine');
    await env.chat.deleteThread(ACCOUNT, parent.id);
    expect(await roles(branch.id)).toEqual(['user', 'assistant']);
    expect((await env.threads.tree(ACCOUNT, branch.id)).rootThreadId).toBe(branch.id);
  });

  it('refuses a branch point that is not on the active path', async () => {
    env = await makeEnv();
    const t = await env.threads.create(ACCOUNT, {});
    const a = await env.chat.send(ACCOUNT, t.id, { text: 'x' });
    await env.chat.idle();
    await env.chat.edit(ACCOUNT, t.id, a.userMessageId, { text: 'y' });
    await env.chat.idle();
    await expect(
      env.threads.branch(ACCOUNT, t.id, { fromMessageId: a.userMessageId }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('side chats (FR-026)', () => {
  it('answers with the parent context and adds nothing to the parent', async () => {
    env = await makeEnv();
    const parent = await env.threads.create(ACCOUNT, { title: 'Main' });
    await env.chat.send(ACCOUNT, parent.id, { text: 'the main topic' });
    await env.chat.idle();
    const res = await env.chat.sideChat(ACCOUNT, parent.id, { text: 'quick question' });
    expect(res.thread).toMatchObject({
      side: true,
      memoryOptOut: true,
      parentThreadId: parent.id,
      temporary: false,
    });
    expect(res.send.disposition).toBe('started');
    await env.chat.idle();
    expect(
      texts(env.mock.requests.at(-1))
        .slice(1)
        .map((x) => x[1]),
    ).toEqual(['the main topic', 'You said: the main topic', 'quick question']);
    expect(await roles(parent.id)).toEqual(['user', 'assistant']);
    expect(await roles(res.thread.id)).toEqual(['user', 'assistant']);
    expect((await env.threads.list(ACCOUNT)).items.map((t) => t.id)).toEqual([parent.id]);
    const tree = await env.threads.tree(ACCOUNT, parent.id);
    expect(tree.nodes.map((n) => [n.threadId, n.side])).toEqual([
      [parent.id, false],
      [res.thread.id, true],
    ]);

    // A later parent message is part of the next side turn's context (the current path).
    await env.chat.send(ACCOUNT, parent.id, { text: 'new detail' });
    await env.chat.idle();
    await env.chat.send(ACCOUNT, res.thread.id, { text: 'and now?' });
    await env.chat.idle();
    expect(
      texts(env.mock.requests.at(-1))
        .slice(1)
        .map((x) => x[1]),
    ).toEqual([
      'the main topic',
      'You said: the main topic',
      'new detail',
      'You said: new detail',
      'quick question',
      'You said: quick question',
      'and now?',
    ]);
    // Deleting the parent takes its side chats with it.
    await env.chat.deleteThread(ACCOUNT, parent.id);
    await expect(env.threads.row(ACCOUNT, res.thread.id)).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('inherits temporary from the parent and removes itself when the first send fails', async () => {
    env = await makeEnv();
    const parent = await env.threads.create(ACCOUNT, { temporary: true });
    const side = await env.chat.sideChat(ACCOUNT, parent.id, { text: 'q' });
    expect(side.thread.temporary).toBe(true);
    await env.chat.idle();
    await expect(
      env.chat.sideChat(ACCOUNT, parent.id, { text: 'q', model: 'nope/x' }),
    ).rejects.toMatchObject({ code: 'validation' });
    await env.registry.remove(ACCOUNT, env.mockAccountId);
    const before = count('SELECT count(*) AS n FROM thread');
    await expect(env.chat.sideChat(ACCOUNT, parent.id, { text: 'q' })).rejects.toMatchObject({
      code: 'validation',
    });
    expect(count('SELECT count(*) AS n FROM thread')).toBe(before);
  });
});

describe('temporary chats (FR-027)', () => {
  it('delete purges every row, the search index and unshared blobs', async () => {
    env = await makeEnv();
    const keep = await env.threads.create(ACCOUNT, {});
    await env.chat.send(ACCOUNT, keep.id, {
      text: 'shared file',
      attachments: [{ name: 's.txt', mime: 'text/plain', data: b64('shared bytes') }],
    });
    await env.chat.idle();
    const tmp = await env.threads.create(ACCOUNT, { temporary: true });
    await env.chat.send(ACCOUNT, tmp.id, {
      text: 'ephemeral words',
      attachments: [
        { name: 'only.txt', mime: 'text/plain', data: b64('temporary only bytes') },
        { name: 's.txt', mime: 'text/plain', data: b64('shared bytes') },
      ],
    });
    await env.chat.idle();
    await env.chat.sideChat(ACCOUNT, tmp.id, { text: 'side of temp' });
    await env.chat.idle();
    const blobs = (
      env.db.raw
        .prepare('SELECT DISTINCT blob_path AS p FROM attachment WHERE thread_id = ?')
        .all(tmp.id) as { p: string }[]
    ).map((r) => join(env.dir, 'data', r.p));
    expect(blobs).toHaveLength(2);

    await env.chat.deleteThread(ACCOUNT, tmp.id);
    expect(count('SELECT count(*) AS n FROM thread WHERE temporary = 1')).toBe(0);
    expect(
      count('SELECT count(*) AS n FROM message WHERE thread_id NOT IN (SELECT id FROM thread)'),
    ).toBe(0);
    expect(
      count('SELECT count(*) AS n FROM turn WHERE thread_id NOT IN (SELECT id FROM thread)'),
    ).toBe(0);
    expect(count("SELECT count(*) AS n FROM message_search WHERE text LIKE '%ephemeral%'")).toBe(0);
    expect(
      count(
        'SELECT count(*) AS n FROM attachment WHERE thread_id IS NULL OR thread_id NOT IN (SELECT id FROM thread)',
      ),
    ).toBe(0);
    // Usage stays for spend accounting, without the thread.
    expect(count('SELECT count(*) AS n FROM usage_event WHERE thread_id IS NULL')).toBeGreaterThan(
      0,
    );
    const exists = blobs.map((b) => existsSync(b)).sort();
    expect(exists).toEqual([false, true]);
    // The non-temporary chat is untouched.
    expect(await roles(keep.id)).toEqual(['user', 'assistant']);
  });

  it('the sweeper purges temporary chats idle past the TTL, and soft-deleted ones', async () => {
    env = await makeEnv();
    env.settings.ttlHours = 1;
    const old = await env.threads.create(ACCOUNT, { temporary: true });
    const fresh = await env.threads.create(ACCOUNT, { temporary: true });
    const regular = await env.threads.create(ACCOUNT, {});
    const leftover = await env.threads.create(ACCOUNT, { temporary: true });
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString();
    await env.db.transaction(() => {
      for (const id of [old.id, regular.id])
        env.db.raw.prepare('UPDATE thread SET updated_at = ? WHERE id = ?').run(twoHoursAgo, id);
      env.db.raw
        .prepare('UPDATE thread SET deleted_at = ? WHERE id = ?')
        .run(new Date().toISOString(), leftover.id);
    });
    expect(await env.chat.sweepTemporary()).toBe(2);
    const ids = (env.db.raw.prepare('SELECT id FROM thread').all() as { id: string }[]).map(
      (r) => r.id,
    );
    expect(ids.sort()).toEqual([fresh.id, regular.id].sort());
  });

  it('temporary chats are listed (marked) while they exist and kept out of search', async () => {
    env = await makeEnv();
    const tmp = await env.threads.create(ACCOUNT, { temporary: true });
    await env.chat.send(ACCOUNT, tmp.id, { text: 'kiwi smoothie' });
    await env.chat.idle();
    expect((await env.threads.list(ACCOUNT)).items[0]).toMatchObject({ temporary: true });
    expect(env.threads.search(ACCOUNT, 'kiwi')).toEqual([]);
  });
});

describe('search (FR-025)', () => {
  it('returns role and project, filters by project and leaves out side chats', async () => {
    env = await makeEnv();
    const p = await env.projects.create(ACCOUNT, { name: 'Garden' });
    const inProject = await env.threads.create(ACCOUNT, { projectId: p.id });
    const outside = await env.threads.create(ACCOUNT, {});
    await env.chat.send(ACCOUNT, inProject.id, { text: 'mango tree' });
    await env.chat.idle();
    await env.chat.send(ACCOUNT, outside.id, { text: 'mango juice' });
    await env.chat.idle();
    await env.chat.sideChat(ACCOUNT, outside.id, { text: 'mango side' });
    await env.chat.idle();
    const all = env.threads.search(ACCOUNT, 'mango');
    expect(new Set(all.map((h) => h.threadId))).toEqual(new Set([inProject.id, outside.id]));
    expect(new Set(all.map((h) => h.role))).toEqual(new Set(['user', 'assistant']));
    const scoped = env.threads.search(ACCOUNT, 'mango', { projectId: p.id });
    expect(scoped.map((h) => [h.threadId, h.projectId])).toEqual([
      [inProject.id, p.id],
      [inProject.id, p.id],
    ]);
  });
});

describe('thread updates (FR-032, FR-034)', () => {
  it('moves a chat into and out of a project and toggles memory opt-out', async () => {
    env = await makeEnv();
    const p = await env.projects.create(ACCOUNT, { name: 'Work' });
    const t = await env.threads.create(ACCOUNT, { memoryOptOut: true });
    expect(t.memoryOptOut).toBe(true);
    expect(await env.threads.update(ACCOUNT, t.id, { projectId: p.id })).toMatchObject({
      projectId: p.id,
    });
    expect((await env.threads.list(ACCOUNT, { projectId: p.id })).items).toHaveLength(1);
    expect(
      await env.threads.update(ACCOUNT, t.id, { projectId: null, memoryOptOut: false }),
    ).toMatchObject({ projectId: null, memoryOptOut: false });
    await expect(env.threads.update(ACCOUNT, t.id, { projectId: 'nope' })).rejects.toMatchObject({
      details: { reason: 'project' },
    });
  });
});
