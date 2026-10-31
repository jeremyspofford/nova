// Settings › Changes (M7 plan §1): every change to Nova through the pipeline, from
// /api/v1/changes. Each shows its stage and status in the one vocabulary, the evidence of every
// stage one layer down, and a canary in progress with its probes as they last ran. The one
// standout is "Ship it" while a change waits for the person; a tier-3 one asks them to confirm,
// every time, with what the sandbox showed right there. Rolling back a live change is always
// offered, quietly, and asks before it acts. All state comes from the pipeline's records: nothing
// here simulates progress.
import { api, on } from './core.js';
import { escapeHtml as esc } from './markdown.js';
import { status } from './components.js';
import { toast } from './shell.js';
import { over, waitingLine } from './wait.js';

let data = null;
let failed = '';
let rerender = () => {};
// The row whose roll back the person asked about, waiting for their answer.
let asking = null;

export async function loadChanges() {
  try {
    data = await api('GET', '/changes');
    failed = '';
    over('changes');
  } catch (e) {
    failed = e.message || 'Nova’s server didn’t answer.';
  }
  rerender();
}

const KEY = { Working: 'working', 'Needs you': 'needs-you', Verified: 'verified', Failed: 'failed', Quiet: 'quiet' };
const STAGE_WORDS = { sandbox: 'Sandbox', tests: 'Tests', health: 'Health gates', release: 'Release', approval: 'Approval', canary: 'Canary', promote: 'Promoted' };
const STATE_WORDS = { passed: 'passed', failed: 'failed', running: 'running', pending: 'not yet' };
const KIND_WORDS = { extension: 'Extension', 'design-system': 'Design system', config: 'Setting', template: 'Decision template', 'trigger-rules': 'Rule pack' };
const BY_WORDS = (c) => (c.proposed_by === 'foundry' ? `Written by Nova’s foundry${c.author ? ` (${c.author})` : ''}` : c.proposed_by.startsWith('provider:') ? `Proposed by ${c.proposed_by.slice(9)}` : 'Proposed by you');
const time = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); };
// The pipeline's words carry exact times; a person reads them as a date and a time.
const plain = (text) => String(text ?? '').replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g, (iso) => time(iso));

function stageList(c, { upto = null } = {}) {
  const rows = c.stages_in_order.filter((s, i) => upto === null || i < upto);
  return `<ol class="change-stages">${rows.map((s) => `<li class="change-stage" data-stage="${esc(s.stage)}" data-state="${esc(s.status)}">
  <span class="change-stage-name">${esc(STAGE_WORDS[s.stage] ?? s.stage)}</span> <span class="change-stage-state">${esc(STATE_WORDS[s.status] ?? s.status)}</span>
  ${s.summary ? `<p class="settings-note">${esc(plain(s.summary))}</p>` : ''}
</li>`).join('')}</ol>`;
}

// The canary, as its probes last ran.
function canaryPanel(c) {
  const k = c.canary;
  if (!k?.started_at || c.state !== 'canary') return '';
  const last = k.runs.at(-1);
  const probes = last ? last.results : k.probes.map((name) => ({ name, ok: null, why: 'Not run yet.' }));
  return `<div class="change-canary" aria-label="Canary in progress">
  <p class="settings-note">Live on ${esc(k.scope)} until ${esc(time(k.ends_at))}. ${k.runs.length ? `Probes ran ${k.runs.length} time${k.runs.length === 1 ? '' : 's'}${last ? `, last at ${esc(time(last.at))}` : ''}.` : 'Probes run through the window.'}</p>
  <ul class="change-probes">${probes.map((p) => `<li class="change-probe" data-ok="${p.ok === null ? 'pending' : p.ok}">${esc(plain(p.why))}</li>`).join('')}</ul>
</div>`;
}

// The change that waits for the person: what it asks, what the sandbox showed, and Ship it.
function shipCard(c) {
  const three = c.tier === 3;
  return `<article class="change-ship" data-change="${esc(c.id)}" data-tier="${c.tier}" aria-labelledby="ship-${esc(c.id)}">
  <p class="sheet-kicker">${status('needs-you')}</p>
  <h3 class="change-title" id="ship-${esc(c.id)}">${esc(c.title)} <span class="change-version">v${esc(c.version)}</span></h3>
  <p class="settings-note">${esc(KIND_WORDS[c.kind] ?? c.kind)} · ${esc(BY_WORDS(c))} · tier ${c.tier}${c.previous_version ? ` · replaces v${esc(c.previous_version)}` : ''}</p>
  <ul class="change-asks">${c.asks.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>
  <p class="conn-sub">What the sandbox showed</p>
  ${stageList(c, { upto: 4 })}
  ${three ? '<label class="confirm"><input type="checkbox" name="confirm" data-action="changes-confirm"> It changes Nova itself. I’ve seen what the sandbox showed, and I want it to go live.</label>' : ''}
  <div class="sheet-actions">
    <button type="button" class="btn primary" data-action="changes-ship" data-change="${esc(c.id)}"${three ? ' disabled' : ''}>Ship it</button>
    <button type="button" class="btn quiet" data-action="changes-decline" data-change="${esc(c.id)}">Not now</button>
  </div>
</article>`;
}

function changeRow(c) {
  const back = c.can_roll_back
    ? asking === c.id
      ? `<div class="change-confirm" role="group" aria-label="Roll back ${esc(c.title)}"><p class="settings-note">Put back ${c.previous_version ? `v${esc(c.previous_version)}` : 'what was there before'}? Only ${esc(c.title)} changes.</p>
  <div class="sheet-actions"><button type="button" class="btn small" data-action="changes-rollback-yes" data-change="${esc(c.id)}">Roll it back</button><button type="button" class="btn small quiet" data-action="changes-rollback-no">Keep it</button></div></div>`
      : `<div class="sheet-actions"><button type="button" class="btn small quiet" data-action="changes-rollback" data-change="${esc(c.id)}">Roll back</button></div>`
    : '';
  return `<li class="change-row" data-change="${esc(c.id)}" data-state="${esc(c.state)}">
  <div class="conn-head"><p class="settings-label">${esc(c.title)} <span class="change-version">v${esc(c.version)}</span></p>${status(KEY[c.status] ?? 'quiet', c.status === 'Verified' && c.ship_task_id ? { task: c.ship_task_id } : {})}</div>
  <p class="settings-note">${esc(KIND_WORDS[c.kind] ?? c.kind)} · ${esc(BY_WORDS(c))} · ${esc(time(c.updated_at))}</p>
  ${canaryPanel(c) || `<p class="settings-note change-words">${esc(plain(c.words))}</p>`}
  ${c.state === 'refused' ? '' : `<details class="raw change-evidence"><summary>Evidence for every stage</summary>${stageList(c)}${c.release ? `<p class="settings-note change-release">Released as ${esc(c.release.dir)}${c.release.commit ? ` · commit ${esc(c.release.commit.slice(0, 10))}` : ''}. ${esc(c.release.history)}</p>` : ''}</details>`}
  ${back}
</li>`;
}

export function renderChanges() {
  const head = '<section class="memory-section" id="changes" aria-labelledby="set-changes"><h2 class="memory-heading" id="set-changes">Changes</h2>';
  if (!data) return `${head}${failed ? `<p class="memory-lede">${esc(failed)}</p><button type="button" class="btn set-retry" data-action="changes-retry">Try again</button>` : waitingLine('Loading changes', { key: 'changes' })}</section>`;
  const waiting = data.changes.find((c) => c.id === data.standout);
  const rest = data.changes.filter((c) => c.id !== data.standout);
  return `${head}
<p class="memory-lede">A change to Nova goes through these steps: tried on a copy first, tested, released as a version, and watched live before it stays. If a check fails, Nova puts back what was there before.</p>
${waiting ? shipCard(waiting) : ''}
${rest.length ? `<ul class="change-list">${rest.map(changeRow).join('')}</ul>` : waiting ? '' : '<p class="settings-note">No changes yet. When Nova or you propose one, it shows here with every check it went through.</p>'}
</section>`;
}

async function act(fn, done) {
  try {
    const r = await fn();
    if (done) toast(typeof done === 'function' ? done(r) : done);
  } catch (e) { toast(e.message); }
  await loadChanges();
}

// Wires the part into Settings: `render` redraws it when the data changes.
export function bindChanges(root, render) {
  rerender = render;
  on('change', () => { if (document.getElementById('changes')) loadChanges(); });
  root.addEventListener('change', (e) => {
    const box = e.target.closest('[data-action="changes-confirm"]');
    if (!box) return;
    const ship = box.closest('.change-ship')?.querySelector('[data-action="changes-ship"]');
    if (ship) ship.disabled = !box.checked;
  });
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-action]');
    if (!b || !b.dataset.action.startsWith('changes-')) return;
    const a = b.dataset.action;
    const id = b.dataset.change;
    if (a === 'changes-retry') loadChanges();
    if (a === 'changes-ship') {
      const confirm = !!b.closest('.change-ship')?.querySelector('[data-action="changes-confirm"]')?.checked;
      act(() => api('POST', `/changes/${encodeURIComponent(id)}/ship`, { confirm }), 'Shipping it: first a canary, then everyone.');
    }
    if (a === 'changes-decline') act(() => api('POST', `/changes/${encodeURIComponent(id)}/decline`), 'Not now. Nothing of it went live.');
    if (a === 'changes-rollback') { asking = id; rerender(); document.querySelector(`[data-action="changes-rollback-yes"][data-change="${CSS.escape(id)}"]`)?.focus(); }
    if (a === 'changes-rollback-no') { asking = null; rerender(); }
    if (a === 'changes-rollback-yes') { asking = null; act(() => api('POST', `/changes/${encodeURIComponent(id)}/rollback`, { confirm: true }), 'Rolling it back.'); }
  });
}
