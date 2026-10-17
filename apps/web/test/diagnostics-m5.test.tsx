// Settings → Diagnostics Test actions (FR-119): each component (a provider, an MCP server, the
// sandbox, storage, updates) runs its test and shows the status and detail in a live region; a
// provider test reloads the snapshot; a failed request shows why.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { DiagnosticTestResult } from '../src/settings/DiagnosticsPage.tsx';
import { createHub } from './fakes.ts';
import { m3State } from './fakes-m3.ts';
import { renderApp, resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Body = { component: string; ref?: string };

function stubTests(answer: (b: Body) => { status: number; body: unknown }) {
  const fn = vi.fn((url: string, init: RequestInit) => {
    expect(url).toBe('/api/v1/diagnostics/test');
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin' });
    const r = answer(JSON.parse(init.body as string) as Body);
    return Promise.resolve({
      ok: r.status < 400,
      status: r.status,
      statusText: 'x',
      json: () => Promise.resolve(r.body),
    });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function result(over: Partial<DiagnosticTestResult>): DiagnosticTestResult {
  return {
    component: 'storage',
    ref: null,
    status: 'ok',
    detail: 'Fine.',
    checks: [],
    durationMs: 3,
    testedAt: '2026-10-17T09:30:00.000Z',
    ...over,
  };
}

async function open() {
  const m3 = m3State();
  m3.diagnostics = {
    ...m3.diagnostics,
    providers: [{ id: 'pa1', label: 'Mock', status: 'active' }],
    mcp: [{ id: 's1', name: 'files', status: 'connected', lastError: null }],
    sandbox: { substrate: 'container', available: true, detail: 'docker 27' },
  };
  const hub = createHub({ m3 });
  await renderApp({ hub, path: '/settings/diagnostics' });
  const health = screen.getByRole('heading', { name: 'Health' }).closest('section')!;
  await within(health).findByText('0.1.0');
  const card = (name: string) => within(health).getByRole('region', { name });
  return { hub, card };
}

describe('Settings → Diagnostics: tests (FR-119)', () => {
  it('tests storage and shows each check', async () => {
    const fetchFn = stubTests(() => ({
      status: 200,
      body: result({
        status: 'warning',
        detail: 'Free space: Only 0.4 GB free.',
        checks: [
          {
            name: 'Data folder',
            ref: null,
            status: 'ok',
            detail: 'Wrote, read back and deleted a test file.',
          },
          { name: 'Database', ref: null, status: 'ok', detail: 'Passed its integrity check.' },
          { name: 'Free space', ref: null, status: 'warning', detail: 'Only 0.4 GB free.' },
        ],
      }),
    }));
    const { card } = await open();
    const storage = card('Storage');
    await userEvent.click(within(storage).getByRole('button', { name: 'Test storage' }));
    const status = within(storage).getByRole('status');
    expect(await within(status).findByText('Warning:')).toBeTruthy();
    expect(
      within(status).getByText(/Free space: Only 0\.4 GB free\./, { selector: 'span' }),
    ).toBeTruthy();
    const checks = within(status).getByRole('list', { name: 'Checks' });
    expect(
      within(checks)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([
      'Data folder: Passed. Wrote, read back and deleted a test file.',
      'Database: Passed. Passed its integrity check.',
      'Free space: Warning. Only 0.4 GB free.',
    ]);
    expect(JSON.parse(fetchFn.mock.calls[0]![1].body as string)).toEqual({ component: 'storage' });
  });

  it('tests one provider by id and reloads the snapshot afterwards', async () => {
    const fetchFn = stubTests((b) => ({
      status: 200,
      body: result({
        component: 'provider',
        ref: b.ref ?? null,
        detail: 'Mock fast answered in 12 ms.',
      }),
    }));
    const { hub, card } = await open();
    const before = vi.mocked(hub.api.diagnostics).mock.calls.length;
    const providers = card('Providers');
    await userEvent.click(within(providers).getByRole('button', { name: 'Test Mock' }));
    expect(await within(providers).findByText('Passed:')).toBeTruthy();
    expect(within(providers).getByText(/Mock fast answered in 12 ms\./)).toBeTruthy();
    expect(JSON.parse(fetchFn.mock.calls[0]![1].body as string)).toEqual({
      component: 'provider',
      ref: 'pa1',
    });
    await waitFor(() =>
      expect(vi.mocked(hub.api.diagnostics).mock.calls.length).toBeGreaterThan(before),
    );
  });

  it('tests an MCP server, the sandbox and updates, and reports a request that failed', async () => {
    stubTests((b) => {
      if (b.component === 'mcp')
        return {
          status: 200,
          body: result({ component: 'mcp', ref: 's1', status: 'error', detail: 'spawn ENOENT' }),
        };
      if (b.component === 'update')
        return {
          status: 200,
          body: result({
            component: 'update',
            status: 'unavailable',
            detail: 'No update channel is configured. This Hub runs version 0.1.0.',
          }),
        };
      return {
        status: 500,
        body: { error: { code: 'server_error', message: 'The Hub is busy', retryable: true } },
      };
    });
    const { card } = await open();
    const mcp = card('MCP servers');
    await userEvent.click(within(mcp).getByRole('button', { name: 'Test files' }));
    expect(await within(mcp).findByText('Failed:')).toBeTruthy();
    expect(within(mcp).getByText(/spawn ENOENT/)).toBeTruthy();

    const updates = card('Updates');
    await userEvent.click(within(updates).getByRole('button', { name: 'Test updates' }));
    expect(await within(updates).findByText('Not available:')).toBeTruthy();
    expect(within(updates).getByText(/No update channel is configured/)).toBeTruthy();

    const sandbox = card('Sandbox');
    await userEvent.click(within(sandbox).getByRole('button', { name: 'Test the sandbox' }));
    expect(await within(sandbox).findByText('The Hub is busy')).toBeTruthy();
    expect(
      within(sandbox).getByRole('button', { name: 'Test the sandbox' }).hasAttribute('disabled'),
    ).toBe(false);
  });

  it('disables a Test button while its test runs', async () => {
    let finish!: () => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise((resolve) => {
            finish = () =>
              resolve({
                ok: true,
                status: 200,
                statusText: 'OK',
                json: () => Promise.resolve(result({})),
              });
          }),
      ),
    );
    const { card } = await open();
    const storage = card('Storage');
    await userEvent.click(within(storage).getByRole('button', { name: 'Test storage' }));
    expect(
      within(storage).getByRole('button', { name: 'Test storage' }).hasAttribute('disabled'),
    ).toBe(true);
    finish();
    expect(await within(storage).findByText('Passed:')).toBeTruthy();
    expect(
      within(storage).getByRole('button', { name: 'Test storage' }).hasAttribute('disabled'),
    ).toBe(false);
  });
});
