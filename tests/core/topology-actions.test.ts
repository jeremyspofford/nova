import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { releaseRepo, scratch, supervise, cli, api as rawApi, until } from '../supervisor/support.ts';
import { SERVICE_TIMINGS } from '../supervisor/services-support.ts';
import { freePort, standIn } from '../support/services.ts';

// Fixed topology routes require the guard projected by the currently observed service.
// Explicit supplied guards are never replaced, so stale/race tests reach the real authority.
async function api(base: string, method: string, path: string, body?: any) {
  if (method === 'POST' && path.startsWith('/api/v1/services/hub/') && body && !Object.hasOwn(body, 'expected')) {
    const service = path.split('/')[5];
    const snapshot = await rawApi(base, 'GET', '/api/v1/services/topology');
    const row = snapshot.body.machines.flatMap((m: any) => m.services).find((s: any) => s.service === service);
    body = { ...body, expected: row?.rollback.expected ?? { live: null, previous: null, assigned: null } };
  }
  return rawApi(base, method, path, body);
}

test('fixed hub API reaches supervisor IPC and actual manager: tiers, confirmations, readiness and rollback', async () => {
  const dir = scratch('nova-topology-actions-');
  const s = await supervise({ dir, repo: releaseRepo(dir).repo, timings: SERVICE_TIMINGS });
  try {
    assert.equal((await api(s.base(), 'POST', '/api/v1/services/hub/missing/promote', { version: '1', confirm: 'missing@1' })).status, 409);
    for (const [service, secrets, tier] of [['ordinary', [], 2], ['privileged', ['file-access'], 3], ['capture-demo', ['screen-recording'], 3]] as const) {
      const port = await freePort();
      for (const version of ['1.0.0', '2.0.0']) {
        const def = standIn({ version, port });
        def.service = service;
        def.os_permissions = [...secrets];
        if (service === 'capture-demo') { def.alongside = 'none'; def.placement = { mode: 'pinned', device: 'hub', roles: ['capture-source'] }; }
        const file = join(dir, `${service}-${version}.json`);
        writeFileSync(file, JSON.stringify(def));
        const deploy = await cli(s.dir, 'service', 'deploy', file, '--confirm', `${service}@${version}`);
        assert.equal(deploy.code, 0, deploy.out);
        const map = await api(s.base(), 'GET', '/api/v1/services/topology');
        assert.equal(map.status, 200);
        const svc = map.body.machines[0].services.find((x: any) => x.service === service);
        assert.equal(svc.versions.find((v: any) => v.version === version).promote.tier, tier);
        const route = `/api/v1/services/hub/${service}/promote`;
        assert.equal((await api(s.base(), 'POST', route, { version, confirm: 'wrong' })).status, 400);
        assert.equal((await api(s.base(), 'POST', route, { version, confirm: `${service}@${version}`, argv: ['bad'] })).status, 400);
        const promoted = await api(s.base(), 'POST', route, { version, confirm: `${service}@${version}` });
        assert.equal(promoted.status, 200, JSON.stringify(promoted.body));
        assert.equal(promoted.body.accepted, true);
        assert.match(promoted.body.said, /accepted.*does not confirm/);
        await until(async () => { const rows = JSON.parse((await cli(s.dir, 'services', '--json')).out); return rows.find((x: any) => x.service === service)?.live === version; }, 'accepted promotion to be observed');
        await until(() => s.state()?.services?.find((x: any) => x.service === service)?.history?.some((x: any) => x.version === version && x.outcome === 'promoted'), 'the manager canary to finish');
        assert.equal((await api(s.base(), 'POST', route, { version, confirm: `${service}@${version}` })).status, 409, 'live is no longer ready');
      }
      const back = `/api/v1/services/hub/${service}/rollback`;
      assert.equal((await api(s.base(), 'POST', back, { confirm: 'wrong' })).status, 400);
      const accepted = await api(s.base(), 'POST', back, { confirm: 'rollback' });
      assert.equal(accepted.status, 200);
      assert.equal(accepted.body.accepted, true);
      await until(() => s.state()?.services?.find((x: any) => x.service === service)?.live === '1.0.0', 'accepted rollback to be observed');
      const map = await api(s.base(), 'GET', '/api/v1/services/topology');
      assert.equal(map.body.machines[0].services.find((x: any) => x.service === service).rollback.tier, 2);
    }
    const candidate = standIn({ version: '3.0.0', service: 'revoked-candidate', port: await freePort() });
    const file = join(dir, 'candidate.json');
    writeFileSync(file, JSON.stringify(candidate));
    assert.equal((await cli(s.dir, 'service', 'deploy', file, '--confirm', 'revoked-candidate@3.0.0')).code, 0);
    const accepted = await api(s.base(), 'POST', '/api/v1/services/hub/revoked-candidate/promote', { version: '3.0.0', confirm: 'revoked-candidate@3.0.0' });
    assert.equal(accepted.body.accepted, true);
    unlinkSync(join(s.dir, 'registry', 'revoked-candidate', '3.0.0.json'));
    await until(async () => JSON.stringify((await api(s.base(), 'GET', '/api/v1/problems')).body).includes('The accepted change to revoked-candidate was refused'), 'execution revalidation refusal to be reported');
    assert.equal(s.state().services.find((x: any) => x.service === 'revoked-candidate').live, null);
  } finally { await s.stop(); }
});


test('console promotion and rollback acknowledge acceptance before restarting the requester', async () => {
  const { consoleDefinition } = await import('../../src/core/services/console.ts');
  const dir = scratch('nova-topology-console-');
  const s = await supervise({ dir, repo: releaseRepo(dir).repo, timings: SERVICE_TIMINGS });
  try {
    const file = join(dir, 'console.json');
    writeFileSync(file, JSON.stringify(consoleDefinition({ version: 'v1.0.0', port: 0 })));
    const deployed = await cli(s.dir, 'service', 'deploy', file, '--confirm', 'nova-console@v1.0.0');
    assert.equal(deployed.code, 0, deployed.out);
    const promoted = await api(s.base(), 'POST', '/api/v1/services/hub/nova-console/promote', { version: 'v1.0.0', confirm: 'nova-console@v1.0.0' });
    assert.equal(promoted.status, 200);
    assert.equal(promoted.body.accepted, true);
    assert.match(promoted.body.said, /accepted.*does not confirm/);
    await until(() => s.state()?.deploy?.outcome === 'promoted', 'console manager promotion to finish');
    assert.equal(s.state().releases.current, 'v1.0.0');
    const rolled = await api(s.base(), 'POST', '/api/v1/services/hub/nova-console/rollback', { confirm: 'rollback' });
    assert.equal(rolled.status, 200);
    assert.equal(rolled.body.accepted, true);
    await until(() => s.state()?.releases?.current === 'base' && s.state()?.mode === 'running', 'console rollback to finish');
  } finally { await s.stop(); }
});
