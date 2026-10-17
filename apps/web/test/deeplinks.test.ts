import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { screen, waitFor } from '@testing-library/react';
import { deepLinkPath } from '../src/deeplinks.ts';
import { CommandRegistry } from '../src/commands.ts';
import {
  NEW_PROJECT_PATH,
  registerWorkspaceCommands,
  workspaceCommands,
} from '../src/workspace-commands.ts';
import { createHub } from './fakes.ts';
import { renderApp, resetDom } from './render.tsx';

afterEach(resetDom);

describe('deepLinkPath (FR-007)', () => {
  it.each([
    ['nova://settings', '/settings/general'],
    ['nova://settings/models', '/settings/models'],
    ['nova://settings/devices/', '/settings/devices'],
    ['nova://settings/nonsense', '/settings/general'],
    ['nova://chat', '/chat'],
    [
      'nova://chat/0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
      '/chat/0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
    ],
    ['nova://chat/t0001?m=m0002', '/chat/t0001?m=m0002'],
    ['nova://chat/t0001?m=bad%20id', '/chat/t0001'],
    ['nova://code', '/code'],
    ['nova://code/s1', '/code/s1'],
    ['nova://agent/a1', '/agents/a1'],
    ['nova://computer/c1', '/computers/c1'],
    ['nova://computers', '/computers'],
    ['nova://device/d1', '/devices/d1'],
    ['nova://devices', '/devices'],
    ['nova://agents', '/agents'],
    ['nova://projects', '/projects'],
    ['nova://projects/p1', '/projects/p1'],
    ['web+nova://chat/abc', '/chat/abc'],
    ['WEB+NOVA://Settings/Memory', '/settings/general'],
    ['NOVA://SETTINGS/memory', '/settings/memory'],
    ['nova:chat/abc', '/chat/abc'],
    ['nova:///chat/abc', '/chat/abc'],
    ['nova://chat/abc#frag', '/chat/abc'],
    ['  nova://chat/abc  ', '/chat/abc'],
  ])('%s -> %s', (url, path) => {
    expect(deepLinkPath(url)).toBe(path);
  });

  it('decodes percent-encoded ids and re-encodes them safely', () => {
    expect(deepLinkPath('nova://chat/abc%2D123')).toBe('/chat/abc-123');
    expect(deepLinkPath('nova://projects/p%5F1')).toBe('/projects/p_1');
  });

  it.each([
    'javascript:alert(1)',
    'JavaScript:alert(1)//nova://chat',
    'https://example.com/chat/1',
    'http://nova/chat',
    'data:text/html,<b>x</b>',
    'novax://chat',
    'nova-evil://chat',
    'web+novas://chat',
    'nova://',
    'nova://unknown',
    'nova://run/r1',
    'web+nova:javascript:alert(1)',
    'nova://chat/a/b',
    'nova://chat//x',
    'nova://chat/%2F%2Fevil.com',
    'nova://chat/..',
    'nova://chat/a%20b',
    'nova://chat/%E0%A4%A',
    `nova://chat/${'x'.repeat(101)}`,
    '',
    '/chat/abc',
    '//evil.com/chat',
  ])('rejects %s', (url) => {
    expect(deepLinkPath(url)).toBeNull();
  });

  it('opens /open?url=<link> at the linked route, and unknown links at /chat', async () => {
    const link = encodeURIComponent('web+nova://settings/memory');
    await renderApp({ path: `/open?url=${link}` });
    await waitFor(() => expect(window.location.pathname).toBe('/settings/memory'));
    expect(await screen.findByRole('heading', { name: 'Memory', level: 2 })).toBeTruthy();
    resetDom();
    await renderApp({ path: `/open?url=${encodeURIComponent('javascript:alert(1)')}` });
    await waitFor(() => expect(window.location.pathname).toBe('/chat'));
  });

  it('registers web+nova as a protocol handler in the manifest', () => {
    // Vitest runs in apps/web (npm test inside the package).
    const manifest = JSON.parse(
      readFileSync(join(process.cwd(), 'public/manifest.webmanifest'), 'utf8'),
    ) as { protocol_handlers: { protocol: string; url: string }[] };
    expect(manifest.protocol_handlers).toEqual([{ protocol: 'web+nova', url: '/open?url=%s' }]);
  });
});

describe('workspace commands', () => {
  it('registers the navigation commands and runs them', () => {
    const registry = new CommandRegistry({ mac: false, browserTab: false });
    const go = vi.fn();
    const off = registerWorkspaceCommands(registry, { navigate: go });
    const titles = registry.list().map((c) => c.title);
    expect(titles).toEqual(expect.arrayContaining(['Go to Projects', 'New project']));
    registry.run('projects.open');
    registry.run('projects.new');
    expect(go.mock.calls.map((c) => c[0])).toEqual(['/projects', NEW_PROJECT_PATH]);
    off();
    expect(registry.get('projects.open')).toBeUndefined();
    expect(registry.conflicts()).toEqual([]);
  });

  it('navigates with the router by default; New project opens the dialog', async () => {
    const hub = createHub();
    await renderApp({ hub, path: '/chat' });
    const cmd = workspaceCommands().find((c) => c.id === 'projects.new')!;
    cmd.run();
    expect(await screen.findByRole('dialog', { name: 'New project' })).toBeTruthy();
    await waitFor(() => expect(window.location.search).toBe(''));
    expect(window.location.pathname).toBe('/projects');
  });
});
