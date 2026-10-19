// Generate image in the composer (FR-030): offered only while a provider can make images and the
// chat exists; the description is required; the image is saved in the chat's artifacts and shown
// from the Hub's own route; a policy that asks first leaves the approval in the chat; a provider
// failure is said plainly. (Not flagged: it shares this test prefix for lack of an images one.)
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { resetImageAvailability } from '../src/images/GenerateImage.tsx';
import { imagesApi } from '../src/images/api.ts';
import { DONE_ONBOARDING, createHub, thread } from './fakes.ts';
import { createWorkHub, type M7WorkState } from './fakes-m7-work.ts';
import { renderApp, resetDom } from './render.tsx';

afterEach(resetDom);

async function openChat(work: Partial<M7WorkState>) {
  const hub = createHub({ threads: [thread({ id: 't1', title: 'Ideas' })] });
  hub.state.settings = { 'onboarding.state': DONE_ONBOARDING };
  hub.state.messages.set('t1', []);
  const w = createWorkHub(hub, work);
  Object.assign(hub.api, w.api);
  await renderApp({ hub, path: '/chat/t1' });
  return { hub, work: w };
}

describe('Generate image (FR-030)', () => {
  it('is not offered while no provider can make images', async () => {
    const { work } = await openChat({ imageTool: false });
    await waitFor(() => expect(work.api.imageGenerationTool).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Generate an image' })).toBeNull();
  });

  it('generates an image into the chat and shows it from the Hub', async () => {
    const { hub, work } = await openChat({ imageTool: true });
    await userEvent.click(await screen.findByRole('button', { name: 'Generate an image' }));
    const dialog = screen.getByRole('dialog', { name: 'Generate an image' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Generate' }));
    expect(within(dialog).getByText(/Describe the image/)).toBeTruthy();
    expect(work.api.generateImage).not.toHaveBeenCalled();
    await userEvent.type(within(dialog).getByLabelText('Description'), 'A lighthouse at dusk');
    await userEvent.click(within(dialog).getByRole('radio', { name: /Landscape/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Generate' }));
    await waitFor(() =>
      expect(work.api.generateImage).toHaveBeenCalledWith(
        't1',
        'A lighthouse at dusk',
        '1536x1024',
      ),
    );
    const img = await within(dialog).findByRole('img', { name: 'A lighthouse at dusk' });
    const art = hub.state.m3.artifacts.find((a) => a.kind === 'image')!;
    expect(img.getAttribute('src')).toBe(`/api/v1/artifacts/${art.id}/content`);
    expect(within(dialog).getByText('Saved in this chat’s artifacts.')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Generate another' })).toBeTruthy();
  });

  it('leaves the approval in the chat, and says when the provider fails', async () => {
    const { work } = await openChat({ imageTool: true, imageOutcome: 'approval' });
    await userEvent.click(await screen.findByRole('button', { name: 'Generate an image' }));
    const dialog = screen.getByRole('dialog', { name: 'Generate an image' });
    await userEvent.type(within(dialog).getByLabelText('Description'), 'A cat');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Generate' }));
    expect((await within(dialog).findByRole('status')).textContent).toMatch(
      /Your rules ask before generating images\. Approve it in the chat/,
    );
    work.state.imageOutcome = 'error';
    await userEvent.click(within(dialog).getByRole('button', { name: 'Generate' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'The image provider is busy. Try again.',
    );
  });
});

describe('an image result without its artifact in meta', () => {
  it('says where the image is without showing a guess', async () => {
    const { work } = await openChat({ imageTool: true });
    work.api.generateImage.mockResolvedValueOnce({
      ok: true,
      text: 'done',
      meta: { truncated: true },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Generate an image' }));
    const dialog = screen.getByRole('dialog', { name: 'Generate an image' });
    await userEvent.type(within(dialog).getByLabelText('Description'), 'A boat');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Generate' }));
    expect(await within(dialog).findByText('Saved in this chat’s artifacts.')).toBeTruthy();
    expect(within(dialog).queryByRole('img')).toBeNull();
  });
});

describe('the images client', () => {
  it('asks for the image tool and invokes it as the user', async () => {
    const calls: { method: string; path: string; body?: unknown }[] = [];
    const api = imagesApi(<T,>(method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body });
      return Promise.resolve(
        (path.endsWith('/tools')
          ? { items: [{ name: 'image.generate' }] }
          : { ok: true, text: '' }) as T,
      );
    });
    expect(await api.imageGenerationTool()).toEqual({ name: 'image.generate' });
    await api.generateImage('t9', 'p', '1024x1024');
    expect(calls[1]).toEqual({
      method: 'POST',
      path: '/api/v1/tools/image.generate/invoke',
      body: { args: { prompt: 'p', size: '1024x1024' }, threadId: 't9', initiator: 'user' },
    });
    resetImageAvailability(api);
  });
});
