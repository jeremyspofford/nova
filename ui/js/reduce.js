// Folds a session's JSONL events into the view of the conversation.
// Shared by the server (snapshots) and the browser (live events), so both
// read the log the same way.
//
// The log is append-only. Regenerating a reply starts a new attempt for the
// same turn; the view shows the latest attempt, and the log keeps every one.

export function emptySession(id = null) {
  return { id, title: '', created: null, kind: null, turns: [] };
}

export function applyEvent(s, ev) {
  switch (ev.type) {
    case 'session':
      // kind: "main", "run" (a schedule's work) or "helper"; a person's
      // conversations have none. Helpers know which conversation asked.
      s.id = ev.id;
      s.title = ev.title ?? '';
      s.created = ev.ts;
      s.kind = ev.kind ?? null;
      if (ev.parent) s.parent = ev.parent;
      if (ev.schedule) s.schedule = ev.schedule;
      break;
    case 'delivered':
      s.delivered = { to: ev.to, handoff: ev.handoff };
      break;
    case 'title':
      s.title = ev.title;
      break;
    case 'user':
      s.turns.push({ id: ev.turn, text: ev.text, ts: ev.ts, attempt: 0, items: [], state: 'open', endedAt: null, ...(ev.followup ? { followup: ev.followup } : {}) });
      break;
    case 'handoff':
      // A report from scheduled work: an entry of its own, between replies.
      s.turns.push({
        id: ev.id, kind: 'handoff', name: ev.name, schedule: ev.schedule, helper: ev.helper, stopped: !!ev.stopped, run: ev.run, text: ev.text, ok: ev.ok !== false,
        late: !!ev.late, manual: !!ev.manual, due: ev.due, ts: ev.ts, attempt: 0, items: [], state: 'done', endedAt: ev.ts,
      });
      break;
    case 'attempt': {
      const t = turn(s, ev.turn);
      if (t) Object.assign(t, { attempt: ev.attempt, items: [], state: 'open', endedAt: null });
      break;
    }
    default: {
      const t = turn(s, ev.turn);
      if (!t || ev.attempt !== t.attempt) break; // a superseded attempt
      applyTurnEvent(t, ev);
    }
  }
  return s;
}

function applyTurnEvent(t, ev) {
  switch (ev.type) {
    case 'recall':
      t.items.push({ kind: 'recall', notes: ev.notes });
      break;
    case 'memory':
      t.items.push({ kind: 'memory', ops: ev.ops ?? [] });
      break;
    case 'skill':
      t.items.push({ kind: 'skill', id: ev.skill, name: ev.name, how: ev.how });
      break;
    case 'assistant':
      t.items.push({ kind: 'text', id: ev.id, text: ev.text, ts: ev.ts });
      break;
    case 'tool_call':
      t.items.push({ kind: 'tool', id: ev.id, name: ev.name, args: ev.args, needsApproval: !!ev.needs_approval, preview: ev.preview ?? null, approval: null, result: null, ts: ev.ts });
      break;
    case 'approval': {
      const tool = t.items.find((i) => i.kind === 'tool' && i.id === ev.id);
      if (tool) tool.approval = { decision: ev.decision, ts: ev.ts, ...(ev.auto ? { auto: true } : {}) };
      break;
    }
    case 'tool_result': {
      const tool = t.items.find((i) => i.kind === 'tool' && i.id === ev.id);
      if (tool) tool.result = { ok: ev.ok, output: ev.output, summary: ev.summary, link: ev.link, ts: ev.ts };
      break;
    }
    case 'error':
      t.items.push({ kind: 'error', message: ev.message, detail: ev.detail ?? '' });
      t.state = 'error';
      t.endedAt = ev.ts;
      break;
    case 'stopped':
      t.state = 'stopped';
      t.endedAt = ev.ts;
      break;
    case 'done':
      t.state = 'done';
      t.endedAt = ev.ts;
      break;
  }
}

const turn = (s, id) => s.turns.find((t) => t.id === id);

export function reduce(events, id = null) {
  const s = emptySession(id);
  for (const ev of events) applyEvent(s, ev);
  return s;
}

// A short, readable title from the first message: no model call needed.
export function titleFrom(text, max = 60) {
  const one = String(text).replace(/\s+/g, ' ').trim();
  if (one.length <= max) return one;
  const cut = one.slice(0, max);
  const at = cut.lastIndexOf(' ');
  return `${(at > max * 0.5 ? cut.slice(0, at) : cut).replace(/[\s,.;:!?-]+$/, '')}…`;
}
