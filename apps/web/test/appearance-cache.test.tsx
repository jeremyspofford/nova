// First paint before settings load (FR-010, FR-011): the last look this device applied, saved
// theme and overrides included, is cached and applied while the app connects.
import { afterEach, describe, expect, it } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { App } from '../src/App.tsx';
import { readCachedLook, resolveAppearance, writeCachedLook } from '../src/appearance.ts';
import { createHub, fakeEventSource } from './fakes.ts';
import { clearViewport, resetDom, setViewport } from './render.tsx';

afterEach(() => {
  resetDom();
  clearViewport();
});

const look = () =>
  resolveAppearance(
    {
      theme: 'dark',
      custom: null,
      accent: '#ff8800',
      background: null,
      foreground: null,
      uiFont: 'Inter, sans-serif',
      codeFont: null,
      fontScale: 1.25,
      reducedMotion: 'on',
    },
    true,
  );

describe('the cached look', () => {
  it('round-trips for the same OS darkness only', () => {
    writeCachedLook(look(), true);
    const back = readCachedLook(true);
    expect(back?.theme.tokens['--u-accent']).toBe('#ff8800');
    expect(back).toMatchObject({
      fontScale: 1.25,
      motion: 'reduce',
      fonts: { '--u-font-ui': 'Inter, sans-serif' },
    });
    expect(readCachedLook(false)).toBeNull();
  });

  it('ignores a malformed or tampered cache', () => {
    localStorage.setItem('nova.look', '{nope');
    expect(readCachedLook(true)).toBeNull();
    localStorage.setItem(
      'nova.look',
      JSON.stringify({ dark: true, look: { theme: { tokens: 3 } } }),
    );
    expect(readCachedLook(true)).toBeNull();
    const bad = look();
    localStorage.setItem(
      'nova.look',
      JSON.stringify({
        dark: true,
        look: {
          ...bad,
          theme: { ...bad.theme, tokens: { ...bad.theme.tokens, color: 'red' } },
          fonts: { '--u-font-ui': 'x; } body { display: none', '--u-font-code': null },
          fontScale: 40,
        },
      }),
    );
    const safe = readCachedLook(true);
    expect(safe?.theme.tokens.color).toBeUndefined();
    expect(safe?.fonts['--u-font-ui']).toBeNull();
    expect(safe?.fontScale).toBe(1);
  });

  it('paints the cached look while the app connects', async () => {
    setViewport(1400, { dark: true });
    writeCachedLook(look(), true);
    const hub = createHub();
    hub.api.hello.mockImplementation(() => new Promise(() => undefined));
    render(<App api={hub.api} eventSource={fakeEventSource} takeSetupCode={() => null} />);
    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue('--u-accent')).toBe('#ff8800'),
    );
    expect(document.documentElement.style.getPropertyValue('--u-font-scale')).toBe('1.25');
  });
});
