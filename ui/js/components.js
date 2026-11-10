// Nova's component inventory (DESIGN-SYSTEM §7): pure functions, data in, HTML out, so the app,
// the style reference and the appearance preview all draw the same components. Every visual
// value is a token (components.css); nothing here carries a colour, size or font.
import { escapeHtml as esc } from './markdown.js';
import { ORB_WORDS, STATUS, isOpen, label, needsApproval, severity, statusOf, taskIconState } from './status.js';
import { qrSvg } from './qr.js';
import { waitingLine } from './wait.js';

// ---- icons: Nova's one icon set (DESIGN-SYSTEM §2.1) ------------------------------------------
// Line drawings in currentColor on a 24-unit grid, all at one stroke weight (ICON_STROKE in
// src/core/design.ts; lint:tokens refuses any other), round caps and joins, no fills. Drawn for
// Nova, so there is no third-party set to license. A new icon is added here, and shown in the
// styleguide's icon entry, before anything uses it.

const svg = (d, extra = '') => `<svg viewBox="0 0 24 24" aria-hidden="true" class="icon"${extra}><g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${d}</g></svg>`;
export const ICONS = {
  home: svg('<path d="M4 11.5 12 5l8 6.5"/><path d="M6.5 10v9h11v-9"/>'),
  chat: svg('<path d="M5 6.5h14v9H10l-4 3v-3H5z"/>'),
  tasks: svg('<path d="M9 7h10M9 12h10M9 17h10"/><path d="m4.5 7 1 1 1.6-1.8M4.5 12l1 1 1.6-1.8M4.5 17l1 1 1.6-1.8"/>'),
  memory: svg('<path d="M12 5.5c-1.7-1.6-4.8-1.4-6 .8-1.3.2-2.2 1.7-1.6 3-1 1-1 2.8.3 3.6-.2 1.6 1 3 2.6 2.9.7 1.6 3 2 4.7.7"/><path d="M12 5.5c1.7-1.6 4.8-1.4 6 .8 1.3.2 2.2 1.7 1.6 3 1 1 1 2.8-.3 3.6.2 1.6-1 3-2.6 2.9-.7 1.6-3 2-4.7.7"/><path d="M12 5.5v13"/>'),
  automations: svg('<path d="M13 3.5 6 13.5h5.5l-1 7 7-10H12z"/>'),
  skills: svg('<path d="M12 4.5 13.6 9l4.4 1.5-4.4 1.6L12 16.5l-1.6-4.4L6 10.5 10.4 9z"/><path d="M18 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>'),
  activity: svg('<path d="M3.5 12h4l2.5-6 4 12 2.5-6h4"/>'),
  health: svg('<path d="M12 19s-7-4.3-7-9.3A3.7 3.7 0 0 1 12 7.6a3.7 3.7 0 0 1 7 2.1c0 5-7 9.3-7 9.3z"/>'),
  // A gear: eight teeth and a centre hole (the old rays read as display brightness, ruling 2026-11-08).
  settings: svg('<path d="M10.52 5.57L10.82 3.58L13.18 3.58L13.48 5.57A6.6 6.6 0 0 1 15.5 6.4L17.12 5.21L18.79 6.88L17.6 8.5A6.6 6.6 0 0 1 18.43 10.52L20.42 10.82L20.42 13.18L18.43 13.48A6.6 6.6 0 0 1 17.6 15.5L18.79 17.12L17.12 18.79L15.5 17.6A6.6 6.6 0 0 1 13.48 18.43L13.18 20.42L10.82 20.42L10.52 18.43A6.6 6.6 0 0 1 8.5 17.6L6.88 18.79L5.21 17.12L6.4 15.5A6.6 6.6 0 0 1 5.57 13.48L3.58 13.18L3.58 10.82L5.57 10.52A6.6 6.6 0 0 1 6.4 8.5L5.21 6.88L6.88 5.21L8.5 6.4A6.6 6.6 0 0 1 10.52 5.57Z"/><circle cx="12" cy="12" r="2.5"/>'),
  more: svg('<circle cx="6" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18" cy="12" r="1.2"/>'),
  mic: svg('<rect x="9" y="3.5" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v2.5"/>'),
  send: svg('<path d="M12 18.5v-13M6.5 11 12 5.5l5.5 5.5"/>'),
  stop: svg('<rect x="7.5" y="7.5" width="9" height="9" rx="1.5"/>'),
  plus: svg('<path d="M12 5.5v13M5.5 12h13"/>'),
  close: svg('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>'),
  check: svg('<path d="m5.5 12.5 4 4 9-9"/>'),
  device: svg('<rect x="7" y="3.5" width="10" height="17" rx="2.5"/><path d="M11 17.5h2"/>'),
  search: svg('<circle cx="11" cy="11" r="5.5"/><path d="m15.5 15.5 4 4"/>'),
  brief: svg('<circle cx="12" cy="12" r="3.5"/><path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6 18 18M6 18l1.4-1.4M16.6 7.4 18 6"/>'),
  handling: svg('<path d="M5 19 15 9"/><path d="m15 9 1.5-1.5"/><path d="M17.5 3.5v3M16 5h3M19.5 9.5v2M18.5 10.5h2M10 3.5v2M9 4.5h2"/>'),
  conversations: svg('<path d="M4.5 6.5h15M4.5 12h15M4.5 17.5h9"/>'),
  panel: svg('<rect x="3.5" y="5" width="17" height="14" rx="2.5"/><path d="M14.5 5v14"/>'),
  back: svg('<path d="M14.5 6 8.5 12l6 6"/>'),
  chevron: svg('<path d="m9.5 6 6 6-6 6"/>'),
  copy: svg('<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6A1.5 1.5 0 0 0 14 4.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/>'),
  again: svg('<path d="M18.5 12a6.5 6.5 0 1 1-1.9-4.6"/><path d="M18.5 4.5v3.5H15"/>'),
};

// ---- the orb: Nova's presence. Abstract light only: no face, no features, ever. -----------

export const ORB_SIZES = ['hero', 'rail', 'avatar', 'mini'];
// `live` orbs follow Nova's state as it changes (shell.js); others show the state they're given.
export function orb({ state = 'idle', size = 'hero', label: words = null, decorative = false, live = false } = {}) {
  const name = words ?? ORB_WORDS[state] ?? ORB_WORDS.idle;
  const a11y = decorative ? 'aria-hidden="true"' : `role="img" aria-label="${esc(name)}"`;
  return `<span class="orb orb-${size}" data-state="${esc(state)}"${live ? ' data-orb-live' : ''} ${a11y}><span class="orb-glow"></span><span class="orb-core"></span><span class="orb-swirl"></span><span class="orb-sheen"></span></span>`;
}

// ---- status -------------------------------------------------------------------------------

// A status in the one vocabulary. Verified always carries its evidence affordance.
export function status(key, { task = null } = {}) {
  const k = STATUS[key] ? key : 'quiet';
  if (k === 'verified' && task) {
    return `<button type="button" class="status" data-status="verified" data-action="evidence" data-task="${esc(task)}" aria-label="Verified: see the evidence">${ICONS.check}<span>Verified</span></button>`;
  }
  return `<span class="status" data-status="${k}">${esc(label(k))}</span>`;
}

// ---- small pieces -------------------------------------------------------------------------

const clip = (t, n = 120) => { const s = String(t ?? ''); return s.length > n ? `${s.slice(0, n - 1).replace(/\s+\S*$/, '')}…` : s; };
const ago = (iso, now = new Date()) => {
  if (!iso) return '';
  const s = Math.max(0, Math.round((now - new Date(iso)) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};
export { ago, clip };

// A card: one job, one headline, at most a few lines, at most one action (DESIGN-SYSTEM §6).
export function card({ kind, title, icon = null, body = '', action = '', id = null, level = 3, attrs = '' }) {
  const h = `h${level}`;
  return `<section class="card ${esc(kind)}"${id ? ` id="${esc(id)}"` : ''} aria-labelledby="${esc(kind)}-title"${attrs ? ` ${attrs}` : ''}>
  <${h} class="card-title" id="${esc(kind)}-title">${icon ? ICONS[icon] : ''}<span>${esc(title)}</span></${h}>
  <div class="card-body">${body}</div>${action ? `<div class="card-action">${action}</div>` : ''}
</section>`;
}

// "Nothing needs you" is a valid, designed state.
// No orb of its own: the view already shows it once (DESIGN-SYSTEM §1).
export function emptyState({ title = 'Nothing needs you', line = '', action = '' } = {}) {
  return `<div class="empty-state"><p class="empty-title">${esc(title)}</p>${line ? `<p class="empty-sub">${esc(line)}</p>` : ''}${action}</div>`;
}

// ---- cards ----------------------------------------------------------------------------------

// No brief workflow exists yet, so the Brief card says so plainly.
export function briefCard({ brief = null } = {}) {
  const body = brief
    ? `<p class="card-lead">${esc(clip(brief.headline, 90))}</p>${(brief.lines ?? []).slice(0, 2).map((l) => `<p class="card-line">${esc(clip(l, 90))}</p>`).join('')}`
    : '<p class="card-lead">No brief yet.</p><p class="card-line">A daily brief arrives here once you set one up.</p>';
  return card({ kind: 'brief-card', title: 'Brief', icon: 'brief', body });
}

// One task: plain-language title and status, opening the ledger entry.
export function taskRow(t, { now = new Date(), compact = false } = {}) {
  const st = statusOf(t);
  const when = ago(t.updated_at ?? t.created_at, now);
  const why = st === 'needs-you' && needsApproval(t) ? 'Needs your OK before it runs.' : t.reason ?? '';
  // The task's own state as a 16 px status icon, drawn in place by shell.js (decorative: the
  // status beside it says the state in words).
  const icon = taskIconState(t);
  return `<li class="task-row" data-status="${st}" data-task="${esc(t.id)}">
  ${icon ? `<span class="task-icon-slot" data-task-icon="${icon}" data-task="${esc(t.id)}" aria-hidden="true"></span>` : ''}<button type="button" class="task-open" data-action="open-task" data-task="${esc(t.id)}"><span class="task-title">${esc(clip(t.title, 80))}</span>${compact ? '' : `<span class="task-meta">${esc(clip(why, 90))}${why && when ? ' · ' : ''}${when ? `<time>${esc(when)}</time>` : ''}</span>`}</button>
  ${status(st, { task: st === 'verified' ? t.id : null })}
</li>`;
}

// "Nova is handling": background work, up to three rows, then a way to the ledger.
export function handlingCard({ tasks = [], now = new Date() } = {}) {
  const open = tasks.filter((t) => isOpen(t) && t.user_visibility !== 'silent');
  const body = open.length
    ? `<ul class="task-list">${open.slice(0, 3).map((t) => taskRow(t, { now, compact: true })).join('')}</ul>${open.length > 3 ? `<p class="card-line">and ${open.length - 3} more</p>` : ''}`
    : '<p class="card-lead">Nothing in progress.</p><p class="card-line">Work Nova takes on shows here until it’s verified.</p>';
  return card({ kind: 'handling-card', title: 'Nova is handling', icon: 'handling', body, action: '<a class="link" href="/tasks" data-nav="tasks">All tasks</a>' });
}

// A finished task, with what proved it.
export function verifiedResultCard(t, { now = new Date() } = {}) {
  const summary = t.report?.summary ?? t.brief?.goal ?? '';
  const checks = t.verification?.checks ?? [];
  const passed = checks.filter((c) => c.ok).length;
  return `<section class="card verified-result-card" aria-labelledby="vr-${esc(t.id)}" data-task="${esc(t.id)}">
  <div class="vr-text">
    <p class="card-kicker">Verified result</p>
    <h3 class="card-lead" id="vr-${esc(t.id)}">${esc(clip(t.title, 80))}</h3>
    <p class="card-line">${esc(clip(summary, 120))}</p>
    <p class="card-line">${passed} of ${checks.length} check${checks.length === 1 ? '' : 's'} passed · <time>${esc(ago(t.completed_at ?? t.updated_at, now))}</time></p>
  </div>
  ${status('verified', { task: t.id })}
</section>`;
}

// What proved a task done: each requirement, what Nova found, and why it passed or didn't.
// The raw report is one tap further down.
export function evidenceViewer(t) {
  const v = t.verification;
  // The Relay run a coding task's work came from (its report's relay-run artifact), if any.
  const relayRun = (t.report?.artifacts ?? []).find((a) => a?.kind === 'relay-run');
  const evidence = (e) => {
    if (!e) return 'Nothing was offered.';
    switch (e.kind) {
      case 'read_back': return `Read back ${esc(e.target)}: ${esc(String(e.bytes))} bytes, fingerprint ${esc(String(e.sha256).slice(0, 12))}…`;
      case 'test_result': return `Test ${esc(e.name)} ${e.passed ? 'passed' : 'failed'}`;
      case 'file_diff': return `A change to ${esc(e.target)}`;
      case 'url': return `Link: ${esc(e.url)}`;
      // A screenshot the browser worker took is shown, straight from Nova (never from a cache).
      case 'screenshot': return /^workers\/browser\//.test(String(e.ref)) ? `<img class="evidence-shot" src="/api/v1/browser/tasks/${encodeURIComponent(t.id)}/screenshot" alt="The page when the task finished" loading="lazy">` : `Screenshot ${esc(e.ref)}`;
      case 'confirmation': return `Confirmed by ${esc(e.system)} (${esc(e.id)})`;
      default: return esc(e.kind);
    }
  };
  const checks = (v?.checks ?? []).map((c) => `<li class="check" data-ok="${c.ok}">
    <span class="check-mark" aria-hidden="true">${c.ok ? ICONS.check : ICONS.close}</span>
    <div><p class="check-what">${esc(c.requirement.kind.replace(/_/g, ' '))}${c.requirement.target ? ` · ${esc(c.requirement.target)}` : ''}</p>
    <p class="check-found">${evidence(c.evidence)}</p><p class="check-why">${esc(c.why)}</p></div>
  </li>`).join('');
  return `<div class="evidence" data-task="${esc(t.id)}">
  <p class="sheet-kicker">${status(statusOf(t))}</p>
  <h2 class="sheet-title" id="sheet-title">${esc(t.title)}</h2>
  <p class="sheet-line">${esc(t.brief?.goal ?? '')}</p>
  ${t.state === 'waiting' && t.reason ? `<p class="sheet-line task-reason">${esc(t.reason)}</p>` : ''}
  ${t.report?.summary ? `<p class="sheet-line">${esc(t.report.summary)}</p>` : ''}
  ${relayRun ? `<p class="sheet-line is-faint">Done by Relay run ${esc(relayRun.ref)}${relayRun.branch ? `, branch ${esc(relayRun.branch)}` : ''}.</p>` : ''}
  ${v ? `<h3 class="sheet-heading">How Nova checked</h3><ul class="checks">${checks}</ul><p class="sheet-line">Checked <time datetime="${esc(v.at)}">${esc(new Date(v.at).toLocaleString('en-US'))}</time>.</p>` : `<p class="sheet-line">${t.state === 'done' ? 'Done.' : 'Not checked yet: Nova checks the evidence before it calls anything done.'}</p>`}
  <details class="raw"><summary>The ledger entry</summary><pre tabindex="0">${esc(JSON.stringify({ id: t.id, state: t.state, reason: t.reason, owner: t.owner, privacy_mode: t.privacy_mode, approval_tier: t.approval_tier, brief: t.brief, report: t.report, verification: t.verification }, null, 2))}</pre></details>
</div>`;
}

// Inline in a conversation while Nova works on something it said it would look into.
export function lookingIntoItCard(t) {
  return `<div class="card looking-into-it-card" data-task="${esc(t.id)}" role="status">
  <span class="lii-icon">${ICONS.search}</span>
  <div><p class="card-lead">Looking into it</p><p class="card-line">${esc(clip(t.title, 90))}${t.reason ? ` · ${esc(clip(t.reason, 60))}` : ''}</p></div>
  ${status(statusOf(t))}
</div>`;
}

// Devices: the registry's own records (GET /api/v1/mesh/devices), or, before it has answered, this
// browser alone ({ name, detail, online, current }).
export const KIND_WORDS = { browser: 'Browser', phone: 'Phone', computer: 'Computer', standby: 'Standby' };
export function deviceDetail(d, now = new Date()) {
  if (d.detail !== undefined || !d.kind) return d.detail ?? '';
  // The role first, where it is one: which node is hub changes when a standby is promoted.
  const what = d.role === 'hub' ? 'The hub' : d.role === 'standby' ? 'The standby' : KIND_WORDS[d.kind] ?? d.kind;
  if (d.trust === 'revoked') return `${what} · revoked ${ago(d.revoked_at, now)}`;
  // A computer's agent that stopped its runtime after repeated crashes says so in its heartbeat.
  if (d.agent?.safe_mode && d.online) return `${what} · safe mode: its agent stopped after repeated crashes`;
  if (d.online || d.role === 'hub') return what;
  return `${what} · ${d.last_seen ? `last seen ${ago(d.last_seen, now)}` : 'not seen yet'}`;
}

// Device roles (M10f): what a device is for, beside its mesh role. The words are the hub's
// (src/core/mesh/purposes.ts PURPOSE_WORDS); a test keeps them the same.
export const ROLE_WORDS = Object.freeze({
  'thin-client': { label: 'Thin client', note: 'A screen onto Nova, for using it.' },
  'hub-candidate': { label: 'Hub candidate', note: 'It could become the hub one day. Its key is pinned for that, so this is confirmed every time.' },
  compute: { label: 'Compute', note: 'Runs models and other heavy work.' },
  storage: { label: 'Storage', note: 'Keeps models and data.' },
  'capture-source': { label: 'Capture source', note: 'May run capture. Capture itself stays off until you turn it on.' },
  'general-server': { label: 'General server', note: 'Runs other services Nova manages.' },
});
export const rolesWords = (list = []) => (list.length ? list.map((p) => ROLE_WORDS[p]?.label ?? p).join(', ') : 'No roles yet');

export function deviceRow(d, { now = new Date(), actions = '', roles = false } = {}) {
  const current = d.current ?? d.this ?? false;
  const online = d.online ?? true;
  const detail = deviceDetail(d, now);
  const pill = d.trust === 'revoked' ? '<span class="pill">Revoked</span>' : `<span class="pill${online ? ' is-on' : ' is-warn'}">${online ? 'Online' : 'Offline'}</span>`;
  const shown = roles && Array.isArray(d.purposes) ? `<p class="device-detail device-roles">Roles: ${esc(rolesWords(d.purposes))}</p>` : '';
  return `<li class="device-row"${d.id ? ` data-device="${esc(d.id)}"` : ''}>${ICONS.device}<div class="device-text"><p class="device-name">${esc(d.name)}${current ? ' <span class="device-tag">· this device</span>' : ''}</p>${detail ? `<p class="device-detail">${esc(detail)}</p>` : ''}${shown}</div>${pill}${actions ? `<span class="row-actions">${actions}</span>` : ''}</li>`;
}

// The roles a device may hold, as checkboxes: what it holds (or asked for) ticked; what its kind must
// hold ticked and fixed. A kind with only one possible role says it instead of asking.
function rolesField({ allowed = [], chosen = [], fixed = [], legend = 'Roles' }) {
  if (allowed.length === 1) {
    const only = allowed[0];
    return `<dl class="facts"><dt>${esc(legend)}</dt><dd>${esc(ROLE_WORDS[only]?.label ?? only)}. ${esc(ROLE_WORDS[only]?.note ?? '')}</dd></dl><input type="hidden" name="purpose" value="${esc(only)}">`;
  }
  const box = (p) => {
    const lock = fixed.includes(p);
    const on = lock || chosen.includes(p);
    return `<label class="confirm role-choice"><input type="checkbox" name="purpose" value="${esc(p)}"${on ? ' checked' : ''}${lock ? ' disabled data-fixed="1"' : ''}> <span><strong>${esc(ROLE_WORDS[p]?.label ?? p)}</strong>${lock ? ' (always)' : ''}: ${esc(ROLE_WORDS[p]?.note ?? '')}</span></label>`;
  };
  return `<fieldset class="roles-field"><legend class="sheet-heading">${esc(legend)}</legend>${allowed.map(box).join('')}</fieldset>`;
}

// What the roles picked in a form are: the ticked boxes, the fixed ones and a single hidden one.
export function pickedRoles(form) {
  return [...form.querySelectorAll('input[name="purpose"]')].filter((i) => i.type === 'hidden' || i.checked).map((i) => i.value);
}

// Changing a device's roles (M10f), from Settings › Devices: step one, the choice.
export function rolesSheet(d, { allowed = [], fixed = [] } = {}) {
  return `<form class="roles-sheet" data-roles="${esc(d.id)}" method="dialog">
  <h2 class="sheet-title" id="sheet-title">What is “${esc(d.name)}” for?</h2>
  <p class="sheet-line">Roles decide what Nova may run there. Adding one asks for your explicit confirmation; taking one away asks first.</p>
  ${rolesField({ allowed, chosen: d.purposes ?? [], fixed })}
  <div class="sheet-actions">
    <button type="submit" class="btn primary" value="review">Review</button>
    <button type="button" class="btn quiet" data-action="close-sheet">Not now</button>
  </div>
</form>`;
}

// Step two, at its tier: widening is tier 3; narrowing tier 2, saying what it would stop. A new hub
// candidacy is confirmed on its own (Decision 2).
export function rolesReviewSheet(d, next, change, stops = []) {
  const tier = change.added.length ? 3 : 2;
  const what = [
    ...(change.added.length ? [`<dt>Adding</dt><dd>${esc(rolesWords(change.added))}. That changes what may run there.</dd>`] : []),
    ...(change.removed.length ? [`<dt>Taking away</dt><dd>${esc(rolesWords(change.removed))}. ${esc(stops.length ? `It stops ${stops.join(', ')} there.` : 'Nothing runs there that needs it, so nothing stops.')}</dd>`] : []),
  ].join('');
  const candidate = change.added.includes('hub-candidate') && d.kind === 'computer'
    ? '<label class="confirm"><input type="checkbox" name="confirm_candidate"> I want this computer to be able to become the hub. Its key is pinned for that.</label>' : '';
  return `<form class="approval-sheet" data-tier="${tier}" data-roles-confirm="${esc(d.id)}" data-next="${esc(next.join(','))}" method="dialog">
  <p class="sheet-kicker">${status('needs-you')}</p>
  <h2 class="sheet-title" id="sheet-title">Change what “${esc(d.name)}” is for?</h2>
  <dl class="facts">${what}<dt>Roles after</dt><dd>${esc(rolesWords(next))}</dd><dt>Why it asks</dt><dd>${esc(TIER_WORDS[tier])}</dd></dl>
  ${candidate}
  ${tier === 3 ? '<label class="confirm"><input type="checkbox" name="confirm" required> I want to change its roles.</label>' : ''}
  <div class="sheet-actions">
    <button type="submit" class="btn primary" data-action="approve" value="approve"${tier === 3 ? ' disabled' : ''}>Change roles</button>
    <button type="button" class="btn quiet" data-action="close-sheet">Not now</button>
  </div>
</form>`;
}

// The trusted devices, at most three rows. "Only this device for now" only while that is true.
export function deviceMeshCard({ devices = [], now = new Date() } = {}) {
  const trusted = devices.filter((d) => d.trust !== 'revoked');
  const alone = trusted.length <= 1;
  const body = `<ul class="device-list">${trusted.slice(0, 3).map((d) => deviceRow(d, { now })).join('')}</ul>${trusted.length > 3 ? `<p class="card-line">and ${trusted.length - 3} more</p>` : ''}${alone ? '<p class="card-line is-faint">Only this device for now. Pair your phone to reach Nova from it.</p>' : ''}`;
  return card({ kind: 'device-mesh-card', title: 'Devices', icon: 'device', body, action: '<a class="link" href="/topology">Machines and services</a>' });
}

// What each kind of device may do once it is in, said before the person approves it.
export const KIND_ACCESS = {
  browser: 'It can use Nova as you do here, except approving new devices.',
  phone: 'It can use Nova as you do here, except approving new devices.',
  computer: 'It runs Nova’s device work: check-ins, and tasks and notes it queued while offline. It isn’t given your conversations.',
  standby: 'It keeps a full copy of Nova, your data included, so it can take over if the hub fails.',
};

const digitsHtml = (d) => `<p class="digits" aria-label="${esc(String(d).split('').join(' '))}">${esc(`${String(d).slice(0, 3)} ${String(d).slice(3)}`)}</p>`;

// A device asking to join (tier 3): the digits to compare first, then who it is and what it may do.
export function joinRequestSheet(r) {
  const caps = r.capabilities?.length ? r.capabilities.join(', ') : 'Nothing beyond its kind.';
  // What it asked to be for, to confirm or change here (M10f). A computer as hub candidate is
  // confirmed on its own (Decision 2); a standby's approval is its candidacy.
  const allowed = r.allowed ?? [];
  const roles = allowed.length ? rolesField({ allowed, chosen: r.purposes ?? [], fixed: r.fixed ?? [], legend: 'What it is for' }) : '';
  const candidate = r.kind === 'computer' && allowed.includes('hub-candidate')
    ? '<label class="confirm candidate-confirm"><input type="checkbox" name="confirm_candidate"> If it is a hub candidate: I want it to be able to become the hub. Its key is pinned for that.</label>' : '';
  return `<form class="approval-sheet" data-tier="3" data-request="${esc(r.id)}" method="dialog">
  <p class="sheet-kicker">${status('needs-you')}</p>
  <h2 class="sheet-title" id="sheet-title">Add “${esc(r.name)}”?</h2>
  <p class="sheet-line">A ${esc((KIND_WORDS[r.kind] ?? r.kind).toLowerCase())} is asking to join Nova. Approve it only if it shows these same six digits.</p>
  ${digitsHtml(r.confirmation)}
  <dl class="facts"><dt>Kind</dt><dd>${esc(KIND_WORDS[r.kind] ?? r.kind)}. ${esc(KIND_ACCESS[r.kind] ?? '')}</dd><dt>Platform</dt><dd>${esc(r.platform || 'Not said')}</dd><dt>Asks for</dt><dd>${esc(caps)}</dd><dt>Key</dt><dd class="fingerprint">${esc(r.fingerprint)}</dd><dt>Why it asks</dt><dd>${esc(TIER_WORDS[3])}</dd></dl>
  ${roles}${candidate}
  <label class="confirm"><input type="checkbox" name="confirm" required> The digits match, and I want to add this device.</label>
  <div class="sheet-actions">
    <button type="submit" class="btn primary" data-action="approve" value="approve" disabled>Add this device</button>
    <button type="button" class="btn" data-action="deny-request" data-request="${esc(r.id)}">Deny</button>
    <button type="button" class="btn quiet" data-action="close-sheet">Not now</button>
  </div>
</form>`;
}

// Revoking (tier 3): what it ends, and that it can't come back with the same key.
export function revokeSheet(d) {
  return `<form class="approval-sheet" data-tier="3" data-revoke="${esc(d.id)}" method="dialog">
  <p class="sheet-kicker">${status('needs-you')}</p>
  <h2 class="sheet-title" id="sheet-title">Revoke “${esc(d.name)}”?</h2>
  <p class="sheet-line">It is signed out at once, everything it has open closes, and its key can never be used again. To bring it back later, pair it again; it will get a new key.</p>
  <dl class="facts"><dt>Kind</dt><dd>${esc(KIND_WORDS[d.kind] ?? d.kind)}</dd><dt>Key</dt><dd class="fingerprint">${esc(d.fingerprint ?? '')}</dd><dt>Why it asks</dt><dd>${esc(TIER_WORDS[3])}</dd></dl>
  <label class="confirm"><input type="checkbox" name="confirm" required> I want to revoke this device.</label>
  <div class="sheet-actions">
    <button type="submit" class="btn primary" data-action="approve" value="approve" disabled>Revoke</button>
    <button type="button" class="btn quiet" data-action="close-sheet">Keep it</button>
  </div>
</form>`;
}

// Making this standby the hub (tier 3), from the standby's own screen: what changes, said first.
export function promoteSheet(replica) {
  const hub = replica?.hub?.name ? `“${replica.hub.name}”` : 'the hub';
  return `<form class="approval-sheet" data-tier="3" data-promote="1" method="dialog">
  <p class="sheet-kicker">${status('needs-you')}</p>
  <h2 class="sheet-title" id="sheet-title">Make this the hub?</h2>
  <p class="sheet-line">Do this when ${esc(hub)} is gone for good, or for long enough that you need Nova back. This node starts running your work, with what it has copied so far, and devices move to it.</p>
  <dl class="facts"><dt>Last copied</dt><dd>${esc(replica?.sync?.last_ok_at ? `${ago(replica.sync.last_ok_at)}` : 'Not yet')}</dd><dt>If ${esc(hub)} comes back</dt><dd>It sees that this node took over and steps down; it won’t act as hub again.</dd><dt>Why it asks</dt><dd>${esc(TIER_WORDS[3])}</dd></dl>
  <label class="confirm"><input type="checkbox" name="confirm" required> I want this node to be the hub.</label>
  <div class="sheet-actions">
    <button type="submit" class="btn primary" data-action="approve" value="approve" disabled>Make this the hub</button>
    <button type="button" class="btn quiet" data-action="close-sheet">Not now</button>
  </div>
</form>`;
}

// Promoting a hub candidate to hub (M10g), from Settings › Devices on the hub: what happens and each
// pre-check, said first, then tier 3. The words are the hub's (src/core/mesh/handover.ts), so the
// claims register reads one file. A candidate that fails a pre-check gets the reason and no button.
const checkList = (checks = []) => `<ul class="checks">${checks.map((c) => `<li class="check" data-ok="${c.ok}"><span class="check-mark" aria-hidden="true">${c.ok ? ICONS.check : ICONS.close}</span><div><p class="check-why">${esc(c.said)}</p></div></li>`).join('')}</ul>`;
const factList = (facts = []) => `<dl class="facts">${facts.map((f) => `<dt>${esc(f.label)}</dt><dd>${esc(f.text)}</dd>`).join('')}</dl>`;

export function promotionSheet(d, check) {
  const ok = !!check?.ok;
  return `<form class="approval-sheet" data-tier="3" data-promotion="${esc(d.id)}" method="dialog">
  <p class="sheet-kicker">${status(ok ? 'needs-you' : 'failed')}</p>
  <h2 class="sheet-title" id="sheet-title">Make “${esc(d.name)}” the hub?</h2>
  ${ok ? factList(check.sheet) : '<p class="sheet-line">Not yet: a pre-check didn’t pass.</p>'}
  <h3 class="sheet-heading">The pre-checks</h3>
  ${checkList(check?.checks)}
  ${ok ? '<label class="confirm"><input type="checkbox" name="confirm" required> I want this computer to be the hub.</label>' : ''}
  <div class="sheet-actions">
    ${ok ? '<button type="submit" class="btn primary" data-action="approve" value="approve" disabled>Promote to hub</button>' : ''}
    <button type="button" class="btn quiet" data-action="close-sheet">Not now</button>
  </div>
</form>`;
}

// Becoming the hub from the latest backup (M10g), on a hub candidate whose hub can't be reached: the
// backup's time, what was lost and that connectors sign in again, said before anything (Decision 5).
export function coldPromotionSheet(view) {
  const ok = !!view?.eligible;
  // The backup it shows is the one confirmed: the server refuses any other.
  return `<form class="approval-sheet" data-tier="3" data-cold-promotion="1" data-backup="${esc(view?.facts?.backup?.id ?? '')}" method="dialog">
  <p class="sheet-kicker">${status(ok ? 'needs-you' : 'failed')}</p>
  <h2 class="sheet-title" id="sheet-title">Make this the hub from a backup?</h2>
  ${ok ? factList(view.sheet) : `<p class="sheet-line">Not here: ${esc((view?.reasons ?? [])[0] ?? 'Nova couldn’t tell.')}</p>`}
  ${ok ? '<label class="confirm"><input type="checkbox" name="confirm" required> I understand what is lost, and want this node to be the hub.</label>' : ''}
  <div class="sheet-actions">
    ${ok ? '<button type="submit" class="btn primary" data-action="approve" value="approve" disabled>Make this the hub</button>' : ''}
    <button type="button" class="btn quiet" data-action="close-sheet">Not now</button>
  </div>
</form>`;
}

// Settling a promotion by hand (M10g review), tier 3, with what Nova can't know said first:
// cancelling a hand-over whose outcome isn't known, or taking the hub back from a new hub that can't
// be reached.
export function promotionActionSheet(kind, p) {
  const to = p?.to_name ? `“${p.to_name}”` : 'the other computer';
  const words = kind === 'cancel'
    ? { title: 'Cancel the hand-over?', line: `Nova can’t tell whether ${to} took the hub’s role: it can’t be reached. Nova asks it once more first. If it still can’t say, this computer carries on as the hub at a higher epoch. If ${to} did take the role and some devices reach it, both take changes until the two meet; then ${to} steps down and keeps what it took meanwhile in a checkpoint on itself.`, box: 'I understand, and want this computer to carry on as the hub.', button: 'Cancel the hand-over' }
    : { title: 'Take the hub back?', line: `Nova can’t reach ${to}, the hub since the hand-over. Nova asks it first to stop taking changes. If it can’t be reached and is still running for some devices, both take changes until the two meet; then ${to} steps down and keeps what it took meanwhile in a checkpoint on itself.`, box: 'I understand, and want this computer to be the hub again.', button: 'Take the hub back' };
  return `<form class="approval-sheet" data-tier="3" data-promotion-action="${esc(kind)}" method="dialog">
  <p class="sheet-kicker">${status('needs-you')}</p>
  <h2 class="sheet-title" id="sheet-title">${esc(words.title)}</h2>
  <p class="sheet-line">${esc(words.line)}</p>
  <dl class="facts"><dt>Why it asks</dt><dd>${esc(TIER_WORDS[3])}</dd></dl>
  <label class="confirm"><input type="checkbox" name="confirm" required> ${esc(words.box)}</label>
  <div class="sheet-actions">
    <button type="submit" class="btn primary" data-action="approve" value="approve" disabled>${esc(words.button)}</button>
    <button type="button" class="btn quiet" data-action="close-sheet">Not now</button>
  </div>
</form>`;
}

// Letting a phone or browser approve new devices, or stopping it (tier 3).
export function allowApproveSheet(d, yes) {
  return `<form class="approval-sheet" data-tier="3" data-allow="${esc(d.id)}" data-value="${yes}" method="dialog">
  <p class="sheet-kicker">${status('needs-you')}</p>
  <h2 class="sheet-title" id="sheet-title">${yes ? `Let “${esc(d.name)}” approve new devices?` : `Stop “${esc(d.name)}” approving new devices?`}</h2>
  <p class="sheet-line">${yes ? 'It could then add phones, browsers and computers to Nova on its own, as this screen can.' : 'Only the hub’s own screen, and other devices you allowed, will approve new devices.'}</p>
  <dl class="facts"><dt>Why it asks</dt><dd>${esc(TIER_WORDS[3])}</dd></dl>
  <label class="confirm"><input type="checkbox" name="confirm" required> ${yes ? 'I want this device to approve new devices.' : 'I want to stop it.'}</label>
  <div class="sheet-actions">
    <button type="submit" class="btn primary" data-action="approve" value="approve" disabled>Confirm</button>
    <button type="button" class="btn quiet" data-action="close-sheet">Not now</button>
  </div>
</form>`;
}

// The three front doors for one code: a QR for a phone, the address and code for any browser, the
// command for a computer. The warning is part of the sheet, not small print.
export function addDeviceSheet(p, { now = new Date() } = {}) {
  const until = new Date(p.expires_at);
  if (until <= now) {
    return `<div class="add-device" data-pairing="${esc(p.pairing_id)}">
  <h2 class="sheet-title" id="sheet-title">Add a device</h2>
  <p class="sheet-line">That code has expired. Codes last five minutes and work once.</p>
  <div class="sheet-actions"><button type="button" class="btn primary" data-action="add-device">Make a new code</button></div>
</div>`;
  }
  const time = until.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `<div class="add-device" data-pairing="${esc(p.pairing_id)}" data-expires="${esc(p.expires_at)}">
  <h2 class="sheet-title" id="sheet-title">Add a device</h2>
  <p class="sheet-line">On a phone, scan this with the camera. On any browser, open the address and type the code. On a computer, run the command. The code works once, until ${esc(time)}.</p>
  <div class="qr-frame">${qrSvg(p.url, { label: 'QR code: opens the pairing page with this code' })}</div>
  <dl class="facts"><dt>Address</dt><dd>${esc(p.hub_url)}/pair</dd><dt>Code</dt><dd class="pair-code-text">${esc(p.code)}</dd></dl>
  <h3 class="sheet-heading">On a computer</h3>
  <div class="command"><code id="add-command">${esc(p.command)}</code><button type="button" class="btn small" data-action="copy-command">Copy</button></div>
  <p class="sheet-line is-faint">The command installs whatever ${esc(p.hub_url)} sends. Run it only where that address can only be this Nova: over HTTPS the computer trusts, or on a network you control.</p>
  <p class="warning" role="note">Only enter this code at ${esc(p.hub_url)} on a device you already trust.</p>
  <p class="sheet-line is-faint">When the device shows six digits, they appear here too, to compare.</p>
</div>`;
}

// Health: everything fine, or what isn't, in human terms; detail is on the Health page
// (DESIGN-SYSTEM §6). The card never quotes a problem's own message, which can name a file, a path
// or an error: it says how many and what they are about, and Health has the rest (UX review 1, F1).
export const CHECK_NAMES = { database: 'Database', workers: 'Workers', ledger: 'Work Ledger', extensions: 'Extensions', design: 'Design system', triggers: 'Automations', problems: 'Problems', memory: 'Memory', receipts: 'Context receipts', mesh: 'Devices', browser: 'Browser work', backups: 'Backups', changes: 'Changes', capture: 'Capture', vault: 'Vault', connectors: 'Connections', ingest: 'Outside content', passkeys: 'Passkeys' };
// What a problem is about, by where it came from.
const PROBLEM_AREAS = {
  sync: 'the standby’s copy of your files', mesh: 'your devices', connectors: 'a connection', providers: 'a model provider',
  backups: 'backups', changes: 'changes to Nova', capture: 'capture', ingest: 'outside content', resilience: 'keeping Nova running',
  reset: 'a reset', ledger: 'a task that failed', coding: 'a coding task', vault: 'the vault', triggers: 'automations', design: 'the design system',
  models: 'local models', 'chat-run': 'a conversation', receipts: 'privacy', api: 'Nova itself',
};
const listWords = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
export function problemsSummary(problems) {
  const areas = [...new Set(problems.map((p) => PROBLEM_AREAS[p.source] ?? 'Nova itself'))];
  const shown = areas.length > 3 ? [...areas.slice(0, 2), 'more'] : areas;
  if (areas.length === 1 && problems.length > 1) return `${problems.length === 2 ? 'Both are' : `All ${problems.length} are`} about ${areas[0]}.`;
  const words = listWords(shown);
  return `About ${words}.`;
}
// The card's tone and words follow severity() (status.js), as the mark, the badge and Home's first
// line do: red only when Nova is stopped (ruling D5), and the words say which it is (F-075).
// `known`: whether the problems list was read (F-021); `healthFailed`: the health reading couldn't
// be had (F-023), which is said with a retry rather than an endless "Checking".
export function healthCard({ health = null, problems = [], reachable = true, known = true, healthFailed = false } = {}) {
  let body;
  if (!reachable) body = '<p class="card-lead">Nova isn’t answering.</p><p class="card-line">This page reconnects when it’s back.</p>';
  else if (!health && healthFailed) body = `<p class="card-lead" data-status="needs-you">Health checks couldn’t be loaded</p><p class="card-line">Nova answered, but not with its health reading.</p><button type="button" class="btn small" data-action="retry-part" data-part="health">Try again</button>`;
  else if (!health) body = waitingLine('Checking Nova’s health', { key: 'health' });
  else {
    const s = severity({ problems, known, checks: health.checks });
    const stopped = s.level === 'stopped';
    // Working, but not something to call normal: no backup to fall back on (F-019). Amber, never red.
    const look = Object.entries(health.checks ?? {}).filter(([, ch]) => ch && ch.ok !== false && ch.attention);
    const lead = problems.length ? `${problems.length} problem${problems.length === 1 ? '' : 's'} to look at${stopped ? ': Nova is stopped' : ''}`
      : stopped ? 'Nova is stopped' : s.lookChecks.length || look.length ? 'Something needs a look' : !known ? 'Problems couldn’t be checked' : 'All systems normal';
    const failing = [...s.stoppedChecks, ...s.lookChecks];
    const lines = problems.length ? [problemsSummary(problems), stopped ? 'Something stopped Nova. What happened, and what you can do, is in Health.' : 'Nothing has stopped Nova. What happened, and what you can do, is in Health.']
      : failing.length ? [`Needs a look: ${listWords(failing.map((k) => CHECK_NAMES[k] ?? 'another check'))}.`, 'The detail is in Health.']
        : look.length ? [...look.map(([k, ch]) => `${CHECK_NAMES[k] ?? 'A check'}: ${typeof ch.attention === 'string' ? ch.attention : 'needs a look.'}`), 'The detail is in Health.']
          : !known ? ['Nova couldn’t read its list of problems, so it can’t say nothing is wrong.']
            : [`Database, ledger and ${health.checks?.workers?.workers?.length ?? 0} workers are fine.`];
    const tone = stopped ? 'failed' : s.level === 'needs-you' || s.level === 'unknown' || look.length ? 'needs-you' : 'verified';
    body = `<p class="card-lead" data-status="${tone}">${esc(lead)}</p>${lines.map((l) => `<p class="card-line">${esc(l)}</p>`).join('')}${!known ? '<button type="button" class="btn small" data-action="retry-part" data-part="problems">Try again</button>' : ''}`;
  }
  return card({ kind: 'health-card', title: 'System health', icon: 'health', body, action: '<a class="link" href="/health" data-nav="health">Health</a>' });
}

// A playbook's "What Nova did" (Health, M7b), from its repairs as the core records them
// ({ at, name, by, ok, said }), oldest first. A run of the same event in a row is one entry with
// its count and its latest time (owner, 2026-11-08: the same line three times on the Duo cover).
// The same event: the same repair (`name`), the same outcome (`ok`) and the same words (`said`),
// all for this one problem. When it happened (`at`) is not part of it, and neither is who asked
// (`by`): the line doesn't say who, so a person's retry that ended the same way reads the same.
// Only neighbours merge; the same event after a different one is a new entry. The last `keep`.
export function playbookEvents(repairs = [], keep = 3) {
  const out = [];
  for (const r of repairs ?? []) {
    const last = out.at(-1);
    if (last && last.name === r.name && last.ok === r.ok && last.said === r.said) { last.count++; last.at = r.at; continue; }
    out.push({ name: r.name, ok: r.ok, said: r.said, at: r.at, count: 1 });
  }
  return out.slice(-keep);
}

// The Caps.view() shape, supplied by the caller. No fetching or defaults here: an absent view
// must never turn into an editable set of guessed limits. The styleguide uses synthetic views.
export function workCosts({ view = null, state = 'ready', error = '', invalid = {} } = {}) {
  const loaded = !!view && !['loading', 'unavailable'].includes(state);
  const locked = !loaded || state === 'saving';
  const count = (n) => Number.isFinite(n) ? n.toLocaleString('en-US') : 'Unknown';
  const dollars = (n) => Number.isFinite(n) ? n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 }) : 'Unknown';
  const usage = (s) => `${count(s.tokens_in + s.tokens_out)} tokens · ${count(s.estimated_tokens)} estimated · ${count(s.unpriced_tokens)} unpriced`;
  const accountingScope = 'Nova runner usage on this machine; provider-managed tasks are not included.';
  const accountingWords = view?.accounting?.words ?? `${accountingScope} Autonomous runner work is live capped; your own conversations are metered without caps. Provider-owned loops are not live capped. Spend on other nodes is not included. Estimated tokens and tokens without a price are labeled separately; this is not complete monthly billing.`;
  const month = view?.month;
  const totals = !loaded ? (state === 'unavailable' ? '<p class="card-line" role="status">Work costs are unavailable. Limits cannot be saved until they load.</p>' : waitingLine('Loading work costs and limits', { key: 'health-costs' }))
    : `<p class="sheet-heading">Month to date · ${esc(month.month)}</p><p class="card-lead">${dollars(month.total.usd)} priced USD</p><p class="card-line">${usage(month.total)}</p>
      ${month.providers.length ? `<ul class="settings-list work-cost-providers" aria-label="Usage by provider and model">${month.providers.map((p) => settingsRow({ title: `${p.provider} · ${p.model}`, note: usage(p), control: `<span class="card-line">${dollars(p.usd)} priced USD</span>` })).join('')}</ul>` : '<p class="card-line">No model usage recorded this month. Usage from Nova runner work and your conversations will appear here.</p>'}`;
  const fields = [['task', 'Per task'], ['day', 'Per day']].map(([scope, title]) => `<fieldset class="work-cost-group"><legend class="sheet-heading">${title}</legend><ul class="settings-list">${[['iterations', 'Weighted steps'], ['tokens', 'Tokens'], ['usd', 'Priced USD']].map(([key, label]) => {
    const name = `${scope}.${key}`;
    const id = `work-limit-${scope}-${key}`;
    const value = loaded ? view.limits[scope][key] : undefined;
    const unlimited = value === null;
    const problem = invalid[name];
    return settingsRow({ title: label, note: key === 'iterations' ? 'Repeated tool calls count more.' : '', control: `<input class="input work-limit" id="${id}" name="${name}" aria-label="${title} ${label.toLowerCase().replace('usd', 'USD')}" type="number" step="any" required value="${value === null || value === undefined ? '' : esc(String(value))}"${locked || unlimited ? ' disabled' : ''}${problem ? ` aria-invalid="true" aria-describedby="${id}-error"` : ''}><label class="work-unlimited"><input type="checkbox" name="${name}.unlimited" aria-label="${title} ${label.toLowerCase().replace('usd', 'USD')} unlimited"${unlimited ? ' checked' : ''}${locked ? ' disabled' : ''}> Unlimited</label>${problem ? `<p class="card-line work-limit-error" id="${id}-error">${esc(problem)}</p>` : ''}` });
  }).join('')}</ul></fieldset>`).join('');
  const notice = state === 'saving' ? '' : state === 'success' ? 'Limits saved on this node.' : state === 'save-error' ? (error || 'Limits could not be saved. Your edits are still here; try again.') : Object.keys(invalid).length ? 'Enter a finite number greater than zero, or choose Unlimited.' : '';
  return `<section class="work-costs" aria-label="Work costs" data-work-costs-state="${esc(state)}">${totals}
    <p class="card-line">${accountingScope} Estimated tokens are part of the total; unpriced tokens are not included in priced USD.</p>
    <h3 class="sheet-heading">Autonomous work limits</h3><p class="card-line">Nova stops autonomous runner work at a limit and needs new approval to resume. Your own conversations are metered, but not capped.</p>
    <form data-work-limits novalidate>${fields}<div class="work-cost-actions"><button class="btn" type="submit" data-save-work-limits${locked || Object.keys(invalid).length ? ' disabled' : ''}>Save limits</button><p class="card-line" role="status" data-work-costs-notice>${state === 'saving' ? waitingLine('Saving limits', { key: 'health-costs-save', tag: 'span' }) : esc(notice)}</p></div></form>
    <details class="work-cost-details"><summary>How these limits work</summary><p class="card-line">${esc(accountingWords)}</p><p class="card-line">Task limits apply to each run or approved resume. Daily limits use your profile’s timezone. Unpriced tokens cannot be held to a dollar limit. Estimated usage is approximate. Spend is local to this node; after failover, another node may have different totals.</p></details>
  </section>`;
}

// Leave the real action as a native attachment navigation. The styleguide alone intercepts it;
// future Health composition must not fetch the bundle or turn it into a client-side data store.
// `why` it is unavailable: Nova out of reach, or reachable without its health reading (F-023).
export function diagnosticsDownload({ available = true, why = 'unreachable' } = {}) {
  const unavailable = why === 'health' ? 'Diagnostics are unavailable until Nova’s health reading is in. Try the checks again below.' : 'Diagnostics are unavailable. Try again when Nova is reachable.';
  return `<section class="diagnostics-download" aria-label="Diagnostics" data-diagnostics-state="${available ? 'available' : 'unavailable'}"><p class="card-line">Download versions, health, settings and recent diagnostic logs. Work, memory and conversations are represented by counts and states, without conversation, memory or captured screen/audio content.</p><p class="card-line">Built in memory for your download. Nova keeps no copy and uploads nothing.</p><details class="work-cost-details"><summary>Review before sharing</summary><p class="card-line">Known secrets and secret-shaped values are redacted. Logs and error details can still contain other free text; this is not a guarantee that every private detail is removed. Review the file before sharing.</p></details>${available ? '<a class="btn" href="/api/v1/diagnostics" download data-download-diagnostics>Download diagnostics</a>' : `<p class="card-line">${esc(unavailable)}</p><button class="btn" disabled>Download diagnostics</button>`}</section>`;
}

export function memoryHighlightCard({ records = [] } = {}) {
  const r = records.find((m) => m.active && m.user_state !== 'forgotten');
  const body = r
    ? `<p class="card-lead">${esc(clip(r.content, 90))}</p><p class="card-line">${esc(r.kind)} · <time>${esc(ago(r.created_at))}</time></p>`
    : '<p class="card-lead">Nothing kept yet.</p><p class="card-line">What lasts from your conversations shows here.</p>';
  return card({ kind: 'memory-highlight-card', title: 'Memory', icon: 'memory', body, action: '<a class="link" href="/memory" data-nav="memory">Memory</a>' });
}

// ---- the approval sheet, tiered (NOVA-SPEC §6) ----------------------------------------------

const TIER_WORDS = {
  2: 'Nova asks before doing this, because it reaches outside Nova or can’t easily be taken back.',
  3: 'This needs your explicit confirmation every time: it changes something core, deletes data, or can’t be undone.',
};
const PRIVACY_WORDS = { 'local-only': 'Model calls stay on your own devices.', 'local-preferred': 'Local first; cloud help only if needed, and recorded.', 'cloud-allowed': 'Nova may use cloud services for this.' };

// `run`: Nova asking to run a brief's test on what a provider wrote (GET /providers/tasks/{id}/test-run).
// The person sees each file it changed, a short preview of the change, and what running it means.
function testRunSheet(t, run, where) {
  const KIND = { added: 'added', modified: 'changed', deleted: 'deleted' };
  const files = run.files.map((f) => `<li><p class="card-line"><strong>${esc(f.path)}</strong> · ${esc(KIND[f.kind] ?? f.kind)} · +${Number(f.added)} −${Number(f.removed)}</p>${f.preview ? `<pre tabindex="0">${esc(f.preview)}</pre>` : ''}</li>`).join('');
  return `<form class="approval-sheet" data-tier="2" data-test-run="${esc(t.id)}" method="dialog">
  <p class="sheet-kicker">${status('needs-you')}</p>
  <h2 class="sheet-title" id="sheet-title">${esc(t.title)}</h2>
  <p class="sheet-line">${esc(run.provider_name)} has finished. Before Nova checks its work, it needs to run <code>${esc(run.command)}</code>.</p>
  <p class="sheet-line"><strong>${esc(run.words)}</strong></p>
  ${run.files.length ? `<h3 class="sheet-heading">What it changed</h3><ul class="checks">${files}</ul>${run.more ? `<p class="sheet-line is-faint">And ${Number(run.more)} more.</p>` : ''}` : ''}
  <dl class="facts"><dt>Who did it</dt><dd>${where}</dd><dt>Why it asks</dt><dd>${esc(TIER_WORDS[2])}</dd></dl>
  <div class="sheet-actions">
    <button type="submit" class="btn primary" data-action="approve" value="approve">Run the test</button>
    <button type="button" class="btn" data-action="cancel-task" data-task="${esc(t.id)}">Cancel the task</button>
    <button type="button" class="btn quiet" data-action="close-sheet">Not now</button>
  </div>
</form>`;
}

// Tier 3 on the hub's own screen is confirmed with a passkey (Insertion #3 T2): it proves a person
// is here, not just a program on this computer. Tiers 0–2 are unchanged. Approved in #291; every
// tier-3 sheet gets the line from passkey.js, which runs the step for any request with confirm: true.
export const PASSKEY_STATES = ['ready', 'waiting', 'cancelled', 'failed', 'expired', 'no-passkey', 'unavailable', 'rate', 'confirmed'];
const PASSKEY_LINES = {
  ready: ['status', 'Confirm with your passkey. Nova checks that you are here, not only a program on this computer.'],
  waiting: ['status', 'Waiting for your passkey. Use your security key, fingerprint or screen lock when your browser asks.'],
  cancelled: ['status', 'No passkey was used, so nothing was approved.'],
  failed: ['alert', 'That passkey didn’t confirm this request, so nothing was approved.'],
  expired: ['status', 'This request ran out of time before it was confirmed, so nothing was approved. Ask again for a fresh one.'],
  'no-passkey': ['status', 'Actions like this need a passkey on Nova’s own screen. Add one first; nothing is approved until then.'],
  unavailable: ['alert', 'This browser can’t use a passkey here. Open Nova on this computer’s own address (localhost) in a browser that supports passkeys. There is no other way to confirm this.'],
  rate: ['alert', 'Too many tries. Wait a minute, then try again.'],
  confirmed: ['status', 'Confirmed with your passkey.'],
};
export function passkeyLine(state = 'ready') {
  const [role, line] = PASSKEY_LINES[state] ?? PASSKEY_LINES.ready;
  return `<p class="settings-note passkey-line" role="${role}" data-passkey-state="${esc(state)}">${esc(line)}</p>`;
}
export function passkeyConfirm({ state = 'ready', confirmed = false } = {}) {
  const box = ['ready', 'cancelled', 'failed'].includes(state)
    ? `<label class="confirm"><input type="checkbox" name="confirm" required${confirmed ? ' checked' : ''}> I understand, and I want Nova to do this.</label>` : '';
  return `${box}${passkeyLine(state)}`;
}
export function passkeyAction({ state = 'ready', confirmed = false } = {}) {
  const b = (action, label, o = {}) => `<button type="${o.submit ? 'submit' : 'button'}" class="btn ${o.quiet ? 'quiet' : 'primary'}" data-action="${action}"${o.disabled ? ' disabled' : ''}${o.busy ? ' aria-busy="true"' : ''}>${esc(label)}</button>`;
  if (state === 'waiting') return `${b('passkey-wait', 'Waiting for your passkey', { disabled: true, busy: true })}${b('passkey-stop', 'Stop waiting', { quiet: true })}`;
  if (state === 'expired') return b('passkey-ask-again', 'Ask again');
  if (state === 'no-passkey') return b('passkey-add', 'Add a passkey');
  if (state === 'unavailable' || state === 'confirmed') return '';
  if (state === 'rate') return b('passkey-confirm', 'Confirm with passkey', { disabled: true });
  return b('passkey-confirm', state === 'ready' ? 'Confirm with passkey' : 'Try again', { submit: true, disabled: !confirmed });
}
// Adding the console's passkeys (Settings › Security). Setup is complete with two, so losing one
// never locks the person out (owner, #291); Nova keeps only their public keys.
export const PASSKEY_SETUP_STATES = ['start', 'waiting', 'added', 'failed', 'unavailable'];
export function passkeySetup({ state = 'start', name = 'This computer’s passkey', count = state === 'added' ? 1 : 0, passkeys = [], first = null } = {}) {
  const second = count === 1;
  const lines = {
    start: ['status', count === 1 ? 'One passkey so far. Add a second one, such as a security key you keep somewhere safe: setup is complete with two, and with only one, losing it means a factory reset.'
      : count >= 2 ? `Setup is complete: ${count} passkeys. Tier-3 actions on Nova’s own screen ask for one of them.`
      : 'Tier-3 actions on Nova’s own screen ask for a passkey, and nothing tier-3 runs until you add one. Your browser will ask you to create it with your security key, fingerprint or screen lock. Nova keeps only its public key. Add two, so losing one never locks you out.'],
    waiting: ['status', 'Waiting for your browser to create the passkey.'],
    added: ['status', second ? `Passkey added: ${name}. Now add a second one: setup is complete with two.` : `Passkey added: ${name}. Setup is complete: ${count} passkeys.`],
    failed: ['alert', 'No passkey was added. Nothing changed; try again when you are ready.'],
    unavailable: ['alert', 'This browser can’t create a passkey here. Open Nova on this computer’s own address (localhost) in a browser that supports passkeys.'],
  };
  const [role, line] = lines[state] ?? lines.start;
  const label = state === 'failed' ? 'Try again' : count === 1 ? 'Add a second passkey' : count >= 2 ? 'Add another passkey' : 'Add a passkey';
  const action = state === 'waiting' ? '<button type="button" class="btn primary" data-action="passkey-setup-wait" disabled aria-busy="true">Waiting for your browser</button>'
    : state !== 'unavailable' ? `<button type="button" class="btn ${count >= 2 && state !== 'failed' ? '' : 'primary'}" data-action="passkey-setup">${label}</button>` : '';
  const list = passkeys.length ? `<ul class="settings-list">${passkeys.map((p) => `<li class="settings-row"><div class="settings-text"><p class="settings-label">${esc(p.name)}</p><p class="settings-note">Added ${esc(new Date(p.created_at).toLocaleDateString())}${p.created_at === first ? ', the first, taken on trust' : ''}</p></div></li>`).join('')}</ul>` : '';
  return `<section class="passkey-setup" aria-labelledby="passkey-setup-title" data-passkey-count="${count}"><h3 class="settings-group-title" id="passkey-setup-title">Passkeys for tier-3 actions</h3>${list}<p class="settings-note" role="${role}" data-passkey-setup-state="${esc(state)}">${esc(line)}</p>${action ? `<div class="connection-actions">${action}</div>` : ''}</section>`;
}

export function approvalSheet(t, { worker = null, run = null, passkey = null } = {}) {
  const tier = Number(t.approval_tier) >= 3 ? 3 : 2;
  const EGRESS = { none: 'stays on this machine', local: 'stays on your devices', remote: 'reaches the internet' };
  const where = worker ? `${esc(worker.name ?? worker.id)}${EGRESS[worker.egress] ? ` · ${EGRESS[worker.egress]}` : ''}` : esc(t.owner);
  if (run) return testRunSheet(t, run, where);
  return `<form class="approval-sheet" data-tier="${tier}" data-task="${esc(t.id)}" method="dialog">
  <p class="sheet-kicker">${status('needs-you')}</p>
  <h2 class="sheet-title" id="sheet-title">${esc(t.title)}</h2>
  <p class="sheet-line">${esc(t.brief?.goal ?? '')}</p>
  <dl class="facts"><dt>Who does it</dt><dd>${where}</dd><dt>Privacy</dt><dd>${esc(PRIVACY_WORDS[t.privacy_mode] ?? t.privacy_mode ?? '')}</dd><dt>Why it asks</dt><dd>${esc(TIER_WORDS[tier])}</dd></dl>
  ${tier === 3 && passkey ? passkeyConfirm(passkey) : tier === 3 ? '<label class="confirm"><input type="checkbox" name="confirm" required> I understand, and I want Nova to do this.</label>' : ''}
  <div class="sheet-actions">
    ${tier === 3 && passkey ? passkeyAction(passkey) : `<button type="submit" class="btn primary" data-action="approve" value="approve"${tier === 3 ? ' disabled' : ''}>${tier === 3 ? 'Confirm' : 'Approve'}</button>`}
    ${passkey?.state === 'waiting' ? '' : '<button type="button" class="btn" data-action="cancel-task">Cancel the task</button>'}
    <button type="button" class="btn quiet" data-action="close-sheet">Not now</button>
  </div>
</form>`;
}

// ---- coding through chat (M10c) ----------------------------------------------------------------

// A coding run's step that waits for the person (GET /coding/runs/{id}). The check (tier 2): what the
// agent changed, and the commands Nova will run on it, which run the agent's code as the person. The
// merge (tier 3): the reviewed diff, Nova's test result and the preview link, then what merging does,
// before the confirmation.
// The same words as the check step's own goal (coding/index.ts RUNS_AGENT_CODE): what this OK means.
export const RUNS_AGENT_CODE = 'This runs code the coding agent wrote, as you: it can do anything you can on this computer, Nova’s own files included. Nova’s later promise, to merge only exactly what you reviewed, is only as strong as this OK.';
export function codingSheet(t, run) {
  const step = t.brief?.inputs?.step;
  const merge = step === 'merge';
  const tier = merge ? 3 : 2;
  const KIND = { added: 'added', modified: 'changed', deleted: 'deleted' };
  const short = (s) => esc(String(s ?? '').slice(0, 7));
  const files = (run.changes ?? []).map((c) => `<li><p class="card-line"><strong>${esc(c.path)}</strong> · ${esc(KIND[c.kind] ?? c.kind)}${c.added === null ? ' · binary' : ` · +${Number(c.added)} −${Number(c.removed)}`}</p></li>`).join('');
  const diff = run.diff ? `<details class="raw coding-diff"${merge ? ' open' : ''}><summary>The whole diff</summary><pre tabindex="0">${esc(run.diff)}</pre></details>` : '';
  const scope = run.scope ? `<p class="sheet-line coding-scope">What it was allowed to change: ${esc(run.scope)}</p>` : '';
  const changed = `<h3 class="sheet-heading">What ${esc(run.agent_name)} changed</h3>${scope}<ul class="checks coding-files">${files}</ul>${diff}`;
  const test = run.test;
  const tests = test ? `<h3 class="sheet-heading">Tests</h3>
  <p class="sheet-line coding-test" data-passed="${test.passed}">Nova ran <code>${esc(test.command)}</code> itself on <code>${short(test.commit)}</code>: ${test.passed ? 'it passed' : 'it failed'} (exit ${esc(String(test.exit ?? 'none'))}, ${esc((Number(test.ms) / 1000).toFixed(1))} s).</p>
  ${test.output?.trim() ? `<details class="raw"><summary>Its output</summary><pre tabindex="0">${esc(test.output)}</pre></details>` : ''}` : '';
  const p = run.preview;
  const preview = !merge ? '' : p
    ? `<h3 class="sheet-heading">Preview</h3><p class="sheet-line coding-preview">${p.running ? `<a class="link" href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.url)}</a> · on this computer only` : `Stopped (${esc(p.why_stopped ?? 'it isn’t running')}). It was at ${esc(p.url)}.`}</p>`
    : run.preview_command ? '' : '<h3 class="sheet-heading">Preview</h3><p class="sheet-line">No preview: none was asked for.</p>';
  const lead = merge
    ? `<p class="sheet-line">Reviewed and tested. ${esc(run.merge ?? '')}</p>`
    : `<p class="sheet-line">${esc(run.agent_name)} wrote this on Nova’s branch <code>${esc(run.nova_branch)}</code>, from ${esc(run.branch)} in ${esc(run.repo)}. Nothing in your repository has changed.</p>
  <p class="sheet-line">To check it, Nova runs <code>${esc(run.test_command)}</code>${run.preview_command ? ` and then starts the preview <code>${esc(run.preview_command)}</code>` : ''} in its worktree, on this computer.</p>
  <p class="sheet-line"><strong>${esc(RUNS_AGENT_CODE)}</strong></p>`;
  const actions = merge
    ? `<button type="submit" class="btn primary" data-action="approve" value="approve" disabled>Merge</button>
    <button type="button" class="btn" data-action="decline-merge" data-run="${esc(run.id)}">Don’t merge</button>`
    : `<button type="submit" class="btn primary" data-action="approve" value="approve">Run the tests</button>
    <button type="button" class="btn" data-action="cancel-task" data-task="${esc(t.id)}">Cancel the task</button>`;
  return `<form class="approval-sheet coding-sheet" data-tier="${tier}" data-task="${esc(t.id)}" data-coding="${esc(step)}" method="dialog">
  <p class="sheet-kicker">${status('needs-you')}</p>
  <h2 class="sheet-title" id="sheet-title">${esc(t.title)}</h2>
  ${lead}
  ${changed}
  ${tests}
  ${preview}
  <dl class="facts"><dt>Repository</dt><dd>${esc(run.repo)} · ${esc(run.branch)}</dd><dt>Why it asks</dt><dd>${esc(merge ? `Merging changes ${run.branch}, a branch others may build on, and Nova can’t take it back: it asks every time.` : 'It runs code Nova didn’t write, on this computer: Nova asks first.')}</dd></dl>
  ${merge ? `<label class="confirm"><input type="checkbox" name="confirm" required> I’ve reviewed this. Merge it into ${esc(run.branch)}.</label>` : ''}
  <div class="sheet-actions">
    ${actions}
    <button type="button" class="btn quiet" data-action="close-sheet">Not now</button>
  </div>
</form>`;
}

// ---- infrastructure and networking through chat (M10d) --------------------------------------------

const ACTION_WORDS = { create: 'add', update: 'change', replace: 'replace', delete: 'destroy' };
const money = (n) => `${n < 0 ? '−' : '+'}$${Math.abs(Number(n)).toFixed(2)}`;
const minutesOf = (s) => (Number(s) % 60 === 0 ? `${Number(s) / 60} minute${Number(s) === 60 ? '' : 's'}` : `${Number(s)} seconds`);

// An infrastructure run's apply (GET /infra/runs/{id}): the plan in full, each change with its price,
// where the month would stand against the budget, and what applying does, before the confirmation.
export function infraSheet(t, run) {
  const lines = (run.changes ?? []).map((c) => `<li><p class="card-line"><strong>${esc(c.address)}</strong> · ${esc(ACTION_WORDS[c.action] ?? c.action)} · ${esc(money(c.delta_usd))} a month</p></li>`).join('');
  const b = run.budget;
  const budget = b ? `<p class="sheet-line infra-budget" data-level="${esc(b.level)}">After it: ${esc(b.words)}.${b.level === 'warn' ? ' <strong>That is past 80 % of the budget.</strong>' : ''}</p>` : '';
  return `<form class="approval-sheet infra-sheet" data-tier="3" data-task="${esc(t.id)}" data-infra="${esc(run.id)}" method="dialog">
  <p class="sheet-kicker">${status('needs-you')}</p>
  <h2 class="sheet-title" id="sheet-title">${esc(t.title)}</h2>
  <p class="sheet-line">Nova planned “${esc(run.project?.name ?? '')}” with OpenTofu. No infrastructure has changed yet.</p>
  ${run.planning ? `<p class="sheet-line infra-planning">${esc(run.planning)}</p>` : ''}
  <p class="sheet-line">${esc(run.apply ?? '')}</p>
  <h3 class="sheet-heading">What it changes</h3>
  <ul class="checks infra-changes">${lines}</ul>
  ${budget}
  <h3 class="sheet-heading">The plan, in full</h3>
  <details class="raw infra-plan" open><summary>OpenTofu’s plan</summary><pre tabindex="0">${esc(run.plan_text ?? '')}</pre></details>
  <dl class="facts"><dt>Project</dt><dd>${esc(run.folder ?? '')}</dd><dt>Before it</dt><dd>Nova takes a checkpoint of itself and keeps a copy of OpenTofu’s state.</dd><dt>Why it asks</dt><dd>Applying can spend money, or destroy what it lists, and Nova can’t take it back: it asks every time.</dd></dl>
  <label class="confirm"><input type="checkbox" name="confirm" required> I’ve read the plan. Apply it to “${esc(run.project?.name ?? '')}”.</label>
  <div class="sheet-actions">
    <button type="submit" class="btn primary" data-action="approve" value="approve" disabled>Apply</button>
    <button type="button" class="btn" data-action="decline-change" data-path="/infra/runs/${esc(encodeURIComponent(run.id))}/decline" data-said="Not applied. Nothing changed.">Don’t apply</button>
    <button type="button" class="btn quiet" data-action="close-sheet">Not now</button>
  </div>
</form>`;
}

// A network change's apply, or a revert the person asked for (GET /network/changes/{id}): the diff
// against the snapshot (secret values masked), and the dead-man's switch, before the confirmation.
export function networkSheet(t, change) {
  const step = t.brief?.inputs?.step;
  const name = change.target?.name ?? '';
  const revert = step === 'revert';
  const diff = change.diff ? `<h3 class="sheet-heading">The change</h3><details class="raw network-diff" open><summary>The diff against the snapshot</summary><pre tabindex="0">${esc(change.diff)}</pre></details>` : '';
  const snap = change.snapshot ? `sha256 ${esc(String(change.snapshot.sha256).slice(0, 12))}…${change.snapshot.at ? `, taken ${esc(ago(change.snapshot.at))}` : ''}` : '';
  return `<form class="approval-sheet network-sheet" data-tier="3" data-task="${esc(t.id)}" data-network="${esc(change.id)}" method="dialog">
  <p class="sheet-kicker">${status('needs-you')}</p>
  <h2 class="sheet-title" id="sheet-title">${esc(t.title)}</h2>
  ${revert
    ? `<p class="sheet-line">Nova puts ${esc(name)} back to the snapshot from before “${esc(change.title)}”.</p>`
    : `<p class="sheet-line">Nova took a snapshot of ${esc(name)} and worked out this change. Nothing has changed yet.</p>
  <p class="sheet-line network-switch"><strong>After the change, if Nova can’t hear from one of your devices within ${esc(minutesOf(change.window_s))}, it puts the snapshot back by itself.</strong></p>`}
  ${revert ? '' : diff}
  <dl class="facts"><dt>Target</dt><dd>${esc(name)} · ${esc(change.target?.kind ?? '')}</dd>${snap ? `<dt>Snapshot</dt><dd>${snap}</dd>` : ''}${!revert && change.counts?.length ? `<dt>Keeps the change</dt><dd class="network-counts">A request from ${esc(change.counts.join(' or '))}, not from this computer</dd>` : ''}<dt>Before it</dt><dd>Nova takes a checkpoint of itself.</dd><dt>Why it asks</dt><dd>A network change can cut your devices off: Nova asks every time.</dd></dl>
  <label class="confirm"><input type="checkbox" name="confirm" required> ${revert ? `Put ${esc(name)} back.` : `I’ve read the diff. Change ${esc(name)}.`}</label>
  <div class="sheet-actions">
    <button type="submit" class="btn primary" data-action="approve" value="approve" disabled>${revert ? 'Put it back' : 'Apply'}</button>
    ${revert ? `<button type="button" class="btn" data-action="cancel-task" data-task="${esc(t.id)}">Keep the change</button>` : `<button type="button" class="btn" data-action="decline-change" data-path="/network/changes/${esc(encodeURIComponent(change.id))}/decline" data-said="Not applied. ${esc(name)} is as it was.">Don’t apply</button>`}
    <button type="button" class="btn quiet" data-action="close-sheet">Not now</button>
  </div>
</form>`;
}

// ---- browser takeover (M5c) -----------------------------------------------------------------

const TAKE_OVER_ONLY = 'Only the hub’s own screen, or a device you’ve allowed to approve, can take over.';
const stepLine = (v) => (v.step ? `Step ${v.step.n} of ${v.step.of}: ${v.step.what}.` : '');

// What the takeover view says and offers, from the session's real state (GET /browser/tasks/{id}).
// `me`: this client's key (console or device:<id>); `canTake`: whether it may take over.
export function takeoverState(v, { me = 'console', canTake = true } = {}) {
  const mine = !!v?.holder && v.holder.key === me;
  const held = !!v?.holder;
  if (!v?.live) return { status: 'quiet', line: 'The browser work is over. Nova is checking what it proves.', action: null, held: false, mine: false };
  if (held) {
    const line = mine
      ? `You have control. Nova waits until you hand back.${v.asked ? ` It asked you to: ${v.asked}` : ''} A payment goes only when you press it yourself; the page can’t pay on its own, and it has no WebSockets.`
      : `${v.holder.label} has control. Nova waits until they hand back.`;
    // The hub's own screen can end someone else's takeover; nobody else can.
    const action = mine || (me === 'console' && canTake) ? 'hand-back' : null;
    return { status: 'waiting', line, action, held, mine };
  }
  if (v.mode === 'needs_person') return { status: 'needs-you', line: `Needs you: ${v.asked ?? 'a step only a person can do.'}`, action: canTake ? 'take-over' : null, held, mine };
  // M10b: the person paused it; Carry on is theirs.
  if (v.mode === 'paused') return { status: 'waiting', line: 'Paused. Nova does nothing until you let it carry on.', action: canTake ? 'resume' : null, held, mine };
  if (v.mode === 'starting') return { status: 'working', line: 'Nova is opening a browser.', action: null, held, mine };
  if (v.mode === 'finishing') return { status: 'working', line: 'Nova has finished the steps and is taking its evidence.', action: null, held, mine };
  return { status: 'working', line: `Nova is working. ${stepLine(v)}`.trim(), action: canTake ? 'take-over' : null, held, mine };
}

export function takeoverActions(st, { canTake = true } = {}) {
  const primary = st.action === 'take-over'
    ? '<button type="button" class="btn primary" data-action="take-over">Take over</button>'
    : st.action === 'hand-back' ? `<button type="button" class="btn primary" data-action="hand-back">${st.mine ? 'Hand back' : 'End their takeover'}</button>`
      : st.action === 'resume' ? '<button type="button" class="btn primary" data-action="resume-browser">Carry on</button>' : '';
  const why = !canTake && !st.held && st.status !== 'quiet' ? `<p class="sheet-line takeover-only">${esc(TAKE_OVER_ONLY)}</p>` : '';
  // M10b: the person in control can pause the worker or stop the task, quietly beside the standout.
  const live = canTake && st.status !== 'quiet' && !st.held;
  const pause = live && st.action === 'take-over' && st.status === 'working' ? '<button type="button" class="btn quiet" data-action="pause-browser">Pause</button>' : '';
  const stopBtn = live ? '<button type="button" class="btn quiet" data-action="stop-browser">Stop</button>' : '';
  return `${why}${primary}${pause}${stopBtn}<button type="button" class="btn quiet" data-action="close-sheet">Close</button>`;
}

export function takeoverRefused(v) {
  const list = (v?.blocked ?? []);
  if (!list.length) return '';
  return `<details class="raw"><summary>Refused ${list.length} host${list.length === 1 ? '' : 's'} the task didn’t declare</summary><ul class="timeline">${list.map((b) => `<li>${esc(b.host)}${b.count > 1 ? ` · ${b.count} times` : ''}</li>`).join('')}</ul></details>`;
}

// The live view of a browser task: its picture, what is happening in plain words, and the one
// standout action (Take over, or Hand back). The picture fills in from the frame stream.
export function takeoverPanel(t, v, opts = {}) {
  const st = takeoverState(v, opts);
  const host = (() => { try { return new URL(v?.url ?? '').host; } catch { return ''; } })();
  return `<section class="takeover" data-task="${esc(t.id)}" data-mode="${esc(v?.mode ?? 'closed')}" aria-labelledby="sheet-title">
  <p class="sheet-kicker takeover-status">${status(st.status)}</p>
  <h2 class="sheet-title" id="sheet-title">${esc(t.title)}</h2>
  <p class="sheet-line takeover-line" role="status" aria-live="polite">${esc(st.line)}</p>
  <div class="takeover-screen" data-held="${st.mine}">
    <img class="takeover-frame" alt="The browser’s screen, live${host ? `, at ${esc(host)}` : ''}" tabindex="0" hidden>
    ${waitingLine('Waiting for the browser’s picture', { key: 'takeover-picture' })}
  </div>
  <form class="takeover-type"${st.mine ? '' : ' hidden'}>
    <label class="takeover-type-label" for="takeover-text">Type into the page</label>
    <div class="takeover-type-row"><input id="takeover-text" name="text" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="send"><button type="submit" class="btn">Type</button><button type="button" class="btn" data-action="takeover-key" data-key="Enter">Enter</button></div>
  </form>
  <p class="sheet-line is-faint takeover-where">${esc(host)}</p>
  <div class="takeover-refused">${takeoverRefused(v)}</div>
  <div class="sheet-actions takeover-actions">${takeoverActions(st, opts)}</div>
</section>`;
}

// ---- automations ------------------------------------------------------------------------------

const CLASS_WORDS = { heartbeat: 'On a schedule', event: 'When something happens', proactive: 'When Nova has something to say' };
export function triggerRow(r) {
  // A connector's event (M5b): source connector:<id>/<topic>.
  const from = /^connector:([^/]+)\/(.+)$/.exec(r.source ?? '');
  const when = r.schedule ?? r.cron ?? (r.hook_path ? `Webhook ${r.hook_path}` : from ? `${from[1] === 'home-assistant' ? 'Home Assistant' : from[1] === 'gmail' ? 'Gmail' : from[1]}: ${from[2]}` : '');
  const what = r.action?.kind === 'message' ? `Says: “${clip(r.action.text, 60)}”` : r.action?.kind === 'task' ? `Starts: ${clip(r.action.task?.title ?? 'a task', 60)}` : '';
  return `<li class="trigger-row${r.paused ? ' is-paused' : ''}" id="tr-${esc(r.id)}" data-rule="${esc(r.id)}">
  <div class="trigger-text"><p class="trigger-name">${esc(r.name)}</p><p class="trigger-meta">${esc(CLASS_WORDS[r.class] ?? r.class)}${when ? ` · ${esc(when)}` : ''}</p>${what ? `<p class="trigger-meta">${esc(what)}</p>` : ''}</div>
  ${r.paused ? '<span class="pill">Paused</span>' : ''}
  <span class="row-actions"><button type="button" class="btn small" data-action="${r.paused ? 'resume-rule' : 'pause-rule'}">${r.paused ? 'Resume' : 'Pause'}</button><button type="button" class="btn small quiet" data-action="delete-rule">Delete</button></span>
</li>`;
}

// ---- conversation pieces ----------------------------------------------------------------------

// `still`: already on screen before this render, so it doesn't rise in again.
// Nova's words carry no avatar or orb: the orb shows once per view (DESIGN-SYSTEM §1).
export function chatBubble({ from = 'nova', text = '', html = null, still = false }) {
  const inner = html ?? esc(text).replace(/\n/g, '<br>');
  const cls = still ? ' is-still' : '';
  return `<div class="chat-bubble from-${from === 'nova' ? 'nova' : 'person'}${cls}"><div class="bubble-body">${inner}</div></div>`;
}

// The voice button and the line that says why it's off, when it is.
export function voiceState({ privacy = 'local-only', supported = false } = {}) {
  if (privacy === 'local-only') return { enabled: false, reason: 'Voice is off in local-only mode: your browser’s speech recognition may send audio to a cloud service.' };
  if (!supported) return { enabled: false, reason: 'This browser can’t take voice input.' };
  return { enabled: true, reason: '' };
}

// ---- notices ------------------------------------------------------------------------------------

export function toast({ text, tone = 'info', action = null }) {
  return `<div class="toast-item" data-tone="${esc(tone)}" role="${tone === 'alert' ? 'alert' : 'status'}"><span>${esc(text)}</span>${action ? `<button type="button" class="toast-btn" data-action="${esc(action.id)}"${action.data ? ` data-ref="${esc(action.data)}"` : ''}>${esc(action.label)}</button>` : ''}</div>`;
}

// A message Nova started (CONTRACTS §6): one line and one action.
export function proactiveBanner(m) {
  const held = m.hold === 'needs_ok';
  return `<div class="proactive-banner" data-message="${esc(m.id)}"${held ? ' data-held' : ''} role="status">
  <p class="banner-text">${esc(clip(m.text, 140))}</p>
  <button type="button" class="btn small" data-action="${held ? 'send-message' : 'read-message'}" data-message="${esc(m.id)}">${held ? 'Let it through' : 'Got it'}</button>
</div>`;
}

// ---- settings ------------------------------------------------------------------------------

// ---- configuration: one layered store, three doors (proposed; owner direction 2026-11-04) -----
// Defaults ship with Nova and are read-only; this hub's settings and your own pack lie over them,
// key by key (config design 2026-11-03). Whichever door a change comes through (a file, the form,
// a chat with Nova), it is shown as the same diff before anything is applied. A file is only an
// import and export format; secrets never travel in one, only references to the vault.
export const CONFIG_LAYERS = { default: 'Default', hub: 'This hub', pack: 'Your pack' };
export const layerBadge = (layer) => `<span class="pill" data-layer="${esc(layer)}">${esc(CONFIG_LAYERS[layer] ?? layer)}</span>`;

// One change: the setting, what it is now and what it would be, and the layer it lands in. A
// refused line says why and is left out.
function configChange(c) {
  const now = c.from === undefined ? 'not set' : c.from;
  return `<li class="settings-row" data-config-key="${esc(c.key)}"><div class="settings-text"><p class="settings-label">${esc(c.label)}</p>
  ${c.refused ? `<p class="settings-note" role="alert">${esc(c.refused)}</p>` : `<p class="settings-note"><del>${esc(now)}</del> → <strong>${esc(c.to)}</strong></p>`}</div>${c.refused ? '<span class="pill is-warn">Left out</span>' : layerBadge(c.layer)}</li>`;
}
export const configDiff = (changes) => `<ul class="settings-list" data-config-diff>${changes.map(configChange).join('')}</ul>`;

// Door 1: a config file or a pack, checked against the schema and shown as a diff first.
export const CONFIG_IMPORT_STATES = ['choose', 'review', 'refused', 'applied'];
export function configImport({ state = 'choose', file = 'nova.config.json', changes = [], problems = [] } = {}) {
  const kept = changes.filter((c) => !c.refused).length;
  const head = `<h3 class="section-title" id="config-import-title">Bring in a configuration</h3>`;
  const body = {
    choose: `<p class="settings-note">A Nova configuration file or a personal pack. Nova checks it and shows every change before applying any; nothing is overwritten that you don’t see first.</p>
<div class="connection-actions"><button type="button" class="btn primary" data-action="config-choose">Choose a file</button><button type="button" class="btn" data-action="config-export">Export your configuration</button><input type="file" hidden accept=".json,application/json" data-config-file></div>`,
    review: `<p class="settings-note" role="status">${esc(file)}: ${kept} change${kept === 1 ? '' : 's'} to apply${kept < changes.length ? `, ${changes.length - kept} left out` : ''}.</p>${configDiff(changes)}
<div class="connection-actions"><button type="button" class="btn primary" data-action="config-apply">Apply ${kept} change${kept === 1 ? '' : 's'}</button><button type="button" class="btn quiet" data-action="config-cancel">Not now</button></div>`,
    refused: `<p class="settings-note" role="alert">${esc(file)} can’t be used, so nothing changed:</p><ul class="steps">${problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
<div class="connection-actions"><button type="button" class="btn" data-action="config-choose">Choose another file</button><input type="file" hidden accept=".json,application/json" data-config-file></div>`,
    applied: `<p class="settings-note" role="status">Applied ${kept} change${kept === 1 ? '' : 's'} from ${esc(file)}. Each one is in the activity log, and each can go back to its default.</p>
<div class="connection-actions"><button type="button" class="btn" data-action="config-cancel">Bring in another file</button><button type="button" class="btn" data-action="config-export">Export your configuration</button></div>`,
  }[state];
  return `<section class="panel config-import" aria-labelledby="config-import-title" data-config-import="${esc(state)}">${head}${body}</section>`;
}

// Door 2: one setting in the form (setup, then Settings): its value, the layer that set it, and a
// way back to the default when an overlay set it.
export function configField(f) {
  const id = `cfg-${f.key.replace(/[^a-z0-9]+/gi, '-')}`;
  const control = f.options
    ? `<select class="input" id="${id}">${f.options.map((o) => { const [v, l] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(v)}"${v === f.value ? ' selected' : ''}>${esc(l)}</option>`; }).join('')}</select>`
    : `<input class="input" id="${id}" value="${esc(f.value)}" spellcheck="false">`;
  return `<li class="settings-row" data-config-key="${esc(f.key)}"><div class="settings-text"><label class="settings-label" for="${id}">${esc(f.label)}</label>
  <p class="settings-note">${esc(f.help)} ${f.layer === 'default' ? 'Nova’s default.' : `Set by ${f.layer === 'pack' ? 'your pack' : 'this hub'}.`}</p></div>
  <div class="settings-control">${control}${layerBadge(f.layer)}${f.layer === 'default' ? '' : `<button type="button" class="btn quiet" data-action="config-reset" data-key="${esc(f.key)}">Use the default</button>`}</div></li>`;
}
export const CONFIG_SETUP_STATES = ['step', 'review'];
export function configSetup({ state = 'step', step = 2, of = 4, title, fields = [], changes = [] } = {}) {
  if (state === 'review') return `<section class="panel config-setup" aria-labelledby="config-setup-title" data-config-setup="review"><h3 class="card-title" id="config-setup-title">Your answers, as changes</h3><p class="settings-note">Nothing is saved until you say so.</p>${configDiff(changes)}
<div class="connection-actions"><button type="button" class="btn primary" data-action="config-apply">Save these</button><button type="button" class="btn quiet" data-action="config-back">Back</button></div></section>`;
  return `<section class="panel config-setup" aria-labelledby="config-setup-title" data-config-setup="step"><h3 class="card-title" id="config-setup-title">${esc(title)}</h3><p class="settings-note">Step ${step} of ${of}</p>
<ul class="settings-list">${fields.map(configField).join('')}</ul>
<div class="connection-actions"><button type="button" class="btn primary" data-action="config-next">Next</button><button type="button" class="btn quiet" data-action="config-back">Back</button></div></section>`;
}

// Door 3: Nova proposes a change in chat. The same diff, asked for at the change's tier; nothing
// is applied until the person says so.
export const CONFIG_PROPOSAL_STATES = ['asking', 'applied', 'declined'];
export function configProposal({ state = 'asking', changes = [], tier = 2 } = {}) {
  const n = changes.length;
  const line = {
    asking: `Nova would change ${n} setting${n === 1 ? '' : 's'}. ${tier === 3 ? 'This loosens a gate, so it’s tier 3: confirmed every time.' : 'Tier 2: it asks once.'}`,
    applied: `Changed ${n} setting${n === 1 ? '' : 's'}. Each is in the activity log and can go back to its default.`,
    declined: 'Nothing changed.',
  }[state];
  return `<article class="card config-proposal" aria-labelledby="config-proposal-title" data-config-proposal="${esc(state)}"><h3 class="card-title" id="config-proposal-title">A change to your settings</h3>
<p class="settings-note" role="status">${esc(line)}</p>${configDiff(changes)}
${state === 'asking' ? `<div class="connection-actions"><button type="button" class="btn primary" data-action="config-apply">${n === 1 ? 'Make this change' : `Make these ${n} changes`}</button><button type="button" class="btn quiet" data-action="config-cancel">Not now</button></div>` : ''}</article>`;
}

// ---- a device's models: the memory budget, the plan, the picks (proposed; owner direction 2026-11-04) --
// Settings › Devices › [device] › Models, and the same component in device setup. Every number and
// verdict is the fit engine's (src/core/models/fit.ts; docs/plans/model-fit-adr-2026-11-04.md): these
// functions only say it. The bar is never read by colour alone: each segment is a row of the legend
// beside it, in words and numbers, in the bar's order, and the bar's own label says the total.
const GIB = 1024 ** 3;
const gbWords = (b) => `${(b / GIB).toFixed(1)} GB`;
const ctxK = (n) => `${Math.round(n / 1024)}k`;
export const FIT_WORDS = { fits: 'Fits', tight: 'Tight', 'wont-fit': 'Won’t fit' };
const verdictPill = (v, extra = '') => `<span class="fit-verdict" data-verdict="${esc(v)}"${extra}>${v === 'fits' ? ICONS.check : v === 'wont-fit' ? ICONS.close : '<span class="fit-tight-mark" aria-hidden="true"></span>'}${FIT_WORDS[v] ?? esc(v)}</span>`;
const MEMORY_WORDS = {
  gpu: (d) => `Budget: ${gbWords(d.budget_bytes)}, one GPU’s own memory. A model sits on one GPU; Nova doesn’t add GPUs together unless the backend splits models across them.`,
  // Where the number came from: the limit set on the Mac, or Nova's estimate of the macOS default.
  unified: (d) => (d.budget_source === 'measured'
    ? `GPU memory limit set on this Mac: ${gbWords(d.budget_bytes)}.`
    : `Estimated GPU share of ${gbWords(d.ram_bytes)} unified memory: ${gbWords(d.budget_bytes)} (macOS default).`),
  cpu: (d) => `No GPU found. Nova plans against half of this computer’s ${gbWords(d.ram_bytes)} of memory, and models run on the processor, slowly.`,
};

// The segments, left to right: each model's weights then its context (KV cache), the overhead, the
// reserve, anything else on the GPU, and what's free. Over budget, the bar spans what's needed and a
// line marks where the budget ends.
function budgetSegments(view) {
  const r = view.total;
  const segs = [];
  r.parts.forEach((p, i) => {
    const m = view.plan[i] ?? {};
    const est = r.basis === 'tier-table' && m.estimate ? ', estimated' : '';
    segs.push({ kind: 'weights', model: i, what: `${p.name}: weights`, sub: `${m.quant}${m.installed ? ', the installed file' : ''}`, bytes: p.weights_bytes });
    segs.push({ kind: 'kv', model: i, what: `${p.name}: context memory`, sub: `KV cache for ${ctxK(m.context)} tokens${est}`, bytes: p.kv_bytes });
  });
  segs.push({ kind: 'overhead', what: 'Runtime overhead', sub: view.device.overhead_source === 'learned' ? `measured from ${view.device.overhead_loads} load${view.device.overhead_loads === 1 ? '' : 's'} on this device` : 'Nova’s estimate; measured after the first load', bytes: r.overhead_bytes });
  segs.push({ kind: 'reserve', what: 'Safety reserve', sub: 'always kept free', bytes: r.reserve_bytes });
  if (r.other_use_bytes > 0) segs.push({ kind: 'other', what: 'In use by other programs', sub: 'the display and other apps', bytes: r.other_use_bytes });
  if (r.headroom_bytes > 0) segs.push({ kind: 'free', what: 'Free', sub: r.verdict === 'fits' ? 'room to spare' : 'less than a tenth of the budget', bytes: r.headroom_bytes });
  return segs;
}

export function memoryBudget(view) {
  const r = view.total;
  const segs = budgetSegments(view);
  const span = Math.max(r.budget_bytes, r.need_bytes);
  const over = r.headroom_bytes < 0;
  const id = `${view.id}-budget`;
  const summary = over
    ? `${gbWords(r.need_bytes)} needed, ${gbWords(-r.headroom_bytes)} more than the ${gbWords(r.budget_bytes)} budget.`
    : `${gbWords(r.need_bytes)} of ${gbWords(r.budget_bytes)} planned, ${gbWords(r.headroom_bytes)} free.`;
  const bar = `<div class="fit-bar" role="img" aria-labelledby="${id}-total" aria-describedby="${id}-legend">${segs.map((s) => `<span class="fit-seg" data-seg="${s.kind}"${s.model === undefined ? '' : ` data-model="${s.model % 3}"`} style="flex-grow: ${(s.bytes / span).toFixed(4)}"></span>`).join('')}${over ? `<span class="fit-limit" style="inset-inline-start: ${((r.budget_bytes / span) * 100).toFixed(2)}%"></span>` : ''}</div>`;
  const legend = `<ul class="fit-legend" id="${id}-legend">${segs.map((s) => `<li class="fit-legend-row"><span class="fit-key" data-seg="${s.kind}"${s.model === undefined ? '' : ` data-model="${s.model % 3}"`} aria-hidden="true"></span><span class="fit-what">${esc(s.what)}<span class="fit-sub">${esc(s.sub)}</span></span><span class="fit-gb">${gbWords(s.bytes)}</span></li>`).join('')}${over ? `<li class="fit-legend-row is-over"><span class="fit-key" data-seg="over" aria-hidden="true"></span><span class="fit-what">Over budget<span class="fit-sub">this plan needs more than the device has</span></span><span class="fit-gb">${gbWords(-r.headroom_bytes)}</span></li>` : ''}</ul>`;
  return `<section class="dm-budget" aria-labelledby="${id}-title"><h4 class="section-title" id="${id}-title">Memory budget</h4>
<div class="dm-total-row"><p class="dm-total" id="${id}-total">${esc(summary)}</p>${verdictPill(r.verdict)}</div>
${bar}<div class="fit-scale" aria-hidden="true"><span>0</span><span>${over ? `needed ${gbWords(r.need_bytes)}` : `budget ${gbWords(r.budget_bytes)}`}</span></div>
<p class="settings-note">${esc(MEMORY_WORDS[view.device.memory](view.device))}</p>${legend}</section>`;
}

// One planned or loaded model: its verdict on its own, with the quant and context it assumed, how far
// its context stretches, and the controls that change them.
function modelPlanRow(view, m, i) {
  const r = m.result;
  const key = `${view.id}-m${i}`;
  // How far the context stretches, said once: a Won't fit verdict already says it, a model with one
  // context has nothing to stretch, and past the longest context offered Nova says that instead.
  const longest = Math.max(...m.contexts);
  const stretch = m.contexts.length < 2 || (r.verdict === 'wont-fit' && r.max_context_fits) ? ''
    : r.max_context_fits === null ? (r.basis === 'tier-table' ? 'How far its context stretches is unknown until Nova can read the model’s shape.' : '')
    : r.max_context_fits >= longest ? `Fits comfortably even at ${ctxK(longest)}, the longest context offered.`
    : r.max_context_fits >= 1024 ? `Fits comfortably up to ${ctxK(r.max_context_fits)} context at ${m.quant}.`
    : `At ${m.quant} it doesn’t fit comfortably at any context.`;
  const ctxIndex = Math.max(0, m.contexts.indexOf(m.context));
  const context = m.contexts.length > 1
    ? `<label class="dm-field" for="${key}-ctx"><span class="dm-field-label">Context</span><input class="dm-range" type="range" id="${key}-ctx" min="0" max="${m.contexts.length - 1}" step="1" value="${ctxIndex}" aria-valuetext="${ctxK(m.context)} tokens" data-models-context="${i}"><output class="dm-out" for="${key}-ctx">${ctxK(m.context)}</output></label>`
    : `<p class="dm-field dm-fixed"><span class="dm-field-label">Context</span><span class="dm-out">${ctxK(m.context)}, the model’s own</span></p>`;
  return `<li class="dm-model" data-model-row="${i}"><div class="dm-model-head"><span class="fit-key" data-seg="weights" data-model="${i % 3}" aria-hidden="true"></span><div class="dm-model-text"><p class="dm-model-name">${esc(m.name)}</p><p class="dm-model-meta">${m.loaded ? 'Loaded now' : m.installed ? 'Installed' : 'Planned, not installed'}${m.estimate ? ' · <span class="dm-estimate">Estimate</span>' : ''}${view.plan.length > 1 ? ' · on its own' : ''}</p></div>${verdictPill(r.verdict)}</div>
<p class="settings-note dm-words">${esc(r.words)}</p>${stretch ? `<p class="settings-note">${esc(stretch)}</p>` : ''}
<div class="dm-controls"><label class="dm-field" for="${key}-quant"><span class="dm-field-label">Quant</span><select class="input" id="${key}-quant" data-models-quant="${i}">${m.quants.map((q) => `<option${q === m.quant ? ' selected' : ''}>${esc(q)}</option>`).join('')}</select></label>${context}<button type="button" class="btn quiet" data-action="models-remove" data-index="${i}" aria-label="Remove ${esc(m.name)} from the plan">Remove</button></div></li>`;
}

// Several models planned: whether they all stay loaded together (overhead and reserve counted once).
function together(view) {
  const r = view.total;
  const n = view.plan.length;
  const all = n === 2 ? 'Both' : `All ${n}`;
  const line = r.verdict === 'fits' ? `${all} stay loaded together, with ${gbWords(r.headroom_bytes)} to spare.`
    : r.verdict === 'tight' ? `${all} stay loaded together, but it’s tight: ${gbWords(r.headroom_bytes)} to spare, and nothing else can load.`
    : `These don’t stay loaded together: ${gbWords(-r.headroom_bytes)} over budget. Nova would load one at a time and swap when a task needs the other. Lower a quant or a context, or remove one.`;
  return `<div class="dm-together" data-together="${esc(r.verdict)}"><div class="dm-model-head"><p class="dm-model-name">Together</p>${verdictPill(r.verdict)}</div><p class="settings-note">${esc(line)}</p></div>`;
}

export const TASK_WORDS = { 'general-chat': 'General chat', coding: 'Coding', screening: 'Screening and decisions', embeddings: 'Embeddings (memory search)', vision: 'Vision', transcription: 'Transcription' };
const PRIVACY_PICKS = {
  'local-only': '<strong>Local only.</strong> Every pick runs on your own devices; no cloud option is offered.',
  'local-preferred': '<strong>Local first.</strong> Local picks come first. A cloud option is listed after them, and runs only if you allow it.',
  'cloud-allowed': '<strong>Cloud allowed.</strong> Cloud options are listed beside the local picks.',
};
const pickWords = (p) => `${p.name} at ${p.quant}, ${ctxK(p.context)} context`;

// Per task class: a pick for this device and a smaller, faster alternative, each with its verdict.
// Privacy comes first: under local-only no cloud option is drawn at all.
// On a Mac, where each verdict's budget came from (the pick's budget_source), in the budget line's own
// words. Said once: every pick here is worked out against the same budget. Not repeated when the
// Memory budget section above already says the same; per row only if the picks ever disagree.
function picksBudget(view) {
  if (view.device.memory !== 'unified') return { once: '', row: () => '' };
  const line = (p) => `<p class="settings-note" data-picks-budget="${esc(p.budget_source)}">${esc(MEMORY_WORDS.unified({ ...view.device, budget_source: p.budget_source }))}</p>`;
  const shown = view.advice.flatMap((a) => [a.pick ?? a.tight, a.alternative]).filter(Boolean);
  const sources = new Set(shown.map((p) => p.budget_source));
  if (sources.size > 1) return { once: '', row: (p) => line(p) };
  const said = view.total && sources.has(view.device.budget_source);
  return { once: shown.length && !said ? line(shown[0]) : '', row: () => '' };
}

export function taskPicks(view) {
  const budget = picksBudget(view);
  const rows = view.advice.map((a) => {
    const label = `<p class="settings-label">${esc(TASK_WORDS[a.task] ?? a.task)}</p>`;
    // A pick always Fits. With none, a tight option is shown, labelled Tight, never as the pick.
    const shown = a.pick ?? a.tight;
    if (shown) {
      const alt = a.alternative ? `<p class="settings-note">Smaller and faster: ${esc(pickWords(a.alternative))}, ${esc(FIT_WORDS[a.alternative.verdict].toLowerCase())}.</p>` : '';
      const est = shown.basis === 'tier-table' ? ' · <span class="dm-estimate">Estimate</span>' : '';
      const why = a.pick ? '' : `<p class="settings-note">${esc(a.words)}</p>`;
      return `<li class="settings-row dm-pick" data-task="${esc(a.task)}"${a.pick ? '' : ' data-tight-option'}><div class="settings-text">${label}${why}<p class="settings-note">${esc(pickWords(shown))}${est}</p>${budget.row(shown)}${alt}${a.alternative ? budget.row(a.alternative) : ''}</div><div class="settings-control">${verdictPill(shown.verdict)}<button type="button" class="btn quiet" data-action="models-plan" data-name="${esc(shown.name)}" data-quant="${esc(shown.quant)}" data-context="${shown.context}" aria-label="Plan it: ${esc(shown.name)} for ${esc((TASK_WORDS[a.task] ?? a.task).toLowerCase())}">Plan it</button></div></li>`;
    }
    const why = a.nothing_fits
      ? `Nothing here fits at ${ctxK(a.context)} context. ${a.nothing_fits.name} at ${a.nothing_fits.quant} fits up to ${ctxK(a.nothing_fits.max_context)}.${view.privacy === 'local-only' ? ' Under local only, the work waits for a device it fits.' : ''}`
      : a.words;
    return `<li class="settings-row dm-pick" data-task="${esc(a.task)}"><div class="settings-text">${label}<p class="settings-note">${esc(why)}</p></div>${a.nothing_fits ? `<div class="settings-control">${verdictPill('wont-fit')}</div>` : ''}</li>`;
  }).join('');
  const cloud = view.privacy === 'local-only' ? [] : [...new Map(view.advice.flatMap((a) => a.cloud).map((c) => [c.name, c])).values()];
  const cloudList = cloud.length ? `<h5 class="dm-sub-title">${view.privacy === 'local-preferred' ? 'After the local picks' : 'Beside the local picks'}</h5><ul class="settings-list" data-cloud>${cloud.map((c) => `<li class="settings-row"><div class="settings-text"><p class="settings-label">${esc(c.name)}</p><p class="settings-note">Runs off your devices; asked for each time, and recorded.</p></div></li>`).join('')}</ul>` : '';
  return `<section class="dm-picks" aria-labelledby="${view.id}-picks-title"><h4 class="section-title" id="${view.id}-picks-title">Recommended for this device</h4>
<p class="settings-note dm-privacy">${PRIVACY_PICKS[view.privacy] ?? ''}</p>${budget.once}<ul class="settings-list">${rows}</ul>${cloudList}</section>`;
}

// Install and assign, asked before anything downloads: what goes where, and what it serves. The
// downloads are tier-2 tasks that wait for this OK, as every model download does.
function installConfirm(view) {
  const c = view.confirm;
  return `<div class="dm-confirm" role="group" aria-labelledby="${view.id}-confirm-title" data-models-confirm><p class="settings-label" id="${view.id}-confirm-title">${esc(c.title)}</p>${c.lines.map((l) => `<p class="settings-note">${esc(l)}</p>`).join('')}
<div class="connection-actions"><button type="button" class="btn primary" data-action="models-confirm">${esc(c.ok)}</button><button type="button" class="btn quiet" data-action="models-not-now">Not now</button></div></div>`;
}

// Wake on demand (proposed, 2026-11-06; docs/plans/wol-inference-nodes-adr-2026-11-06.md): a compute
// device that sleeps says whether Nova can wake it, what a wake is doing now, why one failed and what
// Nova does instead, and its sleep policy. `device.wake`: {state: asleep | waking | awake | failed,
// pill, lines, waiting?: {text, since}, actions?: [{action, label}], policy: {idle, demand, notes}}.
const WAKE_PILL = { asleep: '', waking: '', awake: ' is-on', failed: ' is-warn' };
const SLEEP_IDLE = [['never', 'Never sleep'], ['15', 'Sleep after 15 minutes'], ['30', 'Sleep after 30 minutes'], ['60', 'Sleep after 1 hour'], ['120', 'Sleep after 2 hours']];
const SLEEP_DEMAND = [['wake', 'Nova wakes it'], ['wait', 'Wait until it’s turned on']];
function wakeStatus(view) {
  const w = view.device.wake;
  const wait = w.waiting ? waitingLine(w.waiting.text, { since: w.waiting.since }) : '';
  const acts = w.actions?.length ? `<div class="connection-actions">${w.actions.map((a) => `<button type="button" class="btn quiet" data-action="${esc(a.action)}">${esc(a.label)}</button>`).join('')}</div>` : '';
  return `<div class="dm-wake" data-wake="${esc(w.state)}"><p class="dm-seen"><span class="pill${WAKE_PILL[w.state] ?? ''}">${esc(w.pill)}</span>${view.device.seen ? ` ${esc(view.device.seen)}` : ''}</p>${wait}${w.lines.map((l) => `<p class="settings-note">${esc(l)}</p>`).join('')}${acts}</div>`;
}
function sleepPolicy(view) {
  const p = view.device.wake.policy;
  const id = `${view.id}-sleep`;
  const select = (key, label, value, options) => `<label class="dm-field" for="${id}-${key}"><span class="dm-field-label">${esc(label)}</span><select class="input" id="${id}-${key}" data-models-sleep="${key}">${options.map(([v, l]) => `<option value="${v}"${v === value ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
  return `<section class="dm-sleep" aria-labelledby="${id}-title"><h4 class="section-title" id="${id}-title">Sleep and wake</h4>
<div class="dm-controls">${select('idle', 'When it’s idle', p.idle, SLEEP_IDLE)}${select('demand', 'When work needs it', p.demand, SLEEP_DEMAND)}</div>${p.notes.map((n) => `<p class="settings-note">${esc(n)}</p>`).join('')}</section>`;
}

// The whole screen. `view`: { id, device: {name, path, hardware, memory, budget_bytes, budget_source, ram_bytes,
// overhead_source, overhead_loads, seen?, wake?}, plan: [{name, quant, quants, context, contexts, installed,
// loaded, estimate, result}], total (the plan's own fit result), catalog: [names], advice, privacy,
// crumb?, confirm?: {title, lines, ok}, status?, busy?, acked? }. `acked`: the person ticked that a
// tight plan leaves little headroom, for this plan. `device.seen` is said for a device that is
// asleep: how old what it shows is. `confirm` replaces the install button while it asks.
export function deviceModels(view) {
  const planned = view.plan.some((m) => !m.installed);
  const wont = view.total && view.total.verdict === 'wont-fit';
  // A tight plan (a model, or the set together: the set's verdict covers each) is installed only once
  // the person ticks that they understand, for this plan; Nova never picks one for them.
  const tight = view.total && view.total.verdict === 'tight';
  const ack = tight ? `<label class="confirm dm-ack" for="${view.id}-ack"><input type="checkbox" id="${view.id}-ack" data-models-ack${view.acked ? ' checked' : ''}> I understand ${view.plan.length > 1 ? 'this plan' : 'this model'} leaves little memory headroom, so replies may slow down sharply or fail under load.</label>` : '';
  const action = view.confirm ? installConfirm(view) : view.plan.length
    ? `${ack}<div class="connection-actions"><button type="button" class="btn primary" data-action="models-install"${wont || view.busy || (tight && !view.acked) ? ' disabled' : ''}${wont ? ' aria-describedby="' + view.id + '-why"' : ''}>${planned ? 'Install and assign' : 'Assign'}</button></div>${wont ? `<p class="settings-note" id="${view.id}-why">The plan doesn’t fit yet. Lower a quant or a context, or remove a model.</p>` : ''}`
    : '';
  const status = view.status ? `<p class="settings-note dm-status" role="status">${esc(view.status)}</p>` : '';
  const add = `<div class="dm-add"><label class="dm-field" for="${view.id}-add"><span class="dm-field-label">Add a model</span><select class="input" id="${view.id}-add">${view.catalog.map((n) => `<option>${esc(n)}</option>`).join('')}</select></label><button type="button" class="btn" data-action="models-add">Add to the plan</button></div>`;
  const crumb = view.crumb === undefined ? `Settings › Devices › ${view.device.name}` : view.crumb;
  const seen = view.device.wake ? wakeStatus(view) : view.device.seen ? `<p class="dm-seen" data-asleep><span class="pill">Asleep</span> ${esc(view.device.seen)}</p>` : '';
  return `<section class="panel device-models" aria-labelledby="${view.id}-title" data-device-models="${esc(view.id)}">
<header class="dm-head">${crumb ? `<p class="dm-crumb">${esc(crumb)}</p>` : ''}<h3 class="dm-title" id="${view.id}-title">Models</h3><p class="dm-device">${esc(view.device.hardware)}</p>${seen}</header>
${view.total ? memoryBudget(view) : ''}
<section class="dm-plan" aria-labelledby="${view.id}-plan-title"><h4 class="section-title" id="${view.id}-plan-title">Planned on this device</h4>
${view.plan.length ? `<ul class="dm-models">${view.plan.map((m, i) => modelPlanRow(view, m, i)).join('')}</ul>` : '<p class="settings-note">Nothing is planned here yet. Plan a pick below, or add a model.</p>'}
${view.plan.length > 1 ? together(view) : ''}${add}${action}${status}</section>
${taskPicks(view)}${view.device.wake ? sleepPolicy(view) : ''}</section>`;
}

export function settingsRow({ id = '', title, note = '', control = '' }) {
  return `<li class="settings-row"${id ? ` id="${esc(id)}"` : ''}><div class="settings-text"><p class="settings-label">${esc(title)}</p>${note ? `<p class="settings-note">${esc(note)}</p>` : ''}</div>${control ? `<div class="settings-control">${control}</div>` : ''}</li>`;
}

// ---- About Nova, the changelog, the pipeline and the version stamp ---------------------------------
// docs/builder-packet/nova-versioning-changelog-2026-11-03.md and its 2026-11-06 delta, built against
// the approved compositions (styleguide ui-about). Data in, HTML out: a build is GET /api/v1/version's,
// a release GET /api/v1/changelog's, a pipeline item GET /api/v1/pipeline's.

// An ISO time as Health's build stamp says it: "2026-11-06 21:02 UTC".
const utcWords = (iso) => `${String(iso).slice(0, 16).replace('T', ' ')} UTC`;
// Whether this build is the latest merged: 'current', 'pending' (a redeploy is waiting) or 'unknown'.
export const buildTone = (v) => (v?.behind === true ? 'pending' : v?.behind === false ? 'current' : 'unknown');

// The version stamp at the rail's foot (so also at the foot of a phone's navigation drawer): the
// version and the short commit (open rail), the short version, never a bare letter (slim rail; the
// owner found a lone "v" reading as a stray letter, 2026-11-10), amber with a dot when a redeploy is
// pending. A link to About. Nothing until the build is known.
export function versionStamp(v) {
  if (!v?.version) return '';
  const pending = buildTone(v) === 'pending';
  const words = `Nova ${v.version}${v.commit_short ? `, build ${v.commit_short}` : ''}${pending ? ', redeploy pending' : ''}`;
  return `<a class="rail-stamp" href="/about"${pending ? ' data-pending' : ''} title="${esc(words)}. About Nova"><span class="sr-only">${esc(words)}. About Nova</span><span class="rail-stamp-v" aria-hidden="true">${esc(String(v.version).split('-')[0])}</span>${pending ? '<span class="rail-stamp-dot" aria-hidden="true"></span>' : ''}<span class="rail-stamp-full" aria-hidden="true">${esc(v.version)}${v.commit_short ? ` <span class="rail-stamp-commit">${esc(v.commit_short)}</span>` : ''}${pending ? ' redeploy pending' : ''}</span></a>`;
}

const ABOUT_LINE = {
  current: 'This is the latest merged build.',
  pending: 'A newer merged build is waiting to be deployed. Until Nova restarts on it, you are using the older one shown here.',
  unknown: 'Nova can’t tell whether a newer merged build is waiting: the deploy step hasn’t told it which one is latest.',
};
const ABOUT_LINKS = [['/changelog', 'What’s new', 'Every change, newest first'], ['/pipeline', 'Where Nova stands', 'Merged, in progress and planned work'], ['/health', 'Health', 'What is working right now']];

// About Nova: the version, the running build against the latest merged one ("redeploy pending" when
// it is behind), when it was built (or, said as such, when it started), and the way on.
// `state`: 'ready' | 'loading' | 'failed'.
export function aboutCard({ build = null, state = 'ready' } = {}) {
  const links = `<ul class="about-links" aria-label="More about Nova">${ABOUT_LINKS.map(([href, name, line]) => `<li><a class="about-link" href="${href}"><span class="about-link-text"><span class="about-link-name">${name}</span><span class="about-link-line">${line}</span></span>${ICONS.chevron}</a></li>`).join('')}</ul>`;
  if (state === 'failed') return `<section class="card about-card" aria-labelledby="about-card-title" data-about-state="failed"><h3 class="card-title" id="about-card-title">Nova</h3><p class="about-state" data-tone="unknown" role="status"><span class="about-dot" aria-hidden="true"></span><span>Nova’s server didn’t answer, so this page can’t say which build is running.</span></p>${links}</section>`;
  if (state === 'loading' || !build) return `<section class="card about-card" aria-labelledby="about-card-title" data-waiting><h3 class="card-title" id="about-card-title">Nova</h3>${waitingLine('Asking Nova which build is running', { key: 'view-about' })}</section>`;
  const tone = buildTone(build);
  const when = build.built_at ? ['Built', utcWords(build.built_at)] : build.started_at ? ['Started', `${utcWords(build.started_at)}. No build date was given, so this is when Nova started.`] : null;
  const latest = build.latest ? `<span class="about-mono">${esc(build.latest.commit.slice(0, 8))}</span>, merged ${esc(utcWords(build.latest.merged_at))}` : 'Not known';
  const facts = [['Version', esc(build.version)], ['Running build', build.commit_short ? `<span class="about-mono">${esc(build.commit_short)}</span>` : 'Not known'], ...(when ? [[when[0], esc(when[1])]] : []), ['Latest merged', latest]];
  return `<section class="card about-card" aria-labelledby="about-card-title" data-about-state="${tone}">
<h3 class="card-title" id="about-card-title">Nova ${esc(build.version)}</h3>
<p class="about-state" data-tone="${tone}" role="status"><span class="about-dot" aria-hidden="true"></span><span>${esc(build.words)}</span></p>
<p class="about-line">${ABOUT_LINE[tone]}</p>
<dl class="about-facts">${facts.map(([k, v]) => `<div class="about-fact"><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>
${links}</section>`;
}

const DAY = new Intl.DateTimeFormat('en', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
const dayWords = (d) => { const t = Date.parse(`${d}T12:00:00Z`); return Number.isFinite(t) ? DAY.format(t) : String(d); };
const SECTION_WORDS = { Added: 'New', Changed: 'Changed', Removed: 'Removed', Fixed: 'Fixed', Security: 'Safer' };

// One changelog entry: a version (or, `waiting`, the changes merged but not yet in one), its date and
// its sections in plain words. `running`: the version this Nova is running.
export function changelogEntry({ version = '', date = '', sections = [], running = false, waiting = false } = {}) {
  const hid = `cl-${waiting ? 'waiting' : String(version).replace(/[^\w-]/g, '-')}`;
  const title = waiting ? 'Merged, not yet in a version' : `Nova ${esc(version)}`;
  const meta = waiting ? 'These come with the next version.' : `${esc(dayWords(date))}${running ? ' · the version you’re running' : ''}`;
  return `<section class="changelog-entry${running ? ' is-running' : ''}${waiting ? ' is-waiting' : ''}" aria-labelledby="${hid}"${waiting ? ' data-waiting-changes' : ` data-version="${esc(version)}"`}>
<header class="changelog-head"><h3 class="changelog-title" id="${hid}">${title}</h3><p class="changelog-meta">${meta}</p></header>
${sections.map((s) => `<h4 class="changelog-section">${esc(SECTION_WORDS[s.name] ?? s.name)}</h4><ul class="changelog-items">${s.items.map((it) => `<li>${esc(it)}</li>`).join('')}</ul>`).join('')}</section>`;
}

export const PIPELINE_STATES = { merged: 'Merged', progress: 'In progress', designed: 'Designed', none: 'Not started' };
const EVIDENCE_KIND = { gate: 'Gate evidence', ledger: 'Ledger entry', plan: 'Plan', roadmap: 'Roadmap' };

// One item on the pipeline dashboard: its name and state, and the evidence behind the state one tap
// away (a ledger entry's own plain words, or the gate, plan or roadmap section it stands on).
export function pipelineRow({ id = '', name, state, why = '', evidence = null }) {
  const s = PIPELINE_STATES[state] ? state : 'none';
  const parts = evidence ? [['What changed', evidence.changed], ['What you can now do', evidence.now], ['Still unfinished', evidence.unfinished]].filter(([, t]) => t) : [];
  const ev = evidence ? `<p class="pipeline-ev-src">${esc(EVIDENCE_KIND[evidence.kind] ?? 'Evidence')}${evidence.pull ? `, pull request ${esc(String(evidence.pull))}` : ''}${evidence.date ? `, ${esc(dayWords(evidence.date))}` : ''}: <span class="pipeline-ev-title">${esc(evidence.title)}</span> <span class="pipeline-ev-path">${esc(evidence.path)}</span></p>${parts.map(([k, t]) => `<p class="pipeline-ev-part"><span class="pipeline-ev-k">${k}:</span> ${esc(t)}</p>`).join('')}` : '<p class="pipeline-ev-src">No evidence on file.</p>';
  return `<li class="pipeline-row" data-p="${s}"${id ? ` data-item="${esc(id)}"` : ''}><details class="pipeline-item"><summary class="pipeline-sum"><span class="pipeline-mark" data-p="${s}" aria-hidden="true"></span><span class="pipeline-name">${esc(name)}</span><span class="pipeline-state" data-p="${s}">${PIPELINE_STATES[s]}</span></summary><div class="pipeline-ev">${why ? `<p class="pipeline-why">${esc(why)}</p>` : ''}${ev}</div></details></li>`;
}
