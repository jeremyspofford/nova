// Shared setup for the Code mode tests: a fake Hub with one Code session (and its `code` thread)
// opened at /code/:id, and a way to send `code.*` events on the global stream.
import { screen, waitFor } from '@testing-library/react';
import { expect } from 'vitest';
import type { CodeSessionView } from '@nova/shared';
import { EVENTS_STREAM_URL } from '../src/notifications/Bell.tsx';
import { sessionTitle } from '../src/code/labels.ts';
import { DONE_ONBOARDING, FakeEventSource, createHub, thread, type HubState } from './fakes.ts';
import { codeSession, m5CodeState, type M5CodeState } from './fakes-m5-code.ts';
import { renderApp } from './render.tsx';

export function codeHub(
  sessions: CodeSessionView[],
  opts: {
    code?: Partial<M5CodeState>;
    settings?: Record<string, unknown>;
    hub?: Partial<HubState>;
  } = {},
) {
  const hub = createHub({
    threads: sessions.map((s) => thread({ id: s.threadId, mode: 'code', title: s.title })),
    m5code: m5CodeState({ sessions, ...opts.code }),
    ...opts.hub,
  });
  hub.state.settings = { 'onboarding.state': DONE_ONBOARDING, ...opts.settings };
  for (const s of sessions) hub.state.messages.set(s.threadId, []);
  // A created session gets its thread, as the Hub creates both.
  hub.state.m5code.onCreate = (s) => {
    hub.state.threads = [thread({ id: s.threadId, mode: 'code' }), ...hub.state.threads];
    hub.state.messages.set(s.threadId, []);
  };
  return hub;
}

export async function openSession(
  over: Partial<CodeSessionView> = {},
  opts: Parameters<typeof codeHub>[1] = {},
) {
  const s = codeSession(over);
  const hub = codeHub([s], opts);
  const r = await renderApp({ hub, path: `/code/${s.id}` });
  const view = await screen.findByRole('region', { name: `Code session: ${sessionTitle(s)}` });
  await waitFor(() => expect(hub.api.listChanges).toHaveBeenCalled());
  return { ...r, s, view };
}

/** Send an event on every open global stream (the bell has its own; it ignores code events). */
export function emitCode(name: string, payload: Record<string, unknown>) {
  const sources = FakeEventSource.all.filter((x) => !x.closed && x.url.includes(EVENTS_STREAM_URL));
  if (!sources.length) throw new Error('no open event stream');
  for (const es of sources) es.emit(name, payload);
}

export function threadStream(threadId: string) {
  return FakeEventSource.for(`/threads/${threadId}/stream`);
}
