// One status vocabulary everywhere (DESIGN-SYSTEM §1): Quiet, Working, Waiting, Verified,
// Needs you, Failed, each with a fixed status colour from the tokens (components.css,
// .status[data-status]). Work Ledger states map
// onto it here and nowhere else; so do Era 2's activity states. The orb's state comes from
// the same real signals. Pure, so it is unit-tested.

export const STATUS = Object.freeze({
  quiet: { label: 'Quiet' },
  working: { label: 'Working' },
  waiting: { label: 'Waiting' },
  verified: { label: 'Verified' },
  'needs-you': { label: 'Needs you' },
  failed: { label: 'Failed' },
});

// A ledger task waits for the person's OK when it is tier 2 or 3, not yet approved, and waiting.
export const needsApproval = (t) => !!t && t.state === 'waiting' && Number(t.approval_tier) >= 2 && !t.approved_at;

// The single mapping from a Work Ledger task to the vocabulary.
//   queued                       → Waiting (its turn)
//   active, verifying            → Working
//   waiting for the person's OK  → Needs you
//   waiting, flagged for you     → Needs you (blocked or partly done, and Nova needs a hand)
//   waiting otherwise            → Waiting (local capacity, a lane, a retry)
//   done                         → Verified (done is reachable only through verification)
//   failed                       → Failed
//   cancelled                    → Quiet (nothing more will happen; the reason says why)
export function statusOf(task) {
  switch (task?.state) {
    case 'queued': return 'waiting';
    case 'active':
    case 'verifying': return 'working';
    case 'waiting': return needsApproval(task) || task.user_visibility === 'attention' ? 'needs-you' : 'waiting';
    case 'done': return task.verification && task.verification.ok === false ? 'failed' : 'verified';
    case 'failed': return 'failed';
    default: return 'quiet';
  }
}

// Era 2's activity entries (replies, scheduled runs, helpers). They carry no verification, so
// a finished one is Quiet, never Verified.
export function activityStatus(state) {
  switch (state) {
    case 'working': return 'working';
    case 'waiting': return 'needs-you';
    case 'queued': return 'waiting';
    case 'failed':
    case 'interrupted':
    case 'missed': return 'failed';
    default: return 'quiet';
  }
}

export const label = (status) => STATUS[status]?.label ?? STATUS.quiet.label;

// Live work for the "Nova is handling" surface: not finished, and not hidden by the person.
export const isOpen = (t) => ['queued', 'active', 'waiting', 'verifying'].includes(t?.state);

// The retry button says what it will ask for: running work again that needed the person's OK
// asks for it again (tier 2), or for their confirmation (tier 3).
export function retryLabel(t) {
  const tier = Number(t?.approval_tier ?? 1);
  if (tier >= 2 && Number(t?.attempts ?? 0) > 0) return tier === 3 ? 'Try again (you confirm first)' : 'Try again (asks for your OK)';
  return 'Try again';
}

// The orb's state, from real signals, most urgent first. The set is fixed (DESIGN-SYSTEM §1;
// owner decision 2026-10-31): a design system draws each state its own way, never a different set.
//   offline    the server isn't answering;
//   listening  the person is talking to Nova;
//   stopped    Nova is stopped (severity() below, ruling D5). Red, and only this is;
//   needs-you  something needs the person while Nova keeps running: an OK waiting, any other open
//              problem (a failed task, a Health item, capture running degraded), a check that
//              isn't fine. Amber;
//   speaking   a reply is arriving;
//   working    the ledger or a conversation is busy;
//   idle       nothing happening: breathing.
export function orbState({ reachable = true, listening = false, stopped = 0, needsYou = 0, speaking = false, working = 0 } = {}) {
  if (!reachable) return 'offline';
  if (listening) return 'listening';
  if (stopped > 0) return 'stopped';
  if (needsYou > 0) return 'needs-you';
  if (speaking) return 'speaking';
  if (working > 0) return 'working';
  return 'idle';
}

// Open problems, split by the rule above: those raised as stopping Nova, and the rest, which need
// the person while Nova keeps running. A problem says which it is (`stops`, set where it is raised).
export const stoppingProblems = (problems = []) => problems.filter((p) => !!p?.stops);
export const problemTone = (problems = []) => (stoppingProblems(problems).length ? 'alert' : problems.length ? 'attention' : null);

// How serious things are, worked out once for every surface (F-022; owner ruling D5): the status
// mark, the navigation badge, Home's first line and health card, and Health all read it, so they
// can't disagree.
//   stopped    Nova is stopped: a problem raised as stopping it (Nova held or not answering, a
//              dead-man's switch, a security refusal), or a failing check marked `stops` (a dead
//              database). Red, and nothing else is.
//   needs-you  something needs the person while Nova runs: an OK waiting, any other open problem
//              (a failed task, scheduled or not, is one: tasks are not a downed system), a check
//              that isn't fine. Amber.
//   unknown    the problems list couldn't be read (F-021): no claim either way, and never quiet.
//   quiet      none of these.
// `checks` is the health reading's checks, or null while there is none.
export function severity({ problems = [], known = true, checks = null, asking = 0 } = {}) {
  const stoppedProblems = stoppingProblems(problems).length;
  const failing = Object.entries(checks ?? {}).filter(([, c]) => c && c.ok === false);
  const stoppedChecks = failing.filter(([, c]) => c.stops).map(([k]) => k);
  const lookChecks = failing.filter(([, c]) => !c.stops).map(([k]) => k);
  const stopped = stoppedProblems + stoppedChecks.length;
  const needs = asking + (problems.length - stoppedProblems) + lookChecks.length;
  const level = stopped ? 'stopped' : needs ? 'needs-you' : !known ? 'unknown' : 'quiet';
  return { level, stopped, needs, asking, known, problems: problems.length, stoppedProblems, stoppedChecks, lookChecks };
}

// The Health badge from it, its words carrying the severity (F-075): never a bare count, and never
// absent when the problems list couldn't be read.
export function healthBadge(s) {
  const n = s.problems;
  const what = `${n} problem${n === 1 ? '' : 's'}`;
  if (s.level === 'stopped') return { tone: 'alert', label: s.stoppedProblems ? `${what}, Nova is stopped` : 'Nova is stopped', ...(n ? { count: n } : {}) };
  if (n) return { tone: 'attention', label: `${what}, ${n === 1 ? 'it needs' : 'they need'} you`, count: n };
  if (s.lookChecks.length) return { tone: 'attention', label: `${s.lookChecks.length === 1 ? 'A check needs' : `${s.lookChecks.length} checks need`} a look` };
  if (!s.known) return { tone: 'unknown', label: 'problems couldn’t be loaded' };
  return null;
}

export const ORB_STATES = Object.freeze(['idle', 'listening', 'working', 'speaking', 'needs-you', 'stopped', 'offline']);

// What the orb says to a screen reader.
export const ORB_WORDS = Object.freeze({
  idle: 'Nova is quiet',
  listening: 'Nova is listening',
  working: 'Nova is working',
  speaking: 'Nova is replying',
  'needs-you': 'Something needs you',
  stopped: 'Nova is stopped; see Health',
  offline: 'Nova isn’t reachable',
});

// The status icon (status-icon.js) draws the live state above in the app (owner, 2026-11-08: the
// rail, the header and task rows; never per message). It is the same state, drawn one step finer
// where the app knows more: working while the conversation in view is thinking (no words yet; the
// thread says "Thinking" then too) is drawn as thinking. Nothing else is added.
export function iconState(orb, { thinking = false } = {}) {
  return orb === 'working' && thinking ? 'thinking' : orb;
}
export const ICON_WORDS = Object.freeze({ ...ORB_WORDS, thinking: 'Nova is thinking' });

// A ledger task's own state, for its row's icon (statusOf above, then):
//   working                  → working
//   needs you                → needs-you
//   waiting (queued, a lane) → idle: Nova isn't on it yet; nothing in the ledger is paused
//   failed                   → needs-you: a failed task needs the person; it hasn't stopped
//                              Nova (ruling D5)
//   verified                 → success, shown only when the row saw the task finish (shell.js);
//                              it settles to idle by itself
//   cancelled                → none: nothing more will happen, and the row says why
export function taskIconState(task) {
  switch (statusOf(task)) {
    case 'working': return 'working';
    case 'needs-you': return 'needs-you';
    case 'waiting': return 'idle';
    case 'failed': return 'needs-you';
    case 'verified': return 'success';
    default: return null;
  }
}

// The greeting under the orb, by the hour.
export function greeting(date = new Date(), name = '') {
  const h = date.getHours();
  const part = h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  return name ? `${part}, ${name}` : part;
}

// The approval tier of an Era 2 tool step (NOVA-SPEC §6). Every one of these already asks first
// (tier 2). Deleting something, or a command that looks irreversible, is tier 3: an explicit
// confirm every time. The command check only ever adds friction; a command it misses still asks.
const IRREVERSIBLE = /(^|[\s;&|(])(rm|rmdir|shred|unlink|dd|mkfs(\.\w+)?|truncate|wipefs)\s|\bgit\s+(push\b[^\n]*(--force|-f\b|--delete|\s:)|reset\s+--hard|clean\s+-\w*f|branch\s+-D|checkout\s+--\s|restore\b)|\bfind\b[^\n]*\s-delete\b|>\s*\/dev\/sd|\bdrop\s+(table|database)\b|\bchmod\s+-R\b|\bchown\s+-R\b/i;
export function toolTier(name, args = {}) {
  if (name === 'schedule_remove') return 3;
  // A settings change that touches privacy or what asks first loosens a gate (config doors).
  if (name === 'settings_change' && args?.settings && typeof args.settings === 'object' && ('privacy' in args.settings || 'policy' in args.settings)) return 3;
  if (name === 'exec' && IRREVERSIBLE.test(` ${String(args?.command ?? '')}`)) return 3;
  return 2;
}
