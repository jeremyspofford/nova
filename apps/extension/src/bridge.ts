// The extension's background logic (FR-096, docs/11 §4.3; ADR-096 D8), written against the
// `ChromeApi` subset so tests can run it on a fake. It connects to novad's native-messaging host
// (registered only by `novad bridge enable`, for this extension only) and keeps the consents:
//   - Per-tab consent: the agent acts only in tabs the user shared from the popup, or tabs it
//     opened itself; those live in a "Nova" tab group. `tabs.list` lists only these, never the
//     user's other tabs.
//   - Every consented tab shows a badge; a controlled tab also shows the browser's own "being
//     debugged" banner (chrome.debugger), and cancelling that banner unshares the tab.
//   - Per-host permission: the extension has no host access by default. Sharing a tab asks the
//     browser for that site (a user click in the popup); `cdp.send` acts only on a page whose site
//     the browser granted, and `Page.navigate` only to one. Grants and withdrawals are reported to
//     the Hub, where the owner confirms them.
//   - Only the DevTools methods the Hub's tab driver uses pass. `Runtime.evaluate` runs only the
//     extension's own page scripts (scripts.ts), never an expression from upstream, and every
//     command runs only while the tab is on the host the Hub checked its grant for. Keys carry no
//     modifier but Shift (no paste, copy or cut of the user's clipboard). The extension has no
//     `cookies` permission and reads no passwords or page storage for export.
//   - History: no standing permission. Each `history.search` opens a prompt; only the user's
//     click there requests the `history` permission, which is removed again after the search.
import type { ChromeApi, NativePort } from './chrome.ts';
import {
  ALLOWED_CDP_METHODS,
  BridgeRefusal,
  MAX_MESSAGE_CHARS,
  NATIVE_HOST,
  hostOf,
  hostsOfOrigins,
  originPattern,
  parseCall,
  parseHostStatus,
  type BridgeEvent,
  type CallMessage,
} from './protocol.ts';
import { isScriptName, scriptExpression } from './scripts.ts';

const DEBUGGER_VERSION = '1.3';
const GROUP_TITLE = 'Nova';
const BADGE = 'NOVA';
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 5 * 60_000;
/** How long the history prompt waits for the user (the Hub waits 120 s). */
export const HISTORY_PROMPT_MS = 110_000;
const STATE_KEY = 'novaBridge';

export interface BridgeOptions {
  chrome: ChromeApi;
  /** The browser's name and version for the Hub's status (navigator.userAgent's product). */
  browser?: string;
  setTimer?: (fn: () => void, ms: number) => () => void;
  /** Ids for history prompts (tests). */
  newId?: () => string;
}

export interface TabStatus {
  tabId: number;
  host: string | null;
  shared: boolean;
  agent: boolean;
  attached: boolean;
  permitted: boolean;
}

export interface BridgeStatus {
  connected: boolean;
  lastError: string | null;
  browser: string;
  version: string;
  tabs: {
    tabId: number;
    host: string | null;
    title: string;
    origin: 'shared' | 'agent';
    loading: boolean;
    pendingHost: string | null;
  }[];
}

interface Shared {
  url: string;
  title: string;
}

function defaultTimer(fn: () => void, ms: number): () => void {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
}

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}

export class Bridge {
  readonly #c: ChromeApi;
  readonly #browser: string;
  readonly #setTimer: (fn: () => void, ms: number) => () => void;
  readonly #newId: () => string;
  #port: NativePort | null = null;
  #retryMs = RETRY_MIN_MS;
  #cancelRetry: (() => void) | null = null;
  #lastError: string | null = null;
  #hostState: 'unknown' | 'connected' | 'refused' = 'unknown';
  readonly #shared = new Map<number, Shared>();
  readonly #agent = new Set<number>();
  readonly #attached = new Set<number>();
  #groupId: number | null = null;
  readonly #prompts = new Map<string, (allow: boolean) => void>();
  #seq = 0;

  constructor(opts: BridgeOptions) {
    this.#c = opts.chrome;
    this.#browser = (opts.browser ?? 'Chromium').slice(0, 80);
    this.#setTimer = opts.setTimer ?? defaultTimer;
    this.#newId = opts.newId ?? (() => `${Date.now().toString(36)}-${++this.#seq}`);
  }

  /** Restore the consents (the worker may have restarted), listen, and connect. */
  async start(): Promise<void> {
    await this.#restore();
    const c = this.#c;
    c.tabs.onRemoved.addListener((tabId) => void this.#tabGone(tabId));
    c.debugger.onDetach.addListener((source, reason) => void this.#detached(source.tabId, reason));
    c.permissions.onAdded.addListener((p) => {
      for (const host of hostsOfOrigins(p.origins)) this.#emit({ kind: 'host.granted', host });
    });
    c.permissions.onRemoved.addListener((p) => void this.#permissionsRemoved(p.origins));
    c.runtime.onMessage.addListener((message, _sender, respond) => {
      void this.handleUi(message).then(respond, (err: unknown) =>
        respond({ ok: false, error: errorText(err) }),
      );
      return true;
    });
    this.connect();
  }

  // ---- the native host -------------------------------------------------------------------------

  /** The host is up and novad took it (until the host says otherwise, an open port counts). */
  get connected(): boolean {
    return this.#port !== null && this.#hostState !== 'refused';
  }

  connect(): void {
    this.#cancelRetry?.();
    this.#cancelRetry = null;
    let port: NativePort;
    try {
      port = this.#c.runtime.connectNative(NATIVE_HOST);
    } catch (err) {
      this.#lastError = errorText(err);
      this.#retry();
      return;
    }
    this.#port = port;
    this.#hostState = 'unknown';
    port.onMessage.addListener((m) => void this.#onHostMessage(m));
    port.onDisconnect.addListener(() => {
      if (this.#port !== port) return;
      this.#port = null;
      this.#lastError = this.#c.runtime.lastError?.message ?? 'the Nova host closed the connection';
      this.#retry();
    });
    void this.#resync();
  }

  #retry(): void {
    const wait = this.#retryMs;
    this.#retryMs = Math.min(this.#retryMs * 2, RETRY_MAX_MS);
    this.#cancelRetry = this.#setTimer(() => this.connect(), wait);
  }

  /**
   * After (re)connecting, the Hub learns the consents again (novad reports `connected` itself,
   * and the Hub starts that connection without tabs).
   */
  async #resync(): Promise<void> {
    for (const [tabId, s] of this.#shared)
      this.#emit({ kind: 'tab.shared', tabId, host: hostOf(s.url), title: s.title });
    // The tabs the agent opened are consented too: the Hub hears of them again.
    for (const tabId of this.#agent) {
      const tab = await this.#c.tabs.get(tabId).catch(() => null);
      if (tab)
        this.#emit({
          kind: 'tab.shared',
          tabId,
          host: hostOf(tab.url),
          title: (tab.title ?? '').slice(0, 300),
          origin: 'agent',
        });
    }
    const all = await this.#c.permissions.getAll().catch(() => ({ origins: [] }));
    for (const host of hostsOfOrigins(all.origins)) this.#emit({ kind: 'host.granted', host });
  }

  #post(message: Record<string, unknown>): void {
    if (!this.#port) return;
    let text = JSON.stringify(message);
    if (text.length > MAX_MESSAGE_CHARS && message.type === 'result')
      text = JSON.stringify({
        type: 'error',
        id: message.id,
        error: { code: 'too_large', message: 'the answer is too large for the bridge' },
      });
    try {
      this.#port.postMessage(JSON.parse(text) as unknown);
    } catch (err) {
      this.#lastError = errorText(err);
    }
  }

  #emit(event: BridgeEvent): void {
    this.#post({ type: 'event', event });
  }

  async #onHostMessage(raw: unknown): Promise<void> {
    // The host's first word: whether novad took the connection, and why not (it then exits).
    const st = parseHostStatus(raw);
    if (st) {
      this.#hostState = st.connected ? 'connected' : 'refused';
      this.#lastError = st.connected ? null : st.reason;
      return;
    }
    const call = parseCall(raw);
    if (!call) return;
    // A message from the host proves the connection works: start over from a short wait.
    this.#retryMs = RETRY_MIN_MS;
    try {
      const result = await this.dispatch(call);
      this.#post({ type: 'result', id: call.id, result });
    } catch (err) {
      this.#post({
        type: 'error',
        id: call.id,
        error: {
          code: err instanceof BridgeRefusal ? err.code : 'failed',
          message: errorText(err),
        },
      });
    }
  }

  // ---- calls from the Hub ----------------------------------------------------------------------

  #consented(tabId: unknown): number {
    if (typeof tabId !== 'number' || !(this.#shared.has(tabId) || this.#agent.has(tabId)))
      throw new BridgeRefusal('tab_not_shared', 'that tab is not shared with Nova');
    return tabId;
  }

  async #permitted(url: string | undefined): Promise<boolean> {
    const pattern = originPattern(url);
    if (!pattern) return false;
    return this.#c.permissions.contains({ origins: [pattern] }).catch(() => false);
  }

  async dispatch(call: CallMessage): Promise<unknown> {
    const p = call.params;
    switch (call.method) {
      case 'tabs.list':
        return { tabs: await this.#list() };
      case 'tabs.open':
        return this.#open(p);
      case 'tab.attach':
        return this.#attach(this.#consented(p.tabId));
      case 'tab.detach':
        return this.#detach(this.#consented(p.tabId));
      case 'cdp.send':
        return this.#send(this.#consented(p.tabId), p.method, p.params, p.expectHost);
      case 'history.search':
        return this.#history(p.query, p.maxResults);
      default:
        throw new BridgeRefusal(
          'unknown_method',
          `${call.method.slice(0, 40)} is not a bridge method`,
        );
    }
  }

  async #list(): Promise<BridgeStatus['tabs']> {
    const out: BridgeStatus['tabs'] = [];
    for (const tabId of [...this.#shared.keys(), ...this.#agent]) {
      const tab = await this.#c.tabs.get(tabId).catch(() => null);
      if (!tab) continue;
      out.push({
        tabId,
        host: hostOf(tab.url),
        title: (tab.title ?? '').slice(0, 300),
        origin: this.#shared.has(tabId) ? 'shared' : 'agent',
        // Whether a navigation is under way, and to which site (the Hub waits for it).
        loading: tab.status === 'loading' || Boolean(tab.pendingUrl),
        pendingHost: tab.pendingUrl ? hostOf(tab.pendingUrl) : null,
      });
    }
    return out;
  }

  /** A new tab in the Nova group, on about:blank: the Hub navigates it through its checks. */
  async #open(p: Record<string, unknown>): Promise<{ tabId: number }> {
    if (p.url !== undefined && p.url !== 'about:blank')
      throw new BridgeRefusal('url_refused', 'the agent opens a blank tab and navigates it itself');
    const tab = await this.#c.tabs.create({ url: 'about:blank', active: false });
    if (typeof tab.id !== 'number') throw new BridgeRefusal('failed', 'the browser opened no tab');
    const tabId = tab.id;
    this.#agent.add(tabId);
    try {
      const groupId = await this.#c.tabs
        .group(
          this.#groupId === null
            ? { tabIds: [tabId] }
            : { tabIds: [tabId], groupId: this.#groupId },
        )
        .catch(() => this.#c.tabs.group({ tabIds: [tabId] }));
      if (groupId !== this.#groupId) {
        this.#groupId = groupId;
        await this.#c.tabGroups.update(groupId, { title: GROUP_TITLE, color: 'blue' });
      }
    } catch {
      // A browser without tab groups still marks the tab with the badge.
    }
    await this.#badge(tabId);
    await this.#save();
    return { tabId };
  }

  async #attach(tabId: number): Promise<{ attached: true }> {
    if (!this.#attached.has(tabId)) {
      try {
        await this.#c.debugger.attach({ tabId }, DEBUGGER_VERSION);
      } catch (err) {
        // The worker restarted while attached: the attachment is still ours.
        if (!/already attached/i.test(errorText(err))) throw err;
      }
      this.#attached.add(tabId);
    }
    await this.#badge(tabId);
    return { attached: true };
  }

  async #detach(tabId: number): Promise<{ detached: true }> {
    if (this.#attached.delete(tabId))
      await this.#c.debugger.detach({ tabId }).catch(() => undefined);
    await this.#badge(tabId);
    return { detached: true };
  }

  /**
   * One DevTools command on a controlled tab. The Hub says which host it checked its grant for
   * (`expectHost`, null for about:blank); the tab must be on exactly that host now, also counting
   * a navigation still pending, or nothing is sent. Page scripts are ours (scripts.ts), named by
   * the Hub and run only on that host. Keys and clicks carry no modifier but Shift, and no editor
   * command, so the user's clipboard is never pasted, copied or cut.
   */
  async #send(
    tabId: number,
    rawMethod: unknown,
    rawParams: unknown,
    rawExpect: unknown,
  ): Promise<unknown> {
    const method = typeof rawMethod === 'string' ? rawMethod : '';
    if (!ALLOWED_CDP_METHODS.includes(method))
      throw new BridgeRefusal(
        'method_refused',
        `${method.slice(0, 60) || 'that method'} is not allowed`,
      );
    if (!this.#attached.has(tabId)) throw new BridgeRefusal('not_attached', 'attach the tab first');
    if (rawExpect !== null && typeof rawExpect !== 'string')
      throw new BridgeRefusal('host_unknown', 'the call does not say which site it is for');
    const expectHost = rawExpect === null ? null : rawExpect.toLowerCase();
    const params =
      typeof rawParams === 'object' && rawParams !== null && !Array.isArray(rawParams)
        ? (rawParams as Record<string, unknown>)
        : {};
    const tab = await this.#c.tabs.get(tabId);
    const now = tab.pendingUrl || tab.url || '';
    const nowHost = now === 'about:blank' ? null : hostOf(now);
    if (now !== 'about:blank' && !nowHost)
      throw new BridgeRefusal('not_web', 'the tab shows a page that is not a web site');
    if (nowHost !== expectHost)
      throw new BridgeRefusal('host_changed', 'the tab is no longer on the site the call was for');
    if (nowHost !== null && !(await this.#permitted(now)))
      throw new BridgeRefusal('host_not_permitted', `${nowHost} is not allowed in this browser`);
    let send: Record<string, unknown> = params;
    switch (method) {
      case 'Runtime.evaluate': {
        if (params.expression !== undefined || !isScriptName(params.script))
          throw new BridgeRefusal('script_refused', 'only the extension’s own page scripts run');
        send = {
          expression: scriptExpression(params.script, params.arg, expectHost),
          returnByValue: true,
          awaitPromise: true,
          timeout: typeof params.timeout === 'number' ? Math.min(params.timeout, 30_000) : 15_000,
        };
        break;
      }
      case 'Page.navigate': {
        const target = typeof params.url === 'string' ? params.url : '';
        if (!(await this.#permitted(target)))
          throw new BridgeRefusal(
            'host_not_permitted',
            `${hostOf(target) ?? 'that address'} is not allowed in this browser`,
          );
        send = { url: target };
        break;
      }
      case 'Input.dispatchKeyEvent':
      case 'Input.dispatchMouseEvent': {
        const mods = typeof params.modifiers === 'number' ? params.modifiers : 0;
        // 1 Alt, 2 Control, 4 Meta: shortcuts such as paste, copy and cut. Shift (8) is typing.
        if ((mods & 7) !== 0 || params.commands !== undefined)
          throw new BridgeRefusal('key_refused', 'only Shift may be held, and no editor command');
        break;
      }
    }
    return this.#c.debugger.sendCommand({ tabId }, method, send);
  }

  /** One history search, after the user's yes in our own prompt; no permission is kept. */
  async #history(rawQuery: unknown, rawMax: unknown): Promise<{ items: unknown[] }> {
    const query = typeof rawQuery === 'string' ? rawQuery.trim().slice(0, 200) : '';
    if (!query) throw new BridgeRefusal('invalid', 'a search needs some text');
    const max = typeof rawMax === 'number' ? Math.min(Math.max(Math.floor(rawMax), 1), 50) : 20;
    const id = this.#newId();
    const answer = new Promise<boolean>((resolve) => {
      const cancel = this.#setTimer(() => {
        this.#prompts.delete(id);
        resolve(false);
      }, HISTORY_PROMPT_MS);
      this.#prompts.set(id, (allow) => {
        cancel();
        this.#prompts.delete(id);
        resolve(allow);
      });
    });
    await this.#c.windows.create({
      url: this.#c.runtime.getURL(
        `prompt.html?id=${encodeURIComponent(id)}&q=${encodeURIComponent(query)}`,
      ),
      type: 'popup',
      width: 440,
      height: 280,
    });
    if (!(await answer)) throw new BridgeRefusal('declined', 'the user did not allow this search');
    try {
      const history = this.#c.history;
      if (!history) throw new BridgeRefusal('declined', 'the browser did not grant history access');
      const items = await history.search({ text: query, maxResults: max, startTime: 0 });
      return {
        // Titles and sites only, as the prompt says: full addresses can carry tokens.
        items: items.slice(0, max).map((h) => ({
          title: (h.title ?? '').slice(0, 300),
          host: hostOf(h.url),
          lastVisit:
            typeof h.lastVisitTime === 'number' ? new Date(h.lastVisitTime).toISOString() : null,
        })),
      };
    } finally {
      await this.#c.permissions.remove({ permissions: ['history'] }).catch(() => false);
    }
  }

  // ---- the user's side: popup, prompt, the browser's own events ---------------------------------

  /** Messages from the popup and the history prompt (our own pages only). */
  async handleUi(raw: unknown): Promise<unknown> {
    const m = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    switch (m.type) {
      case 'status':
        return this.status(typeof m.tabId === 'number' ? m.tabId : null);
      case 'share':
        return this.share(Number(m.tabId));
      case 'unshare':
        return this.unshare(Number(m.tabId));
      case 'history.answer': {
        const settle = typeof m.id === 'string' ? this.#prompts.get(m.id) : undefined;
        settle?.(m.allow === true);
        return { ok: settle !== undefined };
      }
      case 'reconnect':
        this.#retryMs = RETRY_MIN_MS;
        if (!this.#port) this.connect();
        return { ok: true };
      default:
        return { ok: false, error: 'unknown message' };
    }
  }

  async status(tabId: number | null): Promise<BridgeStatus & { tab: TabStatus | null }> {
    let tab: TabStatus | null = null;
    if (tabId !== null) {
      const t = await this.#c.tabs.get(tabId).catch(() => null);
      if (t)
        tab = {
          tabId,
          host: hostOf(t.url),
          shared: this.#shared.has(tabId),
          agent: this.#agent.has(tabId),
          attached: this.#attached.has(tabId),
          permitted: await this.#permitted(t.url),
        };
    }
    return {
      connected: this.connected,
      lastError: this.#lastError,
      browser: this.#browser,
      version: this.#c.runtime.getManifest().version,
      tabs: await this.#list(),
      tab,
    };
  }

  /** Share a tab (the popup asked the browser for its site first, in the user's click). */
  async share(tabId: number): Promise<{ ok: boolean; error?: string }> {
    const tab = await this.#c.tabs.get(tabId).catch(() => null);
    if (!tab || typeof tab.id !== 'number') return { ok: false, error: 'that tab is gone' };
    if (!hostOf(tab.url)) return { ok: false, error: 'only web pages can be shared' };
    if (!(await this.#permitted(tab.url)))
      return { ok: false, error: 'allow Nova on this site first' };
    const shared = { url: tab.url ?? '', title: (tab.title ?? '').slice(0, 300) };
    this.#shared.set(tabId, shared);
    await this.#badge(tabId);
    await this.#save();
    // The host only: the address can carry tokens.
    this.#emit({ kind: 'tab.shared', tabId, host: hostOf(shared.url), title: shared.title });
    return { ok: true };
  }

  async unshare(tabId: number): Promise<{ ok: boolean }> {
    const was = this.#shared.delete(tabId) || this.#agent.delete(tabId);
    if (this.#attached.delete(tabId))
      await this.#c.debugger.detach({ tabId }).catch(() => undefined);
    await this.#badge(tabId);
    await this.#save();
    if (was) this.#emit({ kind: 'tab.unshared', tabId });
    return { ok: was };
  }

  async #tabGone(tabId: number): Promise<void> {
    this.#attached.delete(tabId);
    const was = this.#shared.delete(tabId) || this.#agent.delete(tabId);
    if (!was) return;
    await this.#save();
    this.#emit({ kind: 'tab.closed', tabId });
  }

  /** The user cancelled the debugging banner: that ends the consent for the tab. */
  async #detached(tabId: number, reason: string): Promise<void> {
    if (!this.#attached.delete(tabId)) return;
    if (reason === 'canceled_by_user') await this.unshare(tabId);
    else await this.#badge(tabId);
  }

  async #permissionsRemoved(origins: string[] | undefined): Promise<void> {
    const hosts = hostsOfOrigins(origins);
    for (const host of hosts) this.#emit({ kind: 'host.revoked', host });
    // A shared tab whose site the browser no longer allows is unshared at once.
    for (const [tabId, s] of [...this.#shared])
      if (hosts.includes('*') || hosts.includes(hostOf(s.url) ?? '')) await this.unshare(tabId);
  }

  async #badge(tabId: number): Promise<void> {
    const on = this.#shared.has(tabId) || this.#agent.has(tabId);
    const a = this.#c.action;
    await a.setBadgeText({ tabId, text: on ? BADGE : '' }).catch(() => undefined);
    if (on) await a.setBadgeBackgroundColor({ tabId, color: '#2457d6' }).catch(() => undefined);
    await a
      .setTitle({
        tabId,
        title: !on
          ? 'Nova'
          : this.#attached.has(tabId)
            ? 'Nova controls this tab'
            : 'Shared with Nova',
      })
      .catch(() => undefined);
  }

  // ---- state across worker restarts (session storage: gone when the browser closes) ----------

  async #save(): Promise<void> {
    await this.#c.storage.session
      .set({
        [STATE_KEY]: {
          shared: [...this.#shared],
          agent: [...this.#agent],
          groupId: this.#groupId,
        },
      })
      .catch(() => undefined);
  }

  async #restore(): Promise<void> {
    const got = await this.#c.storage.session.get(STATE_KEY).catch(() => ({}));
    const st = (got as Record<string, unknown>)[STATE_KEY] as
      { shared?: unknown; agent?: unknown; groupId?: unknown } | undefined;
    if (!st) return;
    if (Array.isArray(st.shared))
      for (const entry of st.shared as unknown[]) {
        if (!Array.isArray(entry)) continue;
        const [id, s] = entry as [unknown, unknown];
        const v = s as Partial<Shared> | null;
        if (typeof id === 'number' && v && typeof v.url === 'string')
          this.#shared.set(id, { url: v.url, title: typeof v.title === 'string' ? v.title : '' });
      }
    if (Array.isArray(st.agent))
      for (const id of st.agent as unknown[]) if (typeof id === 'number') this.#agent.add(id);
    if (typeof st.groupId === 'number') this.#groupId = st.groupId;
  }
}
