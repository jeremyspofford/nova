// FR-023, FR-024, FR-221: the model picker lists presets first, the Faster to Smarter scale sets a
// preset, and the reasoning selector appears only for a direct model that supports it.
import { afterEach, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ModelView } from '@nova/shared';
import { MODELS, createHub } from './fakes.ts';
import { box, openChat } from './chat-helpers.tsx';
import { renderApp, resetDom } from './render.tsx';

afterEach(resetDom);

const preset = (id: string, label: string, disabledReason?: string): ModelView => ({
  ref: `preset:${id}`,
  kind: 'preset',
  source: 'preset',
  providerAccountId: '',
  provider: 'preset',
  modelId: id,
  label,
  reasoning: false,
  ...(disabledReason ? { disabledReason } : {}),
});

// The Hub's order on purpose differs from the ranks (faster 1, balanced 2, smarter 3).
const WITH_PRESETS: ModelView[] = [
  preset('smarter', 'Smarter'),
  preset('faster', 'Faster'),
  preset('balanced', 'Balanced'),
  preset('deep', 'Deep', 'None of its models is available.'),
  ...MODELS,
  {
    ref: 'node:n1/llama-8b',
    kind: 'model',
    source: 'node',
    nodeId: 'n1',
    providerAccountId: '',
    provider: 'node',
    modelId: 'llama-8b',
    label: 'llama-8b',
    reasoning: false,
  },
];

const picker = () => screen.getByRole<HTMLSelectElement>('combobox', { name: 'Model' });
const scale = () => screen.getByRole('group', { name: 'Model preset' });

describe('model picker and presets (FR-023, FR-221)', () => {
  it('groups presets first, then models by provider, with disabled presets explained', async () => {
    await openChat({}, { hub: { models: WITH_PRESETS } });
    const groups = within(picker()).getAllByRole('group');
    expect(groups.map((g) => g.getAttribute('label'))).toEqual(['Presets', 'Mock', 'Compute node']);
    const deep = within(groups[0]!).getByRole<HTMLOptionElement>('option', {
      name: 'Deep (unavailable)',
    });
    expect(deep.disabled).toBe(true);
    expect(deep.title).toBe('None of its models is available.');
    expect(within(groups[2]!).getByRole('option', { name: 'llama-8b' })).toBeTruthy();
  });

  it('orders the scale by rank, sets the thread to a preset, and hides reasoning for presets', async () => {
    const { hub, t } = await openChat({}, { hub: { models: WITH_PRESETS } });
    await waitFor(() =>
      expect(
        within(scale())
          .getAllByRole('radio')
          .map((r) => r.getAttribute('value')),
      ).toEqual(['preset:faster', 'preset:balanced', 'preset:smarter']),
    );
    expect(
      within(scale())
        .getAllByRole<HTMLInputElement>('radio')
        .some((r) => r.checked),
    ).toBe(false);
    await userEvent.click(within(scale()).getByRole('radio', { name: 'Smarter' }));
    await waitFor(() =>
      expect(hub.api.updateThread).toHaveBeenCalledWith(t.id, { model: 'preset:smarter' }),
    );
    expect(picker().value).toBe('preset:smarter');
    expect(screen.queryByRole('combobox', { name: 'Reasoning level' })).toBeNull();
    // The arrow keys move along the scale.
    await userEvent.keyboard('{ArrowLeft}');
    await waitFor(() =>
      expect(hub.api.updateThread).toHaveBeenLastCalledWith(t.id, { model: 'preset:balanced' }),
    );
    // A direct model leaves the scale empty and offers reasoning levels when it has them.
    await userEvent.selectOptions(picker(), 'pa1/mock-smart');
    expect(await screen.findByRole('combobox', { name: 'Reasoning level' })).toBeTruthy();
    expect(
      within(scale())
        .getAllByRole<HTMLInputElement>('radio')
        .some((r) => r.checked),
    ).toBe(false);
    await userEvent.click(within(scale()).getByRole('link', { name: 'Advanced…' }));
    expect(window.location.pathname).toBe('/settings/models');
  });

  it('starts a new chat on the Balanced preset and offers to make it the default', async () => {
    const hub = createHub({ models: WITH_PRESETS });
    await renderApp({ hub });
    await waitFor(() =>
      expect(
        within(scale()).getByRole<HTMLInputElement>('radio', { name: 'Balanced' }).checked,
      ).toBe(true),
    );
    expect(screen.getByText(/Using Balanced\./)).toBeTruthy();
    await userEvent.type(box(), 'Plan my week');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(hub.api.createThread).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'preset:balanced' }),
      ),
    );
  });

  it('keeps the Hub order when preset ranks cannot be loaded', async () => {
    const hub = createHub({ models: WITH_PRESETS });
    hub.state.failNext.listPresets = new Error('offline');
    await renderApp({ hub });
    await waitFor(() =>
      expect(
        within(scale())
          .getAllByRole('radio')
          .map((r) => r.getAttribute('aria-labelledby')),
      ).toHaveLength(3),
    );
    expect(
      within(scale())
        .getAllByRole('radio')
        .map((r) => r.getAttribute('value')),
    ).toEqual(['preset:smarter', 'preset:faster', 'preset:balanced']);
  });

  it('shows no scale without presets', async () => {
    await openChat();
    expect(screen.queryByRole('group', { name: 'Model preset' })).toBeNull();
  });
});
