// The settings store follows the Hub (docs/14 §1): a setting another page or device changes
// through its own route (the Relay area writes `relay.enabled`) arrives as `settings.changed` and
// the store reloads, so a page reading it (Add a device's "Through the Relay") updates without a
// reload of the app.
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ServicesProvider } from '../src/services.tsx';
import { SettingsProvider, useSetting } from '../src/settings.tsx';
import { FakeEventSource, createHub, fakeEventSource, testRegistry } from './fakes.ts';
import { resetDom } from './render.tsx';

afterEach(resetDom);

function RelayFlag() {
  const relay = useSetting('relay.enabled');
  return <p>relay {relay.value ? 'on' : 'off'}</p>;
}

describe('SettingsProvider', () => {
  it('reloads when the Hub announces a settings change', async () => {
    const hub = createHub();
    const { settings } = await hub.api.settings();
    render(
      <ServicesProvider api={hub.api} eventSource={fakeEventSource} registry={testRegistry()}>
        <SettingsProvider api={hub.api} initial={settings}>
          <RelayFlag />
        </SettingsProvider>
      </ServicesProvider>,
    );
    expect(screen.getByText('relay off')).toBeTruthy();
    // Another route (PATCH /api/v1/relay) turns the Relay on and the Hub says so.
    hub.state.settings = { ...hub.state.settings, 'relay.enabled': true };
    FakeEventSource.for('/api/v1/events/stream').emit('settings.changed', {
      key: 'relay.enabled',
      scope: 'global',
    });
    expect(await screen.findByText('relay on')).toBeTruthy();
  });
});
