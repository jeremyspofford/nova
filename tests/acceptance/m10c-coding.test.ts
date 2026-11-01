// M10c gate, end to end: a new user's Nova (blank profile, setup by conversation) takes a coding
// request in chat. A scripted chat model (scripts/stand-ins/fake-coder-chat.js) calls code_change;
// Claude Code's stand-in writes the change; Nova asks before it tests and previews it, then asks,
// at tier 3, before the merge, with the reviewed diff, the test result and the preview link in
// hand. Declined, the person's repository and its bare "remote" stay byte-identical; a second
// request, confirmed, merges exactly the reviewed diff and pushes nothing. All through the real
// server's API with the egress tripwire preloaded, on throwaway repositories in a temp folder. Set
// NOVA_EVIDENCE=<file> to keep a transcript.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { blank, sleep, stop } from './support.ts';
import { APP_FIXED, FAKE_CLAUDE, ROOT, agentScript, git, makeRepos, treeHash } from '../support/coding.ts';

test('M10c gate: a coding request in chat ends as a reviewed diff with green tests and a running preview, asks before merge; declined, nothing is merged; confirmed, exactly the reviewed diff', { timeout: 300_000 }, async () => {
  const m = blank('nova-m10c-');
  const repos = makeRepos('nova-m10c-repos-');
  const api = (p: string) => `/api/v1${p}`;
  const get = (p: string) => m.get(api(p));
  const post = (p: string, body: unknown = {}) => m.send('POST', api(p), body);
  const settle = async (id: string) => {
    let t = await get(`/tasks/${id}`);
    for (let i = 0; i < 2400 && !['done', 'failed', 'waiting', 'cancelled'].includes(t.state); i++) { await sleep(25); t = await get(`/tasks/${id}`); }
    return t;
  };
  const evidence: string[] = ['# M10c gate: coding through chat, end to end', ''];
  const nova = await m.start({ NOVA_AGENT_CMD: `node ${join(ROOT, 'scripts/stand-ins/fake-coder-chat.js')}`, NOVA_AGENT_EGRESS: 'none' });
  // A message in a new conversation, and the conversation once Nova's reply has finished.
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
  const runOf = async () => (await get('/coding')).runs[0];
  const step = async (run: string, name: string) => {
    for (let i = 0; i < 800; i++) {
      const v = await get(`/coding/runs/${run}`);
      const ref = v.tasks.filter((x: { step: string }) => x.step === name).at(-1);
      if (ref) return settle(ref.id);
      await sleep(25);
    }
    throw new Error(`no ${name} step`);
  };
  try {
    // A new user, set up by conversation, who lets Nova use the cloud for this.
    for (const text of ['new', 'yes', 'yes', "Hi! I'm Sam.", 'yes', 'keep', 'plainly, please', 'keep everything on this machine', 'no', 'yes']) assert.equal((await post('/setup/messages', { text })).status, 200);
    assert.equal((await get('/profile')).privacy.default, 'local-only');
    assert.deepEqual((await get('/coding')).runs, []);

    // Local-only, a coding agent off the devices is refused, and chat hears why.
    assert.equal((await m.send('PUT', api('/providers/claude-code/config'), { config: { command: `node ${FAKE_CLAUDE} --script ${agentScript('fix', join(repos.dir, 'scripts'))}` } })).status, 200);
    assert.equal((await post('/providers/claude-code/enable', { approved: true })).body.enabled, true);
    const request = `In the repository at ${repos.person}, make greet() say “Hello, <name>!” as its test expects. Test with \`node --test\`, preview with \`node server.mjs\`.`;
    const refused = await chat(request);
    assert.match(refused.text, /No coding agent is on\. What is on sends data off your devices, and your privacy setting is local-only/);
    assert.deepEqual((await get('/coding')).runs, [], 'nothing was started');
    evidence.push(`- Local-only: the request in chat was refused, and chat said why: “${/No coding agent is on[^"]*/.exec(refused.text)?.[0]}” No run was made.`);

    assert.equal((await m.send('PUT', api('/profile/privacy/default'), { value: 'cloud-allowed' })).status, 200);
    const personBefore = treeHash(repos.person);
    const remoteBefore = treeHash(repos.remote);
    const base = git(repos.person, 'rev-parse', 'main');

    // 1. The request in chat → a plan in the Work Ledger.
    const asked = await chat(request);
    assert.match(asked.text, /Started coding run r[0-9a-f]+/);
    const run = await runOf();
    assert.equal(run.state === 'writing' || run.state === 'checking', true, run.state);
    assert.equal(run.session_id, asked.id, 'the run knows the conversation it came from');
    evidence.push(`- Chat: “${request.replace(repos.dir, '<tmp>')}” → the chat model called code_change → coding run ${run.id}.`);
    const write = await step(run.id, 'write');
    assert.equal(write.state, 'done', write.reason);
    assert.equal(write.approval_tier, 1);
    assert.equal(write.verification.ok, true);
    assert.equal(treeHash(repos.person), personBefore, 'the write touched nothing of the person’s');
    evidence.push(`- Write (tier 1): ${write.report.summary.replace(repos.dir, '<tmp>')}`, `  - Verified: ${write.verification.checks[0].why}`);

    // 2. Tests and the preview: asked first (tier 2).
    const check = await step(run.id, 'check');
    assert.equal(check.state, 'waiting');
    assert.equal(check.approval_tier, 2);
    let v = await get(`/coding/runs/${run.id}`);
    assert.deepEqual(v.changes.map((c: { path: string }) => c.path), ['app.mjs']);
    evidence.push(`- Check (tier 2) asked first: “${check.reason}” — the person sees the diff:`, '', '```diff', v.diff.trimEnd(), '```', '');
    assert.equal((await post(`/tasks/${check.id}/approve`)).status, 200);
    const checked = await settle(check.id);
    assert.equal(checked.state, 'done', checked.reason);
    evidence.push(`- Check ran: ${checked.report.summary}`, ...checked.verification.checks.map((c: { requirement: { kind: string }; why: string }) => `  - ${c.requirement.kind}: ${c.why}`));

    // 3. The merge ask (tier 3), with the reviewed diff, green tests and the running preview.
    const merge = await step(run.id, 'merge');
    assert.equal(merge.state, 'waiting');
    assert.equal(merge.approval_tier, 3);
    v = await get(`/coding/runs/${run.id}`);
    assert.equal(v.state, 'review');
    assert.equal(v.test.passed, true);
    assert.equal(v.preview.running, true);
    const page = await (await fetch(v.preview.url)).text();
    assert.equal(page, 'Hello, preview!');
    evidence.push(`- Merge (tier 3) asks: “${merge.brief.goal.replace(repos.dir, '<tmp>')}”. Test ${v.test.command} passed on ${v.test.commit.slice(0, 7)}; the preview at ${v.preview.url} answered “${page}”.`);
    const noConfirm = await post(`/tasks/${merge.id}/approve`);
    assert.equal(noConfirm.status, 400);
    assert.match(noConfirm.body.error, /explicit confirmation/);
    const told = (await get('/messages')).map((x: { text: string }) => x.text).join('\n');
    assert.match(told, /is ready for you to review: `node --test` passed, and its preview is at http:\/\/127\.0\.0\.1:\d+\//, 'Nova told the person');

    // Declined: nothing merged, nothing pushed.
    const declined = await post(`/coding/runs/${run.id}/decline`);
    assert.equal(declined.status, 200);
    assert.equal(declined.body.state, 'declined');
    assert.equal(git(repos.person, 'rev-parse', 'main'), base);
    assert.equal(treeHash(repos.person), personBefore, 'the person’s repository, .git and all, is byte-identical');
    assert.equal(treeHash(repos.remote), remoteBefore, 'the remote is byte-identical: nothing was pushed');
    await assert.rejects(fetch(v.preview.url, { signal: AbortSignal.timeout(3000) }));
    evidence.push(`- Declined: ${declined.body.reason} main is still ${base.slice(0, 7)}; the person’s repository (with .git) and the bare remote hash the same as before; the preview stopped.`);

    // A second request, confirmed: exactly the reviewed diff, and still nothing pushed.
    await chat(request);
    const run2 = await runOf();
    assert.notEqual(run2.id, run.id);
    assert.equal((await step(run2.id, 'write')).state, 'done');
    const check2 = await step(run2.id, 'check');
    assert.equal((await post(`/tasks/${check2.id}/approve`)).status, 200);
    assert.equal((await settle(check2.id)).state, 'done');
    const merge2 = await step(run2.id, 'merge');
    const reviewed = await get(`/coding/runs/${run2.id}`);
    assert.equal((await post(`/tasks/${merge2.id}/approve`, { confirm: true })).status, 200);
    const merged = await settle(merge2.id);
    assert.equal(merged.state, 'done', merged.reason);
    assert.equal(merged.verification.ok, true);
    assert.equal(git(repos.person, 'rev-parse', 'main'), reviewed.head);
    assert.equal(`${git(repos.person, 'diff', '--no-color', base, 'main')}\n`, reviewed.diff, 'the merged diff is the reviewed diff');
    assert.equal(readFileSync(join(repos.person, 'app.mjs'), 'utf8'), APP_FIXED);
    assert.equal(treeHash(repos.remote), remoteBefore, 'nothing was pushed');
    evidence.push(`- Confirmed (second run ${run2.id}): ${merged.report.summary.replace(repos.dir, '<tmp>')}`, `  - Verified: ${merged.verification.checks[0].why.replace(repos.dir, '<tmp>')}`, '  - `git diff <base> main` in the person’s repository is byte-identical to the reviewed diff; the bare remote is unchanged.');

    // Chat can say where things stand.
    const status = await chat('What is the status of my coding runs?');
    assert.match(status.text, new RegExp(`${run2.id} · .* · merged`));
    assert.match(status.text, new RegExp(`${run.id} · .* · declined`));

    assert.equal(readFileSync(m.egress, 'utf8'), '', 'nothing tried to leave this machine');
    evidence.push('- Egress tripwire: nothing tried to leave this machine.');
  } finally {
    await stop(nova);
    if (process.env.NOVA_EVIDENCE) writeFileSync(process.env.NOVA_EVIDENCE, `${evidence.join('\n')}\n`);
  }
});
