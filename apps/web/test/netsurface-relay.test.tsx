// Network → Relay (FR-137; docs/22 §3, §3.1): the connection's state and latency, Test, the
// settings (turning it on connects the Hub out, so it asks first; the URL is checked as the Hub
// checks it; managed policy refuses), and the paired clients with Revoke, which asks first and
// says the client loses access and must pair again; an empty list leads to Add a device; live
// pairing and revocation events; unknown statuses stay readable.
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '../src/api.ts';
import { RelaySection } from '../src/netsurface/Relay.tsx';
import { FakeEventSource } from './fakes.ts';
import { relayClient, renderWithNetwork } from './fakes-m65-network.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  window.history.replaceState(null, '', '/');
});

const region = (name: string) => screen.getByRole('region', { name });
const stream = () => FakeEventSource.for('/api/v1/events/stream');

async function open(network: NonNullable<Parameters<typeof renderWithNetwork>[1]>['network'] = {}) {
  const r = await renderWithNetwork(<RelaySection />, { network });
  await screen.findByRole('heading', { name: 'Connection' });
  return r;
}

describe('the Relay (FR-137)', () => {
  it('turns the Relay on only after asking, and checks the address first', async () => {
    const { api, state } = await open();
    const conn = region('Connection');
    expect(within(conn).getByText('Off')).toBeTruthy();
    expect(within(conn).getByText('None chosen')).toBeTruthy();
    expect(within(conn).queryByRole('button', { name: 'Test' })).toBeNull();
    const settings = region('Settings');
    await userEvent.click(within(settings).getByRole('switch', { name: 'Use a Relay' }));
    await userEvent.click(within(settings).getByRole('button', { name: 'Save' }));
    expect(
      within(settings).getByText('Enter the address of your Relay, or use the hosted one.'),
    ).toBeTruthy();
    await userEvent.type(
      within(settings).getByLabelText('Relay address'),
      'ftp://relay.example.com',
    );
    await userEvent.click(within(settings).getByRole('button', { name: 'Save' }));
    expect(
      within(settings).getByText(/Enter a wss:\/\/, ws:\/\/, https:\/\/ or http:\/\/ address/),
    ).toBeTruthy();
    await userEvent.clear(within(settings).getByLabelText('Relay address'));
    await userEvent.type(
      within(settings).getByLabelText('Relay address'),
      'wss://relay.example.com',
    );
    await userEvent.click(within(settings).getByRole('button', { name: 'Save' }));
    const dialog = screen.getByRole('dialog', { name: 'Connect this Hub to the Relay?' });
    expect(dialog.textContent).toContain('wss://relay.example.com');
    expect(dialog.textContent).toContain('sees only routing ids and sealed messages');
    expect(api.updateRelay).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.updateRelay).toHaveBeenCalledWith({ enabled: true, url: 'wss://relay.example.com' });
    expect(state.relay.enabled).toBe(true);
    expect(within(region('Connection')).getByText('Connecting')).toBeTruthy();
  });

  it('uses the hosted Relay without asking for an address, and shows a managed refusal', async () => {
    const { api } = await open({ managedRelay: ['enabled'] });
    const settings = region('Settings');
    await userEvent.click(within(settings).getByRole('radio', { name: 'The hosted Relay' }));
    await userEvent.click(within(settings).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.updateRelay).toHaveBeenCalledWith({ selfHosted: false }));
    expect(within(region('Connection')).getByText('wss://relay.arialabs.ai')).toBeTruthy();
    await userEvent.click(within(settings).getByRole('switch', { name: 'Use a Relay' }));
    await userEvent.click(within(settings).getByRole('button', { name: 'Save' }));
    const dialog = screen.getByRole('dialog', { name: 'Connect this Hub to the Relay?' });
    expect(dialog.textContent).toContain('wss://relay.arialabs.ai');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Connect' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'Your organization manages this setting.',
    );
  });

  it('tests the Relay and says what it answered', async () => {
    const { network } = await open({
      relay: {
        enabled: true,
        url: 'wss://relay.example.com',
        selfHosted: true,
        effectiveUrl: 'wss://relay.example.com',
        status: {
          state: 'connected',
          detail: null,
          url: 'wss://relay.example.com',
          routeId: 'r',
          since: '2026-10-01T12:00:00.000Z',
          latencyMs: 30,
        },
        clients: { active: 0, pending: 0 },
      },
    });
    const conn = region('Connection');
    expect(within(conn).getByText('Connected')).toBeTruthy();
    expect(within(conn).getByText('30 ms')).toBeTruthy();
    await userEvent.click(within(conn).getByRole('button', { name: 'Test' }));
    expect(
      (await within(conn).findByText(/The Relay answers in 42 ms \(version 0.1.0\)/)).textContent,
    ).toContain('The Hub is connected to it.');
    network.state.relayTest = {
      ok: false,
      url: 'wss://relay.example.com',
      reachable: false,
      latencyMs: null,
      version: null,
      state: 'error',
      detail: 'the Relay answered 502',
    };
    await userEvent.click(within(conn).getByRole('button', { name: 'Test' }));
    expect((await within(conn).findByText(/The Relay does not answer/)).textContent).toContain(
      'The Relay answered 502.',
    );
    expect(within(conn).getByText('Error')).toBeTruthy();
  });

  it('lists paired clients and revokes one after saying it must pair again', async () => {
    const { api } = await open({
      relayClients: [
        relayClient({ id: 'rc1', name: 'Sam’s phone', platform: 'iOS' }),
        relayClient({
          id: 'rc2',
          name: 'Old tablet',
          status: 'revoked',
          revokedAt: '2026-10-01T12:00:00.000Z',
        }),
        relayClient({
          id: 'rc3',
          name: 'New laptop',
          kind: 'browser',
          status: 'pending',
          lastSeenAt: null,
        }),
        relayClient({ id: 'rc4', name: 'Odd one', status: 'quarantined' as 'denied' }),
      ],
    });
    const list = await screen.findByRole('list', { name: 'Paired clients' });
    const phone = within(list).getByRole('listitem', { name: 'Sam’s phone' });
    expect(within(phone).getByText('Active')).toBeTruthy();
    expect(phone.textContent).toContain('iOS');
    expect(phone.textContent).toContain('Nova app');
    expect(phone.textContent).toContain('Relay client id rc1');
    const laptop = within(list).getByRole('listitem', { name: 'New laptop' });
    expect(within(laptop).getByText('Waiting for approval')).toBeTruthy();
    expect(laptop.textContent).toContain('not seen yet');
    expect(within(list).queryByRole('listitem', { name: 'Old tablet' })).toBeNull();
    const past = screen.getByRole('list', { name: 'Revoked and denied clients' });
    expect(
      within(within(past).getByRole('listitem', { name: 'Odd one' })).getByText('quarantined'),
    ).toBeTruthy();

    await userEvent.click(within(phone).getByRole('button', { name: 'Revoke Sam’s phone' }));
    const dialog = screen.getByRole('dialog', { name: 'Revoke Sam’s phone?' });
    expect(dialog.textContent).toContain('It loses access at once');
    expect(dialog.textContent).toContain('To use it again, pair it again.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(api.revokeRelayClient).toHaveBeenCalledWith('rc1'));
    await waitFor(() =>
      expect(
        within(screen.getByRole('list', { name: 'Revoked and denied clients' })).getByRole(
          'listitem',
          { name: 'Sam’s phone' },
        ),
      ).toBeTruthy(),
    );
  });

  it('keeps a failed revoke in the dialog', async () => {
    const { network } = await open({ relayClients: [relayClient({ id: 'rc1', name: 'Phone' })] });
    network.failNext.revokeRelayClient = new ApiError(404, {
      code: 'not_found',
      message: 'no such paired client',
      retryable: false,
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Revoke Phone' }));
    const dialog = screen.getByRole('dialog', { name: 'Revoke Phone?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe('No such paired client');
  });

  it('leads to Add a device when nothing is paired, and follows pairing events', async () => {
    const { state } = await open();
    expect(
      await screen.findByRole('heading', { name: 'No clients paired through the Relay' }),
    ).toBeTruthy();
    state.relayClients = [relayClient({ id: 'rc9', name: 'Fresh phone' })];
    stream().emit('relay.client.paired', {
      clientId: 'rc9',
      deviceId: 'd9',
      name: 'Fresh phone',
      platform: 'Android',
    });
    expect(await screen.findByRole('listitem', { name: 'Fresh phone' })).toBeTruthy();
    state.relayClients = [];
    stream().emit('relay.client.revoked', { clientId: 'rc9', deviceId: 'd9' });
    await userEvent.click(await screen.findByRole('button', { name: 'Add a device' }));
    expect(window.location.pathname).toBe('/devices/add');
  });

  it('shows a load error with Retry', async () => {
    const r = await renderWithNetwork(<RelaySection />);
    await screen.findByRole('heading', { name: 'Connection' });
    r.network.failNext.getRelay = new ApiError(500, {
      code: 'server_error',
      message: 'internal error',
      retryable: true,
    });
    stream().emit('relay.status.changed', { state: 'error', detail: 'x', url: null });
    expect((await screen.findByRole('alert')).textContent).toContain('Internal error.');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });
});
