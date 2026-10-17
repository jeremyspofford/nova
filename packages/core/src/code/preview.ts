// Dev-server previews in the agent browser (FR-067, FR-097; docs/10 §7, docs/12 §4.2 and §8): the
// DevServerManager's late-bound grant and opener, implemented by the browser area. A dev server is
// published on the Hub's 127.0.0.1 by the sandbox bridge; the grant lets the browser of the session
// thread's computer (an agent's computer, else the thread's own `thread-<threadId>`) reach exactly
// that host and port through its egress proxy session, and the opener shows the server in that
// browser as the user's action, recorded in its action trace. Revoked when the server stops.
import type { BrowserCall } from '../browser/service.ts';
import type { ToolResult } from '../tools/types.ts';
import type { DevServerGrant, DevServerOpener } from './devservers.ts';

/** What the preview needs from the browser area (`BrowserService`). */
export interface DevServerBrowser {
  computerForThread(
    accountId: string,
    threadId: string | null,
    mode?: BrowserCall['mode'],
  ): Promise<string>;
  grantDevServer(input: {
    accountId: string;
    computerId: string;
    host: string;
    port: number;
  }): Promise<{ revoke(): Promise<void> }>;
  openDevServer(input: {
    accountId: string;
    threadId: string | null;
    url: string;
    computerId?: string;
  }): Promise<ToolResult>;
}

/** The dev-server grant for `DevServerManager.useGrant`: the session thread's browser only. */
export function browserDevServerGrant(browser: DevServerBrowser): DevServerGrant {
  return async (input) => {
    const computerId = await browser.computerForThread(input.accountId, input.threadId, 'code');
    const g = await browser.grantDevServer({
      accountId: input.accountId,
      computerId,
      host: input.host,
      port: input.port,
    });
    // The URL stays the bridge's own: the browser reaches it as it is.
    return { url: null, revoke: () => g.revoke() };
  };
}

/** The browser pane's opener for `DevServerManager.useOpener`; a refusal throws (logged). */
export function browserDevServerOpener(browser: DevServerBrowser): DevServerOpener {
  return async (input) => {
    const r = await browser.openDevServer({
      accountId: input.accountId,
      threadId: input.threadId,
      url: input.url,
    });
    if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  };
}
