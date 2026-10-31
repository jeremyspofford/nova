// Review item 1 of PR #258, from the runner's and the helpers' side: a run's own privacy mode (a
// Work Ledger task's, which helpers.js and the scheduler pass as `privacy`) holds every screen that
// run makes, even when the person's default is cloud-allowed and Jev is set up. The screen of a
// read, of a helper's files, and of a report handed back are each held to it. A control without
// the run's mode shows the path really reaches Jev (cloud mode, owner decision 1). Jev is a
// loopback stand-in; nothing calls TypeSafe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startJevStandIn } from '../support/jev-stand-in.ts';
import { call, scripted, sleep, startNova } from './support.js';

const settings = (url) => ({ jev: { base_url: url, model: 'jev-1.14.0' }, tev1: null, opt_in: { screening: false, box: false } });
const got = (jev, s) => jev.requests.some((r) => JSON.stringify(r.body.state).includes(s));

async function rig() {
  const jev = await startJevStandIn({ noul: () => 0.02 });
  const m = scripted((step) => [call('read_file', { path: 'workspace/private-notes.txt' }), 'Done.'][step] ?? 'Done.');
  const h = await startNova({ agent: m.agent, privacy: 'cloud-allowed', hub: 'http://127.0.0.1:9', decision: { settings: settings(jev.url), key: jev.key } });
  mkdirSync(join(h.home, 'workspace'), { recursive: true });
  return { h, jev, close: async () => { await h.close(); await jev.close(); } };
}
const idle = async (h) => { for (let i = 0; i < 500 && h.nova.runner.active.size; i++) await sleep(20); };

test('a run whose own mode is local-only: its reads never go to Jev, and the record says local-only', async () => {
  const { h, jev, close } = await rig();
  try {
    writeFileSync(join(h.home, 'workspace', 'private-notes.txt'), 'Notes.\nPRIVATE-RUN-9911 my bank pin is 4417\n');
    h.nova.runner.ensureMain();
    h.nova.runner.send('main', 'Read my private notes.', { privacy: 'local-only' });
    await idle(h);
    assert.equal(got(jev, 'PRIVATE-RUN-9911'), false, 'the local-only run sent nothing to Jev');
    assert.deepEqual(h.nova.core.receipts.list({ egress: 'remote', limit: 50 }), []);
    const recs = h.nova.core.db.all("SELECT privacy_mode FROM decision_record WHERE template_id = 'ingest-screen'");
    assert.ok(recs.length > 0 && recs.every((r) => r.privacy_mode === 'local-only'), JSON.stringify(recs));
    // Control: the same read in a run with no mode of its own goes to Jev (cloud mode).
    writeFileSync(join(h.home, 'workspace', 'private-notes.txt'), 'Notes.\nCONTROL-RUN-5512\n');
    h.nova.runner.send('main', 'Read them again.');
    await idle(h);
    assert.equal(got(jev, 'CONTROL-RUN-5512'), true, 'without the run’s mode, cloud mode screens with Jev');
  } finally { await close(); }
});

test('a helper’s files and its report are held to the helper task’s local-only mode', async () => {
  const { h, jev, close } = await rig();
  try {
    const run = '2026-10-31-hlpr01';
    // As chat-run begins a helper (helpers.js: privacy is the task's mode).
    h.nova.runner.record(run, { type: 'session', id: run, title: 'Probe', kind: 'helper', parent: 'main', files: ['workspace/private.txt'], v: 1 });
    h.nova.runner.send(run, 'Summarise the file.', { helper: { title: 'Probe', files: [{ path: 'workspace/private.txt', text: 'PRIVATE-HELPER-3301 the safe code is 9182' }] }, privacy: 'local-only' });
    await idle(h);
    assert.equal(got(jev, 'PRIVATE-HELPER-3301'), false, 'a helper’s files: nothing to Jev');
    // Its report, handed back: screened under the helper task's mode.
    const report = { text: 'PRIVATE-REPORT-7710 the summary.', name: 'Probe' };
    const gate = await h.nova.runner.screenReport(run, report, { privacy: 'local-only', task_id: null });
    assert.ok(gate.screened, 'the report was screened (the helper read outside content)');
    assert.equal(got(jev, 'PRIVATE-REPORT-7710'), false, 'its report: nothing to Jev');
    assert.deepEqual(h.nova.core.receipts.list({ egress: 'remote', limit: 50 }), []);
    // Controls: without the task's mode, the same paths reach Jev in cloud mode.
    await h.nova.runner.screenReport(run, { text: 'CONTROL-REPORT-1201 the summary.', name: 'Probe' });
    assert.equal(got(jev, 'CONTROL-REPORT-1201'), true);
    const run2 = '2026-10-31-hlpr02';
    h.nova.runner.record(run2, { type: 'session', id: run2, title: 'Probe 2', kind: 'helper', parent: 'main', files: ['workspace/other.txt'], v: 1 });
    h.nova.runner.send(run2, 'Summarise the file.', { helper: { title: 'Probe 2', files: [{ path: 'workspace/other.txt', text: 'CONTROL-HELPER-4410 a file.' }] } });
    await idle(h);
    assert.equal(got(jev, 'CONTROL-HELPER-4410'), true);
  } finally { await close(); }
});
