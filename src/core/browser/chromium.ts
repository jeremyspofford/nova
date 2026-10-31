// Finding and starting Chromium for browser work (M5 plan §3). Nova brings no browser of its own:
// it uses the one named by NOVA_CHROMIUM (or CHROMIUM), or one in a known install path, and says
// plainly when there is none. Each task gets a fresh, throwaway profile, and the browser is
// reached only over its debugging pipe.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { trackChild } from '../children.ts';
import { accessSync, constants, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { Cdp, pipeTransport } from './cdp.ts';

const KNOWN = [
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/lib/chromium/chromium', '/snap/bin/chromium',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

const runnable = (p: string) => { try { accessSync(p, constants.X_OK); return true; } catch { return false; } };

// Where Playwright puts its browsers (a developer machine, the Playwright image): the newest first.
function playwrightBrowsers(env: NodeJS.ProcessEnv): string[] {
  const roots = [env.PLAYWRIGHT_BROWSERS_PATH, '/ms-playwright', join(homedir(), '.cache', 'ms-playwright')].filter((x): x is string => !!x);
  const out: string[] = [];
  for (const root of roots) {
    let names: string[] = [];
    try { names = readdirSync(root); } catch { continue; }
    for (const n of names.filter((x) => /^chromium-\d+$/.test(x)).sort().reverse()) out.push(join(root, n, 'chrome-linux', 'chrome'), join(root, n, 'chrome-linux64', 'chrome'));
  }
  return out;
}

export interface Found { path: string | null; from: string; detail: string }

// Whether a browser there can start at all (a copy missing its system libraries can't), asked
// once per path: `--version` loads everything the browser needs and opens no window.
const probed = new Map<string, string | null>();
function cannotStart(path: string): string | null {
  if (!probed.has(path)) {
    const r = spawnSync(path, ['--version'], { timeout: 10_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    probed.set(path, r.error ? r.error.message : r.status === 0 ? null : lastLine(r.stderr || r.stdout || `exit ${r.status}`) || `exit ${r.status}`);
  }
  return probed.get(path) ?? null;
}

export function findChromium(env: NodeJS.ProcessEnv = process.env): Found {
  for (const name of ['NOVA_CHROMIUM', 'CHROMIUM'] as const) {
    const v = env[name]?.trim();
    if (!v) continue;
    // A path the person named and that isn't there is said as such, not silently replaced.
    if (!existsSync(v) || !runnable(v)) return { path: null, from: name, detail: `${name} names ${v}, and there is no runnable browser there.` };
    const why = cannotStart(v);
    if (why) return { path: null, from: name, detail: `${name} names ${v}, and it can’t start here: ${why}` };
    return { path: v, from: name, detail: `Chromium at ${v} (from ${name}).` };
  }
  const found = [...KNOWN, ...playwrightBrowsers(env)].filter((p) => existsSync(p) && runnable(p));
  for (const p of found) if (!cannotStart(p)) return { path: p, from: 'known path', detail: `Chromium at ${p}.` };
  if (found.length) return { path: null, from: 'none', detail: `Browser work is unavailable: the Chromium at ${found[0]} can’t start on this machine (${cannotStart(found[0]!)}). Install Chromium, or set NOVA_CHROMIUM to one that runs.` };
  return { path: null, from: 'none', detail: 'Browser work is unavailable: Nova found no Chromium on this machine. Install Chromium, or set NOVA_CHROMIUM to its path.' };
}

export interface LaunchOptions {
  path: string;
  // Hosts the browser may reach directly; everything else is sent to `refuser`, which turns it away.
  bypass: string[];
  refuser: string;
  width?: number;
  height?: number;
  // Chromium's own sandbox. Off only when asked (a container without user namespaces, root).
  sandbox?: boolean;
}

export interface Launched { cdp: Cdp; proc: ChildProcess; profile: string; stderr: () => string; close: () => Promise<void> }

// Each task's profile is a fresh folder in the temp folder, removed when its browser closes. One
// left behind (Nova killed, the machine off) may hold the person's cookies from a takeover, so
// Nova sweeps them at start. A profile names the process that made it (OWNER), and Chromium's own
// lock names the one using it; one whose process is still alive is left alone.
export const PROFILE_PREFIX = 'nova-browser-';
const OWNER = '.nova-owner';
// A profile that names no process (made before profiles named one) is left alone this long.
const UNMARKED_STALE_MS = 2 * 60 * 60_000;

const alive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
};

export function sweepProfiles(dir: string = tmpdir(), o: { now?: number; isAlive?: (pid: number) => boolean } = {}): string[] {
  const live = o.isAlive ?? alive;
  const now = o.now ?? Date.now();
  const removed: string[] = [];
  let names: string[] = [];
  try { names = readdirSync(dir).filter((n) => n.startsWith(PROFILE_PREFIX)); } catch { return removed; }
  for (const n of names) {
    const path = join(dir, n);
    try {
      const st = lstatSync(path);
      // Only folders, and only this user's: never follow a link, never touch someone else's.
      if (!st.isDirectory() || (process.getuid && st.uid !== process.getuid())) continue;
      const owner = (() => { try { return Number(readFileSync(join(path, OWNER), 'utf8').trim()); } catch { return null; } })();
      const locker = (() => { try { return Number(/-(\d+)$/.exec(readlinkSync(join(path, 'SingletonLock')))?.[1]); } catch { return null; } })();
      if ((owner !== null && live(owner)) || (locker !== null && live(locker))) continue;
      if (owner === null && locker === null && now - st.mtimeMs < UNMARKED_STALE_MS) continue;
      rmSync(path, { recursive: true, force: true });
      removed.push(path);
    } catch { /* gone meanwhile, or not ours to remove */ }
  }
  return removed;
}

// Chromium looks up no name but the declared hosts' (and only those resolve): an undeclared name
// can't even be asked of DNS, which would tell whoever answers it where the page wanted to go.
// Ports and brackets don't belong in a rule; a wildcard stays one.
export function resolverRules(hosts: readonly string[]): string {
  const names = [...new Set(hosts.map((h) => h.trim().toLowerCase().replace(/:\d{1,5}$/, '').replace(/^\[|\]$/g, '')).filter(Boolean))];
  return ['MAP * ~NOTFOUND', ...names.map((n) => `EXCLUDE ${n}`)].join(', ');
}

export async function launch(o: LaunchOptions): Promise<Launched> {
  const profile = mkdtempSync(join(tmpdir(), PROFILE_PREFIX));
  writeFileSync(join(profile, OWNER), String(process.pid));
  const width = o.width ?? 1280;
  const height = o.height ?? 800;
  const args = [
    '--headless=new', '--remote-debugging-pipe', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-default-apps', '--disable-extensions', '--disable-sync',
    // Chromium's own calls home (updates, safe browsing, metrics, translation) stay off: the only
    // traffic is the pages the task opens.
    '--disable-background-networking', '--disable-component-update', '--disable-domain-reliability', '--disable-client-side-phishing-detection',
    '--no-pings', '--metrics-recording-only', '--disable-breakpad', '--disable-crash-reporter', '--password-store=basic', '--use-mock-keychain',
    '--disable-component-extensions-with-background-pages', '--disable-field-trial-config', '--disable-search-engine-choice-screen', '--no-service-autorun',
    '--disable-features=Translate,OptimizationHints,MediaRouter,AutofillServerCommunication,InterestFeedContentSuggestions,CertificateTransparencyComponentUpdater,SafeBrowsing,NetworkTimeServiceQuerying,PrivacySandboxSettings4,DialMediaRouteProvider',
    '--mute-audio', '--hide-scrollbars', `--window-size=${width},${height}`,
    // A second wall behind the request interception: what CDP Fetch can't see (WebSockets, for
    // one) goes to a proxy that refuses it, unless its host is one the task declared. WebRTC may
    // not go around the proxy.
    `--proxy-server=${o.refuser}`, `--proxy-bypass-list=${['<-loopback>', ...o.bypass].join(';')}`,
    `--host-resolver-rules=${resolverRules(o.bypass)}`,
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--webrtc-ip-handling-policy=disable_non_proxied_udp',
    ...(o.sandbox === false ? ['--no-sandbox'] : []),
    'about:blank',
  ];
  const proc = trackChild(spawn(o.path, args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] }));
  let err = '';
  (proc.stderr as Readable).on('data', (d: Buffer) => { err = (err + String(d)).slice(-4000); });
  const failed = new Promise<never>((_, fail) => {
    proc.once('error', (e) => fail(new Error(`Chromium at ${o.path} didn't start: ${e.message}`)));
    proc.once('exit', (code, sig) => fail(new Error(`Chromium at ${o.path} stopped at once (${sig ?? `exit ${code}`}). ${lastLine(err)}`.trim())));
  });
  failed.catch(() => {});
  const cdp = new Cdp(pipeTransport(proc.stdio[3] as Writable, proc.stdio[4] as Readable));
  const close = async () => {
    try { if (!cdp.closed) await Promise.race([cdp.send('Browser.close', {}, undefined, { timeoutMs: 2000 }), new Promise((r) => setTimeout(r, 2000))]); } catch { /* it may be gone already */ }
    cdp.close();
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill('SIGTERM');
      await Promise.race([new Promise((r) => proc.once('exit', r)), new Promise((r) => setTimeout(r, 3000))]);
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
    }
    // Chromium's helper processes may still be writing as it goes: removing retries a few times.
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* best effort: it is in the temp folder */ }
  };
  try {
    await Promise.race([cdp.send('Browser.getVersion', {}, undefined, { timeoutMs: 20_000 }), failed]);
  } catch (e) {
    await close();
    throw e instanceof Error && /Chromium at/.test(e.message) ? e : new Error(`Chromium at ${o.path} didn't answer: ${(e as Error).message}. ${lastLine(err)}`.trim());
  }
  return { cdp, proc, profile, stderr: () => err, close };
}

const lastLine = (s: string) => s.trim().split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 300);
