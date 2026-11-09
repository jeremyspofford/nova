// The M3 gate drives the real PWA in Chromium against the real server process. Chromium is found
// at $CHROMIUM, or where `playwright-core install chromium` puts it. With no usable browser the
// suite is skipped with a loud notice on a developer machine, and fails in CI: the gate never
// passes by not running. scripts/ui-test.sh runs it in a container that has the browser.
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, webkit, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { ROOT, blank } from '../acceptance/support.ts';
import { PASSKEY, enrollPasskeys } from '../acceptance/passkey-support.ts';

export { ROOT, blank, PASSKEY };

const CI = !!process.env.CI;

// A test passkey (Insertion #3 T2): tier 3 on Nova's own screen needs one, so every test browser
// gets this software authenticator in place of the platform's, and finishSetup enrolls two
// credentials for it (passkey-support.ts, the same key Node signs with). It signs as a page opened at localhost would (the console's relying party);
// the server checks every signature for real. `window.__novaPasskey = { mode: 'hang' | 'cancel' }`
// makes it wait until stopped, or refuse, as a person would.
const authenticator = (o: { jwk: object; spki: string; base: number }) => {
  const enc = new TextEncoder();
  const b64u = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const unb = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  // A console of another node at the same address (a standby at http://localhost:4317 on its own
  // machine) is said with `__novaPasskey.origin`; tests on one machine run nodes on different ports.
  const origin = () => (window as unknown as { __novaPasskey?: { origin?: string } }).__novaPasskey?.origin ?? location.origin.replace('//127.0.0.1', '//localhost');
  // WebAuthn and WebCrypto exist only in a secure context; elsewhere there is nothing to stand in for.
  if (!globalThis.crypto?.subtle) return;
  let imported: Promise<CryptoKey> | null = null;
  const key = () => (imported ??= crypto.subtle.importKey('jwk', o.jwk as JsonWebKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']));
  const int = (b: Uint8Array) => { let i = 0; while (i < b.length - 1 && b[i] === 0 && !(b[i + 1]! & 0x80)) i++; const t = [...b.slice(i)]; return t[0]! & 0x80 ? [0, ...t] : t; };
  const der = (raw: ArrayBuffer) => { const v = new Uint8Array(raw); const r = int(v.slice(0, 32)); const s = int(v.slice(32)); return new Uint8Array([0x30, r.length + s.length + 4, 0x02, r.length, ...r, 0x02, s.length, ...s]); };
  const hash = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource));
  const person = (signal?: AbortSignal) => new Promise<void>((ok, no) => {
    const mode = (window as unknown as { __novaPasskey?: { mode?: string } }).__novaPasskey?.mode;
    const refuse = () => no(new DOMException('The operation either timed out or was not allowed.', 'NotAllowedError'));
    if (mode === 'cancel') return refuse();
    if (mode === 'hang') { signal?.addEventListener('abort', refuse); return; }
    ok();
  });
  const get = async ({ publicKey: p, signal }: { publicKey: { challenge: Uint8Array; rpId: string; allowCredentials: { id: Uint8Array }[] }; signal?: AbortSignal }) => {
    await person(signal);
    const count = new Uint8Array(4); new DataView(count.buffer).setUint32(0, Date.now() - o.base + 2);
    const auth = new Uint8Array([...await hash(enc.encode(p.rpId)), 0x05, ...count]);
    const cdj = enc.encode(JSON.stringify({ type: 'webauthn.get', challenge: b64u(p.challenge), origin: origin() }));
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, await key(), new Uint8Array([...auth, ...await hash(cdj)]));
    const id = b64u(p.allowCredentials[0]!.id);
    return { id, rawId: unb(id).buffer, type: 'public-key', response: { authenticatorData: auth.buffer, clientDataJSON: cdj.buffer, signature: der(sig).buffer, userHandle: null } };
  };
  const create = async ({ publicKey: p, signal }: { publicKey: { challenge: Uint8Array; rp: { id: string } }; signal?: AbortSignal }) => {
    await person(signal);
    const cred = crypto.getRandomValues(new Uint8Array(32));
    const auth = new Uint8Array([...await hash(enc.encode(p.rp.id)), 0x45, 0, 0, 0, 0, ...new Uint8Array(16), 0, cred.length, ...cred, 0xa0]);
    const cdj = enc.encode(JSON.stringify({ type: 'webauthn.create', challenge: b64u(p.challenge), origin: origin() }));
    const spki = Uint8Array.from(atob(o.spki), (c) => c.charCodeAt(0));
    return { id: b64u(cred), rawId: cred.buffer, type: 'public-key', response: { clientDataJSON: cdj.buffer, getPublicKey: () => spki.buffer, getAuthenticatorData: () => auth.buffer } };
  };
  const w = window as unknown as { PublicKeyCredential?: unknown };
  w.PublicKeyCredential ??= function PublicKeyCredential() {};
  if (!navigator.credentials) Object.defineProperty(navigator, 'credentials', { value: {}, configurable: true });
  Object.defineProperty(navigator.credentials, 'get', { value: get, configurable: true });
  Object.defineProperty(navigator.credentials, 'create', { value: create, configurable: true });
};

// Where the test's Chromium is (also handed to Nova's browser worker as NOVA_CHROMIUM).
export const chromiumPath = (): string => process.env.CHROMIUM || chromium.executablePath();

// The browser, or a reason there isn't one.
export async function browser(): Promise<Browser | string> {
  const path = chromiumPath();
  if (!path || !existsSync(path)) return missing(`no Chromium at ${path || '(none)'}`);
  try {
    return await chromium.launch({ executablePath: path, args: ['--disable-background-networking'] });
  } catch (e) {
    return missing(`Chromium at ${path} would not start: ${(e as Error).message.split('\n')[0]}`);
  }
}

// WebKit, the engine every iPhone browser runs on, for what a phone does. The Playwright image
// carries it; elsewhere `playwright-core install webkit` puts it where this finds it.
export async function webkitBrowser(): Promise<Browser | string> {
  const path = webkit.executablePath();
  if (!path || !existsSync(path)) return missing(`no WebKit at ${path || '(none)'}`);
  try {
    return await webkit.launch();
  } catch (e) {
    return missing(`WebKit at ${path} would not start: ${(e as Error).message.split('\n')[0]}`);
  }
}

function missing(why: string): string {
  if (CI) throw new Error(`The M3 UI gate needs a browser in CI: ${why}`);
  const line = '!'.repeat(78);
  console.error(`\n${line}\n  M3 UI GATE SKIPPED: ${why}.\n  Run scripts/ui-test.sh (Docker) or set CHROMIUM=/path/to/chrome.\n${line}\n`);
  return why;
}

// Where evidence screenshots go: only when NOVA_UI_SHOTS names a folder (scripts/ui-test.sh sets
// docs/screenshots/m3), so a plain test run never rewrites tracked files.
export function shotsDir(): string | null {
  const dir = process.env.NOVA_UI_SHOTS;
  if (!dir) return null;
  const abs = resolve(ROOT, dir);
  mkdirSync(abs, { recursive: true });
  return abs;
}

// A browser context is one device: it gets its own device id, as the PWA keeps it in localStorage.
// `touch` makes it a phone you tap (touch events, no hover); `scheme` is the system's light or dark.
export async function device(b: Browser, { width = 1280, height = 820, id = `ui-test-${Math.random().toString(36).slice(2, 10)}`, scheme = 'light' as 'light' | 'dark', touch = false, timezone = '', serviceWorkers = 'allow' as 'allow' | 'block', scale = 1 } = {}): Promise<{ ctx: BrowserContext; page: Page; id: string; errors: string[] }> {
  const ctx = await b.newContext({ viewport: { width, height }, colorScheme: scheme, serviceWorkers, ...(touch ? { hasTouch: true, isMobile: true } : {}), ...(timezone ? { timezoneId: timezone } : {}), ...(scale !== 1 ? { deviceScaleFactor: scale } : {}) });
  await ctx.addInitScript((d) => { try { localStorage.setItem('nova.device', d); } catch { /* a sandboxed frame */ } }, id);
  await ctx.addInitScript(authenticator, { jwk: PASSKEY.jwk, spki: PASSKEY.spki, base: PASSKEY.base });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  return { ctx, page, id, errors };
}

export const ready = (page: Page) => page.waitForSelector('html[data-ready]');

// Hit targets that are short of `min` px tall (44 to a pointer), by the browser's own layout
// precision: WebKit lays boxes out in 1/64 px units (LayoutUnit), and getBoundingClientRect turns
// a 44 px box at a fractional position into 43.99993896 (#347, offsetHeight 44), so heights are
// read back at 1/64 px. That's not a tolerance: a box 1/64 px short still fails. Queried and measured
// in one task (a locator's two steps can be handed nodes a redraw has just replaced). `enabled`:
// skip disabled controls; `visible`: skip hidden ones; `label`: a control's target is its label.
export const LAYOUT_UNIT = 64;
export function shortTargets(page: Page, selector: string, { min = 44, enabled = true, visible = false, label = false } = {}): Promise<string[]> {
  return page.evaluate(({ selector, min, enabled, visible, label, unit }) => [...document.querySelectorAll<HTMLElement>(selector)]
    .filter((e) => (!enabled || !(e as HTMLInputElement).disabled) && (!visible || e.checkVisibility()))
    .map((e) => (label ? (e.closest('label') ?? e) : e) as HTMLElement)
    .filter((e) => Math.round(e.getBoundingClientRect().height * unit) / unit < min)
    .map((e) => e.outerHTML.slice(0, 80)), { selector, min, enabled, visible, label, unit: LAYOUT_UNIT });
}
// Before a screenshot: every finite animation (an entrance, a fade) has finished. The orb's
// breathing never finishes, so it doesn't count.
export const still = (page: Page) => page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getComputedTiming().iterations === Infinity));

// Waits until an async in-page check is truthy. page.waitForFunction doesn't await a predicate's
// promise: a Promise is truthy, so `waitForFunction(async () => false)` resolves at once (#356's phone
// navigation failure: the crawl's readiness had never waited). page.evaluate does await, so poll it.
// The default 30 s is waitForFunction's own; a navigation mid-poll (a destroyed context) polls again.
export async function until<A>(page: Page, check: (arg: A) => unknown, arg?: A, { timeout = 30_000, every = 50 } = {}): Promise<unknown> {
  const end = Date.now() + timeout;
  for (;;) {
    try {
      const v = await page.evaluate(check as (arg: unknown) => unknown, arg as unknown);
      if (v) return v;
    } catch (e) {
      if (!/Execution context was destroyed|navigat/i.test(String(e))) throw e;
    }
    if (Date.now() >= end) throw new Error(`Timed out after ${timeout} ms waiting for ${String(check).replace(/\s+/g, ' ').slice(0, 160)}`);
    await page.waitForTimeout(every);
  }
}
export const shoot = async (page: Page, path: string) => { await still(page); await page.screenshot({ path }); };
export const cssVar = (page: Page, name: string) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim().toLowerCase(), name);

// Setup answered over the API, for tests about everything after it.
export async function finishSetup(m: ReturnType<typeof blank>, { passkeys = true } = {}) {
  for (const text of ['new', 'yes', 'yes', 'Hi, I am Alex.', 'yes', 'keep', 'plainly', 'keep everything on this machine', 'no', 'no']) {
    const r = await m.send('POST', '/api/v1/setup/messages', { text });
    if (r.status !== 200) throw new Error(`setup answer "${text}" failed: ${JSON.stringify(r.body)}`);
  }
  if (passkeys) await enrollPasskeys(m.plain ?? m.send, m.base);
}
