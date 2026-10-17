// Devices end to end through the Hub (FR-141, FR-142, FR-148, FR-150, FR-210, FR-081): the owner
// creates an enrollment token, a fake novad registers over HTTP against a listening Hub and
// heartbeats; the owner edits overrides, browses granted folders, stages and commits writes; an
// agent's write outside its folders raises an approval card that the owner answers through
// POST /approvals; connections are one per agent and refused below the minimum novad version; a
// device credential never authenticates a user route. (J7 step 7 runs this flow offline.)
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemorySecretStore } from '@nova/secrets';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger, MemorySink } from '@nova/telemetry';
import { FakeDevice } from '@nova/core';
import { SESSION_COOKIE, buildHub, type Hub } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { EventStore } from '../src/event-store.ts';

let dir: string;
let db: NovaDatabase;
let hub: Hub;
let hubUrl: string;
let cookie: string;
let fakes: FakeDevice[];
let proj: string;

beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'nova-hub-devices-')));
  const web = join(dir, 'web');
  mkdirSync(web);
  writeFileSync(join(web, 'index.html'), '<!doctype html><title>Nova</title>');
  const config = loadConfig({ NOVA_DATA_DIR: join(dir, 'data'), NOVA_WEB_DIR: web }, []);
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  hub = await buildHub({
    config,
    db,
    log: new Logger({ module: 'hub', sinks: [new MemorySink()] }),
    secrets: new MemorySecretStore(),
    events: new EventStore(db),
  });
  hubUrl = await hub.app.listen({ port: 0, host: '127.0.0.1' });
  const code = await hub.auth.issueSetupCode();
  const res = await fetch(`${hubUrl}/api/v1/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  cookie = res.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${SESSION_COOKIE}=`))!
    .split(';')[0]!;
  fakes = [];
  proj = join(dir, 'proj');
  mkdirSync(join(proj, 'src'), { recursive: true });
  writeFileSync(join(proj, 'src', 'notes.md'), '# Notes\n\nfirst\n');
});

afterEach(async () => {
  for (const f of fakes) await f.close();
  await hub.app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function api(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = { cookie },
) {
  const res = await fetch(`${hubUrl}${path}`, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : {} };
}

/** A real agent (connections refuse agents that do not exist). */
async function newAgent(name: string): Promise<string> {
  const r = await api('POST', '/api/v1/agents', { name });
  expect(r.status).toBe(201);
  return r.json.id as string;
}

async function enroll(opts: ConstructorParameters<typeof FakeDevice>[0] = {}): Promise<FakeDevice> {
  const t = await api('POST', '/api/v1/devices/novad/enroll', { roles: ['client'] });
  expect(t.status).toBe(201);
  expect(t.json.command).toContain(`--hub ${hubUrl}`);
  const fake = new FakeDevice(opts);
  fakes.push(fake);
  await fake.enroll(hubUrl, t.json.token as string);
  return fake;
}

describe('devices through the Hub', () => {
  it('enrolls, heartbeats and shows the device; a device credential is not a session', async () => {
    const fake = await enroll({ name: 'laptop' });
    fake.crashModule('storage');
    expect((await fake.heartbeat()).status).toBe(200);
    const list = await api('GET', '/api/v1/devices/novad');
    expect(list.json.items).toHaveLength(1);
    const view = await api('GET', `/api/v1/devices/${fake.deviceId!}`);
    expect(view.json).toMatchObject({
      name: 'laptop',
      status: 'active',
      novadVersion: '0.6.0',
      updateRequired: false,
    });
    expect(view.json.modules.find((m: { name: string }) => m.name === 'storage').restarts).toBe(1);
    const caps = await api('GET', `/api/v1/devices/${fake.deviceId!}/capabilities`);
    expect(caps.json.items.find((c: { name: string }) => c.name === 'files').available).toBe(true);
    // The credential authenticates novad's routes only.
    expect(
      (
        await api('GET', '/api/v1/devices/novad', undefined, {
          authorization: `Bearer ${fake.credential!}`,
        })
      ).status,
    ).toBe(401);
    expect((await api('POST', '/agent/v1/heartbeat', {}, {})).status).toBe(401);
    expect(
      (await api('POST', '/agent/v1/heartbeat', {}, { authorization: 'Bearer nvc_wrong' })).status,
    ).toBe(401);
    // Events reached the stream store.
    const events = await api('GET', '/api/v1/events?limit=500');
    const names = (events.json.events as { name: string }[]).map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(['device.registered', 'device.module.changed']));
    // Unknown and other ids.
    expect((await api('GET', '/api/v1/devices/nope')).status).toBe(404);
  });

  it('edits overrides and policy (FR-142, FR-150)', async () => {
    const fake = await enroll({ modules: ['management', 'storage', 'compute'] });
    const r = await api('PATCH', `/api/v1/devices/${fake.deviceId!}`, {
      capabilityOverrides: { computePolicy: { maxConcurrentJobs: 3 } },
      policy: { allowedModules: ['management', 'storage'] },
    });
    expect(r.status).toBe(200);
    expect(r.json.capability.computePolicy).toMatchObject({ maxConcurrentJobs: 3 });
    expect(fake.modules.get('compute')?.state).toBe('stopped');
    expect(
      (
        await api('PATCH', `/api/v1/devices/${fake.deviceId!}`, {
          capabilityOverrides: { hardware: { cores: 64 } },
        })
      ).status,
    ).toBe(400);
    expect((await api('PATCH', `/api/v1/devices/${fake.deviceId!}`, {})).status).toBe(400);
    const start = await api('POST', `/api/v1/devices/${fake.deviceId!}/modules/compute/start`);
    expect(start.status).toBe(403);
    expect(start.json.error.details.reason).toBe('module_not_allowed');
    const svc = await api('POST', `/api/v1/devices/${fake.deviceId!}/services/compute/status`);
    expect(svc.json.service).toMatchObject({ name: 'compute' });
    expect(
      (await api('POST', `/api/v1/devices/${fake.deviceId!}/services/compute/reboot`)).status,
    ).toBe(400);
  });

  it('owner files: grant, list, read, stage with a diff, commit (FR-210)', async () => {
    const fake = await enroll();
    const id = fake.deviceId!;
    const denied = await api('GET', `/api/v1/devices/${id}/files?path=${encodeURIComponent(proj)}`);
    expect(denied.status).toBe(403);
    const req = await api('POST', `/api/v1/devices/${id}/access-requests`, {
      path: proj,
      access: 'write',
    });
    expect(req.status).toBe(201);
    expect(req.json.status).toBe('granted');
    const l = await api('GET', `/api/v1/devices/${id}/files?path=${encodeURIComponent(proj)}`);
    expect(l.json.entries).toEqual([{ name: 'src', kind: 'dir', size: null }]);
    const file = join(proj, 'src', 'notes.md');
    const read = await api(
      'GET',
      `/api/v1/devices/${id}/files/content?path=${encodeURIComponent(file)}`,
    );
    expect(Buffer.from(read.json.contentBase64 as string, 'base64').toString()).toBe(
      '# Notes\n\nfirst\n',
    );
    const st = await api('POST', `/api/v1/devices/${id}/staged`, {
      path: file,
      content: '# Notes\n\nsecond\n',
    });
    expect(st.status).toBe(201);
    expect(st.json.diff).toContain('-first\n+second');
    expect(readFileSync(file, 'utf8')).toBe('# Notes\n\nfirst\n');
    expect(
      (await api('GET', `/api/v1/devices/${id}/staged/${st.json.id as string}`)).json.status,
    ).toBe('staged');
    const c = await api('POST', `/api/v1/devices/${id}/staged/${st.json.id as string}/commit`);
    expect(c.json.status).toBe('committed');
    expect(readFileSync(file, 'utf8')).toBe('# Notes\n\nsecond\n');
    expect(
      (await api('POST', `/api/v1/devices/${id}/staged/${st.json.id as string}/commit`)).status,
    ).toBe(409);
    const d = await api('POST', `/api/v1/devices/${id}/staged`, {
      path: join(proj, 'x.md'),
      content: 'x',
    });
    expect(
      (await api('POST', `/api/v1/devices/${id}/staged/${d.json.id as string}/discard`)).json
        .status,
    ).toBe('discarded');
    expect(
      (await api('GET', `/api/v1/devices/${id}/staged?status=committed`)).json.items,
    ).toHaveLength(1);
    expect((await api('POST', `/api/v1/devices/${id}/staged`, { path: file })).status).toBe(400);
    expect(
      (
        await api('POST', `/api/v1/devices/${id}/staged`, {
          path: join(proj, '.git', 'config'),
          content: 'x',
        })
      ).status,
    ).toBe(403);
    const grants = await api('GET', `/api/v1/devices/${id}/grants`);
    expect(grants.json.items).toHaveLength(1);
    expect(
      (await api('DELETE', `/api/v1/devices/${id}/grants/${grants.json.items[0].id as string}`))
        .json.ok,
    ).toBe(true);
  });

  it('an agent’s write outside its folders becomes an approval card the owner answers (J7 step 7)', async () => {
    const fake = await enroll();
    const id = fake.deviceId!;
    const agentId = await newAgent('Seven');
    const conn = await api('POST', '/api/v1/devices/connections', {
      agentId,
      deviceId: id,
      capabilities: ['files', 'staged_writes'],
    });
    expect(conn.status).toBe(201);
    const agent = { kind: 'agent', id: agentId };
    // The agent's first folder: granted from its profile by the owner.
    expect(
      (
        await api('POST', `/api/v1/devices/${id}/grants`, {
          kind: 'folder',
          grantee: agent,
          path: join(proj, 'src'),
          access: 'write',
        })
      ).status,
    ).toBe(201);
    const ok = await api('POST', `/api/v1/devices/${id}/staged`, {
      path: join(proj, 'src', 'notes.md'),
      content: 'agent\n',
      grantee: agent,
    });
    expect(ok.status).toBe(201);
    expect(ok.json.diff).toContain('+agent');
    expect(
      (await api('POST', `/api/v1/devices/${id}/staged/${ok.json.id as string}/commit`)).json
        .status,
    ).toBe('committed');
    // Outside its folders: a folder-access request with a Hub approval card.
    mkdirSync(join(proj, 'docs'));
    const out = await api('POST', `/api/v1/devices/${id}/staged`, {
      path: join(proj, 'docs', 'plan.md'),
      content: 'plan\n',
      grantee: agent,
    });
    expect(out.status).toBe(403);
    expect(out.json.error.details).toMatchObject({
      reason: 'folder_access_required',
      path: join(proj, 'docs'),
    });
    const approvalId = out.json.error.details.approvalId as string;
    const cards = await api('GET', '/api/v1/approvals');
    expect(
      (cards.json.items as { id: string; tool: string }[]).find((a) => a.id === approvalId)?.tool,
    ).toBe('device.fs.request_access');
    const decided = await api('POST', '/api/v1/approvals', { approvalId, decision: 'allow_once' });
    expect(decided.status).toBe(200);
    const requestId = out.json.error.details.requestId as string;
    for (let i = 0; i < 50; i++) {
      const r = await api('GET', `/api/v1/devices/${id}/access-requests/${requestId}`);
      if (r.json.status === 'granted') break;
      await new Promise((res) => setTimeout(res, 10));
    }
    expect(
      (await api('GET', `/api/v1/devices/${id}/access-requests/${requestId}`)).json.status,
    ).toBe('granted');
    const again = await api('POST', `/api/v1/devices/${id}/staged`, {
      path: join(proj, 'docs', 'plan.md'),
      content: 'plan\n',
      grantee: agent,
    });
    expect(again.status).toBe(201);
    await api('POST', `/api/v1/devices/${id}/staged/${again.json.id as string}/commit`);
    expect(readFileSync(join(proj, 'docs', 'plan.md'), 'utf8')).toBe('plan\n');
    // Audit entries for the writes.
    const audit = await api('GET', '/api/v1/audit?kind=device&limit=100');
    expect(audit.status).toBe(200);
  });

  it('one connection per agent; refused below the minimum novad version (FR-081)', async () => {
    const a = await enroll();
    const b = await enroll();
    const old = await enroll({ novadVersion: '0.5.0' });
    const ag = await newAgent('Ag');
    const other = await newAgent('Other');
    // An agent that does not exist cannot be connected.
    expect(
      (
        await api('POST', '/api/v1/devices/connections', {
          agentId: 'no-such-agent',
          deviceId: a.deviceId!,
        })
      ).status,
    ).toBe(404);
    expect(
      (await api('POST', '/api/v1/devices/connections', { agentId: ag, deviceId: a.deviceId! }))
        .status,
    ).toBe(201);
    const second = await api('POST', '/api/v1/devices/connections', {
      agentId: ag,
      deviceId: b.deviceId!,
    });
    expect(second.status).toBe(409);
    const tooOld = await api('POST', '/api/v1/devices/connections', {
      agentId: other,
      deviceId: old.deviceId!,
    });
    expect(tooOld.status).toBe(400);
    expect(tooOld.json.error).toMatchObject({
      code: 'capability_missing',
      details: { reason: 'update_required' },
    });
    expect((await api('GET', `/api/v1/devices/${old.deviceId!}`)).json.updateRequired).toBe(true);
    const list = await api('GET', `/api/v1/devices/connections?agentId=${ag}`);
    expect(list.json.items).toHaveLength(1);
    const del = await api(
      'DELETE',
      `/api/v1/devices/connections/${list.json.items[0].id as string}`,
    );
    expect(del.json.status).toBe('revoked');
    expect(
      (await api('POST', '/api/v1/devices/connections', { agentId: ag, deviceId: b.deviceId! }))
        .status,
    ).toBe(201);
  });

  it('power, updates and MCP routes reach the device', async () => {
    const fake = await enroll({
      mcp: { notes: { tools: [{ name: 'find' }], call: () => ({ hits: 1 }) } },
    });
    const id = fake.deviceId!;
    expect((await api('GET', `/api/v1/devices/${id}/power`)).json).toMatchObject({
      afterPowerLoss: 'unknown',
    });
    expect(
      (await api('POST', `/api/v1/devices/${id}/power`, { action: 'wol-enable', apply: true })).json
        .error.details.reason,
    ).toBe('elevation_required');
    expect((await api('POST', `/api/v1/devices/${id}/wake`)).json.error.details.reason).toBe(
      'not_wakeable',
    );
    const upd = await api('POST', `/api/v1/devices/${id}/updates`, {
      bundles: [
        {
          manifest: {
            target: 'storage',
            version: '0.6.1',
            channel: 'stable',
            sha256: '0'.repeat(64),
            size: 1,
          },
          signature: 'A'.repeat(86),
          payload: 'eA==',
        },
      ],
    });
    expect(upd.json.items[0]).toMatchObject({ status: 'refused' });
    expect((await api('GET', `/api/v1/devices/${id}/updates`)).json.items).toHaveLength(1);
    expect(
      (
        await api('POST', `/api/v1/devices/${id}/grants`, {
          kind: 'mcp',
          grantee: { kind: 'user', id: 'x' },
          server: 'notes',
        })
      ).status,
    ).toBe(201);
    expect(
      (await api('GET', `/api/v1/devices/${id}/mcp?granteeKind=user&granteeId=x`)).json.servers,
    ).toHaveLength(1);
    const call = await api('POST', `/api/v1/devices/${id}/mcp/call`, {
      server: 'notes',
      tool: 'find',
      grantee: { kind: 'user', id: 'x' },
    });
    expect(call.json).toMatchObject({ untrusted: true, isError: false });
    expect(
      (await api('POST', `/api/v1/devices/${id}/mcp/call`, { server: 'notes', tool: 'find' }))
        .status,
    ).toBe(403);
  });
});
