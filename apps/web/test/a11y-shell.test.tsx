// Accessibility of the shell that axe cannot see in jsdom (FR-015, WCAG 2.2 AA): each page names
// the browser tab (2.4.2). The rest is checked in the browser by e2e/a11y-sweep.spec.ts.
import { act, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { navigate } from '../src/router.ts';
import { renderApp, resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  document.title = '';
});

describe('page titles (WCAG 2.4.2)', () => {
  it('names the open page in the browser tab and follows navigation', async () => {
    await renderApp({ path: '/chat' });
    expect(await screen.findByRole('textbox', { name: 'Message' })).toBeTruthy();
    expect(document.title).toBe('Chat - Nova');
    act(() => navigate('/settings/appearance'));
    expect(await screen.findByRole('heading', { level: 2, name: 'Appearance' })).toBeTruthy();
    expect(document.title).toBe('Settings - Nova');
    act(() => navigate('/marketplace'));
    expect(document.title).toBe('Marketplace - Nova');
    act(() => navigate('/work'));
    expect(document.title).toBe('Work - Nova');
  });
});
