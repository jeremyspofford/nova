// Third-party apps and telemetry export in the pseudo-locale (FR-016): every word of the consent
// page (/authorize: the request, the scopes, the way back, refusals), Settings → Authorized apps
// (the switch, the apps you allowed, registered apps, Revoke and Remove) and Settings → Telemetry
// export (collector, headers, signals, content, test, status) comes from messages. App names,
// addresses, header names and the Hub's own words are data.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { AppsSettings } from '../src/appauth/AppsSettings.tsx';
import { AuthorizePage, consentRedirect } from '../src/appauth/AuthorizePage.tsx';
import { OtlpSettings } from '../src/appauth/OtlpSettings.tsx';
import {
  APPS_TEXT,
  CONSENT_TEXT,
  OTLP_TEXT,
  appErrorMessage,
  savedSignalText,
} from '../src/appauth/format.ts';
import { ApiError } from '../src/api.ts';
import {
  appClient,
  appGrant,
  consentQuery,
  m8AppAuthState,
  renderW11,
} from './fakes-m8-appauth.ts';
import {
  activateTestLocale,
  expectFullyLocalized,
  resetTestLocale,
  unlocalizedResidue,
} from './i18n.ts';
import { resetDom } from './render.tsx';

const realGo = consentRedirect.go;
beforeEach(() => {
  consentRedirect.go = vi.fn<(url: string) => void>();
});
afterEach(() => {
  consentRedirect.go = realGo;
  resetDom();
  resetTestLocale();
  vi.restoreAllMocks();
});

/** Fails on any word in `text` that is not pseudo-localized. */
function expectLocalizedText(text: string, data: readonly string[] = []) {
  expect(unlocalizedResidue(text, data), text).not.toMatch(/[A-Za-z]/);
}

const APPS = ['Notes Desk', 'Calendar Bridge', 'Old Notes'];

describe('the consent page in en-XA', () => {
  it('shows the request, its scopes and the way back', async () => {
    await activateTestLocale('en-XA');
    await renderW11(<AuthorizePage query={`?${consentQuery()}`} />);
    await screen.findByRole('heading', { name: CONSENT_TEXT.title({ name: 'Notes Desk' }) });
    expectFullyLocalized(document.body, { data: APPS });
    await userEvent.click(screen.getByRole('button', { name: CONSENT_TEXT.allow }));
    await screen.findByText(CONSENT_TEXT.allowed({ name: 'Notes Desk' }));
    expectFullyLocalized(document.body, { data: APPS });
  });

  it('explains a refused request, no request, and the owner-only notice', async () => {
    await activateTestLocale('en-XA');
    const r = await renderW11(<AuthorizePage query={`?${consentQuery({ client_id: 'nope' })}`} />);
    await screen.findByRole('heading', { name: CONSENT_TEXT.refusedTitle });
    expectFullyLocalized(document.body, { data: APPS });
    r.unmount();
    const r2 = await renderW11(<AuthorizePage query="" />);
    await screen.findByRole('heading', { name: CONSENT_TEXT.noRequest });
    expectFullyLocalized(document.body);
    r2.unmount();
    await renderW11(<AuthorizePage query={consentQuery()} />, { member: true });
    await screen.findByRole('heading', { name: CONSENT_TEXT.ownerOnly });
    expectFullyLocalized(document.body);
  });
});

describe('Settings → Authorized apps in en-XA', () => {
  it('shows the switch, the apps you allowed and the registered apps', async () => {
    await activateTestLocale('en-XA');
    const recent = new Date(Date.now() - 10 * 60_000).toISOString();
    await renderW11(<AppsSettings />, {
      appauth: {
        clients: [
          appClient({ approved: true }),
          appClient({
            id: 'app_cal',
            name: 'Calendar Bridge',
            registeredAt: recent,
            redirectUris: ['http://127.0.0.1:9000/cb'],
            scopes: ['account:read', 'usage:read'],
          }),
          appClient({
            id: 'app_old',
            name: 'Old Notes',
            approved: true,
            redirectUris: ['com.example.notes:/oauth'],
            scopes: ['memory:read'],
          }),
        ],
        grants: [
          appGrant({
            name: 'Notes Desk',
            scopes: ['account:read', 'threads:read', 'runs:read', 'projects:read'],
            redirectUris: ['http://127.0.0.1/callback', 'com.example.notes:/oauth'],
            sessions: 2,
          }),
        ],
      },
    });
    const list = await screen.findByRole('list', { name: APPS_TEXT.listLabel });
    await screen.findByRole('list', { name: APPS_TEXT.pendingLabel });
    expectFullyLocalized(document.body, { data: APPS });

    await userEvent.click(
      within(list).getByRole('button', { name: APPS_TEXT.revokeLabel({ name: 'Notes Desk' }) }),
    );
    const dialog = screen.getByRole('dialog', {
      name: APPS_TEXT.revokeTitle({ name: 'Notes Desk' }),
    });
    expectFullyLocalized(dialog, { data: APPS });
  });

  it('shows an empty list and a load error localized', async () => {
    await activateTestLocale('en-XA');
    await renderW11(<AppsSettings />, {
      appauth: { clients: [] },
      fail: {
        listPendingApps: new ApiError(404, {
          code: 'not_found',
          message: 'gone',
          retryable: false,
        }),
      },
    });
    await screen.findByText(APPS_TEXT.emptyTitle);
    await screen.findByText(
      appErrorMessage(new ApiError(404, { code: 'x', message: 'gone', retryable: false })),
    );
    expectFullyLocalized(document.body);
  });
});

describe('Settings → Telemetry export in en-XA', () => {
  it('shows the collector, headers, signals, content, test and status', async () => {
    await activateTestLocale('en-XA');
    await renderW11(<OtlpSettings />, {
      appauth: {
        otlp: {
          ...m8AppAuthState().otlp,
          enabled: true,
          endpoint: 'https://c.example',
          headers: { 'x-api-key': 'secret', Authorization: null },
          includeContent: true,
          sent: { traces: 5, metrics: 2, logs: 9 },
          failures: 2,
          lastError: 'HTTP 503 from the collector',
          lastSuccessAt: '2026-10-01T12:00:00.000Z',
          nextAttemptAt: '2026-10-01T12:05:00.000Z',
        },
      },
    });
    await screen.findByText(OTLP_TEXT.active);
    // Header names are protocol values; the name field's example is one too.
    const data = ['x-api-key', 'Authorization', 'HTTP 503 from the collector'];
    expectFullyLocalized(document.body, { data });

    await userEvent.click(screen.getByRole('button', { name: OTLP_TEXT.test }));
    await screen.findByText(OTLP_TEXT.testOkStatus({ status: '200' }));
    await userEvent.click(screen.getByRole('button', { name: OTLP_TEXT.addHeader }));
    expectFullyLocalized(document.body, { data });
    expectLocalizedText(savedSignalText('logs', false));
    expectLocalizedText(savedSignalText('traces', true));
  });

  it('asks before including content, naming the collector', async () => {
    await activateTestLocale('en-XA');
    await renderW11(<OtlpSettings />, {
      appauth: { otlp: { ...m8AppAuthState().otlp, endpoint: 'https://c.example' } },
    });
    await userEvent.click(await screen.findByRole('switch', { name: OTLP_TEXT.contentLabel }));
    const dialog = screen.getByRole('dialog', { name: OTLP_TEXT.contentConfirmTitle });
    expectFullyLocalized(dialog);
  });
});
