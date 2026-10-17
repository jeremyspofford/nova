import { afterEach, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ModelView, Preset } from '@nova/shared';
import { ApiError } from '../src/api.ts';
import { presetId, presetProblems } from '../src/settings/PresetsEditor.tsx';
import { fullOrder } from '../src/settings/RoutingSection.tsx';
import { sameServer } from '../src/settings/LocalServers.tsx';
import { MODELS, createHub } from './fakes.ts';
import { BUILT_IN_PRESETS, workspaceState } from './fakes-workspace.ts';
import { renderApp, resetDom } from './render.tsx';

afterEach(resetDom);

const fail = (message: string, status = 500) =>
  new ApiError(status, { code: 'x', message, retryable: false });
const preset = (label: string) => screen.getByRole('group', { name: label });

describe('presets helpers', () => {
  it('derives unique ids from labels', () => {
    expect(presetId('Deep Think!', new Set())).toBe('deep-think');
    expect(presetId('Custom', new Set(['custom', 'custom-2']))).toBe('custom-3');
    expect(presetId('***', new Set())).toBe('preset');
  });

  it('lists problems before saving', () => {
    const ok: Preset = { id: 'a', label: 'A', strategy: 'single', targets: ['pa1/x'], rank: 1 };
    expect(presetProblems([ok])).toEqual([]);
    expect(presetProblems([{ ...ok, label: ' ' }])).toEqual(['Preset 1 needs a name.']);
    expect(presetProblems([{ ...ok, targets: [] }])).toEqual(['A needs at least one model.']);
    expect(presetProblems(Array.from({ length: 21 }, () => ok))[0]).toMatch(/at most 20/);
  });

  it('completes a partial routing order and compares server addresses', () => {
    expect(fullOrder(['cloud'])).toEqual([
      'cloud',
      'same_device',
      'capability',
      'least_loaded',
      'cost',
    ]);
    expect(sameServer('http://127.0.0.1:11434/v1/', 'http://127.0.0.1:11434')).toBe(true);
    expect(sameServer(null, 'http://x')).toBe(false);
  });
});

describe('Settings → Models: presets (FR-221)', () => {
  it('edits, reorders, adds and saves presets, then resets to built-in', async () => {
    const hub = createHub();
    await renderApp({ hub, path: '/settings/models' });
    const list = await screen.findByRole('list', { name: 'Presets, from faster to smarter' });
    expect(screen.getByText('Built-in')).toBeTruthy();
    expect(
      within(list)
        .getAllByRole('group')
        .filter((g) => g.tagName === 'FIELDSET')
        .map((g) => g.querySelector('legend')?.textContent),
    ).toEqual(['Faster', 'Balanced', 'Smarter']);
    const save = screen.getByRole<HTMLButtonElement>('button', { name: 'Save presets' });
    expect(save.disabled).toBe(true);

    // Edit Smarter: rename, fallback strategy, a second model, speed.
    const smarter = preset('Smarter');
    const label = within(smarter).getByRole('textbox', { name: 'Name' });
    await userEvent.clear(label);
    await userEvent.type(label, 'Deep');
    const deep = preset('Deep');
    await userEvent.selectOptions(
      within(deep).getByRole('combobox', { name: 'Strategy' }),
      'fallback',
    );
    expect(within(deep).getByText(/Tries the models in order/)).toBeTruthy();
    await userEvent.click(within(deep).getByRole('button', { name: 'Add model' }));
    expect(within(deep).getByRole<HTMLSelectElement>('combobox', { name: 'Model 2' }).value).toBe(
      'pa1/mock-fast',
    );
    // Already-used models cannot be picked twice.
    const firstSelect = within(deep).getByRole('combobox', { name: 'Model 1' });
    expect(
      within(firstSelect).getByRole<HTMLOptionElement>('option', { name: 'Mock fast' }).disabled,
    ).toBe(true);
    await userEvent.click(within(deep).getByRole('button', { name: 'Move model 2 up' }));
    expect(within(deep).getByRole<HTMLSelectElement>('combobox', { name: 'Model 1' }).value).toBe(
      'pa1/mock-fast',
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(deep).getByRole('button', { name: 'Move model 1 down' }),
      ),
    );
    await userEvent.selectOptions(within(deep).getByRole('combobox', { name: 'Speed' }), 'fast');

    // Move Deep above Balanced with the keyboard; focus follows the moved preset.
    const up = within(deep).getByRole('button', { name: 'Move preset up' });
    up.focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Move preset up'));
    expect([...list.querySelectorAll('fieldset > legend')].map((l) => l.textContent)).toEqual([
      'Faster',
      'Deep',
      'Balanced',
    ]);

    // Add a custom preset, then remove Balanced.
    await userEvent.click(screen.getByRole('button', { name: 'Add preset' }));
    expect(preset('Custom')).toBeTruthy();
    await userEvent.click(
      within(preset('Balanced')).getByRole('button', { name: 'Remove preset' }),
    );

    await userEvent.click(save);
    await waitFor(() => expect(hub.api.savePresets).toHaveBeenCalled());
    const [sent] = hub.api.savePresets.mock.calls[0] as unknown as [Preset[]];
    expect(sent).toEqual([
      { ...BUILT_IN_PRESETS[0], rank: 1 },
      {
        id: 'smarter',
        label: 'Deep',
        strategy: 'fallback',
        targets: ['pa1/mock-fast', 'pa1/mock-smart'],
        reasoningLevel: 'high',
        speed: 'fast',
        rank: 2,
      },
      { id: 'custom', label: 'Custom', strategy: 'single', targets: ['pa1/mock-fast'], rank: 3 },
    ]);
    expect(await screen.findByText('Presets saved.')).toBeTruthy();
    expect(screen.queryByText('Built-in')).toBeNull();
    expect(hub.api.listModels.mock.calls.length).toBeGreaterThan(1);

    // Reset to built-in, after confirming.
    await userEvent.click(screen.getByRole('button', { name: 'Reset to built-in' }));
    const dialog = screen.getByRole('dialog', { name: 'Reset presets to the built-in set?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reset' }));
    await waitFor(() => expect(hub.api.savePresets).toHaveBeenLastCalledWith([]));
    expect(await screen.findByText('Built-in')).toBeTruthy();
    expect(preset('Balanced')).toBeTruthy();
  });

  it('blocks an unnamed preset, shows Hub errors, discards edits and marks unavailable ones', async () => {
    const unavailable: ModelView = {
      ref: 'preset:smarter',
      kind: 'preset',
      source: 'preset',
      provider: 'preset',
      providerAccountId: '',
      modelId: 'smarter',
      label: 'Smarter',
      reasoning: false,
      disabledReason: 'No connected model can serve it',
    };
    const hub = createHub({
      models: [unavailable, ...MODELS],
      workspace: workspaceState({
        presets: [
          ...BUILT_IN_PRESETS.slice(0, 2),
          { ...BUILT_IN_PRESETS[2]!, targets: ['gone/model'] },
        ],
        presetsBuiltIn: false,
      }),
    });
    await renderApp({ hub, path: '/settings/models' });
    await screen.findByRole('list', { name: 'Presets, from faster to smarter' });
    expect(within(preset('Smarter')).getByText(/Unavailable: No connected model/)).toBeTruthy();
    expect(
      within(preset('Smarter')).getByRole<HTMLSelectElement>('combobox', { name: 'Model 1' }).value,
    ).toBe('gone/model');
    expect(
      within(preset('Smarter')).getByRole('option', { name: 'gone/model (not available)' }),
    ).toBeTruthy();

    const name = within(preset('Faster')).getByRole('textbox', { name: 'Name' });
    await userEvent.clear(name);
    expect(screen.getByText('Preset 1 needs a name.')).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save presets' }).disabled).toBe(
      true,
    );
    await userEvent.type(name, 'Quick');
    hub.state.failNext.savePresets = fail('Malformed model reference: x', 400);
    await userEvent.click(screen.getByRole('button', { name: 'Save presets' }));
    expect(await screen.findByText('Malformed model reference: x')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(preset('Faster')).toBeTruthy();
  });

  it('locks the editor when presets are managed', async () => {
    const hub = createHub({ managed: { 'models.presets': [] } });
    await renderApp({ hub, path: '/settings/models' });
    await screen.findByRole('list', { name: 'Presets, from faster to smarter' });
    // Disabled through its fieldset, as the browser sees it.
    expect(
      within(preset('Faster')).getByRole('textbox', { name: 'Name' }).matches(':disabled'),
    ).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Add preset' }).disabled).toBe(
      true,
    );
    expect(screen.getAllByText('Managed by your organization').length).toBeGreaterThan(0);
  });

  it('reports a failed load with retry', async () => {
    const hub = createHub();
    await renderApp({ hub, path: '/settings/general' });
    hub.state.failNext.listPresets = fail('Hub busy');
    await userEvent.click(screen.getByRole('link', { name: 'Models' }));
    expect(await screen.findByText('Hub busy')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(
      await screen.findByRole('list', { name: 'Presets, from faster to smarter' }),
    ).toBeTruthy();
  });
});

describe('Settings → Models: local servers (docs/07 §12)', () => {
  it('detects servers and connects one with its address filled in', async () => {
    const hub = createHub({
      workspace: workspaceState({
        detected: [
          { kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', models: ['qwen3:8b', 'llama3:8b'] },
          { kind: 'llamacpp', baseUrl: 'http://127.0.0.1:8080', models: [] },
        ],
      }),
    });
    hub.state.providers = [
      {
        id: 'pa9',
        provider: 'ollama',
        label: 'Ollama',
        authKind: 'none',
        baseUrl: 'http://127.0.0.1:11434/v1',
        status: 'active',
        hasSecret: false,
        lastCheckAt: null,
        createdAt: '2026-10-01T00:00:00.000Z',
      },
    ];
    await renderApp({ hub, path: '/settings/models' });
    await userEvent.click(screen.getByRole('button', { name: 'Detect' }));
    expect(await screen.findByText('Found 2 servers.')).toBeTruthy();
    const ollama = screen.getByRole('listitem', { name: 'Ollama at http://127.0.0.1:11434' });
    expect(within(ollama).getByText('2 models: qwen3:8b, llama3:8b')).toBeTruthy();
    expect(within(ollama).getByText('Already connected')).toBeTruthy();
    const llama = screen.getByRole('listitem', { name: 'llama.cpp at http://127.0.0.1:8080' });
    expect(within(llama).getByText('No models installed yet')).toBeTruthy();

    await userEvent.click(within(llama).getByRole('button', { name: 'Connect' }));
    const setup = screen.getByRole('group', { name: 'Connect a detected server' });
    expect(
      within(setup).getByRole<HTMLInputElement>('radio', { name: 'llama.cpp (local)' }).checked,
    ).toBe(true);
    expect(within(setup).getByRole<HTMLInputElement>('textbox', { name: 'Base URL' }).value).toBe(
      'http://127.0.0.1:8080',
    );
    await userEvent.click(within(setup).getByRole('button', { name: 'Save and test' }));
    await waitFor(() =>
      expect(hub.api.createProvider).toHaveBeenCalledWith({
        provider: 'llamacpp',
        label: 'llama.cpp (local)',
        baseUrl: 'http://127.0.0.1:8080',
      }),
    );
    expect(await screen.findByText('llama.cpp (local) connected with 2 models.')).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Connect a detected server' })).toBeNull();
    expect(within(llama).getByText('Already connected')).toBeTruthy();
  });

  it('reports none found and a failed probe', async () => {
    const hub = createHub();
    await renderApp({ hub, path: '/settings/models' });
    hub.state.failNext.detectServers = fail('Probe failed');
    await userEvent.click(screen.getByRole('button', { name: 'Detect' }));
    expect(await screen.findByText('Probe failed')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(/No local model servers found/)).toBeTruthy();
  });
});

describe('Settings → Models: routing (FR-127)', () => {
  it('reorders the steps with the keyboard and toggles cloud models', async () => {
    const hub = createHub();
    await renderApp({ hub, path: '/settings/models' });
    const down = screen.getByRole('button', { name: 'Move This device down' });
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Move This device up' }).disabled,
    ).toBe(true);
    down.focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() =>
      expect(hub.state.settings['routing.order']).toEqual([
        'capability',
        'same_device',
        'least_loaded',
        'cost',
        'cloud',
      ]),
    );
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Move This device down' }),
    );
    const last = screen.getByRole('button', { name: 'Move Cloud providers up' });
    last.focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() =>
      expect((hub.state.settings['routing.order'] as string[]).at(-1)).toBe('cost'),
    );
    // Moving the last row to the bottom disables Down, so focus moves to Up.
    const lowest = screen.getByRole('button', { name: 'Move Cloud providers down' });
    lowest.focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'Move Cloud providers up' }),
      ),
    );

    const cloud = screen.getByRole('switch', { name: 'Allow cloud models' });
    await userEvent.click(cloud);
    await waitFor(() => expect(hub.state.settings['routing.allowCloud']).toBe(false));
    expect(screen.getByText(/Off: cloud models are not allowed/)).toBeTruthy();
  });

  it('shows Managed and disables the cloud switch when policy locks it', async () => {
    const hub = createHub({ managed: { 'routing.allowCloud': false } });
    await renderApp({ hub, path: '/settings/models' });
    const cloud = screen.getByRole<HTMLButtonElement>('switch', { name: 'Allow cloud models' });
    expect(cloud.disabled).toBe(true);
    expect(cloud.getAttribute('aria-checked')).toBe('false');
    expect(screen.getAllByText('Managed by your organization').length).toBeGreaterThan(0);
  });

  it('rolls back a rejected routing change', async () => {
    const hub = createHub();
    await renderApp({ hub, path: '/settings/models' });
    hub.state.failNext.setSetting = fail('Disk full');
    await userEvent.click(screen.getByRole('button', { name: 'Move This device down' }));
    expect(await screen.findByText('Could not save: Disk full')).toBeTruthy();
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Move This device up' }).disabled,
    ).toBe(true);
  });
});
