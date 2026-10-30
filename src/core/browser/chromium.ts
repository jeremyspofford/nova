// Finding and starting Chromium for browser work (M5 plan §3). Nova brings no browser of its own:
// it uses the one named by NOVA_CHROMIUM (or CHROMIUM), or one in a known install path, and says
// plainly when there is none. Each task gets a fresh, throwaway profile, and the browser is
// reached only over its debugging pipe.
import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
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

export function findChromium(env: NodeJS.ProcessEnv = process.env): Found {
  for (const name of ['NOVA_CHROMIUM', 'CHROMIUM'] as const) {
    const v = env[name]?.trim();
    if (!v) continue;
    // A path the person named and that isn't there is said as such, not silently replaced.
    if (!existsSync(v) || !runnable(v)) return { path: null, from: name, detail: `${name} names ${v}, and there is no runnable browser there.` };
    return { path: v, from: name, detail: `Chromium at ${v} (from ${name}).` };
  }
  for (const p of [...KNOWN, ...playwrightBrowsers(env)]) {
    if (existsSync(p) && runnable(p)) return { path: p, from: 'known path', detail: `Chromium at ${p}.` };
  }
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

export async function launch(o: LaunchOptions): Promise<Launched> {
  const profile = mkdtempSync(join(tmpdir(), 'nova-browser-'));
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
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--webrtc-ip-handling-policy=disable_non_proxied_udp',
    ...(o.sandbox === false ? ['--no-sandbox'] : []),
    'about:blank',
  ];
  const proc = spawn(o.path, args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
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
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* best effort: it is in the temp folder */ }
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
