// J10 follow-ups (FR-117, FR-106, FR-049): a stopped extension says why on its card (managed
// policy with the source of the part that refuses it, a policy that cannot be read, the SDK
// switch); a command's result is shown in its own words (a line in the toast, the whole in a
// dialog, never raw JSON in a toast); the marketplace says by name what vouches for an item.
import { act, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { ManagedPolicyView, ManagedRestrict, MarketPublisher } from '@nova/shared';
import { UI_TEXT } from '@nova/ui';
import { ExtensionsPage } from '../src/extensions/ExtensionsPage.tsx';
import { RESULT_TEXT } from '../src/extensions/CommandResult.tsx';
import {
  RESULT_LINE_MAX,
  STATUS_TEXT,
  STOPPED_TEXT,
  commandResultText,
  extensionCommandKey,
  stoppedText,
} from '../src/extensions/format.ts';
import { SHELL_TEXT, ExtensionStatusBar, useExtensionShell } from '../src/extensions/shell.tsx';
import { vouchText } from '../src/market/format.ts';
import { FakeEventSource } from './fakes.ts';
import {
  PUBLISHER_KEY,
  renderWithExtensions,
  wordCount,
  type FakeBundle,
} from './fakes-m8-extensions.ts';
import { localSource, noPolicy } from './fakes-m8-managed.ts';
import { activateTestLocale, expectFullyLocalized } from './i18n.ts';
import { resetDom } from './render.tsx';

afterEach(() => resetDom());

const events = () => FakeEventSource.for('/api/v1/events/stream');
const TRUSTED = { 'plugins.trustedPublishers': [{ name: 'Example Labs', key: PUBLISHER_KEY }] };

const hello: FakeBundle = {
  id: 'com.example.hello',
  name: 'Hello',
  version: '1.0.0',
  signature: 'unverified',
  publisher: null,
  digest: '2'.repeat(64),
};

const card = (name: string) => screen.findByRole('listitem', { name: new RegExp(`^${name}`) });

/** A policy in force from one source, restricting what `restrict` says. */
function policy(
  channel: 'local' | 'test',
  restrict: ManagedRestrict,
  over: Partial<ManagedPolicyView> = {},
): ManagedPolicyView {
  return {
    ...noPolicy(),
    active: true,
    sources: [
      localSource({
        channel,
        status: 'active',
        inForce: true,
        ...(channel === 'test'
          ? { location: '/tmp/nova-demo-policy/managed-settings.json', testOverride: true }
          : {}),
      }),
    ],
    restrict: [{ channel, restrict }],
    ...over,
  };
}

/** Render the page with Hello (unverified) and Word count (verified), then apply `restrict`. */
async function stoppedBy(view: ManagedPolicyView, failClosed: string | null = null) {
  const r = await renderWithExtensions(<ExtensionsPage />, {
    settings: TRUSTED,
    bundles: [{ bundle: hello }, { bundle: wordCount() }],
    prepare: (hub) => {
      hub.state.m8managed.view = view;
    },
  });
  expect(within(await card('Hello')).getByText(STATUS_TEXT.running.text)).toBeTruthy();
  // The policy applies after the install (J10 step 2: a stricter file, "Check for changes").
  r.hub.state.managed = {
    'managed.restrict': { layers: view.restrict.map((x) => x.restrict), failClosed },
  };
  events().emit('extension.status.changed', {
    extensionId: hello.id,
    status: 'stopped',
    error: null,
  });
  await waitFor(async () =>
    expect(within(await card('Hello')).getByText(STATUS_TEXT.stopped.text)).toBeTruthy(),
  );
  return r;
}

describe('why an extension is stopped (J10 #4)', () => {
  it('says that only trusted publishers may run, and names the test policy file', async () => {
    const { ext } = await stoppedBy(policy('test', { unverifiedInstalls: false }));
    const c = await card('Hello');
    const note = within(c).getByRole('note');
    expect(note.textContent).toContain(
      'Your organization allows only extensions signed by a publisher you trust, so this unverified one is stopped.',
    );
    expect(await within(note).findByText('(test policy file)')).toBeTruthy();
    expect(note.textContent).toContain('Managed by your organization');
    // The verified one still runs, with nothing to explain.
    const w = await card('Word count');
    expect(within(w).getByText('Running')).toBeTruthy();
    expect(within(w).queryByRole('note')).toBeNull();
    // Off and on again: the Hub refuses, and the card says so in plain words.
    await userEvent.click(within(c).getByRole('switch', { name: 'Run Hello' }));
    await waitFor(() => expect(ext.setExtensionEnabled).toHaveBeenCalledTimes(1));
    await userEvent.click(within(await card('Hello')).getByRole('switch', { name: 'Run Hello' }));
    expect(
      (await screen.findAllByText(/^Managed by your organization: Installing an unverified/))
        .length,
    ).toBeGreaterThan(0);
  });

  it('says the policy file refuses this extension', async () => {
    await stoppedBy(policy('local', { extensions: { deny: ['com.example.*'] } }));
    const note = within(await card('Hello')).getByRole('note');
    expect(note.textContent).toContain(
      'Your organization’s policy does not allow this extension, so it is stopped.',
    );
    expect(await within(note).findByText('(policy file)')).toBeTruthy();
  });

  it('says every extension is stopped while the policy cannot be read', async () => {
    await stoppedBy(
      policy('local', {}, { failClosed: 'the policy file does not parse' }),
      'the policy file does not parse',
    );
    const note = within(await card('Hello')).getByRole('note');
    expect(note.textContent).toContain(
      'Your organization’s policy could not be read, so every extension is stopped until it is fixed.',
    );
    expect(within(await card('Word count')).getByText('Stopped')).toBeTruthy();
  });

  it('says the SDK switch stopped it, with no managed note', async () => {
    await renderWithExtensions(<ExtensionsPage />, {
      settings: { ...TRUSTED, 'sdk.enabled': false },
      bundles: [{ bundle: wordCount() }],
    });
    const c = await card('Word count');
    expect(within(c).getByText('Stopped')).toBeTruthy();
    expect(within(c).getByRole('note').textContent).toBe(
      'Stopped because extensions are turned off on this Hub.',
    );
  });

  it('words each reason, and keeps an older Hub’s own sentence', () => {
    expect(stoppedText({ stopped: { reason: 'sdk_off', policy: null }, error: null })).toBe(
      'Stopped because extensions are turned off on this Hub.',
    );
    expect(
      stoppedText({ stopped: { reason: 'managed', policy: 'plugins' }, error: 'The plugin …' }),
    ).toBe('Your organization’s policy does not allow this extension, so it is stopped.');
    expect(stoppedText({ stopped: null, error: 'its files changed' })).toBe(
      'Stopped: its files changed',
    );
    expect(stoppedText({ stopped: null, error: null })).toBeNull();
  });
});

// ---- what a command returned (J10 #5) ------------------------------------------------------------

describe('a command’s result', () => {
  it('is a line for the toast, or the whole of it for a dialog, never raw JSON in a toast', () => {
    const none = { line: null, full: null };
    for (const empty of [null, undefined, true, false, '', '   ', {}, []])
      expect(commandResultText(empty)).toEqual(none);
    expect(commandResultText('342 words')).toEqual({ line: '342 words', full: null });
    expect(commandResultText(1234.5)).toEqual({ line: '1,234.5', full: null });
    // The sample's command: its `text`, not "done".
    expect(commandResultText({ text: 'Hello, Ada!', greeted: 1 })).toEqual({
      line: 'Hello, Ada!',
      full: null,
    });
    expect(commandResultText({ message: 'Saved.', text: 'ignored' }).line).toBe('Saved.');
    expect(commandResultText({ saved: true, count: 3 })).toEqual({
      line: 'saved: true, count: 3',
      full: null,
    });
    expect(commandResultText(['a', 'b', 3]).line).toBe('a, b, 3');
    // Nested: no line, the formatted whole in the dialog.
    const nested = commandResultText({ notes: [{ id: 1 }] });
    expect(nested.line).toBeNull();
    expect(nested.full).toEqual({
      text: JSON.stringify({ notes: [{ id: 1 }] }, null, 2),
      json: true,
    });
    // Flat but longer than a line: the dialog too.
    expect(commandResultText({ k: 'v'.repeat(200) })).toMatchObject({
      line: null,
      full: { json: true },
    });
    // Long or multi-line text: its start in the toast, the whole in the dialog.
    const long = commandResultText('x'.repeat(300));
    expect(long.line).toHaveLength(RESULT_LINE_MAX);
    expect(long.line!.endsWith('…')).toBe(true);
    expect(long.full).toEqual({ text: 'x'.repeat(300), json: false });
    expect(commandResultText('First line\nSecond line')).toEqual({
      line: 'First line…',
      full: { text: 'First line\nSecond line', json: false },
    });
  });

  const KEY = extensionCommandKey('com.examplelabs.word-count', 'count');

  function Shell() {
    useExtensionShell();
    return <ExtensionStatusBar />;
  }

  async function runWith(result: unknown) {
    const r = await renderWithExtensions(<Shell />, { bundles: [{ bundle: wordCount() }] });
    await waitFor(() => expect(r.registry.get(KEY)).toBeTruthy());
    r.state.commandResults['com.examplelabs.word-count/count'] = { ok: true, result, error: null };
    act(() => {
      r.registry.run(KEY);
    });
    return r;
  }

  it('toasts what the command said, in its own words', async () => {
    await runWith({ text: 'Hello, Ada!', greeted: 1 });
    expect((await screen.findAllByText('Count words: Hello, Ada!')).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Show the result' })).toBeNull();
    expect(screen.queryByText('Count words: done.')).toBeNull();
  });

  it('offers a long result in a dialog, and the dialog closes', async () => {
    const text = `Report\n${'A long line of the report. '.repeat(10)}`;
    await runWith(text);
    expect((await screen.findAllByText('Count words: Report…')).length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole('button', { name: 'Show the result' }));
    const dialog = await screen.findByRole('dialog', { name: 'Result of Count words' });
    expect(within(dialog).getByRole('region', { name: 'The result' }).textContent).toBe(
      text.trim(),
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('says a nested result finished, and shows it formatted only in the dialog', async () => {
    await runWith({ notes: [{ id: 1, title: 'Tea' }] });
    expect((await screen.findAllByText('Count words finished.')).length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toContain('"notes"');
    await userEvent.click(screen.getByRole('button', { name: 'Show the result' }));
    const dialog = await screen.findByRole('dialog', { name: 'Result of Count words' });
    expect(dialog.querySelector('pre')?.textContent).toContain('"title": "Tea"');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
  });

  it('still says done when it returned nothing', async () => {
    await runWith(null);
    expect((await screen.findAllByText('Count words: done.')).length).toBeGreaterThan(0);
  });
});

// ---- what vouches for a marketplace item (J10 #6) ---------------------------------------------------

describe('what vouches for a Verified item', () => {
  const key = (name: string | null, fingerprint = '1a2b:3c4d:5e6f:7a8b'): MarketPublisher => ({
    name,
    key: PUBLISHER_KEY,
    fingerprint,
    trusted: true,
  });

  it('names the catalog, how its index is signed, and a bundle’s trusted publisher', () => {
    expect(
      vouchText({
        catalog: {
          id: 'nova-sample',
          name: 'Sample catalog',
          signedWith: 'pinned_key',
          publisher: key(null),
        },
        bundle: null,
      }),
    ).toEqual([
      'Verified: listed in Sample catalog, signed with the key this catalog pins (1a2b:3c4d:5e6f:7a8b).',
    ]);
    expect(
      vouchText({
        catalog: {
          id: 'team',
          name: 'Team catalog',
          signedWith: 'trusted_publisher',
          publisher: key('Acme'),
        },
        bundle: key('Example Labs'),
      }),
    ).toEqual([
      'Verified: listed in Team catalog, signed by Acme, a publisher you trust.',
      'Its bundle is signed by Example Labs, a publisher you trust.',
    ]);
  });
});

// ---- the new words, in the pseudo-locale (FR-016) ------------------------------------------------

describe('localized', () => {
  it('words a stopped extension and a command result in the active language', async () => {
    await activateTestLocale('en-XA');
    await stoppedBy(policy('test', { unverifiedInstalls: false }));
    const note = within(await card('Hello')).getByRole('note');
    await within(note).findByText(STOPPED_TEXT.unverified);
    expectFullyLocalized(note);
    resetDom();

    const r = await renderWithExtensions(<StatusAndShell />, {
      bundles: [{ bundle: wordCount() }],
    });
    const key = extensionCommandKey('com.examplelabs.word-count', 'count');
    await waitFor(() => expect(r.registry.get(key)).toBeTruthy());
    r.state.commandResults['com.examplelabs.word-count/count'] = {
      ok: true,
      result: { notes: [{ id: 1 }] },
      error: null,
    };
    act(() => {
      r.registry.run(key);
    });
    const toasts = await screen.findByRole('region', { name: UI_TEXT.notifications });
    await userEvent.click(
      await within(toasts).findByRole('button', { name: SHELL_TEXT.showResult }),
    );
    const dialog = await screen.findByRole('dialog', {
      name: RESULT_TEXT.title({ title: 'Count words' }),
    });
    expectFullyLocalized(dialog, { data: ['Count words'] });
    expectFullyLocalized(toasts, { data: ['Count words'] });
  });
});

function StatusAndShell() {
  useExtensionShell();
  return <ExtensionStatusBar />;
}
