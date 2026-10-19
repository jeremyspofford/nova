import { describe, expect, it } from 'vitest';
import {
  externalUrl,
  localRequestAllowed,
  navigationDecision,
  requestAllowed,
} from '../src/allowlist.ts';
import { deepLinkFromArgv, hubOriginOf, joinPath, routeDeepLink } from '../src/deeplinks.ts';
import { appPath, pathKey, threadIdOf } from '../src/routes.ts';
import {
  currentThread,
  lastUsed,
  pathOfUrl,
  windowForDetach,
  windowForLink,
  type WindowInfo,
} from '../src/windows.ts';

const ID = '01a14c27-a76b-770c-a73e-96d31a615a20';

describe('appPath: what a window may open (FR-009)', () => {
  it.each([
    ['/', '/'],
    [`/chat/${ID}`, `/chat/${ID}`],
    [`/chat/${ID}?m=abc&evil=1`, `/chat/${ID}?m=abc`],
    ['/chat?temporary=1', '/chat?temporary=1'],
    ['/work/scheduled?new=1', '/work/scheduled?new=1'],
    [`/work?fromRun=${ID}`, `/work?fromRun=${ID}`],
    [`/code/${ID}`, `/code/${ID}`],
    ['/settings', '/settings/general'],
    ['/settings/nope', '/settings/general'],
    ['/settings/keyboard', '/settings/keyboard'],
    ['/settings/tools?oauth=ok', '/settings/tools?oauth=ok'],
    ['/settings/tools?oauth=<script>', '/settings/tools'],
    [`/approvals/${ID}`, `/approvals/${ID}`],
    ['/devices/add?request=r1&role=client', '/devices/add?request=r1&role=client'],
    ['/network/trust?run=x1', '/network/trust?run=x1'],
    ['/spaces/a/b', '/spaces/a/b'],
    ['/library', '/library'],
    [`/agents/${ID}?tab=rules`, `/agents/${ID}?tab=rules`],
  ])('%s → %s', (raw, want) => {
    expect(appPath(raw)).toBe(want);
  });

  it.each([
    'https://example.com/chat',
    '//example.com/chat',
    '/\\example.com',
    'chat/x',
    '/chat/x/y',
    '/chat/../../etc',
    '/chat/%2e%2e%2fadmin',
    '/settings/a/b',
    '/add-device?p=x',
    '/open?url=nova://chat',
    '/onboarding',
    '/unknown',
    '/chat/%E0%A4%A',
    '/chat/a\u0000',
    'javascript:alert(1)',
    '',
    `/chat/${'x'.repeat(101)}`,
  ])('refuses %j', (raw) => {
    expect(appPath(raw)).toBeNull();
  });

  it('refuses non-strings and very long input', () => {
    expect(appPath(42)).toBeNull();
    expect(appPath(`/chat?m=${'a'.repeat(2001)}`)).toBeNull();
  });

  it('names the chat a path shows', () => {
    expect(threadIdOf(`/chat/${ID}?m=1`)).toBe(ID);
    expect(threadIdOf('/chat')).toBeNull();
    expect(threadIdOf(`/work/${ID}`)).toBeNull();
    expect(pathKey('/chat/x?m=1#y')).toBe('/chat/x');
  });
});

describe('deep links (docs/04 §5.1, ADR-095 decision 7)', () => {
  it.each([
    [`nova://run/${ID}`, `/work/${ID}`],
    ['nova://work', '/work'],
    [`nova://code/${ID}`, `/code/${ID}`],
    [`nova://approval/${ID}`, `/approvals/${ID}`],
    [`nova://chat/${ID}?m=m1`, `/chat/${ID}?m=m1`],
    ['nova://chat', '/chat'],
    ['nova:chat/abc', '/chat/abc'],
    ['nova:///chat/abc/', '/chat/abc'],
    ['web+nova://settings/appearance', '/settings/appearance'],
    ['nova://settings/whatever', '/settings/general'],
    ['nova://agent/a1', '/agents/a1'],
    ['nova://agents', '/agents'],
    ['nova://computer/c1', '/computers/c1'],
    ['nova://device/d1', '/devices/d1'],
    ['nova://project/p1', '/projects/p1'],
    ['NOVA://projects', '/projects'],
    ['nova://theme?data=abc+def', '/settings/appearance?theme=abc%2Bdef'],
  ])('%s → %s', (link, path) => {
    expect(routeDeepLink(link)).toEqual({ kind: 'path', path });
  });

  it.each([
    'https://example.com',
    'nova://unknown/x',
    'nova://chat/a/b/c',
    'nova://chat/%zz',
    'nova://chat/<script>',
    'nova://theme/x?data=a',
    'nova://theme?data=',
    'nova://add-device/x?p=1',
    'nova:',
    ':nothing',
    `nova://chat/${'a'.repeat(50_001)}`,
  ])('refuses %j', (link) => {
    expect(routeDeepLink(link)).toBeNull();
  });

  it('turns an Add Device link into a Hub to verify and its join page', () => {
    const fp = 'A'.repeat(43);
    const link = `nova://add-device?h=${encodeURIComponent('https://hub.local:7443/x')}&p=pair1&fp=${fp}&e=${encodeURIComponent('https://10.0.0.2:7443')}&e=bad&r=${encodeURIComponent('wss://relay.example')}&rp=rp1#c=ABCD-EFGH`;
    expect(routeDeepLink(link)).toEqual({
      kind: 'add-device',
      hubUrl: 'https://hub.local:7443',
      pin: fp,
      endpoints: ['https://10.0.0.2:7443'],
      path: `/add-device?p=pair1&fp=${fp}&r=wss%3A%2F%2Frelay.example%2F&rp=rp1#c=ABCD-EFGH`,
    });
  });

  it('drops fields that do not validate', () => {
    expect(joinPath(new URLSearchParams('p=pair1&fp=short&r=ftp://x&rp=1'), 'c=nope')).toBe(
      '/add-device?p=pair1',
    );
    expect(joinPath(new URLSearchParams('fp=x'), '')).toBeNull();
    expect(routeDeepLink('nova://add-device?p=pair1&r=https%3A%2F%2Fu%3Ap%40r&rp=1')).toMatchObject(
      {
        hubUrl: null,
        pin: null,
        path: '/add-device?p=pair1',
      },
    );
    expect(hubOriginOf('https://a:b@hub.local')).toBeNull();
    expect(hubOriginOf('file:///etc')).toBeNull();
    expect(hubOriginOf(null)).toBeNull();
    expect(hubOriginOf('not a url')).toBeNull();
  });

  it('finds the link among process arguments', () => {
    expect(deepLinkFromArgv(['/usr/bin/nova', '--flag', 'nova://chat/x'])).toBe('nova://chat/x');
    expect(deepLinkFromArgv(['web+nova://chat'])).toBe('web+nova://chat');
    expect(deepLinkFromArgv(['/usr/bin/nova'])).toBeNull();
  });
});

describe('navigation allowlist', () => {
  const hub = 'https://hub.local:7443';

  it('allows only the Hub origin, sends web links to the browser, denies the rest', () => {
    expect(navigationDecision('https://hub.local:7443/chat', hub)).toBe('allow');
    expect(navigationDecision('https://u:p@hub.local:7443/chat', hub)).toBe('deny');
    expect(navigationDecision('https://example.com/', hub)).toBe('external');
    expect(navigationDecision('http://hub.local:7443/', hub)).toBe('external');
    expect(navigationDecision('mailto:a@b.c', hub)).toBe('external');
    for (const bad of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'nova://chat',
      'data:text/html,x',
      'not a url',
      'https://u:p@example.com',
    ])
      expect(navigationDecision(bad, hub)).toBe('deny');
    expect(navigationDecision(`https://hub.local:7443/${'x'.repeat(9000)}`, hub)).toBe('deny');
    expect(externalUrl('https://example.com/a b')).toBe('https://example.com/a%20b');
    expect(externalUrl('https://u:p@example.com/')).toBeNull();
    expect(externalUrl('ftp://example.com/')).toBeNull();
  });

  it('limits a Hub window to the Hub origin and its WebSockets', () => {
    expect(requestAllowed('https://hub.local:7443/api/v1/x', hub)).toBe(true);
    expect(requestAllowed('wss://hub.local:7443/api/v1/ws', hub)).toBe(true);
    expect(requestAllowed('ws://hub.local:7443/api/v1/ws', hub)).toBe(false);
    expect(requestAllowed('https://hub.local:7444/', hub)).toBe(false);
    expect(requestAllowed('https://cdn.example/x.js', hub)).toBe(false);
    expect(requestAllowed('http://hub.local:7443/', hub)).toBe(false);
    expect(requestAllowed('data:image/png;base64,AA', hub)).toBe(true);
    expect(requestAllowed('blob:https://hub.local:7443/1', hub)).toBe(true);
    expect(requestAllowed('file:///etc/passwd', hub)).toBe(false);
    expect(requestAllowed('ws://127.0.0.1:1/', 'http://127.0.0.1:1')).toBe(true);
    expect(requestAllowed('https://x', 'not an origin')).toBe(false);
    expect(requestAllowed('::', hub)).toBe(false);
  });

  it("limits the shell's own pages to their files", () => {
    const dir = 'file:///opt/nova/src/renderer';
    expect(localRequestAllowed('file:///opt/nova/src/renderer/quick.js', dir)).toBe(true);
    expect(localRequestAllowed('file:///opt/nova/src/renderer/../main.ts', dir)).toBe(false);
    expect(localRequestAllowed('file:///etc/passwd', dir)).toBe(false);
    expect(localRequestAllowed('https://example.com/', dir)).toBe(false);
    expect(localRequestAllowed('data:image/png;base64,AA', `${dir}/`)).toBe(true);
    expect(localRequestAllowed('%%', dir)).toBe(false);
  });
});

describe('window routing', () => {
  const wins: WindowInfo[] = [
    { id: 1, path: '/', focusedAt: 10 },
    { id: 2, path: `/chat/${ID}?m=1`, focusedAt: 30 },
    { id: 3, path: '/work/r1', focusedAt: 20 },
  ];

  it('focuses the window at the place, else reuses the last used one, else makes one', () => {
    expect(windowForLink(wins, `/chat/${ID}?m=1`)).toEqual({ kind: 'focus', id: 2 });
    expect(windowForLink(wins, `/chat/${ID}?m=2`)).toEqual({ kind: 'navigate', id: 2 });
    expect(windowForLink(wins, '/code/c1')).toEqual({ kind: 'navigate', id: 2 });
    expect(windowForLink([], '/code/c1')).toEqual({ kind: 'create' });
  });

  it('opens a new window unless one shows exactly that place', () => {
    expect(windowForDetach(wins, '/work/r1')).toEqual({ kind: 'focus', id: 3 });
    expect(windowForDetach(wins, '/work/r2')).toEqual({ kind: 'create' });
  });

  it('knows the current chat and the last used window', () => {
    expect(currentThread(wins)).toBe(ID);
    expect(currentThread([{ id: 1, path: '/work', focusedAt: 1 }])).toBeNull();
    expect(lastUsed([])).toBeNull();
    expect(pathOfUrl('https://hub.local:7443/chat/x?m=1#f', 'https://hub.local:7443')).toBe(
      '/chat/x?m=1',
    );
    expect(pathOfUrl('https://evil/chat', 'https://hub.local:7443')).toBeNull();
    expect(pathOfUrl('nonsense', 'https://hub.local:7443')).toBeNull();
  });
});
