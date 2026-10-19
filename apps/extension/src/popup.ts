// The popup: whether Nova's host is connected, and sharing the current tab. Sharing first asks
// the browser for this one site (it must happen in the user's click); the agent then acts only in
// shared tabs and the tabs it opens in the Nova group.
import type { ChromeApi } from './chrome.ts';
import type { BridgeStatus, TabStatus } from './bridge.ts';
import { originPattern } from './protocol.ts';

const api = (globalThis as unknown as { chrome: ChromeApi }).chrome;
const $ = (id: string) => document.getElementById(id)!;

type Status = BridgeStatus & { tab: TabStatus | null; url?: string };

async function current(): Promise<{ id: number; url: string } | null> {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  return tab && typeof tab.id === 'number' ? { id: tab.id, url: tab.url ?? '' } : null;
}

async function render(): Promise<void> {
  const tab = await current();
  const st = (await api.runtime.sendMessage({ type: 'status', tabId: tab?.id ?? null })) as Status;
  $('connection').textContent = st.connected
    ? 'Connected to Nova on this computer.'
    : `Not connected to Nova${st.lastError ? ` (${st.lastError})` : ''}. Run "novad bridge enable" on this computer.`;
  $('connection').className = st.connected ? 'ok' : 'warn';
  const button = $('share') as HTMLButtonElement;
  const site = st.tab?.host ?? null;
  $('site').textContent = site ?? 'This page cannot be shared.';
  button.disabled = !site || !tab;
  const on = st.tab?.shared === true || st.tab?.agent === true;
  button.textContent = on ? 'Stop sharing this tab' : 'Share this tab with Nova';
  $('state').textContent = !on
    ? 'Not shared. Nova cannot see or use this tab.'
    : st.tab?.attached
      ? 'Shared. Nova is controlling this tab now.'
      : 'Shared. Nova may act in this tab on the sites you allow.';
  const list = $('tabs');
  list.textContent = '';
  for (const t of st.tabs) {
    const li = document.createElement('li');
    li.textContent = `${t.host ?? 'blank page'} (${t.origin === 'shared' ? 'shared by you' : 'opened by Nova'})`;
    list.append(li);
  }
  button.onclick = () => void toggle(tab, on);
}

async function toggle(tab: { id: number; url: string } | null, on: boolean): Promise<void> {
  if (!tab) return;
  if (on) await api.runtime.sendMessage({ type: 'unshare', tabId: tab.id });
  else {
    const pattern = originPattern(tab.url);
    // The browser shows its own prompt for this one site.
    if (!pattern || !(await api.permissions.request({ origins: [pattern] }))) {
      $('state').textContent = 'Nova was not allowed on this site.';
      return;
    }
    const r = (await api.runtime.sendMessage({ type: 'share', tabId: tab.id })) as {
      ok: boolean;
      error?: string;
    };
    if (!r.ok) $('state').textContent = r.error ?? 'The tab could not be shared.';
  }
  await render();
}

$('reconnect').onclick = () => void api.runtime.sendMessage({ type: 'reconnect' }).then(render);
void render();
