// Native-shell journey (docs/16 §3.3; FR-008, FR-009, FR-134, ADR-001): the desktop shell against a
// real Hub over HTTPS with its local CA. A wrong pin is refused before anything is sent; the
// right pin from an Add Device link verifies the Hub, the Hub's own join page signs the shell in
// once the owner approves, the web UI loads, a thread opens in a window of its own, the window
// never leaves the Hub, and quick chat sends a message to a new chat. With the Hub away, the web
// UI still opens from its offline copy and answers from local models through novad (FR-128).
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import {
  dataDirOf,
  launchShell,
  otherFingerprint,
  sendDeepLink,
  startFakeNovad,
  startTlsHub,
  type FakeNovad,
  type TestHub,
} from './support.ts';

test.describe.configure({ mode: 'serial' });

/** What a Hub window's page has (evaluated in the page; this file has no DOM types). */
interface InPage {
  novaShell: {
    openWindow(path: string): Promise<boolean>;
    localRuntime: {
      models(): Promise<{ ok: boolean; reason?: string; models: string[] }>;
      chat(
        req: { model: string; messages: { role: string; content: string }[] },
        onDelta: (text: string) => void,
      ): Promise<{ text: string }>;
    };
  };
  require?: unknown;
  location: { href: string };
}

let hub: TestHub;
let novad: FakeNovad;
/** The shell that joined the Hub: its data folder, for the offline start. */
let joined = '';
const apps: ElectronApplication[] = [];

test.beforeAll(async () => {
  hub = await startTlsHub();
  novad = await startFakeNovad();
  // The shell finds this computer's novad here (as configured in its settings).
  process.env.NOVA_LOCAL_RUNTIME_SOCKET = novad.socket;
});

test.afterAll(async () => {
  for (const a of apps) await a.close().catch(() => undefined);
  await hub?.stop();
  await novad?.stop();
});

async function shell(args: string[] = [], dataDir?: string): Promise<ElectronApplication> {
  const app = await launchShell(args, dataDir);
  apps.push(app);
  return app;
}

/** The next window the shell opens while `action` runs. */
async function nextWindow(app: ElectronApplication, action: () => Promise<unknown>): Promise<Page> {
  const [win] = await Promise.all([app.waitForEvent('window'), action()]);
  await win.waitForLoadState('domcontentloaded');
  return win;
}

test('refuses a Hub whose identity does not match the pinned fingerprint', async () => {
  const app = await shell();
  const connect = await app.firstWindow();
  await expect(connect).toHaveTitle('Connect to your Hub');
  const manual = connect.getByRole('form', { name: 'Enter the address and fingerprint' });
  await manual.getByLabel('Hub address').fill(hub.url);
  await manual.getByLabel('Hub fingerprint').fill(otherFingerprint());
  await manual.getByRole('button', { name: 'Connect' }).click();
  await expect(connect.getByRole('alert')).toContainText(
    'This is not the Hub you added: its identity does not match the fingerprint. Nothing was sent to it.',
  );
  // No Hub window was opened and nothing was remembered.
  expect(app.windows()).toHaveLength(1);
  const remembered = await app.evaluate(({ app: electronApp }) => {
    const fs = process.getBuiltinModule('node:fs');
    try {
      return fs.readFileSync(`${electronApp.getPath('userData')}/shell.json`, 'utf8');
    } catch {
      return null;
    }
  });
  expect(remembered).toBeNull();
});

test('joins through Add Device, opens a thread window, sends from quick chat, restarts and routes a link', async () => {
  // The owner adds a client on the Hub; the shell gets the native link (docs/04 §5.1).
  const start = await hub.api<{ deepLink: string; hubFingerprint: string }>(
    'POST',
    '/api/v1/devices/add/start',
    { role: 'client' },
  );
  expect(start.hubFingerprint).toBe(hub.fingerprint);
  const app = await shell([start.deepLink]);
  const connect = await app.firstWindow();
  await expect(connect).toHaveTitle('Connect to your Hub');
  // The link only fills the page: the user confirms before the shell talks to the Hub.
  await expect(connect.getByLabel('Add Device link')).toHaveValue(start.deepLink);
  const main = await nextWindow(app, () =>
    connect
      .getByRole('form', { name: 'Add this computer' })
      .getByRole('button', { name: 'Connect' })
      .click(),
  );

  // The Hub's own join page, over the pinned connection; the code came along in the fragment.
  await expect(main.getByRole('heading', { level: 1, name: 'Add this device' })).toBeVisible();
  expect(new URL(main.url()).origin).toBe(hub.url);
  await main.getByRole('textbox', { name: 'Name for this device' }).fill('Desktop shell');
  await main.getByRole('button', { name: 'Ask to join' }).click();
  await expect(main.getByRole('heading', { level: 1, name: 'Approve on the Hub' })).toBeVisible();
  const digits = (await main.getByText(/^\d{3} \d{3}$/).textContent())!.replace(' ', '');
  const pending = await hub.api<{ items: { id: string; name: string }[] }>(
    'GET',
    '/api/v1/devices/add/requests?status=pending',
  );
  const request = pending.items.find((r) => r.name === 'Desktop shell');
  expect(request).toBeDefined();
  await hub.api('POST', `/api/v1/devices/add/requests/${request!.id}/approve`, {
    confirmation: digits,
  });
  await expect(main.getByRole('heading', { level: 1, name: 'This device is added' })).toBeVisible({
    timeout: 20_000,
  });
  await main.getByRole('button', { name: 'Open Nova' }).click();
  // The owner set the Hub up through its API, so the web UI still offers onboarding.
  await main.getByRole('button', { name: 'Skip setup' }).click();
  await expect(main.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();

  // The bridge the web UI gets, and nothing more (FR-009); no Node in the page.
  expect(
    await main.evaluate(() => Object.keys((globalThis as unknown as InPage).novaShell)),
  ).toEqual(['version', 'platform', 'openWindow', 'shortcuts', 'setShortcut', 'localRuntime']);
  // Local models through this computer's novad, reached by the shell's main process (FR-128).
  expect(
    await main.evaluate(() => (globalThis as unknown as InPage).novaShell.localRuntime.models()),
  ).toEqual({ ok: true, models: ['qwen3:8b'] });
  expect(await main.evaluate(() => typeof (globalThis as unknown as InPage).require)).toBe(
    'undefined',
  );

  // A thread in a window of its own.
  const thread = await hub.api<{ id: string }>('POST', '/api/v1/threads', {
    title: 'Window of its own',
  });
  const second = await nextWindow(app, () =>
    main.evaluate(
      (id) => (globalThis as unknown as InPage).novaShell.openWindow(`/chat/${id}`),
      thread.id,
    ),
  );
  await expect(second).toHaveURL(`${hub.url}/chat/${thread.id}`);
  // Only app routes open: anything else is refused.
  expect(
    await main.evaluate(() =>
      (globalThis as unknown as InPage).novaShell.openWindow('https://example.com/'),
    ),
  ).toBe(false);

  // The window never leaves the Hub: a navigation to anything else is stopped (a web link would
  // go to the system browser instead, which a test must not open).
  await second.evaluate(() => {
    (globalThis as unknown as InPage).location.href = 'file:///etc/hostname';
  });
  await second.waitForTimeout(500);
  expect(await second.evaluate(() => (globalThis as unknown as InPage).location.href)).toBe(
    `${hub.url}/chat/${thread.id}`,
  );
  // Nor does it show the Hub's API at the top level: some of it serves untrusted documents (site
  // previews, app UIs) that must never run where `window.novaShell` lives.
  await second.evaluate((url) => {
    (globalThis as unknown as InPage).location.href = url;
  }, `${hub.url}/api/v1/health`);
  await second.waitForTimeout(500);
  expect(await second.evaluate(() => (globalThis as unknown as InPage).location.href)).toBe(
    `${hub.url}/chat/${thread.id}`,
  );

  // Quick chat (FR-008) from the shell's menu, sent to a new chat.
  const quick = await nextWindow(app, () =>
    app.evaluate(({ Menu }) => {
      Menu.getApplicationMenu()?.getMenuItemById('quick-chat')?.click();
    }),
  );
  await expect(quick).toHaveTitle('Quick chat');
  // The status list comes from the Hub (FR-215).
  await expect(quick.getByRole('list', { name: 'Status' })).toContainText('Window of its own');
  await quick.getByRole('textbox', { name: 'Message' }).fill('Hello from quick chat');
  await quick.getByRole('radio', { name: 'A new chat' }).check();
  await quick.getByRole('button', { name: 'Send' }).click();
  await expect(quick.getByRole('status')).toContainText('Sent to a new chat');
  await expect
    .poll(
      async () => {
        const page = await hub.api<{ items: { id: string }[] }>('GET', '/api/v1/threads?limit=50');
        for (const t of page.items) {
          const detail = await hub.api<{
            messages: { role: string; parts: { type: string; text?: string }[] }[];
          }>('GET', `/api/v1/threads/${t.id}`);
          if (
            detail.messages.some(
              (m) => m.role === 'user' && m.parts.some((p) => p.text === 'Hello from quick chat'),
            )
          )
            return t.id !== thread.id;
        }
        return false;
      },
      { timeout: 15_000 },
    )
    .toBe(true);

  // The pin is remembered: a restart verifies the Hub again and opens the UI, still signed in.
  const remembered = await app.evaluate(({ app: electronApp }) => {
    const fs = process.getBuiltinModule('node:fs');
    return JSON.parse(fs.readFileSync(`${electronApp.getPath('userData')}/shell.json`, 'utf8')) as {
      hub: { url: string; pin: string };
    };
  });
  expect(remembered.hub).toMatchObject({ url: hub.url, pin: hub.fingerprint });
  const dataDir = dataDirOf(app);
  joined = dataDir;
  await app.close();
  const again = await shell([], dataDir);
  const home = await again.firstWindow();
  await expect(home.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
  expect(new URL(home.url()).origin).toBe(hub.url);

  // A `nova://` link from a second launch goes to the running shell's window (docs/04 §5.1).
  await sendDeepLink(dataDir, 'nova://settings/keyboard');
  await expect(home).toHaveURL(`${hub.url}/settings/keyboard`);
  expect(again.windows()).toHaveLength(1);

  // An Add Device link for another Hub (any page can send one) never replaces this Hub on one
  // click: the shell names both and waits for an explicit choice, contacting nothing before.
  const other = otherFingerprint();
  const [connectAgain] = await Promise.all([
    again.waitForEvent('window'),
    sendDeepLink(
      dataDir,
      `nova://add-device?h=${encodeURIComponent('https://127.0.0.1:1')}&p=pair2&fp=${other}#c=ABCD-EFGH`,
    ),
  ]);
  await expect(connectAgain).toHaveTitle('Connect to your Hub');
  await expect(connectAgain.getByText(`This app uses the Hub at ${hub.url}.`)).toBeVisible();
  await connectAgain
    .getByRole('form', { name: 'Add this computer' })
    .getByRole('button', { name: 'Connect' })
    .click();
  const confirm = connectAgain.getByRole('region', { name: 'Replace your Hub?' });
  await expect(confirm).toContainText(
    `This replaces ${hub.url} with another Hub, https://127.0.0.1:1 (fingerprint ${other}).`,
  );
  await expect(
    confirm.getByRole('button', { name: `Replace ${hub.url} with https://127.0.0.1:1` }),
  ).toBeVisible();
  await confirm.getByRole('button', { name: 'Keep the current Hub' }).click();
  await expect(connectAgain.getByRole('status')).toHaveText('Nothing changed.');
  await expect(home).toHaveURL(`${hub.url}/settings/keyboard`);
});

test('opens the web UI while the Hub is away and answers from local models', async () => {
  expect(joined).not.toBe('');
  // One shell per data folder: the one still running would take this launch over.
  for (const a of apps.splice(0)) await a.close();
  await hub.stop();
  const app = await shell([], joined);
  const page = await app.firstWindow();
  // The Hub's own web UI, from its offline copy (its service worker): the page renders although
  // nothing reached the stopped Hub. (What it shows offline is the web UI's to decide.)
  await expect(page.locator('#root > *').first()).toBeVisible({ timeout: 20_000 });
  expect(new URL(page.url()).origin).toBe(hub.url);
  const out = await page.evaluate(async () => {
    const deltas: string[] = [];
    const res = await (globalThis as unknown as InPage).novaShell.localRuntime.chat(
      { model: 'qwen3:8b', messages: [{ role: 'user', content: 'hi' }] },
      (d) => deltas.push(d),
    );
    return { res, deltas };
  });
  expect(out).toEqual({ res: { text: 'Hello' }, deltas: ['Hel', 'lo'] });
  // The Hub took the grant back: refused with the reason, and chat says why.
  novad.mode = 'scope_missing';
  expect(
    await page.evaluate(() => (globalThis as unknown as InPage).novaShell.localRuntime.models()),
  ).toMatchObject({ ok: false, reason: 'scope_missing', models: [] });
  const refused = await page.evaluate(() =>
    (globalThis as unknown as InPage).novaShell.localRuntime
      .chat({ model: 'qwen3:8b', messages: [{ role: 'user', content: 'hi' }] }, () => undefined)
      .then(
        () => 'answered',
        (e: Error) => e.message,
      ),
  );
  expect(refused).toMatch(/has not granted this computer Local models/);
});
