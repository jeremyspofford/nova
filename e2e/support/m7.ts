// Shared steps of the M7 journey (J9): browser devices added through Add a device (each in its own
// browser context, so each has its own cookies and IndexedDB, as two computers would), the
// app's own navigation, a small Git repository for the cloud runner, the cloud runner itself
// (services/runner) on loopback, and an owner API client that keeps working while the owner's
// browser is offline. Every helper drives the UI where the UI offers the action.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  expect,
  request,
  type APIRequestContext,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test';
import { BwrapSubstrate, findOnPath } from '../../services/runner/src/index.ts';
import { until } from './m6.ts';

const RUNNER_MAIN = resolve('services/runner/src/main.ts');
const RUNNER_HOST = resolve('e2e/support/runner-host.ts');

/**
 * A link of the sidebar (desktop layouts). Settings and the modes carry their shortcut in their
 * name ("Settings Ctrl plus ,"), so those are matched by their first word.
 */
export const sidebarLink = (page: Page, name: string) =>
  page
    .getByRole('navigation', { name: 'Sidebar' })
    .getByRole('link', { name: new RegExp(`^${name}(?: (?:Ctrl|Alt|⌘|⌥).*)?$`) });

/** Settings → a section, through the sidebar and the settings navigation (no reload). */
export async function openSettings(page: Page, section: string) {
  await sidebarLink(page, 'Settings').click();
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('link', { name: section, exact: true })
    .click();
  await expect(page.getByRole('heading', { level: 2, name: section, exact: true })).toBeVisible();
}

/** The composer of the chat or session in `scope`: type and send. */
export async function send(scope: Page | Locator, text: string) {
  const box = scope.getByRole('textbox', { name: 'Message', exact: true });
  await box.fill(text);
  await box.press('Enter');
}

export interface DeviceJoin {
  /** The name the device gives itself on the join page (the owner sees "<name> wants to join"). */
  name: string;
  /** Scopes checked in Add a device ("Offline copy", "Local models", …). */
  scopes?: string[];
  /** Add a device → How it connects → Through the Relay. */
  relay?: boolean;
  /** Before the device opens its link (for example, to make the Hub's address unreachable). */
  before?: (device: Page) => Promise<void>;
}

/**
 * Devices → Add device → Client with `scopes` → Create code; the device opens the link in its own
 * browser context, asks to join, and the owner types the six digits it shows and approves. The
 * device then opens Nova signed in; its page is returned.
 */
export async function addBrowserDevice(
  owner: Page,
  ctx: BrowserContext,
  join: DeviceJoin,
): Promise<Page> {
  await sidebarLink(owner, 'Devices').click();
  await expect(owner.getByRole('heading', { level: 1, name: 'Devices' })).toBeVisible();
  await owner.getByRole('button', { name: 'Add device' }).first().click();
  await expect(owner.getByRole('heading', { level: 1, name: 'Add a device' })).toBeVisible();
  await expect(owner.getByRole('radio', { name: 'Client' })).toBeChecked();
  for (const scope of join.scopes ?? []) await owner.getByRole('checkbox', { name: scope }).check();
  if (join.relay) await owner.getByRole('radio', { name: 'Through the Relay' }).check();
  await owner.getByRole('button', { name: 'Create code' }).click();
  const link = (await owner
    .getByRole('region', { name: 'Or send the device this link' })
    .locator('code')
    .textContent())!;
  const device = await ctx.newPage();
  await join.before?.(device);
  await device.goto(link);
  await expect(device.getByRole('heading', { level: 1, name: 'Add this device' })).toBeVisible();
  await device.getByRole('textbox', { name: 'Name for this device' }).fill(join.name);
  await device.getByRole('button', { name: 'Ask to join' }).click();
  await expect(device.getByRole('heading', { level: 1, name: 'Approve on the Hub' })).toBeVisible({
    timeout: 20_000,
  });
  const digits = (await device.getByText(/^\d{3} \d{3}$/).textContent())!;
  const card = owner.getByRole('region', { name: `${join.name} wants to join` });
  await expect(card).toBeVisible({ timeout: 15_000 });
  await card.getByRole('textbox', { name: 'Code shown on the device' }).fill(digits);
  await card.getByRole('button', { name: 'Approve' }).click();
  await expect(
    owner.getByRole('heading', { level: 1, name: `${join.name} is added` }),
  ).toBeVisible();
  await expect(device.getByRole('heading', { level: 1, name: 'This device is added' })).toBeVisible(
    { timeout: 20_000 },
  );
  await device.getByRole('button', { name: 'Open Nova' }).click();
  await expect(device.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible({
    timeout: 20_000,
  });
  return device;
}

/**
 * Lets the journey end a page's open event streams as a lost network would: Chromium's offline
 * emulation (`context.setOffline`) fails new requests but keeps a stream that is already open
 * delivering events. Every EventSource the app opens is tracked; `goOffline` closes them and
 * reports the error, so the app reconnects (from its cursor when it has one) as after an outage.
 */
export async function droppableStreams(ctx: BrowserContext): Promise<void> {
  await ctx.addInitScript(() => {
    const Native = window.EventSource;
    const open = new Set<EventSource>();
    class Tracked extends Native {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        open.add(this);
      }
      override close(): void {
        open.delete(this);
        super.close();
      }
    }
    Object.defineProperty(window, 'EventSource', { value: Tracked, configurable: true });
    Object.defineProperty(window, '__novaDropStreams', {
      value: () => {
        for (const es of [...open]) {
          es.close();
          es.dispatchEvent(new Event('error'));
        }
      },
    });
  });
}

/** The network goes away for every page of `ctx`: requests fail and open event streams end. */
export async function goOffline(ctx: BrowserContext): Promise<void> {
  await ctx.setOffline(true);
  for (const p of ctx.pages())
    await p.evaluate(() =>
      (window as unknown as { __novaDropStreams?: () => void }).__novaDropStreams?.(),
    );
}

/**
 * An owner API client from Node, with the owner's session cookie: it keeps answering while the
 * owner's browser is offline, to read what the UI cannot show at that moment.
 */
export async function ownerApi(ctx: BrowserContext, baseURL: string): Promise<APIRequestContext> {
  return request.newContext({ baseURL, storageState: await ctx.storageState() });
}

/** Git with hooks, fsmonitor, system and global config off, and a fixed author. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args],
    {
      cwd,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: cwd,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_AUTHOR_NAME: 'Fixture Author',
        GIT_AUTHOR_EMAIL: 'fixture@example.com',
        GIT_COMMITTER_NAME: 'Fixture Author',
        GIT_COMMITTER_EMAIL: 'fixture@example.com',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}

/** A Git repository `<root>/<name>` with one commit of `files` on `main`; `executable` get mode 755. */
export function makeRepo(
  root: string,
  name: string,
  files: Record<string, string>,
  executable: readonly string[] = [],
): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), text, { mode: executable.includes(rel) ? 0o755 : 0o644 });
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'Initial commit');
  return dir;
}

// ---- the cloud runner -------------------------------------------------------------------------

export interface RunnerService {
  /** `http://127.0.0.1:<port>`: what Settings → Cloud runner takes (plain HTTP to this machine). */
  url: string;
  /** The Hub's token, as `nova-runner token add` printed it. */
  token: string;
  /** Folders `file://` repositories may come from (`--local-repos`). */
  repos: string;
  /** `bubblewrap` (the real sandbox) or `host test double` (no isolation). */
  substrate: 'bubblewrap' | 'host test double';
  stop(): Promise<void>;
}

/** Whether bubblewrap can make a sandbox here (it cannot in the Playwright container). */
async function bubblewrapWorks(): Promise<boolean> {
  const bin = findOnPath('bwrap');
  if (!bin || process.platform !== 'linux' || process.getuid?.() === 0) return false;
  return (await new BwrapSubstrate({ bin }).available()).ok;
}

/**
 * services/runner on 127.0.0.1 with a token made by its own CLI (`nova-runner token add`): the real
 * `nova-runner` on bubblewrap where that works, else the runner's server with the host test double
 * as its sandbox (e2e/support/runner-host.ts).
 */
export async function startRunnerService(): Promise<RunnerService> {
  const root = mkdtempSync(join(tmpdir(), 'nova-e2e-runner-'));
  const data = join(root, 'data');
  const repos = join(root, 'repos');
  const tokenFile = join(root, 'tokens');
  mkdirSync(repos);
  const add = spawnSync(
    process.execPath,
    [RUNNER_MAIN, 'token', 'add', '--data-dir', data, '--token-file', tokenFile, '--label', 'j9'],
    { encoding: 'utf8' },
  );
  const token = /nvrun_[A-Za-z0-9_-]{43}/.exec(add.stdout)?.[0];
  if (!token) throw new Error(`nova-runner token add failed: ${add.stderr}${add.stdout}`);
  const real = await bubblewrapWorks();
  const args = real
    ? [
        RUNNER_MAIN,
        '--host',
        '127.0.0.1',
        '--port',
        '0',
        '--data-dir',
        data,
        '--token-file',
        tokenFile,
        '--substrate',
        'bwrap',
        '--local-repos',
        repos,
      ]
    : [RUNNER_HOST, data, tokenFile, repos];
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (d: Buffer) => (out += d.toString()));
  child.stderr.on('data', (d: Buffer) => (err += d.toString()));
  const url = await until(
    'the cloud runner listens',
    () => {
      if (child.exitCode !== null) throw new Error(`the runner exited: ${err}`);
      return Promise.resolve(/Nova runner listening on (http:\/\/\S+)/.exec(out)?.[1]);
    },
    20_000,
  );
  return {
    url,
    token,
    repos,
    substrate: real ? 'bubblewrap' : 'host test double',
    stop: () =>
      new Promise<void>((r) => {
        if (child.exitCode !== null) return r();
        child.once('exit', () => r());
        child.kill('SIGTERM');
      }),
  };
}
