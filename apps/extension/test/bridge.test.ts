// The extension's background logic against a fake chrome.* API (FR-096; ADR-096 D8): the native
// host connection and its refusals, reconnects, sharing a tab (the site's permission first, web
// pages only), the Nova tab group, badges, the debugger and its banner, calls checked for the
// tab's consent, the allowed DevTools methods, the page's permitted site and scripts that would
// read cookies or storage, history only after the user's yes in our prompt (no permission kept),
// permission changes reported, and the consents kept across a worker restart.
import { beforeEach, describe, expect, it } from 'vitest';
import { Bridge, HISTORY_PROMPT_MS } from '../src/bridge.ts';
import { NATIVE_HOST, hostsOfOrigins, parseCall, parseHostStatus } from '../src/protocol.ts';
import { FakeChrome } from './fake-chrome.ts';

let chrome: FakeChrome;
let timers: { fn: () => void; ms: number; cancelled: boolean }[];
let bridge: Bridge;

const setTimer = (fn: () => void, ms: number) => {
  const t = { fn, ms, cancelled: false };
  timers.push(t);
  return () => {
    t.cancelled = true;
  };
};

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

/** The host calls the extension; resolves with its answer. */
async function call(method: string, params: Record<string, unknown> = {}, id = 1) {
  const port = chrome.port;
  const before = port.sent.length;
  port.receive({ type: 'call', id, method, params });
  for (let i = 0; i < 50 && !port.sent.slice(before).some((m) => m.id === id); i++) await settle();
  return port.sent.slice(before).find((m) => m.id === id) as Record<string, unknown>;
}

async function shareTab(url: string): Promise<number> {
  const tabId = chrome.addTab(url, 'A page');
  chrome.origins.add(`${new URL(url).protocol}//${new URL(url).hostname}/*`);
  expect(await bridge.share(tabId)).toEqual({ ok: true });
  return tabId;
}

beforeEach(async () => {
  chrome = new FakeChrome();
  timers = [];
  let n = 0;
  bridge = new Bridge({
    chrome: chrome.api(),
    browser: 'Chromium 140',
    setTimer,
    newId: () => `p${++n}`,
  });
  await bridge.start();
  await settle();
});

describe('the native host', () => {
  it('connects to novad’s host and resyncs the consents and hosts', async () => {
    expect(chrome.ports).toHaveLength(1);
    expect(bridge.connected).toBe(true);
    const tabId = await shareTab('https://github.com/nova?token=secret');
    const opened = (await call('tabs.open', {})).result as { tabId: number };
    // A new connection: the Hub learns the shared tabs, the tabs the agent opened and the
    // granted sites again.
    chrome.port.onDisconnect.fire();
    expect(bridge.connected).toBe(false);
    expect(timers.at(-1)?.ms).toBe(1_000);
    timers.at(-1)!.fn();
    await settle();
    expect(chrome.ports).toHaveLength(2);
    expect(chrome.port.events()).toEqual([
      { kind: 'tab.shared', tabId, host: 'github.com', title: 'A page' },
      { kind: 'tab.shared', tabId: opened.tabId, host: null, title: '', origin: 'agent' },
      { kind: 'host.granted', host: 'github.com' },
    ]);
    // Hosts only: never the address (it can carry tokens).
    expect(JSON.stringify(chrome.port.sent)).not.toContain('secret');
    // Nothing but events, results and errors goes to the host.
    expect(chrome.port.sent.every((m) => m.type === 'event')).toBe(true);
  });

  it('notes why the host refused, and backs off when the host is missing', async () => {
    chrome.port.receive({ type: 'status', connected: false, reason: 'not_enabled' });
    expect(bridge.connected).toBe(false);
    expect((await bridge.status(null)).lastError).toBe('not_enabled');
    chrome.lastError = { message: 'Specified native messaging host not found.' };
    chrome.port.onDisconnect.fire();
    timers.at(-1)!.fn();
    await settle();
    chrome.port.receive({ type: 'status', connected: true, reason: null });
    expect(bridge.connected).toBe(true);
    chrome.port.onDisconnect.fire();
    expect(timers.at(-1)?.ms).toBe(2_000);
    chrome.connectError = 'no host';
    timers.at(-1)!.fn();
    expect(timers.at(-1)?.ms).toBe(4_000);
    expect((await bridge.status(null)).lastError).toBe('no host');
    // The popup's "Connect again" starts over.
    chrome.connectError = null;
    expect(await bridge.handleUi({ type: 'reconnect' })).toEqual({ ok: true });
    expect(bridge.connected).toBe(true);
    expect(NATIVE_HOST).toBe('ai.nova.bridge');
  });

  it('answers unknown methods with an error and ignores what is not a call', async () => {
    expect(await call('cookies.getAll')).toMatchObject({
      type: 'error',
      error: { code: 'unknown_method' },
    });
    const before = chrome.port.sent.length;
    chrome.port.receive('garbage');
    chrome.port.receive({ type: 'other', id: 1, method: 'tabs.list' });
    await settle();
    expect(chrome.port.sent.length).toBe(before);
    expect(parseCall({ id: 2, method: 'tabs.list' })).toMatchObject({ id: 2, params: {} });
    expect(parseHostStatus({ type: 'status', connected: false })).toEqual({
      connected: false,
      reason: 'refused',
    });
    expect(parseHostStatus({ type: 'call' })).toBeNull();
  });
});

describe('sharing tabs', () => {
  it('shares web pages the browser allows, with a badge, and unshares', async () => {
    const page = chrome.addTab('https://github.com/', 'GitHub');
    expect(await bridge.share(page)).toEqual({ ok: false, error: 'allow Nova on this site first' });
    const settings = chrome.addTab('chrome://settings');
    expect(await bridge.share(settings)).toEqual({
      ok: false,
      error: 'only web pages can be shared',
    });
    expect(await bridge.share(999)).toMatchObject({ ok: false });
    chrome.origins.add('https://github.com/*');
    expect(await bridge.handleUi({ type: 'share', tabId: page })).toEqual({ ok: true });
    expect(chrome.badges.get(page)).toBe('NOVA');
    expect(chrome.titles.get(page)).toBe('Shared with Nova');
    expect(chrome.port.events().at(-1)).toEqual({
      kind: 'tab.shared',
      tabId: page,
      host: 'github.com',
      title: 'GitHub',
    });
    const st = (await bridge.handleUi({ type: 'status', tabId: page })) as Awaited<
      ReturnType<Bridge['status']>
    >;
    expect(st.tab).toMatchObject({ shared: true, permitted: true, host: 'github.com' });
    expect(st).toMatchObject({ connected: true, browser: 'Chromium 140', version: '0.7.5' });
    expect(await bridge.handleUi({ type: 'unshare', tabId: page })).toEqual({ ok: true });
    expect(chrome.badges.get(page)).toBe('');
    expect(chrome.port.events().at(-1)).toEqual({ kind: 'tab.unshared', tabId: page });
    expect(await bridge.handleUi({ type: 'nope' })).toMatchObject({ ok: false });
  });

  it('ends the consent when the tab closes, the banner is cancelled or the site is withdrawn', async () => {
    const a = await shareTab('https://a.example/');
    const b = await shareTab('https://b.example/');
    const c = await shareTab('https://c.example/');
    chrome.onRemoved.fire(a);
    await settle();
    expect(chrome.port.events()).toContainEqual({ kind: 'tab.closed', tabId: a });
    await call('tab.attach', { tabId: b });
    chrome.onDetach.fire({ tabId: b }, 'canceled_by_user');
    await settle();
    expect(chrome.port.events()).toContainEqual({ kind: 'tab.unshared', tabId: b });
    chrome.withdraw('https://c.example/*');
    await settle();
    expect(chrome.port.events()).toContainEqual({ kind: 'host.revoked', host: 'c.example' });
    expect(chrome.port.events()).toContainEqual({ kind: 'tab.unshared', tabId: c });
    expect((await call('tabs.list')).result).toEqual({ tabs: [] });
  });

  it('keeps consents across a worker restart (session storage), never the attachment', async () => {
    const tabId = await shareTab('https://github.com/');
    const again = new Bridge({ chrome: chrome.api(), setTimer });
    await again.start();
    expect((await again.status(tabId)).tab).toMatchObject({ shared: true, attached: false });
    // The tab is still attached in the browser: attaching again is not an error.
    chrome.attached.add(tabId);
    const port = chrome.port;
    port.receive({ type: 'call', id: 9, method: 'tab.attach', params: { tabId } });
    await settle();
    expect(port.sent.find((m) => m.id === 9)).toMatchObject({
      type: 'result',
      result: { attached: true },
    });
  });
});

describe('calls from the Hub', () => {
  it('lists only consented tabs and opens agent tabs blank in the Nova group', async () => {
    chrome.addTab('https://private.example/', 'Not shared');
    const shared = await shareTab('https://github.com/');
    const opened = await call('tabs.open', { url: 'about:blank', group: 'Nova' });
    const tabId = (opened.result as { tabId: number }).tabId;
    expect(chrome.tabs.get(tabId)).toMatchObject({ url: 'about:blank' });
    const gid = chrome.tabs.get(tabId)!.groupId!;
    expect(chrome.groups.get(gid)).toEqual({ title: 'Nova', color: 'blue' });
    expect(chrome.badges.get(tabId)).toBe('NOVA');
    const second = await call('tabs.open', {}, 2);
    expect(chrome.tabs.get((second.result as { tabId: number }).tabId)!.groupId).toBe(gid);
    // The group was closed: a new one is made.
    chrome.groups.clear();
    const third = await call('tabs.open', {}, 3);
    expect(chrome.tabs.get((third.result as { tabId: number }).tabId)!.groupId).not.toBe(gid);
    expect(await call('tabs.open', { url: 'https://evil.example/' }, 4)).toMatchObject({
      error: { code: 'url_refused' },
    });
    const list = (await call('tabs.list', {}, 5)).result as {
      tabs: { tabId: number; origin: string; host: string | null }[];
    };
    expect(list.tabs.map((t) => [t.tabId, t.origin])).toEqual([
      [shared, 'shared'],
      [tabId, 'agent'],
      [(second.result as { tabId: number }).tabId, 'agent'],
      [(third.result as { tabId: number }).tabId, 'agent'],
    ]);
  });

  it('attaches the debugger only to consented tabs, and detaches', async () => {
    const other = chrome.addTab('https://github.com/');
    expect(await call('tab.attach', { tabId: other })).toMatchObject({
      error: { code: 'tab_not_shared' },
    });
    const tabId = await shareTab('https://github.com/');
    expect(await call('tab.attach', { tabId }, 2)).toMatchObject({ result: { attached: true } });
    expect(chrome.attached.has(tabId)).toBe(true);
    expect(chrome.titles.get(tabId)).toBe('Nova controls this tab');
    expect(await call('tab.detach', { tabId }, 3)).toMatchObject({ result: { detached: true } });
    expect(chrome.attached.has(tabId)).toBe(false);
  });

  it('sends only allowed DevTools methods, on permitted sites, never reading cookies or storage', async () => {
    const tabId = await shareTab('https://github.com/');
    const send = (
      method: string,
      params: Record<string, unknown> = {},
      id = 1,
      expectHost: string | null = 'github.com',
    ) => call('cdp.send', { tabId, method, params, expectHost }, id);
    expect(await send('Runtime.evaluate', { script: 'href' })).toMatchObject({
      error: { code: 'not_attached' },
    });
    await call('tab.attach', { tabId }, 2);
    for (const m of [
      'Network.getAllCookies',
      'Storage.getCookies',
      'Network.getResponseBody',
      'Page.setDownloadBehavior',
    ])
      expect(await send(m, {}, 3)).toMatchObject({ error: { code: 'method_refused' } });
    // No code from upstream: only the extension's own scripts, by name (hardening note).
    for (const params of [
      { expression: 'document.cookie' },
      { expression: "document['coo'+'kie']" },
      { script: 'href', expression: 'x' },
      { script: 'cookies' },
      {},
    ])
      expect(await send('Runtime.evaluate', params, 4)).toMatchObject({
        error: { code: 'script_refused' },
      });
    expect(await send('Runtime.evaluate', { script: 'href' }, 5)).toMatchObject({
      result: { ok: 'Runtime.evaluate' },
    });
    const sent = chrome.commands.at(-1)!.params as { expression: string; returnByValue: boolean };
    // The script runs only on the expected host.
    expect(sent.expression).toContain('location.hostname!=="github.com"');
    expect(sent.expression).toContain('__novaWrongHost');
    expect(sent.returnByValue).toBe(true);
    // No shortcut keys: the user's clipboard is never pasted, copied or cut (review #2).
    for (const params of [
      { type: 'rawKeyDown', key: 'v', modifiers: 2 },
      { type: 'rawKeyDown', key: 'c', modifiers: 4 },
      { type: 'rawKeyDown', key: 'x', modifiers: 1 },
      { type: 'keyDown', key: 'v', commands: ['paste'] },
    ])
      expect(await send('Input.dispatchKeyEvent', params, 6)).toMatchObject({
        error: { code: 'key_refused' },
      });
    expect(
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', modifiers: 2 }, 6),
    ).toMatchObject({
      error: { code: 'key_refused' },
    });
    expect(
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'A', modifiers: 8 }, 7),
    ).toMatchObject({
      type: 'result',
    });
    expect(await send('Page.navigate', { url: 'https://evil.example/' }, 8)).toMatchObject({
      error: { code: 'host_not_permitted' },
    });
    expect(await send('Page.navigate', { url: 'https://github.com/nova' }, 9)).toMatchObject({
      type: 'result',
    });
    // The call must say which host it is for, and the tab must be on it (review #1).
    expect(await send('Input.insertText', { text: 'x' }, 10, 'gitlab.com')).toMatchObject({
      error: { code: 'host_changed' },
    });
    const bad = await call('cdp.send', { tabId, method: 'Input.insertText', params: {} }, 11);
    expect(bad).toMatchObject({ error: { code: 'host_unknown' } });
    // The page moved on its own (or the user moved it), or a navigation is pending elsewhere.
    chrome.tabs.get(tabId)!.url = 'https://evil.example/';
    expect(await send('Input.insertText', { text: 'x' }, 12)).toMatchObject({
      error: { code: 'host_changed' },
    });
    chrome.tabs.get(tabId)!.url = 'https://github.com/';
    chrome.tabs.get(tabId)!.pendingUrl = 'https://mail.example/inbox';
    expect(await send('Runtime.evaluate', { script: 'read' }, 13)).toMatchObject({
      error: { code: 'host_changed' },
    });
    // On a host the browser does not allow, even if expected, nothing is sent.
    chrome.tabs.get(tabId)!.pendingUrl = undefined;
    chrome.tabs.get(tabId)!.url = 'https://evil.example/';
    expect(await send('Input.insertText', { text: 'x' }, 14, 'evil.example')).toMatchObject({
      error: { code: 'host_not_permitted' },
    });
    expect(chrome.commands.map((c) => c.method)).toEqual([
      'Runtime.evaluate',
      'Input.dispatchKeyEvent',
      'Page.navigate',
    ]);
    // A tab the agent opened acts on about:blank until it navigates.
    const opened = (await call('tabs.open', {}, 15)).result as { tabId: number };
    await call('tab.attach', { tabId: opened.tabId }, 16);
    const blank = (method: string, params: unknown, id: number) =>
      call('cdp.send', { tabId: opened.tabId, method, params, expectHost: null }, id);
    expect(await blank('Page.captureScreenshot', {}, 17)).toMatchObject({ type: 'result' });
    expect(await blank('Page.navigate', 'x', 18)).toMatchObject({
      error: { code: 'host_not_permitted' },
    });
    // A page that is not a web site is never acted on.
    chrome.tabs.get(opened.tabId)!.url = 'chrome://settings/';
    expect(await blank('Page.captureScreenshot', {}, 19)).toMatchObject({
      error: { code: 'not_web' },
    });
  });

  it('builds every page script from its own copy, with the host check', async () => {
    const { SCRIPT_NAMES, scriptExpression, isScriptName } = await import('../src/scripts.ts');
    for (const name of SCRIPT_NAMES) {
      const arg = { ref: 'e1', value: 'Large', text: 'hello', maxChars: 5_000 };
      const e = scriptExpression(name, arg, 'github.com');
      expect(e.startsWith('(function(){if(location.hostname!=="github.com")')).toBe(true);
    }
    expect(scriptExpression('href', {}, null)).toContain('location.hostname!==""');
    expect(scriptExpression('read', { maxChars: 1e9 }, 'a.example')).toContain('"maxChars":40000');
    expect(() => scriptExpression('describe', { ref: 'e1"]' }, 'a.example')).toThrow();
    expect(() => scriptExpression('select', { ref: 'e1', value: 1 }, 'a.example')).toThrow();
    expect(isScriptName('read')).toBe(true);
    expect(isScriptName('eval')).toBe(false);
  });
});

describe('history', () => {
  it('asks the user each time, searches once, and keeps no permission', async () => {
    chrome.historyItems = [
      { url: 'https://github.com/nova?token=secret', title: 'Nova', lastVisitTime: 0 },
    ];
    const port = chrome.port;
    port.receive({
      type: 'call',
      id: 1,
      method: 'history.search',
      params: { query: ' nova ', maxResults: 500 },
    });
    await settle();
    expect(chrome.windows).toEqual(['chrome-extension://nova/prompt.html?id=p1&q=nova']);
    // The prompt page: the user's click requests the permission, then answers.
    await chrome.api().permissions.request({ permissions: ['history'] });
    expect(await bridge.handleUi({ type: 'history.answer', id: 'p1', allow: true })).toEqual({
      ok: true,
    });
    await settle();
    expect(port.sent.find((m) => m.id === 1)).toEqual({
      type: 'result',
      id: 1,
      result: {
        items: [
          // Titles and sites only, as the prompt says (review #9).
          { title: 'Nova', host: 'github.com', lastVisit: '1970-01-01T00:00:00.000Z' },
        ],
      },
    });
    expect(chrome.historySearches).toEqual([{ text: 'nova', maxResults: 50 }]);
    expect(chrome.perms.has('history')).toBe(false);
  });

  it('answers declined when the user says no or does not answer, and refuses empty queries', async () => {
    const port = chrome.port;
    port.receive({ type: 'call', id: 1, method: 'history.search', params: { query: 'a' } });
    await settle();
    await bridge.handleUi({ type: 'history.answer', id: 'p1', allow: false });
    await settle();
    expect(port.sent.find((m) => m.id === 1)).toMatchObject({ error: { code: 'declined' } });
    port.receive({ type: 'call', id: 2, method: 'history.search', params: { query: 'b' } });
    await settle();
    const prompt = timers.find((t) => t.ms === HISTORY_PROMPT_MS && !t.cancelled)!;
    prompt.fn();
    await settle();
    expect(port.sent.find((m) => m.id === 2)).toMatchObject({ error: { code: 'declined' } });
    // A yes without the browser's permission is still no history.
    port.receive({ type: 'call', id: 3, method: 'history.search', params: { query: 'c' } });
    await settle();
    await bridge.handleUi({ type: 'history.answer', id: 'p3', allow: true });
    await settle();
    expect(port.sent.find((m) => m.id === 3)).toMatchObject({ error: { code: 'declined' } });
    expect(await call('history.search', { query: '  ' }, 4)).toMatchObject({
      error: { code: 'invalid' },
    });
    expect(await bridge.handleUi({ type: 'history.answer', id: 'gone', allow: true })).toEqual({
      ok: false,
    });
    expect(chrome.historySearches).toEqual([]);
  });
});

describe('permissions', () => {
  it('reports sites the browser granted, all sites as *', async () => {
    await chrome.api().permissions.request({ origins: ['https://gitlab.com/*'] });
    expect(chrome.port.events()).toContainEqual({ kind: 'host.granted', host: 'gitlab.com' });
    expect(
      hostsOfOrigins(['<all_urls>', '*://*/*', 'https://*.x.com/*', 'http://a.example/*']),
    ).toEqual(['*', 'a.example']);
  });
});
