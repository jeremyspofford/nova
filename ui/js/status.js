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

// The orb's state, from real signals, most urgent first:
//   offline   the server isn't answering;
//   listening the person is talking to Nova;
//   alert     an open problem (red only for real alerts);
//   attention something waits for the person's OK;
//   speaking  a reply is arriving;
//   working   the ledger or a conversation is busy;
//   idle      nothing happening: breathing.
export function orbState({ reachable = true, listening = false, problems = 0, needsYou = 0, speaking = false, working = 0 } = {}) {
  if (!reachable) return 'offline';
  if (listening) return 'listening';
  if (problems > 0) return 'alert';
  if (needsYou > 0) return 'attention';
  if (speaking) return 'speaking';
  if (working > 0) return 'working';
  return 'idle';
}

export const ORB_STATES = Object.freeze(['idle', 'listening', 'working', 'speaking', 'attention', 'alert', 'offline']);

// What the orb says to a screen reader.
export const ORB_WORDS = Object.freeze({
  idle: 'Nova is quiet',
  listening: 'Nova is listening',
  working: 'Nova is working',
  speaking: 'Nova is replying',
  attention: 'Something needs you',
  alert: 'Something went wrong; see Health',
  offline: 'Nova isn’t reachable',
});

// The greeting under the orb, by the hour.
export function greeting(date = new Date(), name = '') {
  const h = date.getHours();
  const part = h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  return name ? `${part}, ${name}` : part;
}
