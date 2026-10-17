// The screen service (FR-093, FR-207, FR-098, FR-087, FR-075): explicit enablement, control tiers
// (browser view-only, terminal and editor click-only, other apps full, sensitive apps none),
// per-app grants with a 30-minute expiry on a simulated clock, coordinates checked against the
// last observation, the kill key (no input delivered after it), recording with before/after
// screenshots and audit, takeover pausing the agent, and appshots.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NovaError } from '@nova/shared';
import type { ScreenAction } from '../src/computers/types.ts';
import { decodePng, pngSize, type ScreenOutcome } from '../src/screen/index.ts';
import {
  ACCOUNT,
  BARE,
  BROKEN,
  PC,
  THREAD,
  agent,
  deferred,
  makeScreenEnv,
  type ScreenEnv,
} from './screen-env.ts';

let env: ScreenEnv;
beforeEach(async () => {
  env = await makeScreenEnv();
});
afterEach(() => env.close());

const MIN = 60_000;
const code = (r: ScreenOutcome<unknown>) => (r.ok ? 'ok' : r.error.code);
const tick = (ms: number) => (env.clock.t += ms);

/** Enable control, grant every default app and observe. */
async function ready(apps = ['Expense Form', 'Terminal', 'Code Editor', 'Web Browser']) {
  await env.service.setEnabled(ACCOUNT, PC, true);
  for (const app of apps) await env.service.grant(ACCOUNT, PC, { app });
  const r = await env.service.observe(agent());
  expect(code(r)).toBe('ok');
  return r;
}

const desktop = () => env.desktops.desktop(PC);

describe('enablement and observation', () => {
  it('is off until the user enables it for the computer', async () => {
    expect(await env.service.status(ACCOUNT, PC)).toMatchObject({
      enabled: false,
      state: 'disabled',
      indicator: { visible: false, text: null, killKey: 'Escape' },
    });
    expect(code(await env.service.observe(agent()))).toBe('screen_disabled');
    expect(code(await env.service.act(agent(), { kind: 'click', x: 1, y: 1 }))).toBe(
      'screen_disabled',
    );
    expect(desktop().delivered).toEqual([]);
    const on = await env.service.setEnabled(ACCOUNT, PC, true);
    expect(on).toMatchObject({ enabled: true, state: 'idle' });
    expect(env.audit.map((a) => a.action)).toContain('screen.control.enabled');
    expect(env.events.names()).toContain('screen.control.changed');
  });

  it('observes the screen with tiers per app class', async () => {
    const r = await ready([]);
    if (!r.ok) throw new Error('unreachable');
    expect(r.value).toMatchObject({ computerId: PC, width: 960, height: 600, mime: 'image/png' });
    expect(pngSize(Buffer.from(r.value.image, 'base64'))).toEqual({ width: 960, height: 600 });
    expect(r.value.windows.map((w) => [w.app, w.tier, w.granted])).toEqual([
      ['Expense Form', 'full', false],
      ['Code Editor', 'click', false],
      ['Terminal', 'click', false],
      ['Web Browser', 'view', false],
    ]);
    expect(r.value.tree).toContain('textbox "Name"');
  });

  it('limits the agent to one screenshot every 2 s', async () => {
    await ready([]);
    const again = await env.service.observe(agent());
    expect(again).toMatchObject({
      ok: false,
      error: { code: 'rate_limited', details: { retryAfterMs: 2_000 } },
    });
    tick(2_000);
    expect(code(await env.service.observe(agent()))).toBe('ok');
  });

  it('refuses unknown computers and computers without a desktop', async () => {
    await expect(env.service.status(ACCOUNT, PC)).resolves.toBeTruthy();
    await expect(env.service.setEnabled(ACCOUNT, 'nope', true)).rejects.toThrow(NovaError);
    await expect(env.service.listGrants(ACCOUNT, 'nope')).rejects.toThrow('computer not found');
    await env.service.setEnabled(ACCOUNT, BARE, true);
    expect(code(await env.service.observe(agent(undefined, BARE)))).toBe('screen_unavailable');
    await expect(env.service.frame(ACCOUNT, BARE)).rejects.toThrow('no controlled desktop');
  });
});

describe('failing closed', () => {
  it('refuses to act when the screen cannot be observed (masking failed)', async () => {
    await env.service.setEnabled(ACCOUNT, BROKEN, true);
    const r = await env.service.observe(agent(undefined, BROKEN));
    expect(r).toMatchObject({ ok: false, error: { code: 'observation_failed' } });
    if (!r.ok) expect(r.error.message).toContain('masking failed');
    expect(
      code(await env.service.act(agent(undefined, BROKEN), { kind: 'click', x: 1, y: 1 })),
    ).toBe('observation_required');
    await expect(env.service.frame(ACCOUNT, BROKEN)).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      env.service.appshot({
        accountId: ACCOUNT,
        computerId: BROKEN,
        source: 'screen',
        actor: 'user',
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    // A controller that fails to die is still dropped: control stays stopped.
    expect((await env.service.kill(ACCOUNT, BROKEN, 'system')).stoppedBy).toBe('system');
    expect(env.audit.find((a) => a.action === 'screen.kill')).toMatchObject({ actor: 'system' });
  });

  it('keeps nothing stopped when the kill names an unknown computer', async () => {
    await ready();
    await expect(env.service.kill(ACCOUNT, 'nope')).rejects.toMatchObject({ code: 'not_found' });
    expect(code(await env.service.act(agent(), { kind: 'click', x: 690, y: 74 }))).toBe('ok');
  });
});

describe('control tiers (FR-207)', () => {
  it('keeps the browser view-only and names the browser tool', async () => {
    await ready();
    const r = await env.service.act(agent(), { kind: 'click', x: 100, y: 100 });
    expect(r).toMatchObject({
      ok: false,
      error: {
        code: 'screen_tier',
        details: { app: 'Web Browser', tier: 'view', useInstead: 'browser' },
      },
    });
    if (!r.ok) {
      expect(r.error.message).toContain('tier: view');
      expect(r.error.message).toContain('browser tools');
    }
    expect(desktop().delivered).toEqual([]);
  });

  it('lets the terminal be clicked and scrolled but not typed into', async () => {
    await ready();
    // Clicking the terminal's output raises it (the form in front is full control).
    expect(code(await env.service.act(agent(), { kind: 'click', x: 260, y: 457 }))).toBe('ok');
    expect(desktop().windows()[0]!.id).toBe('w-terminal');
    expect(code(await env.service.act(agent(), { kind: 'scroll', x: 260, y: 457, dy: 40 }))).toBe(
      'ok',
    );
    const typed = await env.service.act(agent(), { kind: 'type', text: 'rm -rf /' });
    expect(typed).toMatchObject({
      ok: false,
      error: {
        code: 'screen_tier',
        details: { app: 'Terminal', tier: 'click', useInstead: 'shell' },
      },
    });
    if (!typed.ok) expect(typed.error.message).toContain('exec.run');
    const refused: ScreenAction[] = [
      { kind: 'key', keys: 'Enter' },
      { kind: 'click', x: 260, y: 457, button: 'right' },
      { kind: 'drag', from: [260, 457], to: [300, 457] },
    ];
    for (const action of refused)
      expect(code(await env.service.act(agent(), action))).toBe('screen_tier');
    // A right click elsewhere is refused too while the terminal is frontmost.
    expect(
      code(await env.service.act(agent(), { kind: 'click', x: 700, y: 200, button: 'right' })),
    ).toBe('screen_tier');
    expect(desktop().delivered.map((e) => e.action.kind)).toEqual(['click', 'scroll']);
    expect(desktop().widget('w-terminal', 'Output')!.value).toBe('$ ');
  });

  it('gives other apps full control: click, type, keys and drag', async () => {
    await ready();
    const actions: ScreenAction[] = [
      { kind: 'click', x: 690, y: 74 },
      { kind: 'type', text: 'Ada' },
      { kind: 'key', keys: 'Enter' },
      { kind: 'drag', from: [700, 31], to: [650, 31] },
    ];
    for (const action of actions) expect(code(await env.service.act(agent(), action))).toBe('ok');
    expect(desktop().widget('w-form', 'Status')!.value).toBe('Submitted: Ada');
    expect(desktop().windows()[0]!.bounds.x).toBe(510);
  });

  it('never controls sensitive apps and lets the user lower a tier', async () => {
    env.close();
    env = await makeScreenEnv({
      desktop: {
        windows: [
          {
            id: 'w-vault',
            app: 'Password Vault',
            appClass: 'sensitive',
            title: 'Vault',
            bounds: { x: 0, y: 0, width: 300, height: 300 },
            widgets: [],
          },
          {
            id: 'w-notes',
            app: 'Notes',
            appClass: 'app',
            title: 'Notes',
            bounds: { x: 400, y: 0, width: 300, height: 300 },
            widgets: [
              { id: 'n', role: 'textbox', name: 'Text', x: 10, y: 10, width: 200, height: 24 },
            ],
          },
        ],
      },
    });
    await ready(['Notes']);
    await expect(env.service.grant(ACCOUNT, PC, { app: 'Password Vault' })).rejects.toMatchObject({
      code: 'policy_denied',
    });
    const r = await env.service.act(agent(), { kind: 'click', x: 50, y: 50 });
    expect(r).toMatchObject({
      ok: false,
      error: { code: 'screen_handoff', details: { tier: 'none' } },
    });
    expect(await env.service.appTier(ACCOUNT, PC, 'Password Vault')).toBe('none');
    // An override can lower Notes to click-only, never raise the vault.
    env.overrides['notes'] = 'click';
    env.overrides['Password Vault'] = 'full';
    expect(code(await env.service.act(agent(), { kind: 'click', x: 450, y: 40 }))).toBe('ok');
    expect(code(await env.service.act(agent(), { kind: 'type', text: 'hi' }))).toBe('screen_tier');
    expect(await env.service.appTier(ACCOUNT, PC, 'Password Vault')).toBe('none');
  });
});

describe('grants', () => {
  it('needs a grant per app and expires it after 30 minutes', async () => {
    await env.service.setEnabled(ACCOUNT, PC, true);
    await env.service.observe(agent());
    const none = await env.service.act(agent(), { kind: 'click', x: 690, y: 74 });
    expect(none).toMatchObject({
      ok: false,
      error: {
        code: 'screen_grant_required',
        details: { apps: ['Expense Form'], tool: 'screen.request_access' },
      },
    });
    const g = await env.service.grant(ACCOUNT, PC, { app: 'expense form', threadId: THREAD });
    expect(g).toMatchObject({
      app: 'expense form',
      tier: 'full',
      active: true,
      remainingSeconds: 1800,
      grantedBy: 'user',
    });
    expect(new Date(g.expiresAt).getTime() - env.clock.t).toBe(30 * MIN);
    const status = await env.service.status(ACCOUNT, PC);
    expect(status).toMatchObject({
      state: 'controlling',
      indicator: {
        visible: true,
        apps: ['expense form'],
        text: 'Nova is controlling expense form · Escape to stop',
      },
    });
    tick(29 * MIN);
    await env.service.observe(agent());
    expect(code(await env.service.act(agent(), { kind: 'click', x: 690, y: 74 }))).toBe('ok');
    tick(2 * MIN);
    await env.service.observe(agent());
    expect(code(await env.service.act(agent(), { kind: 'click', x: 690, y: 74 }))).toBe(
      'screen_grant_required',
    );
    expect((await env.service.status(ACCOUNT, PC)).state).toBe('idle');
    const all = await env.service.listGrants(ACCOUNT, PC, true);
    expect(all).toMatchObject([{ id: g.id, active: false, remainingSeconds: 0 }]);
    expect(await env.service.listGrants(ACCOUNT, PC)).toEqual([]);
    // Renewing runs the full lifetime again; granting the same app again renews it too.
    const renewed = await env.service.renewGrant(ACCOUNT, PC, g.id);
    expect(renewed).toMatchObject({ active: true, remainingSeconds: 1800 });
    expect((await env.service.grant(ACCOUNT, PC, { app: 'Expense Form', minutes: 15 })).id).toBe(
      g.id,
    );
    expect(code(await env.service.act(agent(), { kind: 'click', x: 690, y: 74 }))).toBe('ok');
    // Revoked grants stop the agent at once and cannot be renewed.
    await env.service.revokeGrant(ACCOUNT, PC, g.id);
    expect(code(await env.service.act(agent(), { kind: 'click', x: 690, y: 74 }))).toBe(
      'screen_grant_required',
    );
    expect((await env.service.revokeGrant(ACCOUNT, PC, g.id)).revokedAt).not.toBeNull();
    await expect(env.service.renewGrant(ACCOUNT, PC, g.id)).rejects.toThrow('revoked');
    await expect(env.service.revokeGrant(ACCOUNT, PC, 'missing')).rejects.toThrow(
      'grant not found',
    );
    expect(
      env.audit.filter((a) => a.action.startsWith('screen.grant')).map((a) => a.action),
    ).toEqual([
      'screen.grant.created',
      'screen.grant.renewed',
      'screen.grant.renewed',
      'screen.grant.revoked',
    ]);
    expect(env.events.names().filter((n) => n === 'screen.grant.changed')).toHaveLength(4);
  });
});

describe('coordinates (docs/11 §5)', () => {
  it('checks every action against a recent observation and the screen size', async () => {
    await env.service.setEnabled(ACCOUNT, PC, true);
    await env.service.grant(ACCOUNT, PC, { app: 'Expense Form' });
    expect(code(await env.service.act(agent(), { kind: 'click', x: 690, y: 74 }))).toBe(
      'observation_required',
    );
    await env.service.observe(agent());
    expect(await env.service.act(agent(), { kind: 'click', x: 960, y: 10 })).toMatchObject({
      ok: false,
      error: { code: 'coordinates_invalid', details: { width: 960, height: 600 } },
    });
    expect(code(await env.service.act(agent(), { kind: 'click', x: -1, y: 10 }))).toBe(
      'coordinates_invalid',
    );
    expect(
      code(await env.service.act(agent(), { kind: 'drag', from: [700, 31], to: [700, 600] })),
    ).toBe('coordinates_invalid');
    // The desktop background is no app.
    expect(code(await env.service.act(agent(), { kind: 'click', x: 5, y: 595 }))).toBe('no_target');
    tick(121_000);
    expect(code(await env.service.act(agent(), { kind: 'click', x: 690, y: 74 }))).toBe(
      'observation_stale',
    );
    expect(desktop().delivered).toEqual([]);
    // Refusals are recorded and audited as denials.
    const actions = await env.service.listActions(ACCOUNT, PC, { limit: 50 });
    expect(actions.map((a) => a.error?.code)).toEqual([
      'observation_stale',
      'no_target',
      'coordinates_invalid',
      'coordinates_invalid',
      'coordinates_invalid',
      'observation_required',
    ]);
    expect(actions.every((a) => a.status === 'refused' && !a.hasBefore)).toBe(true);
    expect(
      env.audit.filter((a) => a.action === 'screen.click').every((a) => a.decision === 'deny'),
    ).toBe(true);
  });
});

describe('the kill key', () => {
  it('stops control at once: the in-flight input and everything queued is not delivered', async () => {
    const gate = deferred();
    const arrived = deferred();
    let holding = false;
    env.close();
    env = await makeScreenEnv({
      desktop: {
        beforeInput: () => {
          if (!holding) return Promise.resolve();
          arrived.resolve();
          return gate.promise;
        },
      },
    });
    await ready();
    expect(code(await env.service.act(agent(), { kind: 'click', x: 690, y: 74 }))).toBe('ok');
    expect(desktop().delivered).toHaveLength(1);
    holding = true;
    const inFlight = env.service.act(agent(), { kind: 'type', text: 'Ada' });
    const queued = env.service.act(agent(), { kind: 'key', keys: 'Enter' });
    // The first action reaches the controller; the second waits behind it.
    await arrived.promise;
    const status = await env.service.kill(ACCOUNT, PC, 'key');
    gate.resolve();
    expect(code(await inFlight)).toBe('screen_stopped');
    expect(code(await queued)).toBe('screen_stopped');
    holding = false;
    expect(code(await env.service.act(agent(), { kind: 'click', x: 690, y: 74 }))).toBe(
      'screen_stopped',
    );
    expect(code(await env.service.observe(agent()))).toBe('screen_stopped');
    expect(desktop().delivered).toHaveLength(1);
    expect(status).toMatchObject({
      state: 'stopped',
      stoppedBy: 'key',
      indicator: { visible: false },
    });
    expect(env.hooks).toEqual([{ which: 'pause', computerId: PC, reason: 'kill' }]);
    expect(env.audit.find((a) => a.action === 'screen.kill')).toMatchObject({
      kind: 'screen',
      actor: 'user',
    });
    const recorded = await env.service.listActions(ACCOUNT, PC, { limit: 10 });
    expect(recorded.map((a) => a.status)).toEqual(['refused', 'refused', 'stopped', 'ok']);

    // The user resumes control: the agent observes again and acts through a new handle.
    const resumed = await env.service.resumeControl(ACCOUNT, PC);
    expect(resumed).toMatchObject({ state: 'controlling', stoppedAt: null });
    expect(env.hooks.at(-1)).toEqual({ which: 'resume', computerId: PC, reason: 'kill' });
    expect(code(await env.service.act(agent(), { kind: 'type', text: 'x' }))).toBe(
      'observation_required',
    );
    tick(2_000);
    await env.service.observe(agent());
    expect(code(await env.service.act(agent(), { kind: 'type', text: 'x' }))).toBe('ok');
    const handles = new Set(desktop().delivered.map((e) => e.handle));
    expect(handles.size).toBe(2);
    // Resuming when nothing is stopped changes nothing.
    expect((await env.service.resumeControl(ACCOUNT, PC)).state).toBe('controlling');
  });

  it('stops control when the user turns computer use off', async () => {
    await ready();
    const off = await env.service.setEnabled(ACCOUNT, PC, false);
    expect(off.state).toBe('disabled');
    expect(code(await env.service.act(agent(), { kind: 'click', x: 690, y: 74 }))).toBe(
      'screen_disabled',
    );
    await env.service.setEnabled(ACCOUNT, PC, true);
    // The observation went with the old handle.
    expect(code(await env.service.act(agent(), { kind: 'click', x: 690, y: 74 }))).toBe(
      'observation_required',
    );
    expect(desktop().delivered).toEqual([]);
  });
});

describe('recording (FR-098)', () => {
  it('keeps before/after screenshots and never the typed text', async () => {
    await ready();
    const click = await env.service.act(agent(), { kind: 'click', x: 690, y: 74 });
    expect(code(click)).toBe('ok');
    if (!click.ok) return;
    expect(click.value.action).toMatchObject({
      actor: 'agent:agent-1',
      origin: 'tool',
      kind: 'click',
      app: 'Expense Form',
      tier: 'full',
      status: 'ok',
      hasBefore: true,
      hasAfter: true,
      threadId: THREAD,
      turnId: 'turn-1',
      callId: 'call-1',
    });
    expect(click.value.after?.tree).toContain('textbox "Name" bounds=580,62,220,24 focused');
    const before = await env.service.actionScreenshot(ACCOUNT, PC, click.value.action.id, 'before');
    const after = await env.service.actionScreenshot(ACCOUNT, PC, click.value.action.id, 'after');
    expect(pngSize(before)).toEqual({ width: 960, height: 600 });
    expect(Buffer.compare(before, after)).not.toBe(0);
    expect(decodePng(after)).not.toBeNull();
    const typed = await env.service.act(agent(), { kind: 'type', text: 'secret-Ada' });
    if (!typed.ok) throw new Error(typed.error.message);
    expect(typed.value.action.args).toEqual({ kind: 'type', chars: 10 });
    const rows = env.db.raw.prepare('SELECT args_json FROM screen_action').all() as {
      args_json: string;
    }[];
    expect(JSON.stringify(rows)).not.toContain('secret-Ada');
    expect(JSON.stringify(env.audit)).not.toContain('secret-Ada');
    expect(JSON.stringify(env.events.events)).not.toContain('secret-Ada');
    const audited = env.audit.filter((a) => a.action === 'screen.type');
    expect(audited).toMatchObject([
      {
        kind: 'screen',
        actor: 'agent:agent-1',
        decision: 'allow',
        result: 'ok',
        resource: `computer:${PC}/app:Expense Form`,
        threadId: THREAD,
      },
    ]);
    expect(audited[0]!.inputHash).toMatch(/^[0-9a-f]{64}$/);
    const ev = env.events.events.filter((e) => e.name === 'screen.action');
    expect(ev.at(-1)).toMatchObject({
      payload: { computerId: PC, kind: 'type', status: 'ok', app: 'Expense Form' },
      correlation: { threadId: THREAD, turnId: 'turn-1', callId: 'call-1' },
    });
    await expect(env.service.actionScreenshot(ACCOUNT, PC, 'missing', 'before')).rejects.toThrow(
      'no such screenshot',
    );
    // Paging back.
    const page = await env.service.listActions(ACCOUNT, PC, { limit: 1 });
    const older = await env.service.listActions(ACCOUNT, PC, { limit: 5, before: page[0]!.id });
    expect(older.map((a) => a.kind)).toEqual(['click']);
  });

  it('drops screenshots past the retention, keeping the rows', async () => {
    await ready();
    const r = await env.service.act(agent(), { kind: 'click', x: 690, y: 74 });
    if (!r.ok) throw new Error('unreachable');
    const blobs = env.db.raw
      .prepare('SELECT before_blob AS b, after_blob AS a FROM screen_action')
      .get() as {
      b: string;
      a: string;
    };
    expect(await env.service.pruneScreenshots(30)).toBe(0);
    tick(31 * 86_400_000);
    expect(await env.service.pruneScreenshots(30)).toBe(2);
    expect(existsSync(join(env.dir, blobs.b))).toBe(false);
    expect(existsSync(join(env.dir, blobs.a))).toBe(false);
    expect((await env.service.listActions(ACCOUNT, PC, { limit: 5 }))[0]).toMatchObject({
      hasBefore: false,
      hasAfter: false,
    });
  });
});

describe('takeover (FR-087)', () => {
  it('pauses the agent while the user has control and audits start and end', async () => {
    await ready();
    const t = await env.service.startTakeover(ACCOUNT, PC);
    expect(t).toMatchObject({
      computerId: PC,
      surface: 'desktop',
      startedBy: 'user',
      endedAt: null,
    });
    expect((await env.service.status(ACCOUNT, PC)).state).toBe('taken_over');
    expect(env.hooks).toEqual([{ which: 'pause', computerId: PC, reason: 'takeover' }]);
    await expect(env.service.startTakeover(ACCOUNT, PC)).rejects.toMatchObject({
      code: 'conflict',
    });
    // The agent's action waits for the user.
    let settled = false;
    const waiting = env.service
      .act(agent(), { kind: 'click', x: 690, y: 74 })
      .finally(() => (settled = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
    // The user is not held to the agent's tiers: typing into the terminal works.
    const [tx, ty] = [260, 457];
    expect(
      await env.service.takeoverInput(ACCOUNT, PC, { action: { kind: 'click', x: tx, y: ty } }),
    ).toEqual({
      ok: true,
      error: null,
    });
    await env.service.takeoverInput(ACCOUNT, PC, { action: { kind: 'type', text: 'ls' } });
    expect(desktop().widget('w-terminal', 'Output')!.value).toBe('$ ls');
    await expect(
      env.service.takeoverInput(ACCOUNT, PC, { browser: { kind: 'scroll', dy: 1 } }),
    ).rejects.toMatchObject({ code: 'validation' });
    const ended = await env.service.endTakeover(ACCOUNT, PC);
    expect(ended).toMatchObject({ endReason: 'returned', inputCount: 2 });
    // The screen changed under the agent: it must observe again.
    expect(code(await waiting)).toBe('observation_required');
    expect(env.hooks.at(-1)).toEqual({ which: 'resume', computerId: PC, reason: 'takeover' });
    expect(env.events.events.filter((e) => e.name.startsWith('computer.takeover'))).toMatchObject([
      {
        name: 'computer.takeover.started',
        payload: { computerId: PC, actor: 'user', surface: 'desktop' },
      },
      {
        name: 'computer.takeover.ended',
        payload: { computerId: PC, actor: 'user', inputs: 2, reason: 'returned' },
      },
    ]);
    expect(env.audit.filter((a) => a.kind === 'computer').map((a) => a.action)).toEqual([
      'computer.takeover.started',
      'computer.takeover.ended',
    ]);
    const userRows = (await env.service.listActions(ACCOUNT, PC, { limit: 10 })).filter(
      (a) => a.origin === 'takeover',
    );
    expect(userRows.map((a) => [a.actor, a.kind, a.args])).toEqual([
      ['user', 'type', { kind: 'type', chars: 2 }],
      ['user', 'click', { kind: 'click', x: 260, y: 457 }],
    ]);
    await expect(env.service.endTakeover(ACCOUNT, PC)).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      env.service.takeoverInput(ACCOUNT, PC, { action: { kind: 'type', text: 'x' } }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(await env.service.takeover(ACCOUNT, PC)).toBeNull();
  });

  it('takes over the browser and gives up a waiting action on cancel', async () => {
    await ready();
    const t = await env.service.startTakeover(ACCOUNT, PC, 'browser');
    expect(await env.service.takeover(ACCOUNT, PC)).toMatchObject({ id: t.id, surface: 'browser' });
    // The agent's browser writes wait while the user has the page.
    expect(env.browser.pausedBy).toBe('user');
    expect(
      await env.service.takeoverInput(ACCOUNT, PC, { browser: { kind: 'click', x: 5, y: 6 } }),
    ).toEqual({ ok: true, error: null });
    expect(env.browser.inputs).toEqual([{ kind: 'click', x: 5, y: 6 }]);
    await expect(
      env.service.takeoverInput(ACCOUNT, PC, { action: { kind: 'type', text: 'x' } }),
    ).rejects.toMatchObject({ code: 'validation' });
    expect(pngSize(await env.service.browserFrame(ACCOUNT, PC))).toEqual({ width: 4, height: 2 });
    const ac = new AbortController();
    const waiting = env.service.observe(agent(ac.signal));
    ac.abort();
    expect(code(await waiting)).toBe('cancelled');
    await expect(env.service.startTakeover(ACCOUNT, BARE, 'browser')).rejects.toThrow('no browser');
    expect(await env.service.endTakeover(ACCOUNT, PC)).toMatchObject({ inputCount: 1 });
    expect(env.browser.pausedBy).toBeNull();
    // A failed input is reported, not thrown.
    await env.service.startTakeover(ACCOUNT, PC, 'browser');
    env.browser.resume();
    expect(
      await env.service.takeoverInput(ACCOUNT, PC, { browser: { kind: 'key', key: 'Enter' } }),
    ).toEqual({ ok: false, error: 'not paused' });
    await env.service.endTakeover(ACCOUNT, PC);
  });

  it('closes takeovers left open by a restart', async () => {
    await env.service.startTakeover(ACCOUNT, PC);
    const { ScreenService } = await import('../src/screen/index.ts');
    const fresh = new ScreenService({
      db: env.db,
      events: env.events,
      dataDir: env.dir,
      computers: env.computers,
      now: () => new Date(env.clock.t),
    });
    expect(await fresh.recover()).toBe(1);
    expect(await fresh.takeover(ACCOUNT, PC)).toBeNull();
    expect(env.events.names()).toContain('computer.takeover.ended');
  });
});

describe('appshots (FR-075)', () => {
  it('saves a window, the screen or the browser page as an image artifact', async () => {
    const shot = await env.service.appshot({
      accountId: ACCOUNT,
      computerId: PC,
      source: 'window',
      app: 'expense form',
      threadId: THREAD,
      actor: 'user',
    });
    expect(shot).toMatchObject({
      computerId: PC,
      source: 'window',
      app: 'Expense Form',
      windowTitle: 'New expense - Expense Form',
      width: 380,
      height: 290,
      threadId: THREAD,
      capturedBy: 'user',
    });
    const art = env.db.raw
      .prepare('SELECT kind, mime, title, thread_id FROM artifact WHERE id = ?')
      .get(shot.artifactId);
    expect(art).toEqual({
      kind: 'image',
      mime: 'image/png',
      title: 'Appshot: Expense Form - New expense - Expense Form',
      thread_id: THREAD,
    });
    const focused = await env.service.appshot({
      accountId: ACCOUNT,
      computerId: PC,
      source: 'window',
      actor: 'user',
    });
    expect(focused.app).toBe('Expense Form');
    const byId = await env.service.appshot({
      accountId: ACCOUNT,
      computerId: PC,
      source: 'window',
      windowId: 'w-terminal',
      actor: 'user',
    });
    expect(byId).toMatchObject({ app: 'Terminal', width: 440, height: 260 });
    const screen = await env.service.appshot({
      accountId: ACCOUNT,
      computerId: PC,
      source: 'screen',
      actor: 'user',
    });
    expect(screen).toMatchObject({ app: null, width: 960, height: 600 });
    const page = await env.service.appshot({
      accountId: ACCOUNT,
      computerId: PC,
      source: 'browser',
      actor: 'agent:agent-1',
    });
    expect(page).toMatchObject({
      app: 'Browser',
      windowTitle: 'Example page',
      url: 'https://example.test/',
    });
    await expect(
      env.service.appshot({
        accountId: ACCOUNT,
        computerId: PC,
        source: 'window',
        app: 'Nope',
        actor: 'user',
      }),
    ).rejects.toThrow('no such window');
    await expect(
      env.service.appshot({
        accountId: ACCOUNT,
        computerId: BARE,
        source: 'browser',
        actor: 'user',
      }),
    ).rejects.toThrow('no browser');
    await expect(
      env.service.appshot({
        accountId: ACCOUNT,
        computerId: PC,
        source: 'screen',
        threadId: 'other',
        actor: 'user',
      }),
    ).rejects.toThrow('thread not found');
    expect((await env.service.listAppshots(ACCOUNT, { computerId: PC, limit: 10 })).length).toBe(5);
    expect(await env.service.listAppshots(ACCOUNT, { threadId: THREAD, limit: 10 })).toHaveLength(
      1,
    );
    expect(await env.service.getAppshot(ACCOUNT, shot.id)).toEqual(shot);
    await expect(env.service.getAppshot(ACCOUNT, 'missing')).rejects.toThrow('appshot not found');
    expect(env.audit.filter((a) => a.action === 'appshot.captured')).toHaveLength(5);
    const frame = await env.service.frame(ACCOUNT, PC);
    expect(frame.windows).toHaveLength(4);
  });
});

describe('purge', () => {
  it("removes a deleted computer's screen rows", async () => {
    await ready();
    await env.service.act(agent(), { kind: 'click', x: 690, y: 74 });
    await env.service.appshot({
      accountId: ACCOUNT,
      computerId: PC,
      source: 'screen',
      actor: 'user',
    });
    await env.service.purgeComputer(ACCOUNT, PC);
    for (const t of ['screen_action', 'screen_grant', 'screen_control', 'screen_appshot'])
      expect(env.db.raw.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()).toEqual({ n: 0 });
  });
});
