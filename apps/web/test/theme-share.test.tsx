import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { dark, light, type Theme } from '@nova/ui';
import { deepLinkPath } from '../src/deeplinks.ts';
import {
  checkTheme,
  exportTheme,
  readTheme,
  storedThemes,
  themeContrast,
  themeData,
  themeIdFor,
  themeLink,
  themeSettings,
} from '../src/settings/theme-file.ts';
import { DONE_ONBOARDING, createHub } from './fakes.ts';
import { renderApp, resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  vi.restoreAllMocks();
});

const SUNRISE: Theme = {
  schemaVersion: 1,
  id: 'com.example.sunrise',
  name: 'Sunrise',
  variant: 'light',
  tokens: { '--u-bg': '#fff8f0', '--u-accent': '#b34700', '--u-text': '#201810' },
  fonts: { '--u-font-ui': 'Inter, sans-serif' },
};

describe('theme files (FR-011, contracts/schemas/theme.json)', () => {
  it('accepts a valid theme and drops what Nova does not apply', () => {
    const r = checkTheme({
      ...SUNRISE,
      extends: 'nova.light',
      tokens: {
        ...SUNRISE.tokens,
        '--u-radius-sm': '4px',
        '--u-danger': 'red; background: url(x)',
        '--u-info': '#ABCDEF',
      },
      fonts: {
        '--u-font-ui': 'Inter, sans-serif',
        '--u-font-code': 'x; } body { color: red',
        '--u-font-extra': 'Serif',
      },
    });
    expect(r).toEqual({
      ok: true,
      theme: {
        schemaVersion: 1,
        id: 'com.example.sunrise',
        name: 'Sunrise',
        variant: 'light',
        extends: 'nova.light',
        tokens: {
          '--u-bg': '#fff8f0',
          '--u-accent': '#b34700',
          '--u-text': '#201810',
          '--u-info': '#abcdef',
        },
        fonts: { '--u-font-ui': 'Inter, sans-serif' },
      },
      ignored: ['--u-radius-sm', '--u-danger', '--u-font-code', '--u-font-extra'],
    });
    const unknownBase = checkTheme({ ...SUNRISE, extends: 'solarized' });
    expect(unknownBase.ok && unknownBase.ignored).toEqual(['extends']);
    expect(unknownBase.ok && unknownBase.theme.extends).toBeUndefined();
  });

  it('rejects what the schema forbids, with every reason', () => {
    expect(checkTheme([])).toEqual({ ok: false, errors: ['A theme is a JSON object.'] });
    const r = checkTheme({
      schemaVersion: 2,
      id: 'Bad Id',
      name: '',
      variant: 'sepia',
      extends: 3,
      tokens: { color: '#fff', '--u-bg': 5 },
      fonts: { '--u-x': 'Serif', '--u-font-ui': 1 },
      script: 'alert(1)',
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors).toEqual([
      'Unknown field “script”.',
      'schemaVersion must be 1.',
      'id must be lowercase words joined by dots, like com.example.midnight.',
      'name must be 1 to 100 characters.',
      'variant must be light, dark or system.',
      'extends must be the id of a built-in theme.',
      'Token “color” must start with --u-.',
      'Token --u-bg must be a string.',
      'Font “--u-x” must start with --u-font-.',
      'Font --u-font-ui must be a string.',
    ]);
    expect(checkTheme({ ...SUNRISE, tokens: undefined })).toEqual({
      ok: false,
      errors: ['tokens must be an object of CSS variables.'],
    });
    expect(checkTheme({ ...SUNRISE, fonts: 'Serif' })).toEqual({
      ok: false,
      errors: ['fonts must be an object.'],
    });
  });

  it('round-trips through a link, raw JSON and bare data, and refuses other text', () => {
    const link = themeLink(SUNRISE);
    expect(link).toMatch(/^nova:\/\/theme\?data=[A-Za-z0-9_-]+$/);
    expect(readTheme(link)).toEqual({ ok: true, theme: SUNRISE, ignored: [] });
    expect(readTheme(`web+nova://theme?data=${themeData(SUNRISE)}`).ok).toBe(true);
    expect(readTheme(themeData(SUNRISE)).ok).toBe(true);
    expect(readTheme(JSON.stringify(SUNRISE)).ok).toBe(true);
    // Standard base64 whose `+` arrived as a space.
    const std = btoa(JSON.stringify({ ...SUNRISE, name: 'Sunrise ~~~ >>>' }));
    expect(readTheme(`nova://theme?data=${std.replace(/\+/g, ' ')}`).ok).toBe(true);
    // Non-ASCII names survive.
    const named = { ...SUNRISE, name: 'Aurore boréale' };
    expect(readTheme(themeLink(named))).toMatchObject({
      ok: true,
      theme: { name: 'Aurore boréale' },
    });
    expect(readTheme('')).toEqual({ ok: false, errors: ['Paste a theme link or theme JSON.'] });
    expect(readTheme('nova://chat/abc')).toEqual({
      ok: false,
      errors: ['That link is not a theme link.'],
    });
    expect(readTheme('nova://theme?nodata=1')).toEqual({
      ok: false,
      errors: ['That link does not contain a theme.'],
    });
    expect(readTheme('nova://theme?data=***')).toEqual({
      ok: false,
      errors: ['That link does not contain a theme.'],
    });
    expect(readTheme(`nova://theme?data=${btoa('not json')}`)).toEqual({
      ok: false,
      errors: ['That is not valid JSON.'],
    });
    expect(readTheme('{ broken')).toEqual({ ok: false, errors: ['That is not valid JSON.'] });
  });

  it('exports the current look, maps a theme to settings and checks contrast', () => {
    const t = exportTheme(
      { ...dark, tokens: { ...dark.tokens, '--u-accent': '#ff8800', '--u-radius-sm': '6px' } },
      { '--u-font-ui': 'Inter', '--u-font-code': null },
      '  Night Shift! ',
      'nova.dark',
    );
    expect(t).toMatchObject({
      id: 'user.night-shift',
      name: 'Night Shift!',
      variant: 'dark',
      extends: 'nova.dark',
      fonts: { '--u-font-ui': 'Inter' },
    });
    expect(Object.keys(t.tokens)).not.toContain('--u-radius-sm');
    expect(checkTheme(t).ok).toBe(true);
    expect(themeIdFor('!!!')).toBe('user.theme');
    expect(themeSettings(t, true)).toEqual({
      base: 'dark',
      accent: '#ff8800',
      background: null,
      foreground: null,
      uiFont: 'Inter',
      codeFont: null,
    });
    expect(themeSettings(SUNRISE, false)).toEqual({
      base: 'light',
      accent: '#b34700',
      background: '#fff8f0',
      foreground: '#201810',
      uiFont: 'Inter, sans-serif',
      codeFont: null,
    });
    expect(themeContrast(SUNRISE, false)).toEqual([]);
    const murky = { ...SUNRISE, tokens: { '--u-bg': '#777777', '--u-text': '#888888' } };
    expect(themeContrast(murky, false).map((w) => w.pair)).toContain('Text on background');
    expect(themeContrast({ ...SUNRISE, variant: 'system', tokens: {} }, true)).toEqual([]);
    expect(themeContrast({ ...SUNRISE, variant: 'system', tokens: {} }, false)).toEqual([]);
    expect(storedThemes([{ ...SUNRISE }, { bogus: true }]).map((x) => x.id)).toEqual([
      'com.example.sunrise',
    ]);
    expect(light.id).toBe('nova.light');
  });

  it('maps nova://theme links to Appearance and refuses bad ones', () => {
    const data = themeData(SUNRISE);
    expect(deepLinkPath(`nova://theme?data=${data}`)).toBe(`/settings/appearance?theme=${data}`);
    expect(deepLinkPath('nova://theme?data=ab+c/d=')).toBe(
      '/settings/appearance?theme=ab%2Bc%2Fd%3D',
    );
    expect(deepLinkPath('nova://theme?data=ab c')).toBe('/settings/appearance?theme=ab%2Bc');
    expect(deepLinkPath('nova://theme')).toBeNull();
    expect(deepLinkPath('nova://theme?data=<script>')).toBeNull();
    expect(deepLinkPath(`nova://theme/x?data=${data}`)).toBeNull();
    expect(deepLinkPath(`nova://theme?data=${'a'.repeat(44_001)}`)).toBeNull();
  });
});

describe('Settings → Appearance: theme import and export (FR-011)', () => {
  it('exports the current look as a link and a file, imports it back and uses it', async () => {
    const hub = createHub({
      settings: { 'onboarding.state': DONE_ONBOARDING, 'appearance.accent': '#ff8800' },
    });
    await renderApp({ hub, path: '/settings/appearance' });
    const region = await screen.findByRole('region', { name: 'Themes' });
    const name = within(region).getByRole('textbox', { name: 'Theme name' });
    await userEvent.clear(name);
    await userEvent.type(name, 'Ember');
    const link = within(region).getByLabelText('Theme link').textContent ?? '';
    expect(link).toMatch(/^nova:\/\/theme\?data=/);
    const exported = readTheme(link);
    expect(exported).toMatchObject({
      ok: true,
      theme: { id: 'user.ember', name: 'Ember', variant: 'dark', extends: 'nova.dark' },
    });
    expect(exported.ok && exported.theme.tokens['--u-accent']).toBe('#ff8800');

    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await userEvent.click(within(region).getByRole('button', { name: 'Copy theme link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(link));
    expect(await screen.findByText('Theme link copied.')).toBeTruthy();

    const create = vi.fn(() => 'blob:theme');
    const revoke = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { value: create, configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: revoke, configurable: true });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    await userEvent.click(within(region).getByRole('button', { name: 'Download theme file' }));
    expect(create).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Theme file downloaded.')).toBeTruthy();

    // Now reset the accent and import the link back.
    hub.state.settings['appearance.accent'] = null;
    await userEvent.click(
      within(region).getByRole('textbox', { name: 'Theme link or theme JSON' }),
    );
    await userEvent.paste(link);
    await userEvent.click(within(region).getByRole('button', { name: 'Check theme' }));
    const preview = within(region).getByRole('group', { name: 'Theme to import' });
    expect(within(preview).getByText('Ember')).toBeTruthy();
    expect(within(preview).getByText('Contrast meets the minimums.')).toBeTruthy();
    await userEvent.click(within(preview).getByRole('button', { name: 'Save and use' }));
    expect(await screen.findByText('Using Ember.')).toBeTruthy();
    expect(hub.state.settings['appearance.customThemes']).toEqual([
      expect.objectContaining({ id: 'user.ember', name: 'Ember' }),
    ]);
    expect(hub.state.settings['appearance.theme']).toBe('dark');
    expect(hub.state.settings['appearance.accent']).toBe('#ff8800');
    const mine = within(region).getByRole('list', { name: 'Your themes' });
    const row = within(mine).getByRole('listitem', { name: 'Ember' });
    await userEvent.click(within(row).getByRole('button', { name: 'Remove Ember' }));
    expect(await screen.findByText('Ember removed.')).toBeTruthy();
    expect(hub.state.settings['appearance.customThemes']).toEqual([]);
  });

  it('rejects an invalid theme, warns about low contrast, and imports from a file', async () => {
    const hub = createHub();
    await renderApp({ hub, path: '/settings/appearance' });
    const region = await screen.findByRole('region', { name: 'Themes' });
    const box = within(region).getByRole('textbox', { name: 'Theme link or theme JSON' });
    await userEvent.click(box);
    await userEvent.paste('{"schemaVersion":2,"id":"x","name":"X","variant":"dark","tokens":{}}');
    await userEvent.click(within(region).getByRole('button', { name: 'Check theme' }));
    const alert = within(region).getByRole('alert');
    expect(within(alert).getByText('schemaVersion must be 1.')).toBeTruthy();
    expect(within(region).queryByRole('button', { name: 'Save theme' })).toBeNull();

    await userEvent.clear(box);
    await userEvent.paste(
      JSON.stringify({
        ...SUNRISE,
        id: 'com.example.murky',
        name: 'Murky',
        tokens: { '--u-bg': '#777777', '--u-text': '#888888' },
      }),
    );
    await userEvent.click(within(region).getByRole('button', { name: 'Check theme' }));
    const preview = within(region).getByRole('group', { name: 'Theme to import' });
    expect(
      within(preview).getByText(
        /Text on background: contrast is 1\.\d:1, below the 4\.5:1 minimum/,
      ),
    ).toBeTruthy();
    await userEvent.click(within(preview).getByRole('button', { name: 'Save theme' }));
    expect(await screen.findByText('Murky saved to your themes.')).toBeTruthy();
    // Saving does not change the current look.
    expect(hub.state.settings['appearance.background']).toBeUndefined();

    const json = JSON.stringify(SUNRISE);
    await userEvent.upload(
      within(region).getByLabelText('Theme file'),
      new File([json], 'sunrise.json', { type: 'application/json' }),
    );
    expect(await within(region).findByText('Sunrise')).toBeTruthy();
    await userEvent.click(within(region).getByRole('button', { name: 'Save theme' }));
    expect(await screen.findByText('Sunrise saved to your themes.')).toBeTruthy();
    const mine = within(region).getByRole('list', { name: 'Your themes' });
    await userEvent.click(within(mine).getByRole('button', { name: 'Use Sunrise' }));
    expect(await screen.findByText('Using Sunrise.')).toBeTruthy();
    expect(hub.state.settings).toMatchObject({
      'appearance.theme': 'light',
      'appearance.background': '#fff8f0',
      'appearance.foreground': '#201810',
      'appearance.accent': '#b34700',
      'appearance.uiFont': 'Inter, sans-serif',
      'appearance.codeFont': null,
    });
    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue('--u-bg')).toBe('#fff8f0'),
    );
  });

  it('opens a theme link at Appearance with the import filled in', async () => {
    const link = themeLink(SUNRISE);
    await renderApp({ path: `/open?url=${encodeURIComponent(link)}` });
    await waitFor(() => expect(window.location.pathname).toBe('/settings/appearance'));
    await waitFor(() => expect(window.location.search).toBe(''));
    const region = await screen.findByRole('region', { name: 'Themes' });
    expect(
      within(region).getByRole<HTMLTextAreaElement>('textbox', { name: 'Theme link or theme JSON' })
        .value,
    ).toBe(link);
    const preview = within(region).getByRole('group', { name: 'Theme to import' });
    expect(within(preview).getByText('Sunrise')).toBeTruthy();
    expect(within(preview).getByText('com.example.sunrise')).toBeTruthy();
  });

  it('reports a failed save and keeps the import', async () => {
    const hub = createHub();
    await renderApp({ hub, path: '/settings/appearance' });
    const region = await screen.findByRole('region', { name: 'Themes' });
    await userEvent.click(
      within(region).getByRole('textbox', { name: 'Theme link or theme JSON' }),
    );
    await userEvent.paste(JSON.stringify(SUNRISE));
    await userEvent.click(within(region).getByRole('button', { name: 'Check theme' }));
    hub.state.failNext.setSetting = new Error('Hub offline');
    await userEvent.click(within(region).getByRole('button', { name: 'Save theme' }));
    expect(await screen.findByText('Could not save the theme: Hub offline')).toBeTruthy();
    expect(within(region).getByRole('group', { name: 'Theme to import' })).toBeTruthy();
  });
});
