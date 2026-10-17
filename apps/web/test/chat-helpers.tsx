// Shared setup for the chat tests: open one chat on the fake Hub and send into it.
import { screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { expect } from 'vitest';
import type { MessageView } from '@nova/shared';
import { FakeEventSource, createHub, thread, type HubState } from './fakes.ts';
import { renderApp, type RenderOptions } from './render.tsx';

export const box = () => screen.getByLabelText<HTMLTextAreaElement>('Message');

export async function openChat(
  over: Parameters<typeof thread>[0] = {},
  opts: {
    hub?: Partial<HubState>;
    messages?: (threadId: string) => MessageView[];
    render?: Omit<RenderOptions, 'hub' | 'path'>;
  } = {},
) {
  const t = thread({ title: 'Billing questions', ...over });
  const hub = createHub({ ...opts.hub, threads: [t, ...(opts.hub?.threads ?? [])] });
  hub.state.messages.set(t.id, opts.messages?.(t.id) ?? []);
  const r = await renderApp({ hub, path: `/chat/${t.id}`, ...opts.render });
  await waitFor(() => expect(hub.api.getThread).toHaveBeenCalled());
  const es = FakeEventSource.for(`/threads/${t.id}/stream`);
  return { ...r, t, es };
}

export async function send(text: string, button = 'Send') {
  await userEvent.type(box(), text);
  await userEvent.click(screen.getByRole('button', { name: button }));
}

/** Clipboard stub; jsdom has none. */
export function stubClipboard(impl?: (text: string) => Promise<void>) {
  const writeText = impl ?? (() => Promise.resolve());
  const calls: string[] = [];
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: (text: string) => {
        calls.push(text);
        return writeText(text);
      },
    },
  });
  return calls;
}

export function clearClipboard() {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
}
