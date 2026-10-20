// The offline layer in the pseudo-locale (FR-016): the banner, the changes waiting to send (their
// labels, statuses, reasons and notes are worded when shown, not when made) and the answer from
// this computer's model show only localized words. Chat titles, message texts, model names and
// the Hub's own words are fixture data.
import { act, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { inText, itemLabel, problemText } from '../src/offline/format.ts';
import { LOCAL_TEXT, LocalFallback } from '../src/offline/LocalFallback.tsx';
import { BANNER_TEXT, OfflineBanner } from '../src/offline/OfflineBanner.tsx';
import { QUEUE_TEXT, QueuePanel } from '../src/offline/QueuePanel.tsx';
import { REPLICA_TEXT } from '../src/replica/engine.ts';
import { FakeEventSource, fakeEventSource } from './fakes.ts';
import {
  FakeSyncHub,
  fakeShell,
  installShell,
  offlineSetup,
  renderOffline,
  settle,
} from './fakes-m7-sync.ts';
import {
  activateTestLocale,
  expectFullyLocalized,
  findUnlocalized,
  resetTestLocale,
} from './i18n.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  FakeEventSource.reset();
  installShell(null);
  resetTestLocale();
});

/** Fixture names and texts, and the Hub's own words. */
const DATA = [
  'Trip planning',
  'Lisbon',
  'Book the train',
  'Garden',
  'Shorter.',
  'Packing',
  'Boots, hat',
  'The Hub refused the change.',
];

async function connected(hub = new FakeSyncHub().seed()) {
  const env = offlineSetup(hub);
  await env.api.session();
  await env.api.getSpacePage('s1', 'pg1');
  const stop = env.runtime.start({ eventSource: fakeEventSource });
  await settle(() => {
    const r = env.runtime.getState().replica;
    return r.phase === 'ready' && !r.syncing;
  });
  return { ...env, stop };
}

async function offline() {
  const env = await connected();
  env.hub.down = true;
  return env;
}

describe('the offline layer in en-XA', () => {
  it('words the banner while offline, after a refusal and once the copy is removed', async () => {
    await activateTestLocale('en-XA');
    const env = await offline();
    const { container } = await renderOffline(<OfflineBanner />, {
      runtime: env.runtime,
      hub: env.hub,
    });
    await act(async () => {
      await env.api.updateThread('t1', { title: 'Lisbon' });
    });
    await screen.findByText(BANNER_TEXT.offline);
    expect(screen.getByRole('status', { name: BANNER_TEXT.region })).toBeTruthy();
    expectFullyLocalized(container);

    // Back, and the change is refused: the banner says so.
    env.hub.failNext.set('POST /api/v1/sync/push', {
      status: 400,
      body: { code: 'validation', message: 'The Hub refused the change.', retryable: false },
    });
    await act(async () => {
      env.hub.down = false;
      await env.runtime.checkNow();
      await env.runtime.idle();
    });
    await screen.findByText(BANNER_TEXT.notSent({ n: 1 }));
    expectFullyLocalized(container);
    env.stop();

    // Signed out: the copy goes, and the banner says why once.
    resetDom();
    const next = await connected();
    const again = await renderOffline(<OfflineBanner />, { runtime: next.runtime, hub: next.hub });
    next.hub.signedIn = false;
    await act(async () => {
      await next.runtime.engine.pull();
    });
    await waitFor(() => expect(again.container.querySelector('.of-banner')).toBeTruthy());
    expectFullyLocalized(again.container);
    next.stop();
  });

  it('words each waiting change, its status, its reason and the discard dialog', async () => {
    await activateTestLocale('en-XA');
    const env = await offline();
    await env.api.sendMessage('t1', { text: 'Book the train' });
    await env.api.updateThread('t1', { title: 'Lisbon' });
    await env.api.updateProject('p1', { instructions: 'Shorter.' });
    await env.api.saveSpacePage('s1', 'pg1', { baseVersion: 3, content: 'Boots, hat' });
    const { container } = await renderOffline(<QueuePanel />, {
      runtime: env.runtime,
      hub: env.hub,
    });
    const list = screen.getByRole('list', { name: QUEUE_TEXT.list });
    expect(within(list).getAllByRole('listitem')).toHaveLength(4);
    // Labels are worded when shown: in the locale active now, from what the change keeps.
    const [message] = env.runtime.queue.items();
    expect(within(list).getByRole('listitem', { name: itemLabel(message!) })).toBeTruthy();
    // The check sees the rows: without the fixture data, their texts stand out.
    expect(findUnlocalized(container).join('\n')).toMatch(/Book the train/);
    expectFullyLocalized(container, { data: DATA });

    // The page was deleted on the Hub: refused, with this app's words for the reason; the rest
    // are sent, one with a note.
    env.hub.down = false;
    env.hub.remove('page', 'pg1');
    env.hub.down = true;
    await act(async () => {
      env.hub.down = false;
      await env.runtime.checkNow();
      await env.runtime.idle();
    });
    const page = env.runtime.queue.items().find((i) => i.kind === 'page')!;
    expect(page.status).toBe('failed');
    expect(await within(list).findByText(problemText(page)!)).toBeTruthy();
    expectFullyLocalized(container, { data: DATA });

    const row = within(list).getByRole('listitem', { name: itemLabel(page) });
    await userEvent.click(within(row).getByRole('button', { name: QUEUE_TEXT.discard }));
    const dialog = screen.getByRole('dialog', { name: QUEUE_TEXT.discardTitle });
    expectFullyLocalized(dialog, { data: DATA });
    env.stop();
  });

  it('words the answer from this computer and why it is not offered', async () => {
    await activateTestLocale('en-XA');
    const env = await offline();
    await env.api.getThread('t1').catch(() => undefined);
    const first = await renderOffline(<LocalFallback threadId="t1" />, {
      runtime: env.runtime,
      hub: env.hub,
    });
    expect(screen.getByText(LOCAL_TEXT.noDesktop)).toBeTruthy();
    expectFullyLocalized(first.container);
    first.unmount();

    installShell(fakeShell({ answer: ['Take the ', 'night train.'] }).bridge);
    await env.api.sendMessage('t1', { text: 'How do we get there?' });
    const { container } = await renderOffline(<LocalFallback threadId="t1" />, {
      runtime: env.runtime,
      hub: env.hub,
    });
    const panel = await screen.findByRole('region', { name: LOCAL_TEXT.title });
    await within(panel).findByLabelText(LOCAL_TEXT.model);
    await userEvent.click(within(panel).getByRole('button', { name: LOCAL_TEXT.answer }));
    await within(panel).findByText('Take the night train.');
    expectFullyLocalized(container, {
      data: ['llama3.2', 'Take the night train.', 'How do we get there?'],
    });
    env.stop();
  });

  it('words waits and the offline copy’s reasons when they are read', async () => {
    await activateTestLocale('en-XA');
    const wait = QUEUE_TEXT.tryingAgain({ when: inText(8000) });
    const reasons = [REPLICA_TEXT.unsupported, REPLICA_TEXT.paused, REPLICA_TEXT.failed];
    for (const text of [wait, inText(300_000), ...reasons]) expect(text).toMatch(/^\[/);
    expect(wait).not.toMatch(/Trying/);
  });
});
