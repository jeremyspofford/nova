// The PWA's components are pure functions; these check the rules they carry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approvalSheet, briefCard, chatBubble, deviceMeshCard, emptyState, evidenceViewer, handlingCard, healthCard, memoryHighlightCard, orb, proactiveBanner, status, taskRow, triggerRow, verifiedResultCard, voiceState } from '../ui/js/components.js';
import { ORB_STATES } from '../ui/js/status.js';
import { readdirSync, readFileSync } from 'node:fs';
import { contrast } from '../scripts/check-themes.js';

// The primary button, the send button and your chat bubble are lit with the accent, mixed into
// bg/raised (components.css); their label is text/primary. Checked in every built-in package and
// mode, the same way the package validator checks its token pairs.
test('accent-lit controls keep their labels readable in every built-in design system', () => {
  const parse = (v) => {
    const h = /^#([0-9a-f]{3,8})$/i.exec(v);
    if (h) {
      const x = h[1].length <= 4 ? [...h[1]].map((c) => c + c).join('') : h[1];
      return [0, 2, 4].map((i) => parseInt(x.slice(i, i + 2), 16)).concat(x.length === 8 ? parseInt(x.slice(6), 16) / 255 : 1);
    }
    const m = /^rgba?\(([^)]+)\)$/.exec(v)[1].split(',').map(Number);
    return [m[0], m[1], m[2], m[3] ?? 1];
  };
  const over = (fg, bg) => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat(1);
  const mix = (a, b, p) => [0, 1, 2].map((i) => a[i] * p + b[i] * (1 - p)).concat(1);
  for (const f of readdirSync('design-systems').filter((x) => x.endsWith('.json'))) {
    const pkg = JSON.parse(readFileSync(`design-systems/${f}`, 'utf8'));
    for (const [mode, t] of [['default', pkg.tokens], ...Object.entries(pkg.modes ?? {}).map(([m, o]) => [m, { ...pkg.tokens, ...o }])]) {
      const raised = over(parse(t['bg/raised']), parse(t['bg/base']));
      const lit = mix(parse(t['accent/primary']), raised, 0.24);
      const r = contrast(over(parse(t['text/primary']), lit).slice(0, 3), lit.slice(0, 3));
      assert.ok(r >= 4.5, `${f} ${mode}: text/primary on the accent-lit button is ${r.toFixed(2)}:1`);
    }
  }
});

const task = (id, state, more = {}) => ({ id, title: `Task ${id}`, state, reason: null, owner: 'workspace', approval_tier: 1, approved_at: null, user_visibility: 'handling', privacy_mode: 'local-only', brief: { goal: 'A goal.' }, report: null, verification: null, created_at: '2026-10-29T08:00:00Z', updated_at: '2026-10-29T08:00:00Z', ...more });
const verified = task('v1', 'done', {
  report: { summary: 'Wrote welcome.md.', evidence: [] },
  verification: { ok: true, at: '2026-10-29T08:01:00Z', checks: [{ requirement: { kind: 'read_back', target: 'workspace:welcome.md' }, evidence: { kind: 'read_back', target: 'workspace:welcome.md', sha256: 'abcdef0123456789', bytes: 120 }, ok: true, why: 'Nova read it back; it matches.' }] },
});

test('the orb has every state and no face, ever', () => {
  for (const state of ORB_STATES) {
    const html = orb({ state });
    assert.match(html, new RegExp(`data-state="${state}"`));
    assert.match(html, /role="img" aria-label="[^"]+"/);
    assert.doesNotMatch(html, /eye|mouth|smile|face|pupil|brow/i);
  }
  assert.match(orb({ size: 'avatar', decorative: true }), /aria-hidden="true"/);
});

test('Verified always carries its evidence affordance', () => {
  assert.match(status('verified', { task: 'v1' }), /<button[^>]+data-action="evidence"[^>]+data-task="v1"/);
  assert.match(taskRow(verified), /data-action="evidence"/);
  assert.match(verifiedResultCard(verified), /data-action="evidence"/);
  assert.match(verifiedResultCard(verified), /1 of 1 check passed/);
  assert.match(status('failed'), /data-status="failed">Failed</);
});

test('the evidence viewer shows each check, what was found and why', () => {
  const html = evidenceViewer(verified);
  assert.match(html, /read back · workspace:welcome\.md/);
  assert.match(html, /120 bytes/);
  assert.match(html, /Nova read it back; it matches\./);
  assert.match(html, /<details class="raw">/, 'the raw ledger entry is one tap further down');
  assert.match(evidenceViewer(task('q', 'queued')), /Not checked yet/);
});

test('the approval sheet is tiered: tier 3 needs an explicit confirmation', () => {
  const t2 = approvalSheet(task('a', 'waiting', { approval_tier: 2 }));
  assert.match(t2, /data-tier="2"/);
  assert.doesNotMatch(t2, /name="confirm"/);
  assert.match(t2, />Approve</);
  const t3 = approvalSheet(task('b', 'waiting', { approval_tier: 3 }));
  assert.match(t3, /data-tier="3"/);
  assert.match(t3, /<input type="checkbox" name="confirm" required>/);
  assert.match(t3, /data-action="approve" value="approve" disabled>Confirm</);
  assert.match(t3, /explicit confirmation every time/);
});

test('Nova is handling shows at most three open tasks, never finished or silent ones', () => {
  const tasks = [task('1', 'active'), task('2', 'queued'), task('3', 'waiting', { approval_tier: 2 }), task('4', 'verifying'), task('5', 'done'), task('6', 'active', { user_visibility: 'silent' })];
  const html = handlingCard({ tasks });
  assert.equal((html.match(/class="task-row"/g) ?? []).length, 3);
  assert.match(html, /and 1 more/);
  assert.doesNotMatch(html, /Task 5|Task 6/);
  assert.match(handlingCard({ tasks: [] }), /Nothing in progress/);
});

test('honest surfaces: the brief is empty, devices are only this one', () => {
  assert.match(briefCard(), /No brief yet/);
  const mesh = deviceMeshCard({ devices: [{ name: 'This browser', current: true }] });
  assert.equal((mesh.match(/class="device-row"/g) ?? []).length, 1);
  assert.match(mesh, /this device/);
  assert.match(mesh, /Only this device for now/);
});

test('health and memory cards say what is true', () => {
  assert.match(healthCard({ reachable: false }), /isn’t answering/);
  const ok = { ok: true, checks: { database: { ok: true }, workers: { ok: true, workers: [{}, {}] } } };
  assert.match(healthCard({ health: ok }), /All systems normal/);
  assert.match(healthCard({ health: ok, problems: [{ id: 1, message: 'The heartbeat couldn’t run.' }] }), /1 problem to look at[\s\S]*heartbeat/);
  assert.match(memoryHighlightCard({ records: [] }), /Nothing kept yet/);
  assert.match(memoryHighlightCard({ records: [{ active: true, user_state: 'active', content: 'Prefers tea.', kind: 'preference', created_at: '2026-10-29T08:00:00Z' }] }), /Prefers tea\./);
});

test('voice is off in local-only, and says why; otherwise only where the browser supports it', () => {
  assert.deepEqual(voiceState({ privacy: 'local-only', supported: true }).enabled, false);
  assert.match(voiceState({ privacy: 'local-only', supported: true }).reason, /local-only/);
  assert.equal(voiceState({ privacy: 'cloud-allowed', supported: false }).enabled, false);
  assert.equal(voiceState({ privacy: 'local-preferred', supported: true }).enabled, true);
});

test('rows and notices', () => {
  const rule = { id: 'r1', name: 'Weekly check', class: 'heartbeat', schedule: 'Mondays at 9:00', action: { kind: 'message', text: 'Time to review.' }, paused: true };
  const row = triggerRow(rule);
  assert.match(row, /data-action="resume-rule"/);
  assert.match(row, /data-action="delete-rule"/);
  assert.match(row, /Paused/);
  assert.match(proactiveBanner({ id: 'm1', text: 'Hello', hold: 'needs_ok' }), /data-action="send-message"/);
  assert.match(emptyState(), /Nothing needs you/);
});

// Setup redraws its whole conversation after each answer; lines already on screen must not fade
// out and rise in again (found in the M3 gate screenshots).
test('a chat bubble already on screen does not animate again', () => {
  assert.doesNotMatch(chatBubble({ from: 'nova', text: 'Hi' }), /is-still/);
  assert.match(chatBubble({ from: 'nova', text: 'Hi', still: true }), /class="chat-bubble from-nova is-still"/);
  assert.match(chatBubble({ from: 'person', text: 'yes', still: true }), /class="chat-bubble from-person is-still"/);
  const css = readFileSync(new URL('../ui/styles/components.css', import.meta.url), 'utf8');
  assert.match(css, /\.chat-bubble\.is-still \.bubble-body \{ animation: none; \}/);
});
