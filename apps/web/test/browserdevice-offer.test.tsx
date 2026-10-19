// The local browser fallback's offer (FR-209, docs/11 §4.6): a `user_input` request the Hub asks
// when a site blocks an agent's browser, correlated with the refused browser call. A thread shows
// its pending offers with each choice and what it means; only offers (not share asks or
// `ask_user` questions, not another thread's) show; an answer is sent as the choice, and a
// conflict, an expiry or a failure each say so. Also how the offer is recognized and the words
// for the Hub's refusals.
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '../src/api.ts';
import { FallbackOffers, choiceHints } from '../src/browserdevice/FallbackOffer.tsx';
import {
  browserDeviceError,
  fallbackMarkOf,
  grantLabel,
  markText,
  parseFallbackOffer,
  stampOf,
  whereText,
} from '../src/browserdevice/format.ts';
import { bridgeChip, hostProblem } from '../src/browserdevice/BridgeSection.tsx';
import { createHub, thread } from './fakes.ts';
import { browserActionView } from './fakes-m6-browser.ts';
import { shareAsk } from './fakes-m6-channels.ts';
import { requestView } from './fakes-m5-work.ts';
import { emitHub } from './fakes-m6-browser.ts';
import { bridgeGrantView, fallbackOffer, renderM75Browser } from './fakes-m75-browser.ts';
import { renderApp, resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  window.history.replaceState(null, '', '/');
});

const apiError = (status: number, code: string, message: string, reason?: string) =>
  new ApiError(status, {
    code,
    message,
    retryable: false,
    ...(reason ? { details: { reason } } : {}),
  });

describe('a thread’s fallback offer', () => {
  it('shows the three choices with what each means and sends the one picked', async () => {
    const offer = fallbackOffer({ id: 'rq1' });
    const { hub } = await renderM75Browser(<FallbackOffers threadId="t1" />, {
      requests: [offer],
    });
    const card = within(
      await screen.findByRole('article', { name: 'Continue example.com on Desk PC?' }),
    );
    expect(card.getByText(/Asked because the site showed a block page/)).toBeTruthy();
    // The Hub's question is shown as text.
    expect(card.getByText(/example\.com refused the agent's browser/)).toBeTruthy();
    const clean = card.getByRole('button', { name: 'Continue on Desk PC (clean profile)' });
    const own = card.getByRole('button', {
      name: 'Continue in my own browser on Desk PC (extension)',
    });
    const notNow = card.getByRole('button', { name: 'Not now' });
    // Each choice is described by what it does.
    expect(clean.getAttribute('aria-describedby')).toBeTruthy();
    expect(document.getElementById(clean.getAttribute('aria-describedby')!)!.textContent).toContain(
      'none of your sign-ins, and it reaches only example.com and its subdomains',
    );
    expect(document.getElementById(own.getAttribute('aria-describedby')!)!.textContent).toContain(
      'signed in as you',
    );
    expect(
      document.getElementById(notNow.getAttribute('aria-describedby')!)!.textContent,
    ).toContain('Nothing is remembered');
    expect(card.getByRole('link', { name: 'Settings → Browser' }).getAttribute('href')).toBe(
      '/settings/browser',
    );
    // No answer button takes the focus by itself.
    expect(document.activeElement?.tagName).not.toBe('BUTTON');

    await userEvent.click(clean);
    expect(hub.api.respondRequest).toHaveBeenCalledWith('rq1', {
      choice: 'Continue on Desk PC (clean profile)',
    });
    expect(
      await screen.findByText('The agent continues example.com on Desk PC with a clean profile.'),
    ).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('article')).toBeNull());
    expect(hub.state.m5work.requests[0]!.status).toBe('resolved');
  });

  it('offers only the clean profile when the bridge cannot serve the site, and Not now', async () => {
    const { hub } = await renderM75Browser(<FallbackOffers threadId="t1" />, {
      requests: [fallbackOffer({ id: 'rq1', extension: false })],
    });
    const card = within(await screen.findByRole('article'));
    expect(card.getAllByRole('button')).toHaveLength(2);
    expect(card.queryByRole('button', { name: /own browser/ })).toBeNull();
    await userEvent.click(card.getByRole('button', { name: 'Not now' }));
    expect(hub.api.respondRequest).toHaveBeenCalledWith('rq1', { choice: 'Not now' });
    expect(
      await screen.findByText('The agent does not continue example.com on Desk PC.'),
    ).toBeTruthy();
  });

  it('answers in the own browser', async () => {
    const { hub } = await renderM75Browser(<FallbackOffers threadId="t1" />, {
      requests: [fallbackOffer({ id: 'rq1', site: 'shop.example', device: 'Laptop' })],
    });
    const card = within(
      await screen.findByRole('article', { name: 'Continue shop.example on Laptop?' }),
    );
    await userEvent.click(
      card.getByRole('button', { name: 'Continue in my own browser on Laptop (extension)' }),
    );
    expect(hub.api.respondRequest).toHaveBeenCalledWith('rq1', {
      choice: 'Continue in my own browser on Laptop (extension)',
    });
    expect(
      await screen.findByText('The agent continues shop.example in your browser on Laptop.'),
    ).toBeTruthy();
  });

  it('shows only this thread’s offers, not other questions', async () => {
    await renderM75Browser(<FallbackOffers threadId="t1" />, {
      requests: [
        fallbackOffer({ id: 'mine' }),
        fallbackOffer({ id: 'other', threadId: 't2', site: 'other.example' }),
        // A channels share ask and an ask_user question are other cards' questions.
        shareAsk('t1', { id: 'share' }),
        requestView({
          id: 'ask',
          correlation: { threadId: 't1', callId: 'c9' },
          payload: { question: 'Which?', choices: ['A', 'Not now'] },
        }),
        // The same words without the context are not an offer.
        requestView({
          id: 'bare',
          correlation: { threadId: 't1', callId: 'c8' },
          payload: {
            question: 'example.com refused the agent’s browser.',
            choices: ['Continue on Desk PC (clean profile)', 'Not now'],
          },
        }),
        // An answered offer is gone.
        fallbackOffer({ id: 'done', status: 'resolved', site: 'old.example' }),
      ],
    });
    await screen.findByRole('article', { name: 'Continue example.com on Desk PC?' });
    expect(screen.getAllByRole('article')).toHaveLength(1);
  });

  it('says when it was answered elsewhere or expired, and keeps other errors on the card', async () => {
    const { hub } = await renderM75Browser(<FallbackOffers threadId="t1" />, {
      requests: [fallbackOffer({ id: 'rq1' })],
    });
    const card = within(await screen.findByRole('article'));
    hub.state.failNext.respondRequest = apiError(500, 'server_error', 'Hub is restarting');
    await userEvent.click(card.getByRole('button', { name: 'Not now' }));
    expect((await card.findByRole('alert')).textContent).toBe('Hub is restarting');
    expect(screen.getByRole('article')).toBeTruthy();

    hub.state.failNext.respondRequest = apiError(409, 'conflict', 'Already answered.');
    await userEvent.click(card.getByRole('button', { name: 'Not now' }));
    expect(await screen.findByText('This was already answered on another device.')).toBeTruthy();

    hub.state.m5work.requests = [fallbackOffer({ id: 'rq2' })];
    emitHub('request.created', { requestId: 'rq2' });
    const again = within(await screen.findByRole('article'));
    hub.state.failNext.respondRequest = apiError(410, 'request_expired', 'The question expired.');
    await userEvent.click(again.getByRole('button', { name: 'Not now' }));
    expect(await screen.findByText('This offer expired before your answer arrived.')).toBeTruthy();
  });

  it('appears and leaves with the request events', async () => {
    const { hub } = await renderM75Browser(<FallbackOffers threadId="t1" />, { requests: [] });
    await waitFor(() => expect(hub.api.listRequests).toHaveBeenCalled());
    expect(screen.queryByRole('article')).toBeNull();
    hub.state.m5work.requests = [fallbackOffer({ id: 'rq1' })];
    emitHub('request.created', { requestId: 'rq1' });
    expect(await screen.findByRole('article')).toBeTruthy();
    hub.state.m5work.requests = [];
    emitHub('request.expired', { requestId: 'rq1' });
    await waitFor(() => expect(screen.queryByRole('article')).toBeNull());
  });

  it('shows in the conversation of the app', async () => {
    const hub = createHub();
    hub.state.threads = [thread({ id: 't1', title: 'Shopping' })];
    hub.state.messages.set('t1', []);
    hub.state.m5work.requests = [fallbackOffer({ id: 'rq1' })];
    await renderApp({ hub, path: '/chat/t1' });
    const card = within(
      await screen.findByRole('article', { name: 'Continue example.com on Desk PC?' }),
    );
    await userEvent.click(
      card.getByRole('button', { name: 'Continue on Desk PC (clean profile)' }),
    );
    expect(hub.api.respondRequest).toHaveBeenCalledWith('rq1', {
      choice: 'Continue on Desk PC (clean profile)',
    });
  });
});

describe('the words', () => {
  it('recognizes the offer by its context only', () => {
    const offer = fallbackOffer({
      site: 'a.example',
      device: 'Desk PC',
      cause: 'repeated_challenge',
    });
    expect(parseFallbackOffer(offer)).toEqual({
      site: 'a.example',
      deviceId: 'd1',
      device: 'Desk PC',
      cause: 'repeated_challenge',
      question: expect.stringContaining('a.example refused'),
      choices: [
        { id: 'clean', label: 'Continue on Desk PC (clean profile)' },
        { id: 'extension', label: 'Continue in my own browser on Desk PC (extension)' },
        { id: 'decline', label: 'Not now' },
      ],
    });
    expect(
      parseFallbackOffer(fallbackOffer({ extension: false }))!.choices.map((c) => c.id),
    ).toEqual(['clean', 'decline']);
    // The same words without the context are not an offer any more.
    const { context: _drop, ...bare } = offer.payload;
    expect(parseFallbackOffer({ ...offer, payload: bare })).toBeNull();
    // A context of another kind, or one that does not fit the schema, is not one either.
    const ctx = offer.payload.context as Record<string, unknown>;
    expect(
      parseFallbackOffer({
        ...offer,
        payload: { ...offer.payload, context: { ...ctx, kind: 'x' } },
      }),
    ).toBeNull();
    expect(
      parseFallbackOffer({
        ...offer,
        payload: { ...offer.payload, context: { ...ctx, extra: true } },
      }),
    ).toBeNull();
    expect(parseFallbackOffer({ ...offer, kind: 'elicitation' })).toBeNull();
    expect(parseFallbackOffer(shareAsk('t1'))).toBeNull();
    // Only choices the request itself offers are kept (nothing else is a valid answer).
    const fewer = parseFallbackOffer({
      ...offer,
      payload: { ...offer.payload, choices: ['Not now'] },
    })!;
    expect(fewer.choices).toEqual([{ id: 'decline', label: 'Not now' }]);
    expect(parseFallbackOffer({ ...offer, payload: { ...offer.payload, choices: [] } })).toBeNull();
    // The words match the Hub's offer: the site and its subdomains, a tab it opens or you shared.
    const hints = choiceHints({ device: 'Desk PC', site: 'a.example' });
    expect(hints.clean).toContain('reaches only a.example and its subdomains');
    expect(hints.clean).toContain('stops when the agent leaves a.example');
    expect(hints.extension).toContain('a tab it opens or one you shared, on a.example');
    expect(hints.decline).toContain('Nothing is remembered');
  });

  it('marks a trace row and says where it ran', () => {
    const plain = browserActionView();
    expect(fallbackMarkOf(plain)).toBeNull();
    const marked = {
      ...browserActionView(),
      localFallback: { sessionId: 's1', deviceId: 'd1', profile: 'clean' as const },
    };
    const mark = fallbackMarkOf(marked)!;
    expect(markText(mark, 'Desk PC')).toBe('On Desk PC, clean profile');
    expect(markText({ ...mark, profile: 'extension' }, null)).toBe(
      'On your computer, your own browser',
    );
    expect(whereText(mark, 'Desk PC')).toContain(
      'clean profile that reaches only this site and its subdomains',
    );
    expect(whereText({ ...mark, profile: 'extension' }, null)).toBe(
      'Your own browser on a connected computer, through the Nova extension',
    );
  });

  it('names grants, chips and hosts', () => {
    expect(grantLabel(bridgeGrantView({ host: '*' }))).toBe('All sites');
    expect(grantLabel(bridgeGrantView({ host: 'github.com' }))).toBe('github.com');
    expect(bridgeChip({ connected: true, enabled: false }).text).toBe('Turned off');
    expect(bridgeChip({ connected: true, enabled: true }).text).toBe('Connected');
    expect(bridgeChip({ connected: false, enabled: true }).text).toBe('Not connected');
    expect(hostProblem('github.com')).toBeNull();
    expect(hostProblem('https://github.com/x')).toBe('Enter a host name such as github.com');
    expect(hostProblem('*.github.com')).not.toBeNull();
    expect(hostProblem('10.0.0.1')).not.toBeNull();
    expect(stampOf(null)).toBe('never');
    expect(stampOf('nope')).toBe('unknown');
  });

  it('puts every refusal in plain words', () => {
    const cases: [ApiError, string][] = [
      [apiError(403, 'policy_denied', 'x', 'hub_host'), 'one of this Hub’s own addresses'],
      [apiError(403, 'policy_denied', 'x', 'owner_only'), 'Only the owner of this Hub'],
      [apiError(403, 'policy_denied', 'x', 'bridge_disabled'), 'turned off in Settings → Browser'],
      [apiError(403, 'policy_denied', 'x', 'all_sites_disabled'), 'Grant sites one by one'],
      [apiError(400, 'validation', 'x', 'elevated_ack_required'), 'risk of “all sites”'],
      [apiError(403, 'policy_denied', 'x', 'host_not_granted'), 'not granted for the bridge'],
      [apiError(409, 'conflict', 'x', 'bridge_offline'), 'not connected'],
      [apiError(403, 'policy_denied', 'x', 'extension_refused'), 'The extension refused.'],
      [apiError(409, 'conflict', 'the grant was revoked'), 'revoked in the meantime'],
      [apiError(404, 'not_found', 'grant not found'), 'This grant no longer exists.'],
      [apiError(404, 'not_found', 'consent not found'), 'This consent no longer exists.'],
      [apiError(404, 'not_found', 'device not found'), 'This device is not on this Hub.'],
      [apiError(404, 'not_found', 'something'), 'It no longer exists.'],
      [apiError(410, 'request_expired', 'x'), 'expired before your answer'],
      [apiError(500, 'server_error', 'Hub is restarting'), 'Hub is restarting'],
    ];
    for (const [e, text] of cases) expect(browserDeviceError(e)).toContain(text);
    expect(
      browserDeviceError(apiError(400, 'validation', 'request failed validation'), 'x', {
        invalid: 'Enter a host',
      }),
    ).toBe('Enter a host');
    expect(browserDeviceError(apiError(400, 'validation', 'request failed validation'))).toBe(
      'request failed validation',
    );
    expect(browserDeviceError(new Error('boom'))).toBe('boom');
    expect(browserDeviceError('?', 'Fallback')).toBe('Fallback');
  });
});
