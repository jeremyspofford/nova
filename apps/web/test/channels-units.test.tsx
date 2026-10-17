// The channels client's routes match the Hub's (apps/hub/src/channels.ts), the helpers make
// secrets long enough for the Hub's schemas, and Copy works with and without a clipboard.
import { screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { attempt, channelsApi } from '../src/channels/api.ts';
import {
  absoluteUrl,
  eventDetail,
  formatStamp,
  issueErrors,
  publicBase,
  randomSecret,
  sentence,
} from '../src/channels/format.ts';
import { CopyValue } from '../src/channels/parts.tsx';
import { renderWithChannels, triggerEventView } from './fakes-m6-channels.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('channelsApi routes', () => {
  it('calls the Hub’s routes with the right methods and bodies', async () => {
    const calls: [string, string, unknown][] = [];
    const api = channelsApi(<T,>(method: string, path: string, body?: unknown) => {
      calls.push([method, path, body]);
      return Promise.resolve({} as T);
    });
    await api.listChannels();
    await api.listChannels({ agentId: 'a 1' });
    await api.createChannel({ kind: 'inapp' });
    await api.getChannel('c/1');
    await api.updateChannel('c1', { label: 'x' });
    await api.deleteChannel('c1');
    await api.connectChannel('c1');
    await api.disconnectChannel('c1');
    await api.testChannel('c1');
    await api.listChannelIdentities();
    await api.addChannelIdentity({ kind: 'slack', externalId: 'U1' });
    await api.removeChannelIdentity('i1');
    await api.listChannelAgents();
    await api.listTriggers();
    await api.createTrigger({ kind: 'email', instructions: 'x', mailbox: 'm', label: 'l' });
    await api.getTrigger('t1');
    await api.updateTrigger('t1', { enabled: false });
    await api.deleteTrigger('t1');
    await api.listTriggerEvents('t1');
    await api.listMcpSubscriptions();
    await api.createMcpSubscription({ instructions: 'x', serverId: 's1', event: 'e' });
    await api.getMcpSubscription('s1');
    await api.deleteMcpSubscription('s1');
    await api.listMcpEventSources();
    await api.listNotificationRules();
    await api.setNotificationRule('error', { inapp: true, os: false });
    await api.resetNotificationRule('error');
    await api.getQuietHours();
    await api.setQuietHours({ enabled: false, start: '22:00', end: '07:00', timezone: 'UTC' });
    expect(calls.map(([m, p]) => `${m} ${p}`)).toEqual([
      'GET /api/v1/channels',
      'GET /api/v1/channels?agentId=a%201',
      'POST /api/v1/channels',
      'GET /api/v1/channels/c%2F1',
      'PATCH /api/v1/channels/c1',
      'DELETE /api/v1/channels/c1',
      'POST /api/v1/channels/c1/connect',
      'POST /api/v1/channels/c1/disconnect',
      'POST /api/v1/channels/c1/test',
      'GET /api/v1/channel-identities',
      'POST /api/v1/channel-identities',
      'DELETE /api/v1/channel-identities/i1',
      'GET /api/v1/agents',
      'GET /api/v1/triggers',
      'POST /api/v1/triggers',
      'GET /api/v1/triggers/t1',
      'PATCH /api/v1/triggers/t1',
      'DELETE /api/v1/triggers/t1',
      'GET /api/v1/triggers/t1/events?limit=50',
      'GET /api/v1/mcp/subscriptions',
      'POST /api/v1/mcp/subscriptions',
      'GET /api/v1/mcp/subscriptions/s1',
      'DELETE /api/v1/mcp/subscriptions/s1',
      'GET /api/v1/mcp/event-sources',
      'GET /api/v1/notification-rules',
      'PUT /api/v1/notification-rules/error',
      'DELETE /api/v1/notification-rules/error',
      'GET /api/v1/quiet-hours',
      'PUT /api/v1/quiet-hours',
    ]);
    // Connect and disconnect send an empty body (the Hub accepts only `{}` or none).
    expect(calls[6]![2]).toEqual({});
    expect(calls[8]![2]).toEqual({});
  });

  it('turns a missing call into a rejection', async () => {
    const missing = {} as { list: () => Promise<number> };
    await expect(attempt(() => missing.list())).rejects.toThrow(TypeError);
    await expect(attempt(() => Promise.resolve(3))).resolves.toBe(3);
  });
});

describe('format helpers', () => {
  it('makes secrets the Hub accepts', () => {
    const token = randomSecret(24);
    const secret = randomSecret(32);
    expect(token.length).toBeGreaterThanOrEqual(24);
    expect(secret.length).toBeGreaterThanOrEqual(32);
    expect(secret).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(randomSecret(32)).not.toBe(secret);
  });

  it('builds addresses from the public address or this page', () => {
    expect(publicBase('https://nova.example.com/')).toBe('https://nova.example.com');
    expect(publicBase(null)).toBe(window.location.origin);
    expect(absoluteUrl('/api/v1/x', 'https://h.example')).toBe('https://h.example/api/v1/x');
  });

  it('words errors, details and times plainly', () => {
    expect(sentence('too short')).toBe('Too short.');
    expect(sentence('Done!')).toBe('Done!');
    expect(sentence('  ')).toBe('');
    expect(
      issueErrors([
        { path: ['config', 'appId'], message: 'required' },
        { path: ['config', 'appId'], message: 'second' },
        { path: [], message: 'nothing to update' },
      ]),
    ).toEqual({ 'config.appId': 'Required.', _: 'Nothing to update.' });
    expect(eventDetail(triggerEventView({ detail: 'disabled' }))).toBe('The trigger was off.');
    expect(eventDetail(triggerEventView({ detail: null }))).toBeNull();
    expect(formatStamp(null)).toBe('never');
    expect(formatStamp('nope')).toBe('unknown');
  });
});

describe('CopyValue', () => {
  it('copies to the clipboard', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    await renderWithChannels(<CopyValue label="Inbound address" value="https://h/x" />);
    await userEvent.click(screen.getByRole('button', { name: 'Copy inbound address' }));
    expect(writeText).toHaveBeenCalledWith('https://h/x');
    expect(await screen.findByText('Inbound address copied.')).toBeTruthy();
  });

  it('selects the value when there is no clipboard', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined });
    await renderWithChannels(<CopyValue label="Signing secret" value="s3cret" secret />);
    await userEvent.click(screen.getByRole('button', { name: 'Copy signing secret' }));
    expect(await screen.findByText(/Could not copy. The signing secret is selected/)).toBeTruthy();
    expect(window.getSelection()?.toString()).toBe('s3cret');
  });
});
