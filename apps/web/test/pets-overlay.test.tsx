// The companion (FR-012): off by default; when on it is decoration only (hidden from assistive
// tech, nothing focusable, clicks pass through), sits in the chosen corner, reacts to thread
// status and run outcomes on the shared stream, rests when kept still, and holds a still pose
// under reduced motion. Settings → Appearance turns it on and off.
import { act, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api.ts';
import { PetOverlay } from '../src/pets/PetOverlay.tsx';
import { PetSettings } from '../src/pets/PetSettings.tsx';
import { REACTION_MS } from '../src/pets/state.ts';
import { FakeEventSource } from './fakes.ts';
import { renderWithSpaces } from './fakes-m6-spaces.ts';
import { clearViewport, resetDom } from './render.tsx';

afterEach(() => {
  vi.useRealTimers();
  resetDom();
  clearViewport();
});

const pet = () => document.querySelector<HTMLElement>('.pet');
const events = () => FakeEventSource.for('/api/v1/events/stream');

/** A matchMedia stub that answers the reduced-motion query. */
function osReducedMotion(reduce: boolean) {
  window.matchMedia = (q: string) => ({
    matches: q.includes('prefers-reduced-motion: reduce') ? reduce : false,
    media: q,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  });
}

describe('PetOverlay (FR-012)', () => {
  it('renders nothing and opens no stream of its own while off', async () => {
    await renderWithSpaces(<PetOverlay />);
    expect(pet()).toBeNull();
    expect(document.querySelector('svg')).toBeNull();
    // At most the app's one shared stream (the settings store follows `settings.changed`).
    const open = FakeEventSource.all.filter((s) => !s.closed);
    expect(open.length).toBeLessThanOrEqual(1);
    // A run event while off still shows nothing.
    open[0]?.emit('thread.status.changed', { threadId: 't1', status: 'running' });
    expect(pet()).toBeNull();
  });

  it('is decoration only: hidden from assistive tech, not focusable, in the chosen corner', async () => {
    await renderWithSpaces(<PetOverlay />, {
      settings: { 'appearance.pet': 'sprout', 'appearance.petPosition': 'bottom-left' },
    });
    const el = pet()!;
    expect(el.getAttribute('aria-hidden')).toBe('true');
    // pets.css gives .pet `pointer-events: none` and a z-index below dialogs and toasts.
    expect(el.className).toBe('pet');
    expect(el.dataset.pet).toBe('sprout');
    expect(el.dataset.position).toBe('bottom-left');
    expect(el.dataset.state).toBe('idle');
    expect(el.dataset.animate).toBe('true');
    expect(el.querySelector('svg')!.getAttribute('focusable')).toBe('false');
    expect(el.querySelectorAll('a, button, input, [tabindex]')).toHaveLength(0);
    await userEvent.tab();
    expect(document.activeElement).toBe(document.body);
  });

  it('thinks while a thread runs, waits for input, and reacts to run outcomes', async () => {
    await renderWithSpaces(<PetOverlay />, { settings: { 'appearance.pet': 'spark' } });
    expect(pet()!.dataset.pet).toBe('spark');
    events().emit('thread.status.changed', {
      ref: { kind: 'chat', id: 't1' },
      from: 'ready',
      status: 'running',
    });
    expect(pet()!.dataset.state).toBe('thinking');
    events().emit('thread.status.changed', {
      ref: { kind: 'run', id: 'r1' },
      from: 'running',
      status: 'needs_input',
    });
    // Running wins over waiting.
    expect(pet()!.dataset.state).toBe('thinking');
    events().emit('thread.status.changed', { ref: { kind: 'chat', id: 't1' }, status: 'ready' });
    expect(pet()!.dataset.state).toBe('waiting');
    events().emit('thread.status.changed', { ref: { kind: 'run', id: 'r1' }, status: 'ready' });
    expect(pet()!.dataset.state).toBe('idle');

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    events().emit('run.completed', { runId: 'r1', status: 'done' });
    expect(pet()!.dataset.state).toBe('success');
    act(() => {
      vi.advanceTimersByTime(REACTION_MS - 100);
    });
    expect(pet()!.dataset.state).toBe('success');
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(pet()!.dataset.state).toBe('idle');
    events().emit('run.completed', { runId: 'r2', status: 'failed' });
    expect(pet()!.dataset.state).toBe('error');
    act(() => {
      vi.advanceTimersByTime(REACTION_MS + 100);
    });
    expect(pet()!.dataset.state).toBe('idle');
  });

  it('rests and holds still when kept still', async () => {
    await renderWithSpaces(<PetOverlay />, {
      settings: { 'appearance.pet': 'sprout', 'appearance.petMuted': true },
    });
    events().emit('thread.status.changed', { ref: { kind: 'chat', id: 't1' }, status: 'running' });
    events().emit('run.completed', { runId: 'r1', status: 'failed' });
    expect(pet()!.dataset.state).toBe('idle');
    expect(pet()!.dataset.animate).toBe('false');
  });

  it('holds a still pose under reduced motion, unless the user chose full motion', async () => {
    osReducedMotion(true);
    const first = await renderWithSpaces(<PetOverlay />, {
      settings: { 'appearance.pet': 'sprout' },
    });
    expect(pet()!.dataset.animate).toBe('false');
    events().emit('thread.status.changed', { ref: { kind: 'chat', id: 't1' }, status: 'running' });
    // The pose still changes; only the motion stops.
    expect(pet()!.dataset.state).toBe('thinking');
    first.unmount();

    await renderWithSpaces(<PetOverlay />, {
      settings: { 'appearance.pet': 'sprout', 'appearance.reducedMotion': 'off' },
    });
    expect(pet()!.dataset.animate).toBe('true');
  });

  it('holds still when the app is set to reduce motion', async () => {
    osReducedMotion(false);
    await renderWithSpaces(<PetOverlay />, {
      settings: { 'appearance.pet': 'spark', 'appearance.reducedMotion': 'on' },
    });
    expect(pet()!.dataset.animate).toBe('false');
  });
});

describe('PetSettings (FR-012)', () => {
  it('turns the companion on, moves it and keeps it still', async () => {
    const { hub } = await renderWithSpaces(
      <>
        <PetSettings />
        <PetOverlay />
      </>,
    );
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Off' }).checked).toBe(true);
    expect(screen.queryByRole('radio', { name: 'Bottom left' })).toBeNull();
    expect(pet()).toBeNull();
    await userEvent.click(screen.getByRole('radio', { name: 'Sprout' }));
    expect(hub.api.setSetting).toHaveBeenCalledWith('appearance.pet', 'sprout');
    await waitFor(() => expect(pet()!.dataset.pet).toBe('sprout'));
    await userEvent.click(screen.getByRole('radio', { name: 'Bottom left' }));
    expect(hub.api.setSetting).toHaveBeenCalledWith('appearance.petPosition', 'bottom-left');
    await waitFor(() => expect(pet()!.dataset.position).toBe('bottom-left'));
    await userEvent.click(screen.getByRole('switch', { name: 'Keep still' }));
    expect(hub.api.setSetting).toHaveBeenCalledWith('appearance.petMuted', true);
    await waitFor(() => expect(pet()!.dataset.animate).toBe('false'));
    await userEvent.click(screen.getByRole('radio', { name: 'Off' }));
    await waitFor(() => expect(pet()).toBeNull());
  });

  it('shows managed values as locked and reports a failed save', async () => {
    const managed = await renderWithSpaces(<PetSettings />, {
      managed: { 'appearance.pet': 'spark' },
    });
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Spark' }).checked).toBe(true);
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Off' }).disabled).toBe(true);
    expect(screen.getAllByText('Managed by your organization').length).toBeGreaterThan(0);
    managed.unmount();

    const { hub } = await renderWithSpaces(<PetSettings />, {
      settings: { 'appearance.pet': 'sprout' },
    });
    hub.state.failNext.setSetting = new ApiError(500, {
      code: 'internal',
      message: 'Hub unavailable.',
      retryable: true,
    });
    await userEvent.click(screen.getByRole('switch', { name: 'Keep still' }));
    expect(await screen.findByText('Could not save: Hub unavailable.')).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'Keep still' }).getAttribute('aria-checked')).toBe(
      'false',
    );
  });
});
