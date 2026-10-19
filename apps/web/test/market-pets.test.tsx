// Pets from the marketplace (FR-012, FR-049; docs/14 §2.3): an installed pet is a choice in
// Settings → Appearance → Companion (`market:<id>`), the companion then shows its frames (still
// under Keep still or reduced motion), a pet that is no longer installed stays visible as such, and
// the Pets tab is a link away.
import { act, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { petFrames } from '../src/market/MarketPet.tsx';
import { PetOverlay } from '../src/pets/PetOverlay.tsx';
import { PetSettings } from '../src/pets/PetSettings.tsx';
import { FakeEventSource } from './fakes.ts';
import { pet, renderWithMarket } from './fakes-m8-market.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  vi.useRealTimers();
  resetDom();
});

const img = () => document.querySelector<HTMLImageElement>('.pet img');

describe('pets from the marketplace', () => {
  it('chooses an installed pet as the companion and shows its frames', async () => {
    const { hub } = await renderWithMarket(
      <>
        <PetSettings />
        <PetOverlay />
      </>,
      { market: { pets: [pet()] } },
    );
    const radio = await screen.findByRole('radio', { name: /Pebble/ });
    expect(screen.getByText('Installed from the marketplace')).toBeTruthy();
    await userEvent.click(radio);
    expect(hub.api.setSetting).toHaveBeenCalledWith(
      'appearance.pet',
      'market:com.examplelabs.pebble',
    );
    await waitFor(() => expect(img()).toBeTruthy());
    const el = document.querySelector<HTMLElement>('.pet')!;
    expect(el.getAttribute('aria-hidden')).toBe('true');
    expect(el.dataset.pet).toBe('com.examplelabs.pebble');
    expect(img()!.getAttribute('src')).toBe(
      '/api/v1/market/pets/com.examplelabs.pebble/files/frames/idle-1.webp',
    );
    expect(img()!.getAttribute('alt')).toBe('');

    // It reacts like Nova's own: a running thread shows its thinking frames.
    FakeEventSource.for('/api/v1/events/stream').emit('thread.status.changed', {
      ref: { kind: 'thread', id: 't1' },
      status: 'running',
    });
    await waitFor(() => expect(el.dataset.state).toBe('thinking'));
    expect(img()!.getAttribute('src')).toContain('frames/think.webp');
  });

  it('plays its frames, and holds the first one when kept still', async () => {
    await renderWithMarket(<PetOverlay />, {
      settings: {
        'appearance.pet': 'market:com.examplelabs.pebble',
        'appearance.reducedMotion': 'off',
      },
      market: { pets: [pet()] },
    });
    await waitFor(() => expect(img()).toBeTruthy());
    expect(img()!.getAttribute('src')).toContain('idle-1.webp');
    await waitFor(() => expect(img()!.getAttribute('src')).toContain('idle-2.webp'), {
      timeout: 2000,
    });
    resetDom();
    await renderWithMarket(<PetOverlay />, {
      settings: { 'appearance.pet': 'market:com.examplelabs.pebble', 'appearance.petMuted': true },
      market: { pets: [pet()] },
    });
    await waitFor(() => expect(img()).toBeTruthy());
    const el = document.querySelector<HTMLElement>('.pet')!;
    expect(el.dataset.animate).toBe('false');
    await act(() => new Promise((r) => setTimeout(r, 600)));
    expect(img()!.getAttribute('src')).toContain('idle-1.webp');
  });

  it('keeps a removed pet visible as such and links to the Pets tab', async () => {
    await renderWithMarket(<PetSettings />, {
      settings: { 'appearance.pet': 'market:com.examplelabs.gone' },
    });
    const gone = await screen.findByRole<HTMLInputElement>('radio', {
      name: 'A pet that is no longer installed',
    });
    expect(gone.checked).toBe(true);
    const link = screen.getByRole('link', { name: 'Get more pets in the Marketplace' });
    expect(link.getAttribute('href')).toBe('/marketplace/pets');
    await userEvent.click(link);
    expect(window.location.pathname).toBe('/marketplace/pets');
  });

  it('a member sees Nova’s own companions only', async () => {
    await renderWithMarket(<PetSettings />, { member: true, market: { pets: [pet()] } });
    expect(await screen.findByRole('radio', { name: /Sprout/ })).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('radio', { name: /Pebble/ })).toBeNull());
  });

  it('picks the closest frames for a mood', () => {
    const p = pet({
      states: {
        working: { frames: ['w.webp'], fps: 2, loop: true },
        idle: { frames: ['i.webp'], fps: 1, loop: true },
      },
    });
    expect(petFrames(p, 'thinking')?.frames).toEqual(['w.webp']);
    expect(petFrames(p, 'error')?.frames).toEqual(['i.webp']);
    expect(
      petFrames(pet({ states: { odd: { frames: ['o.webp'], fps: 1, loop: false } } }), 'idle')
        ?.frames,
    ).toEqual(['o.webp']);
    expect(petFrames(pet({ states: {} }), 'idle')).toBeNull();
  });
});
