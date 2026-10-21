// Folds a session's JSONL events into the view of the conversation.
// Shared by the server (snapshots) and the browser (live events), so both
// read the log the same way.
//
// The log is append-only. Regenerating a reply starts a new attempt for the
// same turn; the view shows the latest attempt, and the log keeps every one.

export function emptySession(id = null) {
  return { id, title: '', created: null, turns: [] };
}

export function applyEvent(s, ev) {
  switch (ev.type) {
    case 'session':
      s.id = ev.id;
      s.title = ev.title ?? '';
      s.created = ev.ts;
      break;
    case 'title':
      s.title = ev.title;
      break;
    case 'user':
      s.turns.push({ id: ev.turn, text: ev.text, ts: ev.ts, attempt: 0, items: [], state: 'open', endedAt: null });
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
    case 'assistant':
      t.items.push({ kind: 'text', id: ev.id, text: ev.text, ts: ev.ts });
      break;
    case 'tool_call':
      t.items.push({ kind: 'tool', id: ev.id, name: ev.name, args: ev.args, needsApproval: !!ev.needs_approval, approval: null, result: null, ts: ev.ts });
      break;
    case 'approval': {
      const tool = t.items.find((i) => i.kind === 'tool' && i.id === ev.id);
      if (tool) tool.approval = { decision: ev.decision, ts: ev.ts };
      break;
    }
    case 'tool_result': {
      const tool = t.items.find((i) => i.kind === 'tool' && i.id === ev.id);
      if (tool) tool.result = { ok: ev.ok, output: ev.output, summary: ev.summary };
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
