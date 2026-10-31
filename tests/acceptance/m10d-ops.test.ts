// M10d gate, end to end: a new user's Nova (blank profile, set up by conversation, local-only) takes
// infrastructure, network and account requests in chat. A scripted chat model
// (scripts/stand-ins/fake-ops-chat.js) calls infra_plan, network_change and account_change. Against
// stand-ins only: OpenTofu is scripts/stand-ins/fake-tofu.js on a PATH of the test's own, the network
// target is the loopback stand-in over a file in a temp folder, and the phone is a device paired the
// way the plan says, over the real mesh listener. All through the real server's API with the egress
// tripwire preloaded. Set NOVA_EVIDENCE=<file> to keep a transcript.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { blank, sleep, stop } from './support.ts';
import { PRICES, ROOT, config, fakeToken, filesHolding, makeProject, tofuCalls, tofuOnPath } from '../support/infra.ts';
import { Joiner, call } from '../core/mesh-support.ts';
import { startNetconfig } from '../../scripts/stand-ins/fake-netconfig.js';

const INITIAL = { firewall: { allow: ['mesh', 'web'], default: 'drop' }, dns: { records: { 'printer.home.example': '192.0.2.20' } }, wifi: { ssid: 'example-net', psk: `example-wifi-key-${fakeToken().slice(-8)}` } };

test('M10d gate: infrastructure, a network change and an account step through chat, each asking at tier 3, with no secret in any transcript, log or file', { timeout: 300_000 }, async () => {
  const m = blank('nova-m10d-');
  const { path } = tofuOnPath();
  const api = (p: string) => `/api/v1${p}`;
  const get = (p: string) => m.get(api(p));
  const post = (p: string, body: unknown = {}) => m.send('POST', api(p), body);
  const settle = async (id: string, states = ['done', 'failed', 'waiting', 'cancelled']) => {
    let t = await get(`/tasks/${id}`);
    for (let i = 0; i < 2400 && !states.includes(t.state); i++) { await sleep(25); t = await get(`/tasks/${id}`); }
    return t;
  };
  const evidence: string[] = ['# M10d gate: infrastructure, networking and accounts through chat, end to end', ''];
  const infraToken = fakeToken();
  const netToken = fakeToken();
  const login = { username: `example-user-${fakeToken().slice(-6)}`, password: `example-pw-${fakeToken().slice(-16)}` };
  const net = await startNetconfig({ file: join(mkdtempSync(join(tmpdir(), 'nova-m10d-net-')), 'router.json'), token: netToken, initial: INITIAL });
  const nova = await m.start({
    NOVA_AGENT_CMD: `node ${join(ROOT, 'scripts/stand-ins/fake-ops-chat.js')}`, NOVA_AGENT_EGRESS: 'none',
    NOVA_MESH_URL: 'http://127.0.0.1:0', NOVA_MESH_TRANSPORT: 'proxy', NOVA_MESH_PUBLIC_URL: 'https://hub.example.test',
    PATH: `${path}:${process.env.PATH ?? ''}`,
  });
  // Behind the (stand-in) TLS proxy: the listener's own address, from the server's ready line.
  const meshBase = `http://127.0.0.1:${/listening on [^ ]*:(\d+),/.exec(nova.out.join(''))?.[1]}`;
  const chat = async (text: string) => {
    const res = await fetch(`${m.base}/api/sessions`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-nova': '1' }, body: JSON.stringify({ text }) });
    assert.equal(res.status, 201);
    const { id } = await res.json() as { id: string };
    let s: any;
    for (let i = 0; i < 800; i++) {
      s = await (await fetch(`${m.base}/api/sessions/${id}`)).json();
      if (s.live === null) break;
      await sleep(25);
    }
    return { id, s, text: JSON.stringify(s) };
  };
  const transcripts: string[] = [];
  let polling = false;
  try {
    // A new user, set up by conversation, keeping everything on this machine.
    for (const text of ["Hi! I'm Sam.", 'yes', 'keep', 'plainly, please', 'keep everything on this machine', 'yes']) assert.equal((await post('/setup/messages', { text })).status, 200);
    assert.equal((await get('/profile')).privacy.default, 'local-only');

    // ---- Infrastructure ----
    // The person registers a project (outside chat): its folder, budget, prices, and its secret.
    const proj = makeProject();
    const p = await post('/infra/projects', { name: 'Example', folder: proj.folder, budget_usd_month: 20, prices: PRICES, secrets: ['STANDIN_TOKEN'], egress: 'local' });
    assert.equal(p.status, 201, JSON.stringify(p.body));
    assert.equal((await m.send('PUT', api(`/infra/projects/${p.body.id}/secrets/STANDIN_TOKEN`), { value: infraToken })).body.stored, true);
    const asked = await chat('Plan the infrastructure project Example.');
    transcripts.push(asked.text);
    assert.match(asked.text, /Started infrastructure run i[0-9a-f]+ on “Example”/);
    const run = (await get('/infra')).runs[0];
    evidence.push(`- Chat: “Plan the infrastructure project Example.” → infra_plan → run ${run.id}.`);
    const planTask = await settle(run.tasks[0].id);
    assert.equal(planTask.state, 'done', planTask.reason);
    assert.equal(planTask.approval_tier, 1);
    let v = await get(`/infra/runs/${run.id}`);
    assert.equal(v.state, 'review');
    assert.match(v.plan_text, /Plan: 2 to add, 0 to change, 0 to destroy\./);
    evidence.push(`- Plan (tier 1, automatic): ${planTask.report.summary}`, '  - The plan, shown in full before any apply:', '', '```', v.plan_text.trimEnd(), '```', '');
    const apply = await settle(v.tasks.find((x: { step: string }) => x.step === 'apply').id);
    assert.equal(apply.state, 'waiting');
    assert.equal(apply.approval_tier, 3);
    assert.equal(existsSync(join(proj.folder, 'terraform.tfstate')), false, 'nothing applied before the confirmation');
    const noConfirm = await post(`/tasks/${apply.id}/approve`);
    assert.equal(noConfirm.status, 400);
    assert.match(noConfirm.body.error, /explicit confirmation/);
    const cps = (await get('/resilience/checkpoints')).checkpoints.length;
    assert.equal((await post(`/tasks/${apply.id}/approve`, { confirm: true })).status, 200);
    const applied = await settle(apply.id, ['done', 'failed']);
    assert.equal(applied.state, 'done', applied.reason);
    v = await get(`/infra/runs/${run.id}`);
    const cpsAfter = (await get('/resilience/checkpoints')).checkpoints.length;
    assert.equal(cpsAfter, cps + 1, 'a checkpoint was taken before the apply');
    evidence.push(`- Apply (tier 3) asked; without confirm: “${noConfirm.body.error}”. Confirmed: ${applied.report.summary}`, `  - Verified: ${applied.verification.checks[0].why}`, `  - Checkpoint before the apply: ${v.checkpoint}.`);

    // A budget breach: a second project whose plan would go over its budget.
    const big = makeProject(config({ standin_server: { a: { size: 'large' } } }));
    const p2 = await post('/infra/projects', { name: 'Big', folder: big.folder, budget_usd_month: 10, prices: PRICES, secrets: ['STANDIN_TOKEN'], egress: 'local' });
    await m.send('PUT', api(`/infra/projects/${p2.body.id}/secrets/STANDIN_TOKEN`), { value: infraToken });
    transcripts.push((await chat('Plan the infrastructure project Big.')).text);
    const run2 = (await get('/infra')).runs[0];
    await settle(run2.tasks[0].id);
    const v2 = await get(`/infra/runs/${run2.id}`);
    assert.equal(v2.state, 'over_budget');
    assert.equal(v2.tasks.filter((x: { step: string }) => x.step === 'apply').length, 0, 'no apply is offered');
    const problems = (await get('/problems?open=1')).map((x: { message: string }) => x.message).join('\n');
    assert.match(problems, /Budget alert: The plan for “Big” would cost \+\$40\.00 a month/);
    assert.ok(!tofuCalls(big.folder).some((c) => c.args[0] === 'apply'));
    evidence.push(`- Budget breach: “${v2.reason}” No apply task exists; the problem is listed and the person was told.`);

    // ---- Networking ----
    const t = await post('/network/targets', { name: 'Example router', kind: 'router', url: net.url });
    assert.equal(t.status, 201, JSON.stringify(t.body));
    await m.send('PUT', api(`/network/targets/${t.body.id}/token`), { value: netToken });
    const patch = '{"dns": {"records": {"nas.home.example": "192.0.2.30"}}}';
    const refused = await chat(`Change Example router: ${patch}`);
    transcripts.push(refused.text);
    assert.match(refused.text, /none is paired\. Pair your phone first/);
    evidence.push('- Network change with no paired device: refused, and chat said why (“Pair your phone first”).');
    // A phone pairs over the mesh listener, and keeps in touch while the firewall lets the mesh through,
    // from another machine through the TLS proxy in front of the listener (NOVA_MESH_TRANSPORT=proxy:
    // the proxy reports its address; 192.0.2.x is documentation space). Contact from the hub's own
    // machine never counts.
    const code = (await post('/mesh/pairings')).body.code;
    const phone = new Joiner(meshBase, () => Math.floor(Date.now() / 1000), { name: 'Example phone', kind: 'phone' });
    assert.equal((await phone.join(code)).status, 201);
    assert.equal((await phone.reveal()).status, 200);
    assert.equal((await post(`/mesh/requests/${phone.requestId}/approve`, { confirm: true })).status, 200);
    await phone.poll();
    const session = await phone.session();
    assert.equal(session.status, 200);
    polling = true;
    void (async () => {
      while (polling) {
        if ((net.config().firewall?.allow ?? []).includes('mesh')) await call(meshBase, 'GET', '/api/v1/health', undefined, { authorization: `Bearer ${session.body.token}`, 'x-forwarded-for': '192.0.2.50' }).catch(() => null);
        await sleep(100);
      }
    })();
    const changed = await chat(`Change Example router: ${patch}`);
    transcripts.push(changed.text);
    assert.match(changed.text, /Started network change c[0-9a-f]+ on Example router/);
    const ch = (await get('/network')).changes[0];
    const prep = await settle(ch.tasks[0].id);
    assert.equal(prep.state, 'done', prep.reason);
    let cv = await get(`/network/changes/${ch.id}`);
    assert.equal(cv.state, 'review');
    assert.ok(!JSON.stringify(cv).includes(INITIAL.wifi.psk), 'the Wi-Fi key is masked');
    const napply = await settle(cv.tasks.find((x: { step: string }) => x.step === 'apply').id);
    assert.equal(napply.approval_tier, 3);
    assert.equal(napply.state, 'waiting');
    assert.equal((await post(`/tasks/${napply.id}/approve`)).status, 400);
    assert.equal((await post(`/tasks/${napply.id}/approve`, { confirm: true })).status, 200);
    assert.equal((await settle(napply.id, ['done', 'failed'])).state, 'done');
    for (let i = 0; i < 400 && (cv = await get(`/network/changes/${ch.id}`)).state === 'watching'; i++) await sleep(25);
    assert.equal(cv.state, 'kept', cv.reason);
    assert.equal(cv.contact_device, 'Example phone');
    assert.equal(net.config().dns.records['nas.home.example'], '192.0.2.30');
    evidence.push(`- Network change (tier 3) applied after the confirmation. The diff the person saw (the Wi-Fi key is in no view: secret values are masked):`, '', '```diff', String(cv.diff).trimEnd(), '```', '', `- ${cv.reason}`);

    // ---- Accounts ----
    // The person saves a sign-in (outside chat). The chat asks for a password change: a tier-3 task,
    // with no password anywhere in it.
    assert.equal((await m.send('PUT', api('/browser/logins/127.0.0.1:5099'), login)).status, 200);
    const acct = await chat('Change my password at 127.0.0.1:5099.');
    transcripts.push(acct.text);
    assert.match(acct.text, /Asked the person in Tasks: “Change the password on 127\.0\.0\.1:5099”/);
    const tasks = await get('/tasks');
    const at = tasks.find((x: { title: string }) => x.title === 'Change the password on 127.0.0.1:5099');
    assert.equal(at.approval_tier, 3);
    assert.equal(at.state, 'waiting');
    assert.match(at.reason, /Needs your OK/);
    assert.equal((await post(`/tasks/${at.id}/cancel`, { reason: 'Not now.' })).status, 200);
    evidence.push(`- Account step: “Change my password at 127.0.0.1:5099.” → account_change → a tier-3 task (“${at.title}”), waiting for the person; declined. (The run itself, in Chromium, is tests/ui/m10d-account.test.ts.)`);

    // Chat can say where things stand.
    const st = await chat('Infrastructure status');
    assert.match(st.text, /Example · \$5\.00 a month of the \$20\.00 budget/);
    assert.match(st.text, /Big · /);

    // ---- No secret anywhere ----
    const secrets = [infraToken, netToken, login.password, INITIAL.wifi.psk];
    const files = filesHolding(m.dir, secrets);
    assert.deepEqual(files, [], `files holding a secret: ${files.join(', ')}`);
    assert.ok(!secrets.some((x) => nova.out.join('').includes(x)), 'the server’s own output');
    assert.ok(!secrets.some((x) => transcripts.join('\n').includes(x)), 'the chat transcripts');
    const records = JSON.stringify([await get('/tasks'), await get('/infra'), await get('/network'), await get('/problems'), await get('/messages')]);
    assert.ok(!secrets.some((x) => records.includes(x)), 'the tasks, runs, changes, problems and messages');
    evidence.push(`- Secrets: the project’s provider token (printed by the leaky stand-in on every plan and apply), the router’s token, its Wi-Fi key and the saved sign-in’s password are in no file under the test machine’s folder (Nova’s home, the user folder, the egress log), the server’s output, the ${transcripts.length} chat transcripts, or the API’s tasks, runs, changes, problems and messages.`);
    assert.equal(readFileSync(m.egress, 'utf8'), '', 'nothing tried to leave this machine');
    evidence.push('- Egress tripwire: nothing tried to leave this machine.');
  } finally {
    polling = false;
    await stop(nova);
    await net.close();
    if (process.env.NOVA_EVIDENCE) writeFileSync(process.env.NOVA_EVIDENCE, `${evidence.join('\n')}\n`);
  }
});
