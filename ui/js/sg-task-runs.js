// Coding, infrastructure and network runs in Tasks, design-first (2026-11-09): compositions for the
// owner's reaction, before any wiring. Styleguide only: the app never loads this file, nothing here is
// sent anywhere, every repository, project, target and host is made up, and every control is a
// specimen (a checkbox ticks; Merge, Apply and the passkey say they are a demo).
//
// Drawn from the real model. A run is a chain of Work Ledger tasks, each made only once the one before
// is verified done, and followed and approved through /tasks like any task:
//  - coding (src/core/coding/index.ts, GET /coding and /coding/runs/{id}): write (tier 1, in Nova's own
//    git worktree on nova/<id>) → check (tier 2: Nova runs the test command and the preview, which run
//    the agent's code as the person) → merge (tier 3, every time; nothing is ever pushed). A branch that
//    moved since the review starts a new round (update → check → merge). States: writing, checking,
//    review, merging, moved, merged, declined, failed, conflict, cancelled, discarded. Undo is discard
//    (tier 1), not after a merge. The record keeps the reviewed diff, Nova's own test run and the
//    preview; no budget, and no cost of its own (the write step's report carries the agent's usage).
//  - infrastructure (src/core/infra/, GET /infra and /infra/runs/{id}): plan (tier 1, changes nothing,
//    OpenTofu's saved plan priced from the project's price sheet) → apply (tier 3, every time, after a
//    checkpoint). A plan that adds cost and ends over budget, has a resource the sheet can't price, or
//    is too large to show, is never offered (budget.ts: past 80 % is said; over and adding blocks). States: planning, review, applying,
//    applied, nothing, over_budget, unpriced, too_large, failed, declined, cancelled.
//  - network (src/core/network/, GET /network and /network/changes/{id}): prepare (tier 1: a snapshot
//    and the diff) → apply (tier 3, every time, after a checkpoint) → the dead-man's switch: without a
//    request from one of the person's paired phones or browsers within the window (5 minutes by
//    default), Nova puts the snapshot back itself. No paired device, no change (refused at the start).
//    States: preparing, review, applying, watching, kept, reverting, reverted, revert_failed, settled,
//    nothing, failed, declined, cancelled. Put back by hand only once kept (tier 3, for 30 days);
//    settling a failed revert is tier 3 too.
// Tier 3 on Nova's own screen is confirmed with a passkey (core.js); on a paired device, the box.
//
// Proposed: one list, Tasks' own status groups (Needs you, In progress, Didn't finish, Done and
// checked, Cancelled), each run one row with its steps inside, not three lists by kind. What the
// backend doesn't have is said, not drawn as working: no single runs route (three lists, the newest
// 100 of each), no live output while a plan or an apply runs, no run-again, and no putting a change
// back while the switch still watches. Its CSS is ui/styles/compositions.css (.tr-*, and the .au-*
// panes it shares with the Automations compositions); the narrow layout is layout.css's .au-panes rule.
import { ICONS, passkeyAction, passkeyConfirm, status } from './components.js';
import { escapeHtml as esc } from './markdown.js';
import { statusIcon } from './status-icon.js';

// Every frame: [state, what it shows, which pane a phone shows].
export const TR_FRAMES = [
  ['list', 'Tasks with runs in it: each coding run, plan and network change is one row in Tasks’ own groups, its steps inside', 'list'],
  ['coding-review', 'A coding run waiting to be merged (tier 3): what the agent changed, the whole diff, Nova’s own test run and the preview', 'detail'],
  ['coding-running', 'A coding run while the agent writes: in Nova’s own worktree, nothing in your repository yet', 'detail'],
  ['coding-failed', 'A coding run that stopped: Nova’s own test run failed, so it won’t ask you to merge', 'detail'],
  ['infra-review', 'An infrastructure plan waiting to be applied (tier 3): each change priced, the month against the budget, OpenTofu’s plan in full', 'detail'],
  ['infra-applying', 'An apply while it runs: the checkpoint first, and what cancelling now means', 'detail'],
  ['infra-over-budget', 'A plan Nova won’t offer: over the budget, in the backend’s words', 'detail'],
  ['network-review', 'A network change waiting to be applied (tier 3): the diff against the snapshot, and the dead-man’s switch', 'detail'],
  ['network-watching', 'A network change applied, the switch armed: waiting to hear from one of your devices', 'detail'],
  ['network-revert-failed', 'Nova couldn’t put a change back: the target changed since, so it needs you to settle it (tier 3)', 'detail'],
  ['cancelled', 'A plan you didn’t apply: nothing changed', 'detail'],
  ['empty', 'No runs yet: what starts one, and what can’t start here yet', 'list'],
];
const paneOf = (s) => TR_FRAMES.find(([k]) => k === s)?.[2] ?? 'list';

// ---- the model, made up ----------------------------------------------------------------------------

// Tiers as the backends set them (coding TIER, infra TIER, network #make).
const TIERS = { 1: 'tier 1, doesn’t ask', 2: 'tier 2, asks first', 3: 'tier 3, asks every time' };
const DEVICES = ['Sam’s phone', 'Firefox on the laptop'];

// Coding runs (GET /coding/runs/{id}, only what is drawn).
const DARK = {
  kind: 'coding', id: 'r7c2e41a9d0', title: 'Add a dark-mode switch to the settings page', state: 'review', repo: '/home/you/code/notes-app', branch: 'main', agent_name: 'Claude Code', round: 1,
  base: '3f2e1d0', head: 'a1b2c3d', test_command: 'npm test', preview_command: 'npm run dev', at: '13:52',
  reason: 'Ready for you: `npm test` passed, and the preview is at http://127.0.0.1:41873. Nova asks before it merges into main.',
  steps: [['Write', 1, 'Done and checked', '13:52'], ['Test and preview', 2, 'Done and checked: you said yes at 14:05', '14:05'], ['Merge into main', 3, 'Waiting for your OK', '14:06']],
  scope: 'source code, markup, styles and documents; not its tests or configuration',
  changes: [['src/settings/page.tsx', 'changed', 18, 2], ['src/settings/theme-switch.tsx', 'added', 41, 0], ['src/styles/theme.css', 'changed', 12, 0]],
  diff: `--- a/src/settings/page.tsx
+++ b/src/settings/page.tsx
@@ -4,6 +4,7 @@ import { Section } from '../ui/section';
+import { ThemeSwitch } from './theme-switch';
@@ -31,2 +32,6 @@ export function SettingsPage() {
       <Section title="Appearance">
+        <ThemeSwitch />
       </Section>`,
  test: { command: 'npm test', commit: 'a1b2c3d', passed: true, exit: 0, s: '4.2' },
  preview: 'http://127.0.0.1:41873',
  usage: '48,210 tokens in and 6,920 out, as Claude Code reported. No price: coding runs have no budget.',
};
const PARSER = {
  kind: 'coding', id: 'r3a90f5c172', title: 'Fix the date parser for ISO weeks', state: 'writing', repo: '/home/you/code/notes-app', branch: 'main', agent_name: 'Claude Code', round: 1, at: '14:18', test_command: 'npm test',
  reason: 'Claude Code is writing the change.',
  steps: [['Write', 1, 'In progress since 14:18', '14:18']],
};
const LOADER = {
  kind: 'coding', id: 'r5d1b7e9a03', title: 'Rename the config loader', state: 'failed', repo: '/home/you/code/tools', branch: 'dev', agent_name: 'Codex', round: 1, at: '11:40', test_command: 'npm test', head: '9e8d7c6',
  reason: 'Nova ran `npm test` itself on 9e8d7c6: it failed (exit 1): FAIL tests/config.test.ts › loads the defaults. Nova won’t ask you to merge it.',
  steps: [['Write', 1, 'Done and checked', '11:40'], ['Test and preview', 2, 'Failed', '11:52']],
  output: `FAIL tests/config.test.ts
  › loads the defaults
    Cannot find module '../src/config/load' from 'tests/config.test.ts'
Tests: 1 failed, 23 passed, 24 total`,
};

// Infrastructure runs (GET /infra/runs/{id}).
const MEDIA = {
  kind: 'infra', id: 'i8f20c4d6e1', title: 'Add a second media VM', state: 'review', project: 'Home lab', folder: '/home/you/infra/home-lab', at: '14:12',
  reason: 'Ready for you: the plan in full, +$8.00 a month ($16.00 a month of the $20.00 budget (80 %)). Nova applies it only when you confirm.',
  steps: [['Plan', 1, 'Done and checked', '14:12'], ['Apply', 3, 'Waiting for your OK', '14:13']],
  changes: [['example_vm.media2', 'add', '+$8.00'], ['example_dns_record.media2', 'add', '+$0.00']],
  budget: { now: 8, after: 16, budget: 20, words: '$16.00 a month of the $20.00 budget (80 %)' },
  sha: '5c0e9b71d2a4',
  plan: `OpenTofu will perform the following actions:

  # example_vm.media2 will be created
  + resource "example_vm" "media2" {
      + name = "media2"
      + size = "medium"
    }

  # example_dns_record.media2 will be created
  + resource "example_dns_record" "media2" {
      + name = "media2.home.example"
    }

Plan: 2 to add, 0 to change, 0 to destroy.`,
};
const MEDIA_APPLYING = { ...MEDIA, state: 'applying', reason: 'Applying the reviewed plan.', steps: [['Plan', 1, 'Done and checked', '14:12'], ['Apply', 3, 'In progress since 14:21: you confirmed with your passkey', '14:21']], checkpoint: 'ck-7d3e90a1b5' };
const BUCKET = {
  kind: 'infra', id: 'i2b9e7a1f04', title: 'A larger bucket for the static site', state: 'over_budget', project: 'Static site', folder: '/home/you/infra/static-site', at: '10:05',
  reason: 'The plan for “Static site” would cost +$12.00 a month, taking it to $17.00 a month of the $10.00 budget (170 %): over budget. Nova applied nothing and won’t offer it. Lower the plan, or raise the budget yourself.',
  steps: [['Plan', 1, 'Done and checked', '10:05']],
  changes: [['example_bucket.site', 'replace', '+$12.00']],
  budget: { now: 5, after: 17, budget: 10, words: '$17.00 a month of the $10.00 budget (170 %)' },
};
const BACKUPS = {
  kind: 'infra', id: 'i6c13d8e2b7', title: 'Nightly snapshot schedule', state: 'declined', project: 'Home lab', folder: '/home/you/infra/home-lab', at: 'yesterday',
  reason: 'You didn’t apply it. Nothing in “Home lab” changed.',
  steps: [['Plan', 1, 'Done and checked', 'yesterday'], ['Apply', 3, 'Cancelled: You didn’t apply it.', 'yesterday']],
  changes: [['example_schedule.nightly', 'add', '+$1.50']],
  budget: { now: 8, after: 9.5, budget: 20, words: '$9.50 a month of the $20.00 budget (48 %)' },
};
const APPLIED = { kind: 'infra', id: 'i0a4f6b2c98', title: 'Media VM, smaller size', state: 'applied', project: 'Home lab', at: 'Nov 6', reason: 'Applied. “Home lab” now costs $8.00 a month by its price sheet ($8.00 a month of the $20.00 budget (40 %)).' };

// Network changes (GET /network/changes/{id}).
const PORT = {
  kind: 'network', id: 'n4e7a2c9b15', title: 'Forward port 443 to the NAS', state: 'review', target: 'Home router', target_kind: 'router', at: '14:15', window: '5 minutes',
  reason: 'Ready for you: the diff against the snapshot. Nova applies it only when you confirm, and puts the snapshot back by itself if it can’t hear from your devices within 5 minutes.',
  steps: [['Snapshot and diff', 1, 'Done and checked', '14:15'], ['Apply to Home router', 3, 'Waiting for your OK', '14:15']],
  snapshot: 'sha256 e1c94b07a2d3…, taken 2 min ago',
  diff: `--- Home router (snapshot)
+++ Home router (after the change)
@@ port_forwards @@
+  { "name": "nas-https", "external": 443, "to": "192.168.1.20:443" }`,
};
const DNS = {
  kind: 'network', id: 'n9b03e6d4a2', title: 'A record for media.home.example', state: 'watching', target: 'Home DNS', target_kind: 'dns', at: '14:10', window: '5 minutes',
  reason: 'Changed at 14:10. Nova is waiting to hear from one of your devices until 14:15.',
  steps: [['Snapshot and diff', 1, 'Done and checked', '14:08'], ['Apply to Home DNS', 3, 'Done and checked: you confirmed at 14:10', '14:10']],
  snapshot: 'sha256 7a0d2e91c4b8…, taken 14:08', checkpoint: 'ck-2a6f1c0e93', deadline: '14:15',
};
const TAG = {
  kind: 'network', id: 'n1f8c5a0e67', title: 'Let tag:media reach the NAS', state: 'revert_failed', target: 'Tailnet policy', target_kind: 'tailnet', at: '09:30',
  reason: 'Tailnet policy’s configuration changed after Nova’s change, so Nova didn’t overwrite it. Check Tailnet policy yourself, then settle the change.',
  steps: [['Snapshot and diff', 1, 'Done and checked', '09:28'], ['Apply to Tailnet policy', 3, 'Done and checked: you confirmed at 09:30', '09:30'], ['Put Tailnet policy back as it was', 1, 'Failed: Tailnet policy’s configuration changed after Nova’s change (it isn’t the snapshot or Nova’s change), so Nova didn’t overwrite it', '09:35']],
  snapshot: 'sha256 c3b81f6e05a9…, taken 09:28', checkpoint: 'ck-9e4b7d1a20',
};
const KEPT = { kind: 'network', id: 'n6d2b9f1c30', title: 'Block ads with the DNS blocklist', state: 'kept', target: 'Home DNS', at: 'Nov 5', reason: 'Kept: Nova heard from Sam’s phone after the change, so your devices still reach it.' };

// Ordinary tasks beside them, as Tasks shows them today (taskRow).
const PLAIN = [
  { kind: 'task', id: 't1', title: 'Save the reading list', group: 'verified', meta: 'Wrote lists/reading.md', at: '12:30' },
  { kind: 'task', id: 't2', title: 'Back up Nova', group: 'working', meta: 'Copying to the backup folder', at: '14:20' },
];

const RUNS = [DARK, MEDIA, PORT, TAG, PARSER, DNS, PLAIN[1], LOADER, BUCKET, APPLIED, KEPT, PLAIN[0], BACKUPS];

// ---- where a run sits in Tasks ---------------------------------------------------------------------

// Tasks' own groups (surfaces.js GROUPS), and the one status vocabulary (status.js).
const GROUPS = [['needs-you', 'Needs you'], ['working', 'In progress'], ['failed', 'Didn’t finish'], ['verified', 'Done and checked'], ['quiet', 'Cancelled']];
// A run's state onto them: waiting for the person's OK is Needs you (amber); a run that stopped is
// Didn't finish (red); what Nova is doing, or waiting on, is In progress.
const GROUP_OF = {
  review: 'needs-you', checking: 'needs-you', revert_failed: 'needs-you',
  writing: 'working', merging: 'working', moved: 'working', planning: 'working', applying: 'working', preparing: 'working', watching: 'working', reverting: 'working',
  failed: 'failed', conflict: 'failed', over_budget: 'failed', unpriced: 'failed', too_large: 'failed', reverted: 'failed',
  merged: 'verified', applied: 'verified', nothing: 'verified', kept: 'verified', settled: 'verified',
  declined: 'quiet', cancelled: 'quiet', discarded: 'quiet',
};
const groupOf = (r) => (r.kind === 'task' ? r.group : GROUP_OF[r.state] ?? 'quiet');
const KIND = { coding: 'Coding', infra: 'Infrastructure', network: 'Network', task: 'Task' };
const where = (r) => {
  if (r.kind === 'coding') return `${home(r.repo)}, into ${r.branch}`;
  if (r.kind === 'infra') return `“${r.project}”`;
  if (r.kind === 'network') return r.target;
  return r.meta;
};
// What the row says under its name: the run's own reason, shortened, or the step it waits on.
const LINE = {
  review: { coding: 'Merge into main: needs your OK', infra: 'Apply: +$8.00 a month, needs your OK', network: 'Apply: needs your OK' },
  revert_failed: 'Nova couldn’t put it back: settle it',
  writing: 'Claude Code is writing the change',
  watching: 'Applied; waiting to hear from your devices until 14:15',
  failed: '`npm test` failed on Nova’s run; nothing merged',
  over_budget: 'Over budget: Nova won’t offer it',
  applied: 'Applied: $8.00 a month of $20.00',
  kept: 'Kept: Nova heard from Sam’s phone',
  declined: 'You didn’t apply it; nothing changed',
};
const lineOf = (r) => {
  if (r.kind === 'task') return r.meta;
  const l = LINE[r.state];
  return typeof l === 'string' ? l : l?.[r.kind] ?? r.reason;
};

// ---- the words -----------------------------------------------------------------------------------------

const icon = (name) => ICONS[name] ?? '';
const slot = (state, size) => `<span class="au-icon" data-tr-icon="${state}" data-tr-size="${size}" aria-hidden="true"></span>`;
const home = (p) => p.replace(/^\/home\/you/, '~');
const mono = (t) => `<span class="uc-mono">${esc(t)}</span>`;
// Backticks in the backend's words are code.
const said = (t) => esc(t).replace(/`([^`]+)`/g, '<span class="uc-mono">$1</span>');
const facts = (rows) => `<dl class="uc-facts au-facts">${rows.map(([k, v]) => `<div class="uc-fact"><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>`;
const raw = (id, summary, text, open = true) => `<details class="au-more tr-raw"${open ? ' open' : ''}><summary class="uc-row" id="${id}">${esc(summary)}</summary><pre class="tr-pre" tabindex="0" aria-labelledby="${id}">${esc(text)}</pre></details>`;

// ---- the list: Tasks, runs folded in ---------------------------------------------------------------

function row(id, r, current) {
  const on = r.id === current;
  const key = groupOf(r);
  return `<li class="tr-item"><a class="uc-row au-open${on ? ' is-on' : ''}" href="#${id}-${r.id}"${on ? ' aria-current="true"' : ''}><span class="au-text"><span class="au-name">${esc(r.title)}</span><span class="au-meta">${KIND[r.kind]} · ${esc(where(r))}</span>${r.kind === 'task' ? '' : `<span class="au-meta tr-line">${said(lineOf(r))}</span>`}</span><span class="tr-pill">${status(key)}</span></a></li>`;
}

function listPane(id, { runs = RUNS, current = '' } = {}) {
  const groups = GROUPS.map(([k, title]) => {
    const rs = runs.filter((r) => groupOf(r) === k);
    return rs.length ? `<h3 class="uc-group" id="${id}-g-${k}">${title} · ${rs.length}</h3><ul class="tr-list" aria-labelledby="${id}-g-${k}">${rs.map((r) => row(id, r, current)).join('')}</ul>` : '';
  }).join('');
  return `<div class="au-list"><p class="au-intro">Everything Nova takes on. A coding run, a plan or a network change is one row, its steps inside.</p>${groups}</div>`;
}

// ---- one run -------------------------------------------------------------------------------------------

const back = (id) => `<a class="uc-row uc-back" href="#${id}-list"><span class="uc-ic" aria-hidden="true">${icon('back')}</span><span>Tasks</span></a>`;

function head(id, r, kicker) {
  return `${back(id)}<p class="tr-kind">${kicker}</p><h3 class="uc-h" id="${id}-name">${esc(r.title)}</h3><p class="au-sentence tr-said">${said(r.reason)}</p>`;
}

// Its steps: each a ledger task, with its tier and where it stands.
function steps(id, r, { next = [] } = {}) {
  const done = r.steps.map(([name, tier, state, at]) => `<li class="tr-step"><span class="au-text"><span class="au-name">${esc(name)}</span><span class="au-meta">${TIERS[tier]} · ${said(state)}</span></span><span class="au-state">${esc(at)}</span></li>`);
  const later = next.map(([name, tier]) => `<li class="tr-step is-later"><span class="au-text"><span class="au-name">${esc(name)}</span><span class="au-meta">${TIERS[tier]} · not made yet: it comes once the step before is checked</span></span></li>`);
  return `<h4 class="uc-group au-group-head" id="${id}-steps">Its steps, each a task</h4><ol class="tr-list tr-steps" aria-labelledby="${id}-steps">${[...done, ...later].join('')}</ol>`;
}

// The confirmation, as each place asks it. On Nova's own screen: the box, then the passkey (core.js
// signs every {confirm: true} there; src/core/index.ts refuses one without it). On a paired device
// (a phone, a Duo's cover): the box and the button, nothing more, as the backend takes it there. A
// narrow frame is drawn as a paired device (the container query in compositions.css).
function confirmBlock(id, words, decline, { box, act }) {
  return `<form class="au-confirm" data-sg-inert novalidate aria-labelledby="${id}-ok"><p class="au-block-head" id="${id}-ok">${esc(words)}</p>
<div class="tr-console">${passkeyConfirm({ state: 'ready' })}<div class="au-actions">${passkeyAction({ state: 'ready' })}${decline}</div><p class="au-note">Asked on Nova’s own screen, your passkey confirms it too.</p></div>
<div class="tr-device"><label class="confirm"><input type="checkbox" name="confirm" required> ${esc(box)}</label><div class="au-actions"><button type="submit" class="btn primary" data-tr-device-confirm data-tr-demo disabled>${esc(act)}</button>${decline}</div><p class="au-note">A paired device approves this without a passkey: the box is the confirmation. Flagged for the owner.</p></div></form>`;
}

function codingReview(id) {
  const r = DARK;
  const files = r.changes.map(([p, k, a, d]) => `<li class="tr-line-item">${mono(p)} · ${k} · +${a} −${d}</li>`).join('');
  return `${head(id, r, `Coding run · round ${r.round} · asked for at ${r.at}`)}
${confirmBlock(id, `Merge it into ${r.branch}? Nova moves ${r.branch} from ${r.base} to ${r.head}: exactly this diff. Nova doesn’t push.`, '<button type="button" class="btn" data-tr-demo>Don’t merge</button>', { box: `I’ve reviewed this. Merge it into ${r.branch}.`, act: 'Merge' })}
<h4 class="uc-group au-group-head" id="${id}-what">What ${esc(r.agent_name)} changed · ${r.changes.length} files</h4><p class="au-note">What it was allowed to change: ${esc(r.scope)}.</p><ul class="tr-lines" aria-labelledby="${id}-what">${files}</ul>
${raw(`${id}-diff`, 'The whole diff', r.diff)}
<h4 class="uc-group au-group-head">Tests</h4><p class="au-note tr-strong">Nova ran ${mono(r.test.command)} itself on ${mono(r.test.commit)}: it passed (exit ${r.test.exit}, ${r.test.s} s).</p>
<h4 class="uc-group au-group-head">Preview</h4><p class="au-note">${mono(r.preview)} · on this computer only. It stops when the run ends.</p><div class="au-actions"><a class="btn quiet" href="#${id}-preview">Open the preview</a></div>
${steps(id, r)}
${facts([['Repository', `${mono(r.repo)} · ${esc(r.branch)}`], ['Nova’s branch', `${mono(`nova/${r.id}`)}, in its own worktree`], ['Cost', esc(r.usage)]])}`;
}

function codingRunning(id) {
  const r = PARSER;
  return `${head(id, r, `Coding run · round ${r.round} · asked for at ${r.at}`)}
<div class="au-result" role="group" aria-labelledby="${id}-now"><div class="au-result-text"><p class="au-block-head" id="${id}-now">Writing in Nova’s own worktree</p><p class="au-note">On ${mono(`nova/${r.id}`)}, from ${esc(r.branch)} in ${mono(r.repo)}. Nothing in your repository changes before the merge. What it wrote shows here once it is committed and checked.</p></div>
<div class="au-actions"><button type="button" class="btn" data-tr-demo>Stop and undo</button></div><p class="au-note">Undo cancels its open steps and removes Nova’s worktree and ${mono(`nova/${r.id}`)}. ${esc(r.branch)} is as it was.</p></div>
${steps(id, r, { next: [['Test and preview', 2], [`Merge into ${r.branch}`, 3]] })}
${facts([['Repository', `${mono(r.repo)} · ${esc(r.branch)}`], ['Agent', esc(r.agent_name)], ['Checks with', mono(r.test_command)]])}`;
}

function codingFailed(id) {
  const r = LOADER;
  return `${head(id, r, `Coding run · asked for at ${r.at}`)}
<div class="au-result tr-stopped" role="group" aria-labelledby="${id}-stop"><div class="au-result-text"><p class="au-block-head" id="${id}-stop">Stopped. Nothing was merged.</p><p class="au-note">Nova removed its worktree and ${mono(`nova/${r.id}`)}. ${esc(r.branch)} in ${mono(r.repo)} is as it was.</p></div></div>
${raw(`${id}-out`, 'Its output', r.output)}
${steps(id, r)}
<p class="au-locked">There is no run-again yet: ask for the change again in chat, and it starts a new run.</p><div class="au-actions"><a class="btn" href="#${id}-chat">Ask in chat</a></div>`;
}

// Cost against the budget: ten steps of the budget, what is there now and what the plan adds, in words.
function budget(id, b) {
  const tenths = (n) => Math.min(10, Math.round((n / b.budget) * 10));
  const now = tenths(b.now);
  const after = tenths(b.after);
  const segs = Array.from({ length: 10 }, (_, i) => `<span class="tr-seg${i < now ? ' is-now' : i < after ? ' is-added' : ''}"></span>`).join('');
  const over = b.after > b.budget;
  const usd = (n) => `$${n.toFixed(2)}`;
  return `<div class="tr-budget" role="group" aria-labelledby="${id}-b"><p class="au-block-head" id="${id}-b">The month against the budget</p>
<div class="tr-bar" role="img" aria-label="${esc(`${usd(b.now)} now, ${usd(b.after)} after it, of ${usd(b.budget)}`)}">${segs}</div>
<p class="au-note"><span class="tr-key is-now"></span>Now ${usd(b.now)} a month · <span class="tr-key is-added"></span>After it ${usd(b.after)} · Budget ${usd(b.budget)}</p>
<p class="au-note tr-strong">After it: ${esc(b.words)}.${over ? ' Over the budget.' : b.after >= b.budget * 0.8 ? ' That is past 80 % of the budget.' : ''}</p>
<p class="au-note">Priced from the project’s own price sheet, not the provider’s bill.</p></div>`;
}

const priced = (id, r) => `<h4 class="uc-group au-group-head" id="${id}-ch">What it changes</h4><ul class="tr-lines" aria-labelledby="${id}-ch">${r.changes.map(([a, act, d]) => `<li class="tr-line-item">${mono(a)} · ${act} · ${d} a month</li>`).join('')}</ul>`;

function infraReview(id) {
  const r = MEDIA;
  return `${head(id, r, `Infrastructure · “${r.project}” · planned at ${r.at}`)}
${budget(id, r.budget)}
${confirmBlock(id, `Apply it to “${r.project}”? OpenTofu applies exactly this saved plan (sha256 ${r.sha}…), after a checkpoint. It may spend money; Nova can’t undo it.`, '<button type="button" class="btn" data-tr-demo>Don’t apply</button>', { box: `I’ve read the plan. Apply it to “${r.project}”.`, act: 'Apply' })}
${priced(id, r)}
${raw(`${id}-plan`, 'OpenTofu’s plan, in full', r.plan)}
${steps(id, r)}
${facts([['Project', mono(r.folder)], ['Planning', 'Changed no infrastructure, but OpenTofu ran the project’s providers and data sources: they reach their services.'], ['Before it', 'Nova takes a checkpoint of itself and keeps a copy of OpenTofu’s state.']])}`;
}

function infraApplying(id) {
  const r = MEDIA_APPLYING;
  return `${head(id, r, `Infrastructure · “${r.project}” · planned at ${r.at}`)}
<div class="au-result" role="group" aria-labelledby="${id}-now"><div class="au-result-text"><p class="au-block-head" id="${id}-now">OpenTofu is applying the reviewed plan</p><p class="au-note">Nova took checkpoint ${mono(r.checkpoint)} and a copy of OpenTofu’s state first. Its output shows here when it ends; there is no live output while it runs.</p></div>
<div class="au-actions"><button type="button" class="btn" data-tr-demo>Cancel the apply</button></div><p class="au-note">Cancelled now, it ends with: “Cancelled after the apply had started: check what OpenTofu’s state says for “Home lab”.”</p></div>
${priced(id, r)}
${steps(id, r)}
${facts([['Project', mono(r.folder)], ['After it', `${esc(r.budget.words)}, by the price sheet`]])}`;
}

function infraOver(id) {
  const r = BUCKET;
  return `${head(id, r, `Infrastructure · “${r.project}” · planned at ${r.at}`)}
<div class="au-result tr-stopped" role="group" aria-labelledby="${id}-stop"><div class="au-result-text"><p class="au-block-head" id="${id}-stop">Not offered: over the budget</p><p class="au-note">Nova raised a budget alert when it stopped. Nothing in “${esc(r.project)}” changed.</p></div><div class="au-actions"><a class="btn" href="#${id}-budget">The project’s budget</a></div></div>
${budget(id, r.budget)}
${priced(id, r)}
${steps(id, r)}
<p class="au-locked">There is no run-again: once the budget or the plan changes, ask for a new plan.</p>`;
}

function networkReview(id) {
  const r = PORT;
  return `${head(id, r, `Network · ${r.target} · asked for at ${r.at}`)}
<div class="au-result" role="group" aria-labelledby="${id}-sw"><div class="au-result-text"><p class="au-block-head" id="${id}-sw">After the change, if Nova can’t hear from one of your devices within ${r.window}, it puts the snapshot back by itself.</p><p class="au-note">What counts: a request from ${esc(DEVICES.join(' or '))}, not from this computer.</p></div></div>
${confirmBlock(id, `Change ${r.target}? Nova writes this diff, after a checkpoint. A network change can cut your devices off.`, '<button type="button" class="btn" data-tr-demo>Don’t apply</button>', { box: `I’ve read the diff. Change ${r.target}.`, act: 'Apply' })}
${raw(`${id}-diff`, 'The diff against the snapshot', r.diff)}
${steps(id, r)}
${facts([['Target', `${esc(r.target)} · ${r.target_kind}`], ['Snapshot', esc(r.snapshot)], ['Secrets', 'Masked in the diff. A change that sets one is refused.']])}`;
}

function networkWatching(id) {
  const r = DNS;
  return `${head(id, r, `Network · ${r.target} · asked for at ${r.at}`)}
<div class="au-result" role="group" aria-labelledby="${id}-sw"><div class="au-result-text"><p class="au-block-head" id="${id}-sw">Keeps the change once Nova hears from ${esc(DEVICES.join(' or '))}</p><p class="au-note">Opening Nova on one of them is enough. Without that by ${r.deadline}, Nova puts ${esc(r.target)} back to the snapshot by itself, and tells you.</p></div></div>
<p class="au-locked">You can’t put it back by hand while Nova waits: the switch decides. Once kept, Put it back asks at tier 3, for 30 days.</p>
${steps(id, r, { next: [] })}
${facts([['Target', `${esc(r.target)} · ${r.target_kind}`], ['Snapshot', esc(r.snapshot)], ['Checkpoint', `${mono(r.checkpoint)}, before the change`], ['Window', `${r.window}, from your settings`]])}`;
}

function networkRevertFailed(id) {
  const r = TAG;
  return `${head(id, r, `Network · ${r.target} · asked for at ${r.at}`)}
<p class="au-note">Nova went to put it back, because it heard from none of your devices within 5 minutes, and found someone else’s change there. It doesn’t overwrite that, and ${esc(r.target)} takes no new change until you settle this one.</p>
${confirmBlock(id, `Settle it: you checked ${r.target} yourself, and it is as you want it.`, '', { box: `I checked ${r.target} myself. Settle the change.`, act: 'Settle it' })}
${steps(id, r)}
${facts([['Target', `${esc(r.target)} · ${r.target_kind}`], ['Snapshot', esc(r.snapshot)], ['Checkpoint', `${mono(r.checkpoint)}, before the change`]])}`;
}

function cancelled(id) {
  const r = BACKUPS;
  return `${head(id, r, `Infrastructure · “${r.project}” · planned ${r.at}`)}
${priced(id, r)}
${steps(id, r)}
<p class="au-note">The plan is let go. To apply it after all, ask for a new plan: OpenTofu plans again against what is there now.</p>`;
}

// Nothing yet: what starts a run, and what can't start on this computer yet, said in the list (a phone
// shows only that pane); each kind explained beside it.
function emptyList(id) {
  return `<div class="au-list"><p class="au-intro">Everything Nova takes on. A coding run, a plan or a network change is one row, its steps inside.</p><p class="au-sentence tr-none">No runs yet</p><p class="au-intro">Ask in chat: for a change to a repository, a plan for an infrastructure project, or a change to a network target. Each shows here, and asks before it changes anything of yours.</p>
<h3 class="uc-group" id="${id}-cant">Can’t start here yet</h3><ul class="tr-list tr-cant" aria-labelledby="${id}-cant"><li class="tr-line-item">OpenTofu isn’t on this computer yet, so no plan can run. Nova doesn’t install it.</li><li class="tr-line-item">No phone or browser is paired, so Nova can’t confirm a network change: it refuses to start one. Pair one in Devices first.</li></ul>
<div class="au-actions tr-none"><a class="btn" href="#${id}-chat">Ask in chat</a><a class="btn quiet" href="#${id}-devices">Devices</a></div></div>`;
}
function emptyDetail(id) {
  const kinds = [
    ['Coding', 'A coding agent writes the change in Nova’s own worktree; Nova asks before it runs your tests on it, and every time before it merges. Nothing is pushed.'],
    ['Infrastructure', 'OpenTofu plans a project you added, priced against its budget; Nova asks every time before it applies, and doesn’t offer a plan that adds cost and ends over the budget.'],
    ['Network', 'A change to a target you added, with a snapshot to go back to; Nova asks every time, and puts it back by itself unless it hears from your phone or browser.'],
  ];
  return `<h3 class="uc-h" id="${id}-name">What shows here</h3>${facts(kinds.map(([k, v]) => [k, esc(v)]))}`;
}

// ---- frames ----------------------------------------------------------------------------------------

function screen(state, panes, live) {
  const id = `tr-${state}`;
  return `<div class="uc-screen tr" data-tr-frame="${state}"><div class="uc-main"><header class="uc-top"><button type="button" class="uc-icon uc-menu" aria-label="Open navigation">${icon('panel')}</button><h2 class="uc-title">Tasks</h2>${slot(live, 24)}</header>
<div class="au-panes" data-au-pane="${paneOf(state)}">${panes(id)}</div></div></div>`;
}
const pair = (current, right, list = {}) => (id) => `${listPane(id, { current, ...list })}<div class="au-detail">${right(id)}</div>`;

export function trFrame(state) {
  switch (state) {
    case 'coding-review': return screen(state, pair(DARK.id, codingReview), 'needs-you');
    case 'coding-running': return screen(state, pair(PARSER.id, codingRunning), 'working');
    case 'coding-failed': return screen(state, pair(LOADER.id, codingFailed), 'stopped');
    case 'infra-review': return screen(state, pair(MEDIA.id, infraReview), 'needs-you');
    case 'infra-applying': return screen(state, pair(MEDIA.id, infraApplying, { runs: RUNS.map((r) => (r === MEDIA ? MEDIA_APPLYING : r)) }), 'working');
    case 'infra-over-budget': return screen(state, pair(BUCKET.id, infraOver), 'stopped');
    case 'network-review': return screen(state, pair(PORT.id, networkReview), 'needs-you');
    case 'network-watching': return screen(state, pair(DNS.id, networkWatching), 'working');
    case 'network-revert-failed': return screen(state, pair(TAG.id, networkRevertFailed), 'needs-you');
    case 'cancelled': return screen(state, pair(BACKUPS.id, cancelled), 'idle');
    case 'empty': return screen(state, (id) => `${emptyList(id)}<div class="au-detail">${emptyDetail(id)}</div>`, 'idle');
    default: return screen('list', pair(DARK.id, codingReview), 'needs-you');
  }
}

// The styleguide entry: every frame, each with its full-screen address.
export function trEntry(wrap) {
  return TR_FRAMES.map(([s, words]) => wrap(`${esc(words)} · <a class="link" href="?entry=task-runs&amp;frame=${s}">Full screen</a>`, trFrame(s))).join('');
}
export const isTrFrame = (s) => TR_FRAMES.some(([k]) => k === s);

// Fills the status icon slots and makes the specimens move a little: the passkey checkbox enables
// its button, and the demo buttons say they are a demo.
export function bindTaskRuns(root) {
  for (const el of root.querySelectorAll('[data-tr-icon]')) {
    el.replaceChildren(statusIcon({ status: el.dataset.trIcon, size: Number(el.dataset.trSize), decorative: true }));
  }
  for (const frame of root.querySelectorAll('[data-tr-frame]')) {
    if (frame.dataset.trBound) continue;
    frame.dataset.trBound = '1';
    frame.addEventListener('change', (e) => {
      if (e.target.name !== 'confirm') return;
      const b = e.target.closest('.tr-console, .tr-device')?.querySelector('[data-action="passkey-confirm"], [data-tr-device-confirm]');
      if (b) b.disabled = !e.target.checked;
    });
    frame.addEventListener('click', (e) => {
      const b = e.target.closest('[data-tr-demo], [data-action^="passkey"]');
      if (b) { e.preventDefault(); b.textContent = 'Demo: nothing was sent'; }
      if (e.target.closest('a[href^="#"]')) e.preventDefault();
    });
    frame.addEventListener('submit', (e) => e.preventDefault());
  }
}
