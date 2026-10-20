// The outbound queue (FR-112, FR-109): writes made while the Hub is unreachable (send a message,
// start a chat, rename a chat, edit a page, change a project's instructions) queue as sync changes
// sealed on the device, show at once in the app's views, and on reconnect go out after the copy
// catches up, in order, each with its own Idempotency-Key, which a resend reuses (the Hub applies a
// lost-answer change once). A busy Hub means backoff with jitter; a refusal stays as failed with
// the reason until retried or discarded; a newer change elsewhere wins and the item says so. The
// panel shows each item's status with Retry, Copy and Discard (which asks first).
import { act, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '../src/api.ts';
import { itemLabel, noteText, problemText } from '../src/offline/format.ts';
import { QueuePanel } from '../src/offline/QueuePanel.tsx';
import { backoffMs } from '../src/offline/queue.ts';
import type { Sealed } from '../src/replica/vault.ts';
import { FakeEventSource, fakeEventSource } from './fakes.ts';
import { FakeSyncHub, OTHER_DEVICE, offlineSetup, renderOffline, settle } from './fakes-m7-sync.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  FakeEventSource.reset();
});

async function offline(hub = new FakeSyncHub().seed()) {
  const env = offlineSetup(hub);
  await env.api.session();
  await env.api.getSpacePage('s1', 'pg1');
  const stop = env.runtime.start({ eventSource: fakeEventSource });
  await settle(() => {
    const r = env.runtime.getState().replica;
    return r.phase === 'ready' && !r.syncing;
  });
  hub.down = true;
  return { ...env, stop };
}

const pushes = (hub: FakeSyncHub) =>
  hub.requests.filter((r) => r.method === 'POST' && r.path === '/api/v1/sync/push');

async function reconnect(env: Awaited<ReturnType<typeof offline>>) {
  env.hub.down = false;
  await env.runtime.checkNow();
  await env.runtime.idle();
}

describe('writes made offline', () => {
  it('queue as sync changes, show at once, and go out in order after the copy catches up', async () => {
    const env = await offline();
    const { api, hub, runtime } = env;
    const renamed = await api.updateThread('t1', { title: 'Lisbon' });
    expect(renamed.title).toBe('Lisbon');
    const sent = await api.sendMessage('t1', { text: 'Book the train' });
    expect(sent).toMatchObject({ disposition: 'queued', turnId: null, assistantMessageId: null });
    const page = await api.saveSpacePage('s1', 'pg1', { baseVersion: 3, content: 'Boots, hat' });
    expect(page).toMatchObject({ content: 'Boots, hat', version: 4 });
    const project = await api.updateProject('p1', { instructions: 'Answer in Portuguese.' });
    expect(project.instructions).toBe('Answer in Portuguese.');

    // The views read the changes back; the Hub has none of them yet.
    expect((await api.listThreads({ mode: 'chat' })).items[0]!.title).toBe('Lisbon');
    expect((await api.listQueue('t1')).items).toMatchObject([
      { id: sent.userMessageId, text: 'Book the train', position: 1 },
    ]);
    expect((await api.getSpacePage('s1', 'pg1')).content).toBe('Boots, hat');
    expect(hub.value('thread', 't1', 'title')).toBe('Trip planning');
    const items = runtime.queue.items();
    expect(items.map((i) => [i.kind, i.status, itemLabel(i)])).toEqual([
      ['chat_edit', 'queued', 'Rename “Trip planning” to “Lisbon”'],
      ['message', 'queued', 'Message in “Lisbon”'],
      ['page', 'queued', 'Edit the page “Packing”'],
      ['project', 'queued', 'Change the instructions of “Garden”'],
    ]);
    expect(new Set(items.map((i) => i.idempotencyKey)).size).toBe(4);
    // The edit starts from the value the copy held.
    const titleOp = items[0]!.ops[0]!;
    expect(titleOp.base).toBe(runtime.engine.replica!.entity('thread', 't1')!.fields.title!.hlc);
    // Sealed at rest, like the copy.
    const disk = [...env.kv.raw.get('queue')!.values()]
      .map((v) => new TextDecoder().decode(new Uint8Array((v as Sealed).data)))
      .join();
    expect(disk).not.toMatch(/Book the train|Lisbon|Portuguese/);

    const before = hub.requests.length;
    await reconnect(env);
    expect(runtime.queue.items().map((i) => i.status)).toEqual(['done', 'done', 'done', 'done']);
    const after = hub.requests.slice(before).map((r) => `${r.method} ${r.path.split('?')[0]}`);
    expect(after.indexOf('GET /api/v1/sync/changes')).toBeLessThan(
      after.indexOf('POST /api/v1/sync/push'),
    );
    expect(pushes(hub).map((p) => p.key)).toEqual(items.map((i) => i.idempotencyKey));
    expect(hub.value('thread', 't1', 'title')).toBe('Lisbon');
    expect(hub.value('page', 'pg1', 'content')).toBe('Boots, hat');
    expect(hub.value('project', 'p1', 'instructions')).toBe('Answer in Portuguese.');
    expect(hub.value('message', sent.userMessageId, 'body')).toMatchObject({
      threadId: 't1',
      role: 'user',
      text: 'Book the train',
      parentId: 'm2',
    });
    // The copy has the Hub's result; nothing waits on the device.
    expect(runtime.engine.replica!.value('thread', 't1', 'title')).toBe('Lisbon');
    expect(runtime.engine.replica!.value('page', 'pg1', 'version')).toBe(4);
    expect(env.kv.raw.get('queue')!.size).toBe(0);
    // Once on the Hub, the message is answered there.
    expect(hub.answered).toEqual([sent.userMessageId]);
    expect(noteText(runtime.queue.items()[1]!.note)).toBe('Sent. The Hub is answering it now.');
    const ask = hub.requests.find((r) => r.path.endsWith(`/messages/${sent.userMessageId}/answer`));
    expect(ask).toMatchObject({ method: 'POST', key: `${items[1]!.idempotencyKey}-answer` });
    env.stop();
  });

  it('renames a space offline', async () => {
    const env = await offline();
    const space = await env.api.updateSpace('s1', { name: 'Road notes' });
    expect(space.name).toBe('Road notes');
    expect((await env.api.listSpaces()).items.map((s) => s.name)).toEqual(['Road notes']);
    expect(itemLabel(env.runtime.queue.items()[0]!)).toBe(
      'Rename the space “Field notes” to “Road notes”',
    );
    await reconnect(env);
    expect(env.hub.value('space', 's1', 'name')).toBe('Road notes');
    env.stop();
  });

  it('starts a chat offline and sends its first message after it', async () => {
    const env = await offline();
    const chat = await env.api.createThread({ mode: 'chat', title: 'Weekend' });
    expect(chat).toMatchObject({ title: 'Weekend', mode: 'chat' });
    expect((await env.api.getThread(chat.id)).messages).toEqual([]);
    await env.api.sendMessage(chat.id, { text: 'Plan it' });
    expect((await env.api.listThreads({ mode: 'chat' })).items.map((t) => t.title)).toContain(
      'Weekend',
    );
    await reconnect(env);
    expect(env.hub.value('thread', chat.id, 'title')).toBe('Weekend');
    expect(env.runtime.queue.items().every((i) => i.status === 'done')).toBe(true);
    env.stop();
  });

  it('refuses what cannot wait and leaves other writes failing as before', async () => {
    const env = await offline();
    const err = await env.api
      .sendMessage('t1', {
        text: 'see file',
        attachments: [{ name: 'a.txt', mime: 'text/plain', data: 'aGk=' }],
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).body.message).toMatch(
      /Files cannot be sent while the Hub is unreachable/,
    );
    await expect(env.api.updateThread('t1', { model: 'pa1/mock-fast' })).rejects.toBeInstanceOf(
      TypeError,
    );
    await expect(env.api.updateThread('t1', { unread: false })).rejects.toBeInstanceOf(TypeError);
    await expect(env.api.deleteThread('t1')).rejects.toBeInstanceOf(TypeError);
    await expect(env.api.createThread({ mode: 'chat', temporary: true })).rejects.toBeInstanceOf(
      TypeError,
    );
    expect(env.runtime.queue.items()).toEqual([]);
    env.stop();
  });

  it('lets the queue strip cancel a message written offline', async () => {
    const env = await offline();
    const sent = await env.api.sendMessage('t1', { text: 'never mind' });
    await env.api.cancelQueued('t1', sent.userMessageId);
    expect(env.runtime.queue.items()).toEqual([]);
    expect((await env.api.listQueue('t1')).items).toEqual([]);
    env.stop();
  });
});

describe('sending what waits', () => {
  it('backs off with jitter on a busy Hub and resends with the same key', async () => {
    expect(backoffMs(1, 0)).toBe(500);
    expect(backoffMs(1, 1)).toBe(1000);
    expect(backoffMs(3, 0.5)).toBe(3000);
    expect(backoffMs(20, 1)).toBe(60_000);
    const env = await offline();
    await env.api.updateThread('t1', { title: 'Lisbon' });
    env.hub.failNext.set('POST /api/v1/sync/push', {
      status: 503,
      body: { code: 'unavailable', message: 'The Hub is busy.', retryable: true },
    });
    await reconnect(env);
    const [item] = env.runtime.queue.items();
    expect(item).toMatchObject({ status: 'queued', attempts: 1, error: 'The Hub is busy.' });
    expect(Date.parse(item!.nextAttemptAt!) - env.hub.now).toBe(750);
    expect(env.timers.pending.map((t) => t.ms)).toContain(750);
    env.hub.now += 750;
    act(() => env.timers.run());
    await settle(() => env.runtime.queue.items()[0]?.status === 'done');
    const keys = pushes(env.hub).map((p) => p.key);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(env.hub.value('thread', 't1', 'title')).toBe('Lisbon');
    env.stop();
  });

  it('applies a change once when its answer was lost: the resend gets the first answer', async () => {
    const env = await offline();
    const sent = await env.api.sendMessage('t1', { text: 'Only once' });
    env.hub.loseAnswer.add('POST /api/v1/sync/push');
    env.hub.down = false;
    await env.runtime.checkNow();
    await settle(() => env.runtime.getState().hub === 'offline');
    expect(env.runtime.queue.items()[0]!.status).toBe('queued');
    expect(env.hub.value('message', sent.userMessageId, 'body')).toMatchObject({
      text: 'Only once',
    });
    await reconnect(env);
    expect(env.runtime.queue.items()[0]!.status).toBe('done');
    const keys = pushes(env.hub).map((p) => p.key);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    // On the Hub once, and answered once.
    const copies = [...env.hub.entities.values()].filter(
      (e) => (e.fields.get('body')?.value as { text?: string } | undefined)?.text === 'Only once',
    );
    expect(copies).toHaveLength(1);
    expect(env.hub.answered).toEqual([sent.userMessageId]);
    env.stop();
  });

  it('keeps a refused change as failed with the reason, goes on with the next, retries and discards', async () => {
    const env = await offline();
    await env.api.saveSpacePage('s1', 'pg1', { baseVersion: 3, content: 'Boots, hat' });
    await env.api.updateThread('t1', { title: 'Lisbon' });
    env.hub.down = false;
    env.hub.remove('page', 'pg1');
    env.hub.down = true;
    await reconnect(env);
    const [page, chat] = env.runtime.queue.items();
    expect(page).toMatchObject({ status: 'failed', errorCode: 'deleted', problem: 'rejected' });
    expect(problemText(page!)).toBe('It was deleted on the Hub.');
    expect(chat!.status).toBe('done');
    expect(await env.runtime.queue.discard(page!.id)).toBe(true);
    expect(env.runtime.queue.items().map((i) => i.kind)).toEqual(['chat_edit']);

    await act(async () => {
      env.hub.down = true;
      await env.api.updateThread('t1', { pinned: true });
    });
    env.hub.syncEnabled = false;
    await reconnect(env);
    const pin = env.runtime.queue
      .items()
      .find((i) => i.kind === 'chat_edit' && i.status !== 'done');
    expect(pin).toMatchObject({ status: 'failed' });
    env.hub.syncEnabled = true;
    await env.runtime.engine.pull();
    await env.runtime.queue.retry(pin!.id);
    await settle(() => env.runtime.queue.items().every((i) => i.status === 'done'));
    expect(env.hub.value('thread', 't1', 'pinned')).toBe(true);
    env.stop();
  });

  it('lets a newer change made elsewhere win and says where the lost value is', async () => {
    const env = await offline();
    await env.api.updateThread('t1', { title: 'Lisbon' });
    env.hub.now += 60_000;
    env.hub.write('thread', 't1', { title: 'Porto' }, OTHER_DEVICE);
    await reconnect(env);
    const [item] = env.runtime.queue.items();
    expect(item).toMatchObject({ status: 'done' });
    expect(noteText(item!.note)).toMatch(
      /newer change made elsewhere won.*Settings → Sync → History/,
    );
    expect(env.hub.value('thread', 't1', 'title')).toBe('Porto');
    expect(env.hub.merge).toMatchObject([
      { reason: 'stale', field: 'title', lost: { value: 'Lisbon' }, winner: { value: 'Porto' } },
    ]);
    expect(env.runtime.engine.replica!.value('thread', 't1', 'title')).toBe('Porto');
    env.stop();
  });

  it('keeps what waits across a restart and sends it later', async () => {
    const env = await offline();
    await env.api.updateThread('t1', { title: 'Lisbon' });
    env.stop();
    const again = offlineSetup(env.hub, env.kv);
    await again.api.session();
    await again.runtime.queue.load();
    expect(again.runtime.queue.items().map((i) => itemLabel(i))).toEqual([
      'Rename “Trip planning” to “Lisbon”',
    ]);
    env.hub.down = false;
    await again.api.session();
    const stop = again.runtime.start({ eventSource: fakeEventSource });
    await settle(() => again.runtime.queue.items()[0]?.status === 'done');
    expect(env.hub.value('thread', 't1', 'title')).toBe('Lisbon');
    stop();
  });
});

describe('answers for messages written offline', () => {
  it('asks the Hub to answer only the last message of a chat', async () => {
    const env = await offline();
    const first = await env.api.sendMessage('t1', { text: 'One' });
    const last = await env.api.sendMessage('t1', { text: 'Two' });
    await reconnect(env);
    expect(env.hub.answered).toEqual([last.userMessageId]);
    const [a, b] = env.runtime.queue.items();
    expect(a).toMatchObject({ status: 'done', note: null, entityId: first.userMessageId });
    expect(b).toMatchObject({ status: 'done', note: 'requested' });
    expect(noteText(b!.note)).toBe('Sent. The Hub is answering it now.');
    env.stop();
  });

  it('says plainly when the Hub does not answer it', async () => {
    const cases: [(hub: FakeSyncHub) => void, RegExp][] = [
      [(hub) => hub.busy.add('t1'), /A reply was already running in that chat/],
      [(hub) => hub.shared.add('t1'), /In a shared chat a message written offline is not answered/],
    ];
    for (const [setup, note] of cases) {
      const env = await offline();
      await env.api.sendMessage('t1', { text: 'Hello?' });
      setup(env.hub);
      await reconnect(env);
      expect(env.runtime.queue.items()[0]).toMatchObject({ status: 'done' });
      expect(noteText(env.runtime.queue.items()[0]!.note)).toMatch(note);
      expect(env.hub.answered).toEqual([]);
      env.stop();
    }
    // Someone wrote after it on the Hub first: it stays history.
    const env = await offline();
    await env.api.sendMessage('t1', { text: 'Late' });
    env.hub.down = false;
    await env.api.sendMessage('t1', { text: 'Typed on the Hub' }).catch(() => undefined);
    env.hub.down = true;
    await reconnect(env);
    expect(env.runtime.queue.items()[0]).toMatchObject({ status: 'done' });
    env.stop();
  });

  it('asks again with the same key when the Hub went away before it could answer', async () => {
    const env = await offline();
    const sent = await env.api.sendMessage('t1', { text: 'Still there?' });
    env.hub.loseAnswer.add(`POST /api/v1/threads/t1/messages/${sent.userMessageId}/answer`);
    env.hub.down = false;
    await env.runtime.checkNow();
    await settle(() => env.runtime.getState().hub === 'offline');
    expect(env.runtime.queue.items()[0]!.status).toBe('queued');
    await reconnect(env);
    expect(env.runtime.queue.items()[0]).toMatchObject({ status: 'done', note: 'requested' });
    const asks = env.hub.requests.filter((r) => r.path.endsWith('/answer'));
    expect(asks).toHaveLength(2);
    expect(asks[0]!.key).toBe(asks[1]!.key);
    expect(env.hub.answered).toEqual([sent.userMessageId]);
    env.stop();
  });
});

describe('the waiting-changes panel', () => {
  it('shows each change with its status, retries, copies and discards after asking', async () => {
    const env = await offline();
    await env.api.sendMessage('t1', { text: 'Book the train' });
    await env.api.updateThread('t1', { title: 'Lisbon' });
    await renderOffline(<QueuePanel />, { runtime: env.runtime, hub: env.hub });
    const list = screen.getByRole('list', { name: 'Changes waiting to send' });
    const message = within(list).getByRole('listitem', { name: 'Message in “Trip planning”' });
    expect(within(message).getByText('Waiting to send')).toBeTruthy();
    expect(within(message).getByText('Book the train')).toBeTruthy();

    // A refusal: failed with the reason, Retry and Discard.
    env.hub.failNext.set('POST /api/v1/sync/push', {
      status: 400,
      body: { code: 'validation', message: 'The Hub refused the change.', retryable: false },
    });
    await act(async () => {
      await reconnect(env);
    });
    const failed = await within(list).findByText('Not sent');
    const row = failed.closest('li')!;
    expect(within(row).getByText('The Hub refused the change.')).toBeTruthy();
    expect(within(list).getByRole('listitem', { name: /Rename/ }).textContent).toMatch(/Sent/);

    await userEvent.click(within(row).getByRole('button', { name: 'Discard' }));
    const dialog = screen.getByRole('dialog', { name: 'Discard this change?' });
    expect(dialog.textContent).toMatch(/has not reached the Hub/);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(env.runtime.queue.pending()).toHaveLength(1);

    await userEvent.click(within(row).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(env.runtime.queue.pending()).toHaveLength(0));
    expect(within(list).queryByText('Not sent')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Clear sent' }));
    expect(await screen.findByText(/Nothing waits to send/)).toBeTruthy();
    env.stop();
  });

  it('discards for good once confirmed', async () => {
    const env = await offline();
    await env.api.updateProject('p1', { instructions: 'Shorter.' });
    await renderOffline(<QueuePanel />, { runtime: env.runtime, hub: env.hub });
    const row = screen.getByRole('listitem', { name: 'Change the instructions of “Garden”' });
    expect(within(row).getByText('Shorter.')).toBeTruthy();
    await userEvent.click(within(row).getByRole('button', { name: 'Discard' }));
    await userEvent.click(
      within(screen.getByRole('dialog', { name: 'Discard this change?' })).getByRole('button', {
        name: 'Discard',
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(env.runtime.queue.items()).toEqual([]);
    expect(env.kv.raw.get('queue')!.size).toBe(0);
    expect((await env.api.getProject('p1')).instructions).toBe('Answer briefly.');
    env.stop();
  });
});
