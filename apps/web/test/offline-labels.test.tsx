// Messages written or answered away from the Hub say so in the chat (FR-112, FR-128): a user
// message a device wrote offline and synced reads "Written offline"; an answer a device's own model
// wrote reads "Answered offline by a local model". Other messages carry neither.
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MessageItem } from '../src/chat/MessageItem.tsx';
import { message } from './fakes.ts';
import { resetDom } from './render.tsx';

afterEach(resetDom);

const show = (m: ReturnType<typeof message>) =>
  render(
    <MessageItem
      message={m}
      streamed={undefined}
      reasoning={undefined}
      attachmentUrl={(id) => `/a/${id}`}
      actions={null}
    />,
  );

describe('messages from away from the Hub', () => {
  it('labels a message written offline and an answer from a local model', () => {
    show(message('t1', { role: 'user', provenance: 'sync' }));
    expect(screen.getByText('Written offline')).toBeTruthy();
    resetDom();
    show(
      message('t1', {
        role: 'assistant',
        provenance: 'offline',
        parts: [{ type: 'text', text: 'Take the train.' }],
      }),
    );
    const badge = screen.getByText('Answered offline by a local model');
    expect(badge.getAttribute('title')).toMatch(/while the Hub was unreachable/);
  });

  it('labels nothing else', () => {
    show(message('t1', { role: 'user' }));
    expect(screen.queryByText('Written offline')).toBeNull();
    expect(screen.queryByText(/Answered offline/)).toBeNull();
  });
});
