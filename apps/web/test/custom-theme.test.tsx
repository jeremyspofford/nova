// A saved theme applied in full (FR-011, docs/14 §2.2): `appearance.customTheme` puts every token
// a saved theme sets (checked with the marketplace's and the SDK's plain-value rule) over its base;
// "Use" sets it, a hand change of the base theme, accent or a color stops it, removing the theme
// in use falls back to its base, managed policy locks it, and a theme whose body text fails the
// contrast minimum asks before it is used. The shell applies the look with useApplyAppearance;
// these tests mount the same hook next to the page.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { RADIUS_TOKENS, THEME_TOKENS, dark, light, type Theme } from '@nova/ui';
import {
  applyAppearance,
  bodyTextContrast,
  customLook,
  resolveAppearance,
  themeValueOk,
  type AppearanceSettings,
} from '../src/appearance.ts';
import { MarketplacePage } from '../src/market/MarketplacePage.tsx';
import { AppearancePage } from '../src/settings/AppearancePage.tsx';
import { checkTheme, exportTheme, savedTheme, themeBase } from '../src/settings/theme-file.ts';
import { useApplyAppearance } from '../src/use-appearance.ts';
import { FakeEventSource } from './fakes.ts';
import { renderWithMarket, sampleItems } from './fakes-m8-market.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  window.history.replaceState(null, '', '/');
});

/** The sample catalog's Aurora theme, as the marketplace installs it. */
const AURORA = JSON.parse(
  readFileSync(join(process.cwd(), '../../examples/catalog/themes/aurora.json'), 'utf8'),
) as Theme;

const MURKY: Theme = {
  schemaVersion: 1,
  id: 'com.example.murky',
  name: 'Murky',
  variant: 'dark',
  tokens: { '--u-bg': '#777777', '--u-text': '#888888' },
};

const ROUND: Theme = {
  schemaVersion: 1,
  id: 'com.example.round',
  name: 'Round',
  variant: 'system',
  tokens: {
    '--u-accent': '#0057b8',
    '--u-radius-md': '14px',
    '--u-radius-lg': 'url(https://evil.example/x)',
    '--u-space-4': '40px',
    '--u-dur': '2s',
    '--u-danger': 'red',
  },
  fonts: { '--u-font-ui': 'Atkinson Hyperlegible, sans-serif', '--u-font-code': 'x; } a {' },
};

const BASE: AppearanceSettings = {
  theme: 'light',
  accent: null,
  background: null,
  foreground: null,
  uiFont: null,
  codeFont: null,
  fontScale: 1,
  reducedMotion: 'system',
};

const root = () => document.documentElement.style;

describe('a saved theme token for token (units)', () => {
  it('puts every token the theme sets over its base and ignores the rest', () => {
    const look = customLook(AURORA, false);
    for (const [k, v] of Object.entries(AURORA.tokens)) expect(look.tokens[k], k).toBe(v);
    // Tokens Aurora leaves out come from the dark theme it extends.
    expect(look.tokens['--u-danger']).toBe(dark.tokens['--u-danger']);
    expect(look).toMatchObject({ id: AURORA.id, variant: 'dark', extends: 'nova.dark' });

    const round = customLook(ROUND, false);
    expect(round.variant).toBe('light');
    expect(round.tokens['--u-bg']).toBe(light.tokens['--u-bg']);
    expect(round.tokens['--u-accent']).toBe('#0057b8');
    expect(round.tokens['--u-radius-md']).toBe('14px');
    // Not a plain value, not a theme token, or not a hex color for a color role: ignored.
    expect(round.tokens['--u-radius-lg']).toBeUndefined();
    expect(round.tokens['--u-space-4']).toBeUndefined();
    expect(round.tokens['--u-dur']).toBeUndefined();
    expect(round.tokens['--u-danger']).toBe(light.tokens['--u-danger']);
    expect(round.fonts).toEqual({ '--u-font-ui': 'Atkinson Hyperlegible, sans-serif' });
    // A system theme follows the device.
    expect(customLook(ROUND, true)).toMatchObject({ variant: 'dark' });
    expect(customLook(ROUND, true).tokens['--u-bg']).toBe(dark.tokens['--u-bg']);
  });

  it('checks values with the plain-value rule, hex for color roles', () => {
    expect(themeValueOk('--u-radius-sm', '6px')).toBe(true);
    expect(themeValueOk('--u-radius-sm', '6px; color: red')).toBe(false);
    expect(themeValueOk('--u-bg', '#0b1020')).toBe(true);
    expect(themeValueOk('--u-bg', 'rgb(1, 2, 3)')).toBe(false);
    expect(themeValueOk('--u-text-md', '30px')).toBe(false);
    expect(themeValueOk('--u-bg', 3)).toBe(false);
    expect(THEME_TOKENS).toEqual(expect.arrayContaining([...RADIUS_TOKENS, '--u-focus']));
  });

  it('resolves the look: the saved theme replaces the base, overrides and fonts go on top', () => {
    const a = resolveAppearance({ ...BASE, custom: AURORA }, false);
    for (const [k, v] of Object.entries(AURORA.tokens)) expect(a.theme.tokens[k], k).toBe(v);
    expect(a.theme.variant).toBe('dark');
    expect(a.fonts['--u-font-ui']).toBeNull();
    const accent = resolveAppearance({ ...BASE, custom: AURORA, accent: '#ffd60a' }, false);
    expect(accent.theme.tokens['--u-accent']).toBe('#ffd60a');
    expect(accent.theme.tokens['--u-surface']).toBe(AURORA.tokens['--u-surface']);
    const fonts = resolveAppearance({ ...BASE, custom: ROUND }, false).fonts;
    expect(fonts['--u-font-ui']).toBe('Atkinson Hyperlegible, sans-serif');
    expect(
      resolveAppearance({ ...BASE, custom: ROUND, uiFont: 'Inter' }, false).fonts['--u-font-ui'],
    ).toBe('Inter');
    // No saved theme: the base theme as before.
    expect(resolveAppearance({ ...BASE, custom: null }, false).theme.tokens).toEqual(light.tokens);
  });

  it('applies radii and takes them back when the saved theme stops', () => {
    const el = document.createElement('div');
    applyAppearance(resolveAppearance({ ...BASE, custom: ROUND }, false), el);
    expect(el.style.getPropertyValue('--u-radius-md')).toBe('14px');
    expect(el.style.getPropertyValue('--u-font-ui')).toBe('Atkinson Hyperlegible, sans-serif');
    expect(el.dataset.theme).toBe(ROUND.id);
    applyAppearance(resolveAppearance(BASE, false), el);
    expect(el.style.getPropertyValue('--u-radius-md')).toBe('');
    expect(el.style.getPropertyValue('--u-font-ui')).toBe('');
    expect(el.style.getPropertyValue('--u-accent')).toBe(light.tokens['--u-accent']);
  });

  it('keeps what a saved theme may set, finds it by id and falls back when it is gone', () => {
    const r = checkTheme(ROUND);
    expect(r.ok && r.theme.tokens).toEqual({ '--u-accent': '#0057b8', '--u-radius-md': '14px' });
    expect(r.ok && r.ignored).toEqual([
      '--u-radius-lg',
      '--u-space-4',
      '--u-dur',
      '--u-danger',
      '--u-font-code',
    ]);
    const list = [{ ...AURORA }, { id: 'com.example.broken', tokens: 3 }];
    expect(savedTheme(AURORA.id, list)?.name).toBe('Aurora');
    expect(savedTheme('com.example.broken', list)).toBeNull();
    expect(savedTheme('com.example.gone', list)).toBeNull();
    expect(savedTheme(null, list)).toBeNull();
    expect(themeBase(AURORA)).toBe('dark');
    expect(themeBase(ROUND)).toBe('system');
    expect(themeBase({ ...ROUND, extends: 'nova.high-contrast-light' })).toBe(
      'high-contrast-light',
    );
    // Exporting the look carries the radii the saved theme set.
    const look = resolveAppearance({ ...BASE, custom: ROUND }, false);
    expect(exportTheme(look.theme, look.fonts, 'Mine', 'nova.light').tokens).toMatchObject({
      '--u-radius-md': '14px',
    });
  });

  it('checks the body text contrast alone', () => {
    expect(bodyTextContrast(customLook(AURORA, true))).toBeNull();
    expect(bodyTextContrast(customLook(MURKY, true))).toMatchObject({ minimum: 4.5 });
  });
});

/** The shell's appearance effect, mounted next to the page under test. */
function Shell() {
  useApplyAppearance(true);
  return null;
}

function renderAppearance(opts: Parameters<typeof renderWithMarket>[1] = {}) {
  return renderWithMarket(
    <>
      <Shell />
      <AppearancePage />
    </>,
    opts,
  );
}

const yours = () => screen.getByRole('list', { name: 'Your themes' });
const row = (name: string) => within(yours()).getByRole('listitem', { name });

function expectAurora() {
  for (const [k, v] of Object.entries(AURORA.tokens)) expect(root().getPropertyValue(k), k).toBe(v);
  expect(root().getPropertyValue('--u-danger')).toBe(dark.tokens['--u-danger']);
  expect(document.documentElement.dataset.theme).toBe(AURORA.id);
}

describe('Settings → Appearance: using a saved theme (FR-011)', () => {
  it('Use applies every token; a hand change of the theme stops it', async () => {
    const { hub } = await renderAppearance({
      settings: {
        'appearance.theme': 'light',
        'appearance.accent': '#ff0000',
        'appearance.background': '#fafafa',
        'appearance.customThemes': [AURORA, MURKY],
      },
    });
    await userEvent.click(within(row('Aurora')).getByRole('button', { name: 'Use Aurora' }));
    expect(await screen.findByText('Using Aurora.')).toBeTruthy();
    expect(hub.state.settings).toMatchObject({
      'appearance.customTheme': AURORA.id,
      'appearance.theme': 'dark',
      'appearance.accent': null,
      'appearance.background': null,
    });
    await waitFor(expectAurora);
    expect(within(row('Aurora')).getByText('In use')).toBeTruthy();
    const status = screen.getByRole('group', { name: 'Saved theme in use' });
    expect(status.textContent).toContain(
      'Using Aurora, one of your saved themes, with every color it sets. Choosing a theme, accent, background or text color here stops using it.',
    );
    // The accent field starts from Aurora's accent.
    expect(screen.getByLabelText<HTMLInputElement>('Accent').value).toBe('#7ee0c3');

    await userEvent.click(screen.getByRole('radio', { name: 'Light' }));
    await waitFor(() => expect(hub.state.settings['appearance.customTheme']).toBeNull());
    expect(hub.state.settings['appearance.theme']).toBe('light');
    await waitFor(() => expect(root().getPropertyValue('--u-bg')).toBe(light.tokens['--u-bg']));
    expect(screen.queryByRole('group', { name: 'Saved theme in use' })).toBeNull();
    expect(within(row('Aurora')).queryByText('In use')).toBeNull();
  });

  it('a hand change of a color stops it too, and Stop using goes back to the base', async () => {
    const { hub } = await renderAppearance({
      settings: { 'appearance.customThemes': [AURORA], 'appearance.customTheme': AURORA.id },
    });
    await waitFor(expectAurora);
    await userEvent.click(screen.getByRole('button', { name: 'Stop using Aurora' }));
    expect(await screen.findByText('Stopped using Aurora.')).toBeTruthy();
    // Focus stays on the theme choice (the base setting here is the default, System).
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'System' }));
    expect(hub.state.settings['appearance.customTheme']).toBeNull();
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('nova.dark'));

    await userEvent.click(within(row('Aurora')).getByRole('button', { name: 'Use Aurora' }));
    await waitFor(expectAurora);
    const accent = screen.getByRole('textbox', { name: 'Accent hex value' });
    await userEvent.clear(accent);
    await userEvent.type(accent, '#ffd60a{Enter}');
    await waitFor(() => expect(hub.state.settings['appearance.customTheme']).toBeNull());
    expect(hub.state.settings['appearance.accent']).toBe('#ffd60a');
    await waitFor(() => expect(root().getPropertyValue('--u-accent')).toBe('#ffd60a'));
    expect(root().getPropertyValue('--u-surface')).toBe(dark.tokens['--u-surface']);
  });

  it('removing the theme in use falls back to its base theme', async () => {
    const { hub } = await renderAppearance({
      settings: {
        'appearance.theme': 'light',
        'appearance.customThemes': [AURORA],
        'appearance.customTheme': AURORA.id,
      },
    });
    await waitFor(expectAurora);
    await userEvent.click(within(row('Aurora')).getByRole('button', { name: 'Remove Aurora' }));
    expect(await screen.findByText('Aurora removed. Its base theme is used now.')).toBeTruthy();
    expect(hub.state.settings).toMatchObject({
      'appearance.customThemes': [],
      'appearance.customTheme': null,
      'appearance.theme': 'dark',
    });
    await waitFor(() => expect(root().getPropertyValue('--u-bg')).toBe(dark.tokens['--u-bg']));
    expect(document.documentElement.dataset.theme).toBe('nova.dark');
  });

  it('an id no longer saved falls back to the base theme and says so', async () => {
    await renderAppearance({
      settings: {
        'appearance.theme': 'light',
        'appearance.customThemes': [],
        'appearance.customTheme': 'com.example.gone',
      },
    });
    expect(
      await screen.findByText(
        'The saved theme you chose is no longer in your themes, so its base theme is used.',
      ),
    ).toBeTruthy();
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('nova.light'));
  });

  it('warns before using a theme whose body text fails the contrast minimum', async () => {
    const { hub } = await renderAppearance({
      settings: { 'appearance.customThemes': [AURORA, MURKY] },
    });
    const use = within(row('Murky')).getByRole('button', { name: 'Use Murky' });
    await userEvent.click(use);
    let dialog = await screen.findByRole('dialog', { name: 'Use Murky?' });
    expect(dialog.textContent).toMatch(
      /Text in Murky has a contrast of 1\.\d:1 against its background, below the 4\.5:1 minimum for readable text\./,
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(use);
    expect(hub.state.settings['appearance.customTheme']).toBeUndefined();

    await userEvent.click(use);
    dialog = await screen.findByRole('dialog', { name: 'Use Murky?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Use anyway' }));
    expect(await screen.findByText('Using Murky.')).toBeTruthy();
    expect(hub.state.settings['appearance.customTheme']).toBe(MURKY.id);
    await waitFor(() => expect(root().getPropertyValue('--u-text')).toBe('#888888'));
    // A theme that passes is used without asking.
    await userEvent.click(within(row('Aurora')).getByRole('button', { name: 'Use Aurora' }));
    expect(await screen.findByText('Using Aurora.')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('managed policy locks it: Use is disabled, and managed overrides are left alone', async () => {
    await renderAppearance({
      settings: { 'appearance.customThemes': [AURORA] },
      managed: { 'appearance.customTheme': null },
    });
    expect(
      within(row('Aurora')).getByRole<HTMLButtonElement>('button', { name: 'Use Aurora' }),
    ).toHaveProperty('disabled', true);
    expect(within(yours().parentElement!).getByText('Managed by your organization')).toBeTruthy();
    resetDom();

    const { hub } = await renderAppearance({
      settings: { 'appearance.customThemes': [AURORA] },
      managed: { 'appearance.accent': '#3451d1' },
    });
    await userEvent.click(within(row('Aurora')).getByRole('button', { name: 'Use Aurora' }));
    expect(
      await screen.findByText('Using Aurora, except settings your organization manages.'),
    ).toBeTruthy();
    expect(hub.state.settings['appearance.customTheme']).toBe(AURORA.id);
    // The managed accent still goes on top of the saved theme.
    await waitFor(() => expect(root().getPropertyValue('--u-accent')).toBe('#3451d1'));
    expect(root().getPropertyValue('--u-surface')).toBe(AURORA.tokens['--u-surface']);
  });
});

describe('the marketplace Aurora theme (FR-049, FR-011)', () => {
  it('applies in full after it is installed', async () => {
    window.history.replaceState(null, '', '/marketplace/themes');
    const items = sampleItems().map((i) =>
      i.detail.id === AURORA.id ? { ...i, details: { theme: AURORA }, theme: { ...AURORA } } : i,
    );
    const { hub } = await renderWithMarket(
      <>
        <Shell />
        <MarketplacePage tab="themes" />
        <AppearancePage />
      </>,
      { market: { items } },
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Install Aurora' }));
    const dialog = await screen.findByRole('dialog', { name: 'Install Aurora 1.0.0?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Install' }));
    await waitFor(() => expect(hub.state.settings['appearance.customThemes']).toEqual([AURORA]));
    // The Hub's settings writer says so, and the settings store reloads.
    FakeEventSource.for('/api/v1/events/stream').emit('settings.changed', {
      key: 'appearance.customThemes',
      scope: 'global',
    });
    // Installing does not change the look; using it applies every token.
    expect(document.documentElement.dataset.theme).not.toBe(AURORA.id);
    const list = await screen.findByRole('list', { name: 'Your themes' });
    await userEvent.click(within(list).getByRole('button', { name: 'Use Aurora' }));
    expect(await screen.findByText('Using Aurora.')).toBeTruthy();
    await waitFor(expectAurora);
  });
});
