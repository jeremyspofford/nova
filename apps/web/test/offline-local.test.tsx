// Local fallback (FR-128, docs/21 §9): with the Hub unreachable, inside the desktop app, a model
// on this computer answers the message that waits for the Hub, with the chat from the offline copy
// (and its project's instructions) as context; the answer streams, is kept on the device and is
// queued for the Hub as an offline-written message (which this Hub cannot store yet, so it says
// so and keeps the text). Without the desktop app, an offline copy, or the chat in it, the panel
// says why it is not offered; online it is not shown at all.
import { act, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalFallback } from '../src/offline/LocalFallback.tsx';
import { FakeEventSource, fakeEventSource } from './fakes.ts';
import {
  FakeSyncHub,
  fakeShell,
  installShell,
  offlineSetup,
  renderOffline,
  settle,
} from './fakes-m7-sync.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  FakeEventSource.reset();
  installShell(null);
});

async function offline(opts: { replica?: boolean } = {}) {
  const hub = new FakeSyncHub().seed();
  if (opts.replica === false) {
    hub.deviceId = null;
    hub.scopes = null;
  }
  const env = offlineSetup(hub);
  await env.api.session();
  const stop = env.runtime.start({ eventSource: fakeEventSource });
  await settle(() => {
    const r = env.runtime.getState().replica;
    return r.granted !== null && r.phase !== 'loading' && !r.syncing;
  });
  hub.down = true;
  await env.api.getThread('t1').catch(() => undefined);
  return { ...env, stop };
}

describe('answering with this computer’s model (FR-128)', () => {
  it('answers the waiting message with the chat as context and queues the answer', async () => {
    const env = await offline();
    const shell = fakeShell({ answer: ['Take the ', 'night train.'] });
    installShell(shell.bridge);
    const sent = await env.api.sendMessage('t1', { text: 'How do we get there?' });
    await renderOffline(<LocalFallback threadId="t1" />, { runtime: env.runtime, hub: env.hub });
    const panel = await screen.findByRole('region', { name: 'Answer on this computer' });
    const select = await within(panel).findByLabelText('Model on this computer');
    expect([...(select as HTMLSelectElement).options].map((o) => o.value)).toEqual([
      'llama3.2',
      'qwen3:8b',
    ]);
    await userEvent.selectOptions(select, 'qwen3:8b');
    await userEvent.click(within(panel).getByRole('button', { name: /Answer with this computer/ }));
    await within(panel).findByText('Take the night train.');

    expect(shell.chats).toHaveLength(1);
    expect(shell.chats[0]).toEqual({
      model: 'qwen3:8b',
      messages: [
        { role: 'system', content: 'Answer briefly.' },
        { role: 'user', content: 'Where should we go?' },
        { role: 'assistant', content: 'Try the coast.' },
        { role: 'user', content: 'How do we get there?' },
      ],
    });
    const answer = env.runtime.queue.items().find((i) => i.kind === 'answer')!;
    expect(answer).toMatchObject({
      status: 'queued',
      text: 'Take the night train.',
      model: 'qwen3:8b',
      threadId: 't1',
      label: "Answer from this computer's model in “Trip planning”",
    });
    expect(answer.ops[0]!.value).toEqual({
      threadId: 't1',
      role: 'assistant',
      text: 'Take the night train.',
      parentId: sent.userMessageId,
      model: 'qwen3:8b',
      provenance: 'offline',
    });
    // Answered: nothing left to answer until another message waits.
    expect(within(panel).getByRole('button', { name: /Answer with this computer/ })).toHaveProperty(
      'disabled',
      true,
    );
    expect(within(panel).getByText(/Every message waiting for the Hub has an answer/)).toBeTruthy();
    expect(within(panel).getByText('In answer to “How do we get there?”')).toBeTruthy();

    // Back online: the message and its answer go to the Hub in order; the Hub is not asked to
    // answer a message this computer already answered.
    env.hub.now += 10_000;
    await act(async () => {
      env.hub.down = false;
      await env.runtime.checkNow();
      await env.runtime.idle();
    });
    expect(env.hub.value('message', sent.userMessageId, 'body')).toMatchObject({
      text: 'How do we get there?',
    });
    expect(env.runtime.queue.items().map((i) => [i.kind, i.status])).toEqual([
      ['message', 'done'],
      ['answer', 'done'],
    ]);
    expect(env.hub.value('message', answer.entityId, 'body')).toMatchObject({
      role: 'assistant',
      text: 'Take the night train.',
      parentId: sent.userMessageId,
      model: 'qwen3:8b',
      provenance: 'offline',
    });
    expect(env.hub.answered).toEqual([]);
    // The copy shows both, labelled: written offline, answered offline.
    env.hub.down = true;
    const detail = await env.api.getThread('t1');
    expect(detail.messages.slice(-2).map((m) => [m.role, m.provenance])).toEqual([
      ['user', 'sync'],
      ['assistant', 'offline'],
    ]);
    env.stop();
  });

  it('is not offered without Local models, and says why the Hub refuses a kept answer', async () => {
    const env = await offline();
    installShell(fakeShell().bridge);
    const sent = await env.api.sendMessage('t1', { text: 'Any trains?' });
    // The scope is there when the answer is written, and gone when it is sent.
    await env.runtime.addAnswer({
      threadId: 't1',
      parentId: sent.userMessageId,
      text: 'Yes.',
      model: 'llama3.2',
    });
    env.hub.scopes = ['offline-replica'];
    await act(async () => {
      env.hub.down = false;
      await env.runtime.checkNow();
      await env.runtime.idle();
    });
    const kept = env.runtime.queue.items().find((i) => i.kind === 'answer')!;
    expect(kept).toMatchObject({ status: 'failed', errorCode: 'local_runtime_not_granted' });
    expect(kept.error).toMatch(/has not given this device Local models.*Copy the answer/);
    expect(env.runtime.getState().scopes).toEqual(['offline-replica']);

    env.hub.down = true;
    await act(async () => {
      await env.api.listProjects();
    });
    await renderOffline(<LocalFallback threadId="t1" />, { runtime: env.runtime, hub: env.hub });
    expect(screen.getByText(/can answer only on a device the Hub gave Local models/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Answer with this computer/ })).toBeNull();
    env.stop();
  });

  it('says why when the model server is missing, the answer fails, or no model is there', async () => {
    const env = await offline();
    await env.api.sendMessage('t1', { text: 'Still there?' });
    installShell(
      fakeShell({
        models: {
          ok: false,
          reason: 'no_novad',
          message: 'No Nova device agent runs on this computer.',
          models: [],
        },
      }).bridge,
    );
    const { unmount } = await renderOffline(<LocalFallback threadId="t1" />, {
      runtime: env.runtime,
      hub: env.hub,
    });
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /No Nova device agent runs on this computer\.Check again/,
    );
    unmount();

    installShell(fakeShell({ fail: 'The local model server stopped.' }).bridge);
    const second = await renderOffline(<LocalFallback threadId="t1" />, {
      runtime: env.runtime,
      hub: env.hub,
    });
    await userEvent.click(await screen.findByRole('button', { name: /Answer with this computer/ }));
    expect((await screen.findByRole('alert')).textContent).toBe('The local model server stopped.');
    expect(env.runtime.queue.items().some((i) => i.kind === 'answer')).toBe(false);
    second.unmount();

    installShell(fakeShell({ models: { ok: true, models: [] } }).bridge);
    await renderOffline(<LocalFallback threadId="t1" />, { runtime: env.runtime, hub: env.hub });
    expect(await screen.findByText('No models were found on this computer.')).toBeTruthy();
    env.stop();
  });

  it('says it needs the desktop app, an offline copy, and the chat in it', async () => {
    const env = await offline();
    const first = await renderOffline(<LocalFallback threadId="t1" />, {
      runtime: env.runtime,
      hub: env.hub,
    });
    expect(screen.getByText(/can answer only in the Nova desktop app/)).toBeTruthy();
    first.unmount();
    installShell(fakeShell().bridge);
    await renderOffline(<LocalFallback threadId="nope" />, { runtime: env.runtime, hub: env.hub });
    expect(screen.getByText(/This chat is not in this device's offline copy/)).toBeTruthy();
    env.stop();

    const bare = await offline({ replica: false });
    resetDom();
    await renderOffline(<LocalFallback threadId="t1" />, { runtime: bare.runtime, hub: bare.hub });
    expect(screen.getByText(/keeps no offline copy of your chats/)).toBeTruthy();
    bare.stop();
  });

  it('is not shown while the Hub answers, or without a chat', async () => {
    const env = await offline();
    installShell(fakeShell().bridge);
    env.hub.down = false;
    await env.runtime.checkNow();
    const { container } = await renderOffline(<LocalFallback threadId="t1" />, {
      runtime: env.runtime,
      hub: env.hub,
    });
    expect(container.textContent).toBe('');
    env.hub.down = true;
    await act(async () => {
      await env.api.listProjects();
    });
    await waitFor(() => expect(container.textContent).not.toBe(''));
    resetDom();
    const none = await renderOffline(<LocalFallback threadId={null} />, {
      runtime: env.runtime,
      hub: env.hub,
    });
    expect(none.container.textContent).toBe('');
    env.stop();
  });
});
