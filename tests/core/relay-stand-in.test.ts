// The Relay stand-in (scripts/stand-ins/fake-relay.js) answers in Relay's contract v1: every route
// a client uses, driven end to end, and each response checked against tests/support/
// relay-contract-v1.json (a copy of Relay v0.9.0's contract/v1.json, commit 4add265) with a port
// of Relay's own validator. Also: the transport rules (header, Host, body size), runtime_busy,
// a repeated requestId, a stale baseCommit, cancel, and real worktrees with scripted edits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startFakeRelay } from '../../scripts/stand-ins/fake-relay.js';
import { CONTRACT, checkRequest, checkResponse, validate } from '../support/relay-contract.ts';
import { BROKEN_SUM, FIXED_SUM, writeCalc } from '../support/providers.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

function repo(): { dir: string; head: string } {
  const dir = mkdtempSync(join(tmpdir(), 'relay-repo-'));
  writeCalc(dir);
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'baseline');
  return { dir, head: git(dir, 'rev-parse', 'HEAD') };
}

// A client that checks what it sends and what comes back against the contract.
function client(url: string) {
  const problems: string[] = [];
  const call = async (method: string, path: string, route: string, body?: unknown, headers: Record<string, string> = {}) => {
    if (body !== undefined) problems.push(...checkRequest(route, body));
    const res = await fetch(url + path, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json', 'x-relay-client': 'relay-local' } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const json = await res.json();
    problems.push(...checkResponse(route, res.status, json));
    return { status: res.status, body: json as any };
  };
  return { call, problems };
}

test('the stand-in speaks contract v1 end to end: connect, task, ready, profile, start, poll, handoff', async () => {
  const relay = await startFakeRelay({ mode: 'honest', lagMs: 30 });
  const { call, problems } = client(relay.url);
  const { dir, head } = repo();
  try {
    const status = await call('GET', '/api/status', 'GET /api/status');
    assert.equal(status.body.api, 1);
    assert.equal(status.body.workerEgress, 'local');
    assert.ok(status.body.engines.some((e: any) => e.workersAvailable));

    const project = await call('POST', '/api/projects', 'POST /api/projects', { directory: dir });
    assert.equal(project.status, 201);
    assert.equal(project.body.commit, head);
    const again = await call('POST', '/api/projects', 'POST /api/projects', { directory: dir });
    assert.equal(again.body.id, project.body.id, 'connecting the same folder again is deduplicated');

    const task = await call('POST', '/api/tasks', 'POST /api/tasks', { title: 'Fix calc', outcome: 'Make the failing test in calc/ pass.' });
    assert.equal(task.body.status, 'draft');
    assert.equal((await call('PATCH', `/api/tasks/${task.body.id}`, 'PATCH /api/tasks/:id', { status: 'ready' })).body.status, 'ready');

    const state = await call('GET', '/api/state', 'GET /api/state');
    const profile = state.body.profiles.find((p: any) => p.name === 'Builder');
    const start = { taskId: task.body.id, projectId: project.body.id, profileId: profile.id, profileRevision: profile.revision, baseCommit: head, requestId: randomUUID(), context: 'calc/', check: 'none', allowTests: false };
    const started = await call('POST', '/api/workers', 'POST /api/workers', start);
    assert.equal(started.status, 202);
    // The same requestId with the same settings is the same run, never a second one.
    assert.equal((await call('POST', '/api/workers', 'POST /api/workers', start)).body.id, started.body.id);
    assert.equal((await call('POST', '/api/workers', 'POST /api/workers', { ...start, context: 'other' })).status, 409);

    let run: any;
    for (let i = 0; i < 200; i++) {
      run = (await call('GET', `/api/workers/${started.body.id}`, 'GET /api/workers/:id')).body;
      if (run.status === 'completed') break;
      await sleep(10);
    }
    assert.equal(run.status, 'completed');
    assert.deepEqual(run.review.files, ['calc/sum.mjs']);
    assert.match(run.review.diff, /a \+ b/);
    assert.match(run.worktree.branch, /^relay\/[a-f0-9-]{36}$/);
    assert.equal(readFileSync(join(run.worktree.directory, 'calc/sum.mjs'), 'utf8'), FIXED_SUM, 'a real worktree, really edited');
    assert.equal(readFileSync(join(dir, 'calc/sum.mjs'), 'utf8'), BROKEN_SUM, 'the connected repository is untouched');
    assert.equal(git(run.worktree.directory, 'rev-parse', 'HEAD'), head);

    const handoff = await call('GET', `/api/workers/${run.id}/handoff.json`, 'GET /api/workers/:id/handoff.json');
    assert.equal(handoff.status, 200);
    assert.equal((await call('GET', `/api/workers/${randomUUID()}`, 'GET /api/workers/:id')).status, 404);
    assert.equal((await call('POST', `/api/runs/${run.id}/cancel`, 'POST /api/runs/:id/cancel', {})).status, 409, 'a finished run is not the active one');
    assert.deepEqual(problems, [], 'every request and response matches the contract');
  } finally {
    await relay.close();
  }
});

test('the stand-in keeps the transport rules: the header, the Host, the body size', async () => {
  const relay = await startFakeRelay();
  try {
    const noHeader = await fetch(`${relay.url}/api/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 't', outcome: 'o' }) });
    assert.equal(noHeader.status, 403);
    assert.deepEqual(validate(CONTRACT, CONTRACT.commonErrors['403']!, await noHeader.json()), []);
    const big = await fetch(`${relay.url}/api/tasks`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-relay-client': 'relay-local' }, body: JSON.stringify({ title: 't', outcome: 'x'.repeat(40_000) }) });
    assert.equal(big.status, 413);
    const origin = await fetch(`${relay.url}/api/status`, { headers: { origin: 'http://example.invalid' } });
    assert.equal(origin.status, 403);
    // A Host that isn't Relay's own (as a rebinding page would send) is refused.
    const host = await new Promise<number>((ok, fail) => {
      const r = request({ host: '127.0.0.1', port: relay.port, path: '/api/status', headers: { host: `relay.example.invalid:${relay.port}` } }, (res) => { res.resume(); ok(res.statusCode ?? 0); });
      r.on('error', fail);
      r.end();
    });
    assert.equal(host, 403);
  } finally {
    await relay.close();
  }
});

test('the stand-in: runtime_busy, a stale baseCommit, cancel mid-run, a lying and a mismatched worker', async () => {
  const relay = await startFakeRelay({ busy: 1, slowMs: 400 });
  const { call, problems } = client(relay.url);
  const { dir, head } = repo();
  const begin = async (over: Record<string, unknown> = {}) => {
    const project = (await call('POST', '/api/projects', 'POST /api/projects', { directory: dir })).body;
    const task = (await call('POST', '/api/tasks', 'POST /api/tasks', { title: 'Fix calc', outcome: 'Fix it.' })).body;
    await call('PATCH', `/api/tasks/${task.id}`, 'PATCH /api/tasks/:id', { status: 'ready' });
    const profile = (await call('GET', '/api/state', 'GET /api/state')).body.profiles[0];
    return call('POST', '/api/workers', 'POST /api/workers', { taskId: task.id, projectId: project.id, profileId: profile.id, profileRevision: profile.revision, baseCommit: head, requestId: randomUUID(), check: 'none', allowTests: false, ...over });
  };
  const finish = async (id: string) => {
    for (let i = 0; i < 300; i++) {
      const r = (await call('GET', `/api/workers/${id}`, 'GET /api/workers/:id')).body;
      if (['completed', 'failed', 'cancelled', 'interrupted'].includes(r.status)) return r;
      await sleep(10);
    }
    throw new Error('the run never finished');
  };
  try {
    const busy = await begin();
    assert.equal(busy.status, 409);
    assert.equal(busy.body.code, 'runtime_busy');

    // Cancel while it runs.
    const slow = await begin();
    assert.equal(slow.status, 202);
    await sleep(60);
    const also = await begin();
    assert.equal(also.body.code, 'runtime_busy', 'one run slot');
    const cancel = await call('POST', `/api/runs/${slow.body.id}/cancel`, 'POST /api/runs/:id/cancel', {});
    assert.deepEqual([cancel.status, cancel.body], [202, { status: 'cancelling' }]);
    assert.equal((await finish(slow.body.id)).status, 'cancelled');
    assert.deepEqual(relay.cancels, [slow.body.id]);

    // A lying worker: says it fixed it, changes nothing.
    relay.set({ slowMs: 0, mode: 'lying' });
    const lie = await finish((await begin()).body.id);
    assert.equal(lie.status, 'completed');
    assert.match(lie.text, /Fixed calc\/sum\.mjs/);
    assert.deepEqual(lie.review.files, []);

    // A mismatched report: the worktree has a file the review leaves out.
    relay.set({ mode: 'mismatched' });
    const odd = await finish((await begin()).body.id);
    assert.deepEqual(odd.review.files, ['calc/sum.mjs']);
    assert.ok(existsSync(join(odd.worktree.directory, 'calc/notes.md')));

    // The repository moved on: setup fails, still 202.
    relay.set({ mode: 'honest' });
    const stale = await begin({ baseCommit: 'a'.repeat(40) });
    assert.equal(stale.status, 202);
    assert.equal(stale.body.status, 'failed');
    assert.deepEqual(problems, []);
  } finally {
    await relay.close();
  }
});
