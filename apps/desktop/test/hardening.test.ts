// Regression tests for the M7 desktop security review (M7REV_desktop) and the hold of requests
// to a Hub not verified yet (docs/21 §9).
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shellConnectSchema } from '@nova/shared';
import { externalUrl, permissionAllowed, RateLimiter } from '../src/allowlist.ts';
import { forkChannel, IsolatedRedactor, RedactTimeout } from '../src/capture/redact-service.ts';
import { replacementMessage, replacementOf } from '../src/connect.ts';
import { routeDeepLink } from '../src/deeplinks.ts';
import { RequestHold, type HoldOutcome } from '../src/hold.ts';
import { appPath, SETTINGS_SECTIONS, windowMayShow } from '../src/routes.ts';
import { reservedBySystem } from '../src/shortcuts.ts';

const WORKER = fileURLToPath(new URL('../src/capture/redact-worker.ts', import.meta.url));

describe('requests held while the Hub is not verified', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('holds requests until the Hub is verified, then lets them all out', () => {
    const onHold = vi.fn();
    const hold = new RequestHold({ onHold });
    const out: HoldOutcome[] = [];
    hold.hold((o) => out.push(o));
    hold.hold((o) => out.push(o));
    expect(out).toEqual([]);
    expect(hold.size).toBe(2);
    expect(onHold).toHaveBeenCalledTimes(2);
    hold.open();
    expect(out).toEqual([{ allow: true }, { allow: true }]);
    expect(hold.size).toBe(0);
  });

  it('fails a request that waited too long, with the reason', () => {
    vi.useFakeTimers();
    const denied: [number, string][] = [];
    const hold = new RequestHold({ timeoutMs: 8000, onDenied: (n, r) => denied.push([n, r]) });
    const out: HoldOutcome[] = [];
    hold.hold((o) => out.push(o));
    vi.advanceTimersByTime(7999);
    expect(out).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(out).toEqual([{ allow: false, reason: 'timeout' }]);
    expect(denied).toEqual([[1, 'timeout']]);
    expect(hold.size).toBe(0);
    // A later verification lets nothing out twice.
    hold.open();
    expect(out).toHaveLength(1);
  });

  it('refuses at once beyond its bound, and fails everything when the check fails', () => {
    vi.useFakeTimers();
    const denied: [number, string][] = [];
    const hold = new RequestHold({ limit: 2, onDenied: (n, r) => denied.push([n, r]) });
    const out: HoldOutcome[] = [];
    for (let i = 0; i < 3; i++) hold.hold((o) => out.push(o));
    expect(out).toEqual([{ allow: false, reason: 'full' }]);
    hold.fail('unreachable');
    expect(out.slice(1)).toEqual([
      { allow: false, reason: 'unreachable' },
      { allow: false, reason: 'unreachable' },
    ]);
    expect(denied).toEqual([
      [1, 'full'],
      [2, 'unreachable'],
    ]);
    // Their timers are gone: nothing fires later.
    vi.advanceTimersByTime(60_000);
    expect(out).toHaveLength(3);
    hold.fail('closed');
    expect(denied).toHaveLength(2);
  });
});

describe('redaction away from the main process (finding 4)', () => {
  it('redacts in a worker process', async () => {
    const r = new IsolatedRedactor(() => forkChannel(WORKER), { timeoutMs: 10_000 });
    try {
      const res = await r.redact({
        title: 'token sk-abcdefghijklmnopqrstuvwxyz123456',
        text: 'password=hunter22',
      });
      expect(res.title).toContain('[REDACTED]');
      expect(res.text).not.toContain('hunter22');
      expect(res.redactions.map((x) => x.rule).sort()).toEqual(['bearer', 'secret-assignment']);
      expect(await r.redact({ title: 'plain', text: null })).toEqual({
        title: 'plain',
        text: null,
        redactions: [],
      });
    } finally {
      r.close();
    }
  });

  it('kills a worker that does not answer in time and starts a fresh one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nova-redact-'));
    const stuck = join(dir, 'stuck.mjs');
    writeFileSync(stuck, "process.on('message', () => {});\n");
    let spawned = 0;
    const r = new IsolatedRedactor(
      () => {
        spawned++;
        return forkChannel(spawned === 1 ? stuck : WORKER);
      },
      // The limit also covers starting the fresh worker, which takes over 300 ms on a busy CI runner.
      { timeoutMs: 3_000 },
    );
    try {
      await expect(r.redact({ title: 'a', text: 'b' })).rejects.toBeInstanceOf(RedactTimeout);
      expect(await r.redact({ title: 'a', text: 'b' })).toMatchObject({ title: 'a', text: 'b' });
      expect(spawned).toBe(2);
    } finally {
      r.close();
    }
  });

  it('fails what a worker held when it stops, and when the service closes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nova-redact-'));
    const dies = join(dir, 'dies.mjs');
    writeFileSync(dies, "process.on('message', () => process.exit(3));\n");
    const quiet = join(dir, 'quiet.mjs');
    writeFileSync(
      quiet,
      "process.on('message', (m) => process.send({ id: m.id, nonsense: true }));\n",
    );
    const r = new IsolatedRedactor(() => forkChannel(dies), { timeoutMs: 5000 });
    await expect(r.redact({ title: 'a', text: null })).rejects.toThrow('stopped');
    r.close();
    const q = new IsolatedRedactor(() => forkChannel(quiet), { timeoutMs: 5000 });
    await expect(q.redact({ title: 'a', text: null })).rejects.toThrow('no result');
    const pending = q.redact({ title: 'b', text: null });
    q.close();
    await expect(pending).rejects.toThrow();
  });
});

describe('the Hub page and its permissions (finding 3, hardening)', () => {
  const hub = 'https://hub.local:7443';
  const base = { isMainFrame: true, frameOrigin: hub, hubOrigin: hub, mediaTypes: [] as string[] };

  it("grants only the Hub's top frame, by its real origin", () => {
    expect(permissionAllowed({ ...base, permission: 'clipboard-sanitized-write' })).toBe(true);
    expect(permissionAllowed({ ...base, permission: 'fullscreen' })).toBe(true);
    expect(
      permissionAllowed({ ...base, permission: 'clipboard-sanitized-write', frameOrigin: 'null' }),
    ).toBe(false);
    expect(permissionAllowed({ ...base, permission: 'fullscreen', isMainFrame: false })).toBe(
      false,
    );
    expect(
      permissionAllowed({ ...base, permission: 'fullscreen', frameOrigin: 'https://evil.example' }),
    ).toBe(false);
    expect(permissionAllowed({ ...base, permission: 'fullscreen', hubOrigin: null })).toBe(false);
    expect(permissionAllowed({ ...base, permission: 'notifications' })).toBe(false);
    expect(permissionAllowed({ ...base, permission: 'geolocation' })).toBe(false);
  });

  it('allows the microphone, never the camera, in requests and in checks', () => {
    expect(permissionAllowed({ ...base, permission: 'media', mediaTypes: ['audio'] })).toBe(true);
    expect(permissionAllowed({ ...base, permission: 'media', mediaTypes: ['video'] })).toBe(false);
    expect(
      permissionAllowed({ ...base, permission: 'media', mediaTypes: ['audio', 'video'] }),
    ).toBe(false);
    expect(permissionAllowed({ ...base, permission: 'media', mediaTypes: ['unknown'] })).toBe(
      false,
    );
    expect(permissionAllowed({ ...base, permission: 'media', mediaTypes: [] })).toBe(false);
  });

  it('shows only app pages at the top level, never the API', () => {
    for (const p of [
      '/',
      '/chat/x',
      '/add-device?p=1#c=ABCD-EFGH',
      '/onboarding',
      '/open?url=nova://chat',
      '/team',
    ])
      expect(windowMayShow(p)).toBe(true);
    for (const p of [
      '/api/v1/sites/s1/versions/1/preview',
      '/api/v1/ui/resource?x=1',
      '/api',
      '/sw.js',
      '/unknown',
    ])
      expect(windowMayShow(p)).toBe(false);
  });

  it('opens mail links without their query (no attach=)', () => {
    expect(externalUrl('mailto:a@b.example?attach=/etc/passwd&subject=x')).toBe(
      'mailto:a@b.example',
    );
    expect(externalUrl('mailto:?subject=x')).toBeNull();
  });

  it('stops a page that opens links or windows in a loop', () => {
    let t = 0;
    const limit = new RateLimiter(3, 10_000, () => t);
    expect([limit.take(), limit.take(), limit.take(), limit.take()]).toEqual([
      true,
      true,
      true,
      false,
    ]);
    t = 9_999;
    expect(limit.take()).toBe(false);
    t = 10_001;
    expect(limit.take()).toBe(true);
  });

  it('keeps reserved keys reserved whichever way CommandOrControl reads', () => {
    expect(reservedBySystem('CommandOrControl+Alt+Escape')).toBe(true);
    expect(reservedBySystem('Control+Alt+N')).toBe(false);
    expect(reservedBySystem('CommandOrControl+Alt+N')).toBe(false);
  });
});

describe('replacing the Hub needs an explicit confirmation (finding 6)', () => {
  const target = { origins: ['https://other.example:7443'], pin: 'B'.repeat(43), joinPath: null };

  it('names the current Hub and the new origin and fingerprint', () => {
    const r = replacementOf({ url: 'https://hub.local:7443', pin: 'A'.repeat(43) }, target);
    expect(r).toEqual({
      current: 'https://hub.local:7443',
      next: 'https://other.example:7443',
      fingerprint: 'B'.repeat(43),
    });
    expect(replacementMessage(r!)).toMatch(
      /replaces https:\/\/hub\.local:7443 with another Hub, https:\/\/other\.example:7443 \(fingerprint B{43}\).*deletes its data/,
    );
    expect(shellConnectSchema.parse({ link: 'x', replace: true })).toMatchObject({ replace: true });
  });

  it('asks nothing for the first Hub or the same identity', () => {
    expect(replacementOf(null, target)).toBeNull();
    expect(replacementOf({ url: 'https://elsewhere', pin: 'B'.repeat(43) }, target)).toBeNull();
  });
});

describe('routes and links match the web UI (docs pass)', () => {
  it('knows the M7 settings sections and pages', () => {
    for (const s of ['account', 'members', 'sync', 'cloud', 'experimental']) {
      expect(SETTINGS_SECTIONS).toContain(s);
      expect(appPath(`/settings/${s}`)).toBe(`/settings/${s}`);
    }
    expect(appPath('/approvals')).toBe('/approvals');
    expect(appPath('/team')).toBe('/team');
    expect(appPath('/team/shared/t1')).toBe('/team/shared/t1');
    expect(appPath('/team/Shared/t1')).toBeNull();
    expect(appPath('/team/a/b/c')).toBeNull();
    expect(appPath('/sign-in')).toBe('/settings/account');
  });

  it('opens the lists for run and approval links without an id, like the web UI', () => {
    expect(routeDeepLink('nova://run')).toEqual({ kind: 'path', path: '/work' });
    expect(routeDeepLink('nova://approval')).toEqual({ kind: 'path', path: '/approvals' });
    expect(routeDeepLink('nova://approvals/a1')).toEqual({ kind: 'path', path: '/approvals/a1' });
  });
});
