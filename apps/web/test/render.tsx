import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { App } from '../src/App.tsx';
import type { CommandRegistry } from '../src/commands.ts';
import {
  FakeEventSource,
  FakeScreen,
  FakeSocket,
  createHub,
  fakeEventSource,
  fakeTerminalScreen,
  fakeWebSocket,
  testRegistry,
} from './fakes.ts';

export interface RenderOptions {
  hub?: ReturnType<typeof createHub>;
  path?: string;
  registry?: CommandRegistry;
  announceEveryMs?: number;
  /** Wait for the signed-in workspace (default true). */
  ready?: boolean;
}

export async function renderApp(opts: RenderOptions = {}) {
  window.history.replaceState(null, '', opts.path ?? '/chat');
  const hub = opts.hub ?? createHub();
  const registry = opts.registry ?? testRegistry();
  const utils = render(
    <App
      api={hub.api}
      registry={registry}
      eventSource={fakeEventSource}
      takeSetupCode={() => null}
      announceEveryMs={opts.announceEveryMs ?? 0}
      webSocket={fakeWebSocket}
      terminalScreen={fakeTerminalScreen}
    />,
  );
  if (opts.ready !== false) {
    await screen.findByRole('navigation', { name: 'Sidebar' });
    // The shell's commands register in an effect that can run after the sidebar is in the DOM.
    await waitFor(() => {
      if (!registry.get('view.toggleTheme')) throw new Error('shell commands not registered yet');
    });
  }
  return { hub, registry, ...utils };
}

export function resetDom() {
  cleanup();
  FakeEventSource.reset();
  FakeSocket.reset();
  FakeScreen.reset();
  document.documentElement.removeAttribute('style');
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-motion');
  try {
    window.localStorage.removeItem('nova.theme');
  } catch {
    // storage unavailable
  }
}

/** Install a matchMedia stub for one viewport width (jsdom has none). */
export function setViewport(width: number, opts: { dark?: boolean } = {}) {
  const matches = (q: string) => {
    const max = /max-width:\s*(\d+)px/.exec(q);
    const min = /min-width:\s*(\d+)px/.exec(q);
    if (max) return width <= Number(max[1]);
    if (min) return width >= Number(min[1]);
    if (q.includes('prefers-color-scheme: dark')) return opts.dark ?? true;
    return false;
  };
  window.matchMedia = (q: string) => ({
    matches: matches(q),
    media: q,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  });
}

export function clearViewport() {
  // @ts-expect-error jsdom has no matchMedia; tests add and remove it
  delete window.matchMedia;
}
