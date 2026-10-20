// The joining device's page, /add-device, in the pseudo-locale (FR-016): the form, the wait for
// the owner, the approved page with its install help, the stops, and every refusal in plain words
// come from messages. The device name suggestion is a message too ("{browser} on {device}", with
// product names); the confirmation digits are numbers.
import { act, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RelayError } from '@nova/relay';
import { ApiError } from '../src/api.ts';
import { JoinPage, joinErrorMessage } from '../src/join/JoinPage.tsx';
import { detectPlatform } from '../src/join/platform.ts';
import { NoSessionError, RouteDroppedError, relayJoinError } from '../src/join/relay.ts';
import { memoryJoinStore, pageNav } from '../src/join/store.ts';
import { JOIN_ERROR_TEXT, JOIN_TEXT } from '../src/join/strings.ts';
import { m6DevicesState } from './fakes-m6-devices.ts';
import { createAddDeviceHub, hubIdentity, joinFetch } from './fakes-m65-devices.ts';
import { activateTestLocale, expectFullyLocalized, resetTestLocale } from './i18n.ts';
import { resetDom } from './render.tsx';

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

/** Product names inside the suggested device name. */
const PRODUCTS = ['Safari', 'iPhone'];

const realAssign = pageNav.assign;
beforeEach(() => {
  pageNav.assign = vi.fn<(path: string) => void>();
});
afterEach(() => {
  pageNav.assign = realAssign;
  resetDom();
  resetTestLocale();
  window.localStorage.removeItem('nova.device.id');
  window.history.replaceState(null, '', '/');
});

async function pairing() {
  const owner = createAddDeviceHub(
    { hubKey: hubIdentity(), nextCodes: ['ABCDEFGH'] },
    m6DevicesState(),
  );
  const started = await owner.api.startAddDevice({ role: 'client' });
  const url = new URL(started.qr);
  return {
    owner,
    state: owner.state,
    search: url.search,
    hash: url.hash,
    fetch: joinFetch(owner.state),
  };
}

const apiErr = (status: number, code: string, details?: Record<string, unknown>) =>
  new ApiError(status, { code, message: `raw ${code}`, retryable: false, details });

/** `text` in an element, so the localization check can read it. */
function shown(text: string): HTMLElement {
  const p = document.createElement('p');
  p.textContent = text;
  return p;
}

describe('the joining device’s page in a pseudo-locale', () => {
  it('shows the form, the wait and the approved page localized', async () => {
    const p = await pairing();
    await activateTestLocale('en-XA');
    const { container } = render(
      <JoinPage
        fetchImpl={p.fetch}
        store={memoryJoinStore()}
        search={p.search}
        hash={p.hash}
        userAgent={IPHONE}
        poll={{ minGapMs: 20 }}
      />,
    );
    await screen.findByRole('button', { name: JOIN_TEXT.askToJoin });
    expect(screen.getByRole('textbox', { name: JOIN_TEXT.nameLabel })).toHaveProperty(
      'value',
      detectPlatform(IPHONE).name,
    );
    expectFullyLocalized(container);

    await userEvent.click(screen.getByRole('button', { name: JOIN_TEXT.askToJoin }));
    await screen.findByRole('heading', { name: JOIN_TEXT.approveTitle });
    expect(screen.getByText(JOIN_TEXT.waiting)).toBeTruthy();
    expectFullyLocalized(container, { data: PRODUCTS });

    const req = p.state.requests[0]!;
    await act(() => p.owner.api.approveAddRequest(req.view.id, req.view.confirmation));
    await screen.findByRole('heading', { name: JOIN_TEXT.addedTitle });
    expect(screen.getByText(JOIN_TEXT.iosAdd)).toBeTruthy();
    expectFullyLocalized(container);
  });

  it('says a plain-HTTP page needs a secure connection, localized', async () => {
    const p = await pairing();
    vi.stubGlobal('isSecureContext', false);
    await activateTestLocale('en-XA');
    const { container } = render(
      <JoinPage fetchImpl={p.fetch} store={memoryJoinStore()} search={p.search} hash={p.hash} />,
    );
    await screen.findByRole('heading', { name: JOIN_TEXT.insecureTitle });
    expectFullyLocalized(container);
    vi.unstubAllGlobals();
  });

  it('words every refusal in the active locale', async () => {
    await activateTestLocale('en-XA');
    const refusals = [
      apiErr(401, 'auth_missing', { reason: 'wrong_code', attemptsLeft: 3 }),
      apiErr(401, 'auth_missing', { reason: 'wrong_code', attemptsLeft: 1 }),
      apiErr(401, 'auth_missing', { reason: 'wrong_code', attemptsLeft: 0 }),
      apiErr(401, 'auth_missing', { reason: 'wrong_code' }),
      apiErr(410, 'expired'),
      apiErr(403, 'kind_not_allowed'),
      apiErr(401, 'key_revoked'),
      apiErr(409, 'key_in_use'),
      apiErr(403, 'add_device_disabled'),
      apiErr(429, 'rate_limited'),
      apiErr(401, 'auth_missing', { reason: 'bad_signature' }),
      apiErr(400, 'bad_reveal'),
      apiErr(409, 'already_revealed'),
      new RouteDroppedError(),
      new NoSessionError(),
      'odd',
    ];
    for (const err of refusals) expectFullyLocalized(shown(joinErrorMessage(err)));
    expect(joinErrorMessage(refusals[0])).toBe(JOIN_ERROR_TEXT.wrongCodeLeft({ n: 3 }));

    const relayRefusals = [
      new RelayError('invalid_code', 'x', 401),
      new RelayError('expired', 'x', 410),
      new RelayError('rate_limited', 'x', 429),
      new RelayError('relay_full', 'x', 503),
      new TypeError('Failed to fetch'),
    ];
    for (const err of relayRefusals) expectFullyLocalized(shown(relayJoinError(err).message));
    // The Relay's own words for an unknown refusal are its data.
    expectFullyLocalized(
      shown(relayJoinError(new RelayError('pairing_failed', 'no answer')).message),
      {
        data: ['no answer'],
      },
    );
  });
});
