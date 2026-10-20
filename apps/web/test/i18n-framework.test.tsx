import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { defineMessages, getLocale } from '@nova/i18n';
import { ApiError } from '../src/api.ts';
import { LANGUAGE_TEXT, LOCALES, resolveLocale } from '../src/i18n/locales.ts';
import { DONE_ONBOARDING, createHub } from './fakes.ts';
import { renderApp, resetDom } from './render.tsx';
import { expectFullyLocalized, findUnlocalized, renderInLocale, resetTestLocale } from './i18n.ts';

afterEach(() => {
  resetDom();
  resetTestLocale();
});

const T = defineMessages('test.i18nHelper', {
  title: 'Recent work',
  count: '{n, plural, one {# run} other {# runs}}',
  owner: 'Started by {name}',
});

function Screen({ literal }: { literal?: string }) {
  return (
    <section aria-label={T.title}>
      <h2>{T.title}</h2>
      <p>{T.count({ n: 3 })}</p>
      <p>{T.owner({ name: 'Pat Doe' })}</p>
      <kbd aria-label="Ctrl plus K">Ctrl+K</kbd>
      <span translate="no">Nova Hub v4</span>
      <a href="https://example.com/docs">https://example.com/docs</a>
      <code>ext:acme/hello</code>
      <span>mcp:files/read · 42 · Nova</span>
      {literal ? <button title={literal}>{literal}</button> : null}
    </section>
  );
}

describe('the localization test helpers', () => {
  it('passes a screen whose text all comes from messages, allowing data, ids, URLs and code', async () => {
    const { container } = await renderInLocale('en-XA', <Screen />);
    expect(document.documentElement.lang).toBe('en-XA');
    expect(screen.getByRole('heading').textContent).toMatch(/^\[Ŕéçéñţ ŵöŕķ .*\]$/);
    expectFullyLocalized(container, { data: ['Pat Doe'] });
  });

  it('lists every text and accessible name that skipped messages', async () => {
    const { container } = await renderInLocale('en-XA', <Screen literal="Save changes" />);
    expect(findUnlocalized(container, { data: ['Pat Doe'] })).toEqual([
      'text "Save changes" in <button>',
      'title "Save changes" on <button>',
    ]);
    // Fixture data not declared is a miss too.
    expect(findUnlocalized(container).filter((m) => m.includes('Pat Doe'))).toHaveLength(1);
    expect(() => expectFullyLocalized(container, { data: ['Pat Doe'] })).toThrow(/Save changes/);
  });

  it('skips regions by selector', async () => {
    const { container } = await renderInLocale(
      'en-XA',
      <div>
        <div className="other-area">Not converted yet</div>
      </div>,
    );
    expect(findUnlocalized(container)).toHaveLength(1);
    expectFullyLocalized(container, { skip: ['.other-area'] });
  });

  it('accepts the right-to-left pseudo-locale and sets the direction', async () => {
    const { container } = await renderInLocale('ar-XB', <Screen />);
    expect(document.documentElement.dir).toBe('rtl');
    expectFullyLocalized(container, { data: ['Pat Doe'] });
  });
});

describe('choosing the locale', () => {
  it('resolves system from the device languages, never to a pseudo-locale', () => {
    expect(resolveLocale('system', ['en-US', 'en'])).toBe('en');
    expect(resolveLocale('system', ['ar-EG', 'en'])).toBe('ar');
    expect(resolveLocale('system', ['fr-FR', 'de'])).toBe('en');
    expect(resolveLocale('system', ['en-XA'])).toBe('en');
    expect(resolveLocale('ar-XB', ['en'])).toBe('ar-XB');
    expect(resolveLocale('xx', ['ar'])).toBe('ar');
    expect(LOCALES.find((l) => l.tag === 'ar')).toMatchObject({ partial: true });
  });

  it('follows the appearance.locale setting: Arabic loads its catalog and turns the page right to left', async () => {
    const hub = createHub({
      settings: { 'onboarding.state': DONE_ONBOARDING, 'appearance.locale': 'ar' },
    });
    await renderApp({ hub, ready: false });
    const nav = await screen.findByRole('navigation', { name: 'الشريط الجانبي' });
    expect(document.documentElement.lang).toBe('ar');
    expect(document.documentElement.dir).toBe('rtl');
    // The shell's words come from the Arabic catalog (English fills any gap; see @nova/i18n).
    expect(within(nav).getByRole('button', { name: /محادثة جديدة/ })).toBeTruthy();
    expect(within(nav).getByRole('link', { name: /المكتبة/ })).toBeTruthy();
  });

  it('switches language from Settings → Appearance and remounts the shell in it', async () => {
    const hub = createHub();
    await renderApp({ hub, path: '/settings/appearance' });
    // System is listed with the device's language.
    expect(screen.getByRole('radio', { name: 'System (English)' })).toBeTruthy();
    const testing = screen.getByRole('group', { name: 'For testing' });
    await userEvent.click(within(testing).getByRole('radio', { name: /ar-XB/ }));
    await waitFor(() => expect(getLocale()).toBe('ar-XB'));
    expect(hub.api.setSetting).toHaveBeenCalledWith('appearance.locale', 'ar-XB');
    expect(document.documentElement.dir).toBe('rtl');
    // The shell re-rendered in the new locale: its sidebar label is mirrored now.
    const nav = await screen.findByRole('navigation', { name: /Sidebar/ });
    expect(nav.getAttribute('aria-label')).not.toBe('Sidebar');
    expect(localStorage.getItem('nova.locale')).toBe('ar-XB');
  });

  it('puts focus back on the chosen language after the remount, and says so in it (WCAG 3.2.2)', async () => {
    const hub = createHub();
    await renderApp({ hub, path: '/settings/appearance' });
    const testing = screen.getByRole('group', { name: 'For testing' });
    const before = within(testing).getByRole('radio', { name: /ar-XB/ });
    await userEvent.click(before);
    await waitFor(() => expect(getLocale()).toBe('ar-XB'));
    // A new picker (the shell remounted), with focus on the option chosen.
    await waitFor(() => {
      const now = document.activeElement as HTMLInputElement;
      expect(now).not.toBe(before);
      expect(now.isConnected && now.type === 'radio' && now.value).toBe('ar-XB');
    });
    // Said in the new language, through the live region that outlives the remount.
    expect(screen.getByTestId('announcer').textContent).toContain(
      LANGUAGE_TEXT.changed({ name: 'Ŕîĝĥţ-ţö-ļéƒţ (ar-XB)' }),
    );
  });

  it('keeps focus on the language in force when the Hub refuses the change', async () => {
    const hub = createHub();
    hub.state.failNext.setSetting = new ApiError(500, {
      code: 'internal',
      message: 'disk full',
      retryable: true,
    });
    await renderApp({ hub, path: '/settings/appearance' });
    const testing = screen.getByRole('group', { name: 'For testing' });
    await userEvent.click(within(testing).getByRole('radio', { name: /en-XA/ }));
    expect((await screen.findAllByText(/Could not change the language/)).length).toBeGreaterThan(0);
    await waitFor(() => expect(getLocale()).toBe('en'));
    await waitFor(() => {
      const now = document.activeElement as HTMLInputElement;
      expect(now.isConnected && now.type === 'radio' && now.value).toBe('system');
    });
    // Nothing said a change that did not happen (in either language: the name is the same).
    expect(screen.getByTestId('announcer').textContent).not.toContain('Ëñĝļîšĥ (en-XA)');
  });
});

describe('the Arabic draft', () => {
  // The areas the Arabic draft covers in full (D9): the shell, the command palette and commands,
  // the language picker, onboarding, the pane layout, the app's own screens and packages/ui.
  const FULL = [
    'shell',
    'shell.modes',
    'shell.sidebar',
    'shell.commands',
    'commands.category',
    'workspaceCommands',
    'palette',
    'i18n.language',
    'onboarding',
    'layout',
    'app',
    'app.stores',
    'app.contrast',
    'ui',
    'ui.keys',
  ];

  it('translates every message of the areas it covers', () => {
    const dir = join(import.meta.dirname, '../src/i18n');
    const english = JSON.parse(readFileSync(join(dir, 'catalog.en.json'), 'utf8')) as Record<
      string,
      string
    >;
    const missing: string[] = [];
    for (const ns of FULL) {
      const arabic = JSON.parse(
        readFileSync(join(dir, 'locales', 'ar', `${ns}.json`), 'utf8'),
      ) as Record<string, string>;
      // Ids of this namespace that no longer (more specific) namespace in the list owns.
      const longer = FULL.filter((o) => o.startsWith(`${ns}.`));
      for (const id of Object.keys(english)) {
        if (!id.startsWith(`${ns}.`) || longer.some((o) => id.startsWith(`${o}.`))) continue;
        if (!(id.slice(ns.length + 1) in arabic)) missing.push(id);
      }
    }
    expect(missing).toEqual([]);
  });
});
