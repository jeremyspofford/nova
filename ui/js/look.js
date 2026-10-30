// Settings › Appearance, the decisions behind it: what an Undo after Save must put back, and what
// the contrast panel says and offers. Pure, so it is unit-tested (tests/ui-review.test.js).
import { liveCheck } from './contrast.js';

// What Save changed, so Undo puts back exactly that and nothing else.
//   before: { mode, synced (the design every device shows by the person's choice, or the
//             default), device (this device's own design, or null) }
//   saved:  { id?, mode? } — what the person saved for all devices.
// Returns null when Save changed nothing, else { device, user, mode }:
//   device  this device had its own design and Save made it follow the synced one;
//   user    the synced design changed (rolling it back restores `synced`);
//   mode    the light-and-dark setting to put back, or null.
export function undoPlan(before, saved) {
  const plan = {
    device: !!saved.id && !!before.device,
    user: !!saved.id && saved.id !== before.synced,
    mode: saved.mode && saved.mode !== before.mode ? before.mode : null,
  };
  return plan.device || plan.user || plan.mode ? plan : null;
}

// What the contrast panel shows, from the colours on screen.
//   checks    the core's live checks (empty when they couldn't be loaded);
//   fix       this device's applied fix for the design it shows, or null;
//   fixable   the colours a fix can move until they pass; unfixable, those it can't;
//   pending   a design is only being tried (for all devices), not saved.
export function contrastView({ checks = [], get, fix = null, fixable = [], unfixable = [], pending = false }) {
  if (!checks.length) return { state: 'unknown', failures: [], offerFix: false, offerUndo: !!fix && !pending, cantFix: [], line: 'Nova couldn’t check the contrast just now. It will when it can reach the design’s details again.' };
  const c = liveCheck(get, checks);
  const applied = !!fix && Object.keys(fix).length > 0 && !pending;
  const failing = c.failures;
  const helps = failing.filter((f) => fixable.includes(f.fg) && !unfixable.includes(f.fg));
  const cantFix = [...new Set(failing.filter((f) => applied || !helps.includes(f)).map((f) => f.what))];
  return {
    state: c.ok ? 'ok' : 'fail',
    failures: failing,
    offerFix: !c.ok && !applied && !pending && helps.length > 0,
    offerUndo: applied,
    cantFix,
    line: c.ok
      ? `${applied ? 'With this device’s contrast fix, every' : 'Every'} text and control here passes the contrast check: 4.5:1 for text, 3:1 for outlines.`
      : 'Some of this design is hard to read.',
  };
}
