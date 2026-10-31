// Nova's component inventory (DESIGN-SYSTEM §7): pure functions, data in, HTML out, so the app,
// the style reference and the appearance preview all draw the same components. Every visual
// value is a token (components.css); nothing here carries a colour, size or font.
import { escapeHtml as esc } from './markdown.js';
import { ORB_WORDS, STATUS, isOpen, label, needsApproval, statusOf } from './status.js';
import { qrSvg } from './qr.js';
import { waitingLine } from './wait.js';

// ---- icons: line drawings in currentColor -------------------------------------------------

const svg = (d, extra = '') => `<svg viewBox="0 0 24 24" aria-hidden="true" class="icon"${extra}><g fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${d}</g></svg>`;
export const ICONS = {
  home: svg('<path d="M4 11.5 12 5l8 6.5"/><path d="M6.5 10v9h11v-9"/>'),
  chat: svg('<path d="M5 6.5h14v9H10l-4 3v-3H5z"/>'),
  tasks: svg('<path d="M9 7h10M9 12h10M9 17h10"/><path d="m4.5 7 1 1 1.6-1.8M4.5 12l1 1 1.6-1.8M4.5 17l1 1 1.6-1.8"/>'),
  memory: svg('<path d="M12 5.5c-1.7-1.6-4.8-1.4-6 .8-1.3.2-2.2 1.7-1.6 3-1 1-1 2.8.3 3.6-.2 1.6 1 3 2.6 2.9.7 1.6 3 2 4.7.7"/><path d="M12 5.5c1.7-1.6 4.8-1.4 6 .8 1.3.2 2.2 1.7 1.6 3 1 1 1 2.8-.3 3.6.2 1.6-1 3-2.6 2.9-.7 1.6-3 2-4.7.7"/><path d="M12 5.5v13"/>'),
  automations: svg('<path d="M13 3.5 6 13.5h5.5l-1 7 7-10H12z"/>'),
  skills: svg('<path d="M12 4.5 13.6 9l4.4 1.5-4.4 1.6L12 16.5l-1.6-4.4L6 10.5 10.4 9z"/><path d="M18 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>'),
  activity: svg('<path d="M3.5 12h4l2.5-6 4 12 2.5-6h4"/>'),
  health: svg('<path d="M12 19s-7-4.3-7-9.3A3.7 3.7 0 0 1 12 7.6a3.7 3.7 0 0 1 7 2.1c0 5-7 9.3-7 9.3z"/>'),
  settings: svg('<circle cx="12" cy="12" r="3"/><path d="M12 3.5v2.2M12 18.3v2.2M3.5 12h2.2M18.3 12h2.2M6 6l1.6 1.6M16.4 16.4 18 18M6 18l1.6-1.6M16.4 7.6 18 6"/>'),
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
  return `<li class="task-row" data-status="${st}" data-task="${esc(t.id)}">
  <button type="button" class="task-open" data-action="open-task" data-task="${esc(t.id)}"><span class="task-title">${esc(clip(t.title, 80))}</span>${compact ? '' : `<span class="task-meta">${esc(clip(why, 90))}${why && when ? ' · ' : ''}${when ? `<time>${esc(when)}</time>` : ''}</span>`}</button>
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

export function deviceRow(d, { now = new Date(), actions = '' } = {}) {
  const current = d.current ?? d.this ?? false;
  const online = d.online ?? true;
  const detail = deviceDetail(d, now);
  const pill = d.trust === 'revoked' ? '<span class="pill">Revoked</span>' : `<span class="pill${online ? ' is-on' : ' is-warn'}">${online ? 'Online' : 'Offline'}</span>`;
  return `<li class="device-row"${d.id ? ` data-device="${esc(d.id)}"` : ''}>${ICONS.device}<div class="device-text"><p class="device-name">${esc(d.name)}${current ? ' <span class="device-tag">· this device</span>' : ''}</p>${detail ? `<p class="device-detail">${esc(detail)}</p>` : ''}</div>${pill}${actions ? `<span class="row-actions">${actions}</span>` : ''}</li>`;
}

// The trusted devices, at most three rows. "Only this device for now" only while that is true.
export function deviceMeshCard({ devices = [], now = new Date() } = {}) {
  const trusted = devices.filter((d) => d.trust !== 'revoked');
  const alone = trusted.length <= 1;
  const body = `<ul class="device-list">${trusted.slice(0, 3).map((d) => deviceRow(d, { now })).join('')}</ul>${trusted.length > 3 ? `<p class="card-line">and ${trusted.length - 3} more</p>` : ''}${alone ? '<p class="card-line is-faint">Only this device for now.</p>' : ''}`;
  return card({ kind: 'device-mesh-card', title: 'Devices', icon: 'device', body, action: '<a class="link" href="/settings#devices" data-nav="settings">Devices</a>' });
}

// What each kind of device may do once it is in, said before the person approves it.
export const KIND_ACCESS = {
  browser: 'It can use Nova as you do here, except approving new devices.',
  phone: 'It can use Nova as you do here, except approving new devices.',
  computer: 'It runs Nova’s device work: check-ins, and tasks and notes it queued while offline. It can’t read your conversations.',
  standby: 'It keeps a full copy of Nova, your data included, so it can take over if the hub fails.',
};

const digitsHtml = (d) => `<p class="digits" aria-label="${esc(String(d).split('').join(' '))}">${esc(`${String(d).slice(0, 3)} ${String(d).slice(3)}`)}</p>`;

// A device asking to join (tier 3): the digits to compare first, then who it is and what it may do.
export function joinRequestSheet(r) {
  const caps = r.capabilities?.length ? r.capabilities.join(', ') : 'Nothing beyond its kind.';
  return `<form class="approval-sheet" data-tier="3" data-request="${esc(r.id)}" method="dialog">
  <p class="sheet-kicker">${status('needs-you')}</p>
  <h2 class="sheet-title" id="sheet-title">Add “${esc(r.name)}”?</h2>
  <p class="sheet-line">A ${esc((KIND_WORDS[r.kind] ?? r.kind).toLowerCase())} is asking to join Nova. Approve it only if it shows these same six digits.</p>
  ${digitsHtml(r.confirmation)}
  <dl class="facts"><dt>Kind</dt><dd>${esc(KIND_WORDS[r.kind] ?? r.kind)}. ${esc(KIND_ACCESS[r.kind] ?? '')}</dd><dt>Platform</dt><dd>${esc(r.platform || 'Not said')}</dd><dt>Asks for</dt><dd>${esc(caps)}</dd><dt>Key</dt><dd class="fingerprint">${esc(r.fingerprint)}</dd><dt>Why it asks</dt><dd>${esc(TIER_WORDS[3])}</dd></dl>
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
export const CHECK_NAMES = { database: 'Database', workers: 'Workers', ledger: 'Work Ledger', extensions: 'Extensions', design: 'Design system', triggers: 'Automations', problems: 'Problems', memory: 'Memory', receipts: 'Context receipts', mesh: 'Devices', browser: 'Browser work', backups: 'Backups', changes: 'Changes', capture: 'Capture', vault: 'Vault', connectors: 'Connections', ingest: 'Outside content' };
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
export function healthCard({ health = null, problems = [], reachable = true } = {}) {
  let body;
  if (!reachable) body = '<p class="card-lead">Nova isn’t answering.</p><p class="card-line">This page reconnects when it’s back.</p>';
  else if (!health) body = waitingLine('Checking Nova’s health', { key: 'health' });
  else {
    const bad = Object.entries(health.checks ?? {}).filter(([, c]) => c && c.ok === false);
    const lead = problems.length ? `${problems.length} problem${problems.length === 1 ? '' : 's'} to look at` : bad.length ? 'Something isn’t right' : 'All systems normal';
    const lines = problems.length ? [problemsSummary(problems), 'What happened, and what you can do, is in Health.']
      : bad.length ? [`Needs a look: ${listWords(bad.map(([k]) => CHECK_NAMES[k] ?? 'another check'))}.`, 'The detail is in Health.']
        : [`Database, ledger and ${health.checks?.workers?.workers?.length ?? 0} workers are fine.`];
    body = `<p class="card-lead" data-status="${problems.length || bad.length ? 'failed' : 'verified'}">${esc(lead)}</p>${lines.map((l) => `<p class="card-line">${esc(l)}</p>`).join('')}`;
  }
  return card({ kind: 'health-card', title: 'System health', icon: 'health', body, action: '<a class="link" href="/health" data-nav="health">Health</a>' });
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
const PRIVACY_WORDS = { 'local-only': 'Nothing leaves this machine.', 'local-preferred': 'Local first; cloud help only if needed, and recorded.', 'cloud-allowed': 'Nova may use cloud services for this.' };

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

export function approvalSheet(t, { worker = null, run = null } = {}) {
  const tier = Number(t.approval_tier) >= 3 ? 3 : 2;
  const EGRESS = { none: 'stays on this machine', local: 'stays on your devices', remote: 'reaches the internet' };
  const where = worker ? `${esc(worker.name ?? worker.id)}${EGRESS[worker.egress] ? ` · ${EGRESS[worker.egress]}` : ''}` : esc(t.owner);
  if (run) return testRunSheet(t, run, where);
  return `<form class="approval-sheet" data-tier="${tier}" data-task="${esc(t.id)}" method="dialog">
  <p class="sheet-kicker">${status('needs-you')}</p>
  <h2 class="sheet-title" id="sheet-title">${esc(t.title)}</h2>
  <p class="sheet-line">${esc(t.brief?.goal ?? '')}</p>
  <dl class="facts"><dt>Who does it</dt><dd>${where}</dd><dt>Privacy</dt><dd>${esc(PRIVACY_WORDS[t.privacy_mode] ?? t.privacy_mode ?? '')}</dd><dt>Why it asks</dt><dd>${esc(TIER_WORDS[tier])}</dd></dl>
  ${tier === 3 ? '<label class="confirm"><input type="checkbox" name="confirm" required> I understand, and I want Nova to do this.</label>' : ''}
  <div class="sheet-actions">
    <button type="submit" class="btn primary" data-action="approve" value="approve"${tier === 3 ? ' disabled' : ''}>${tier === 3 ? 'Confirm' : 'Approve'}</button>
    <button type="button" class="btn" data-action="cancel-task">Cancel the task</button>
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

export function settingsRow({ id = '', title, note = '', control = '' }) {
  return `<li class="settings-row"${id ? ` id="${esc(id)}"` : ''}><div class="settings-text"><p class="settings-label">${esc(title)}</p>${note ? `<p class="settings-note">${esc(note)}</p>` : ''}</div>${control ? `<div class="settings-control">${control}</div>` : ''}</li>`;
}
