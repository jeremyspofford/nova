// /api/v1/capture: consent, sources, settings, the events and what to do with them (M6 plan §1).
// Every route is the person's (the default scope): a paired phone or computer reaches them only as
// the person would. Device agents send capture through the inbox instead (mesh/spokes.ts).
import { CoreError } from '../errors.ts';
import type { Route, Who } from '../api.ts';
import { KINDS, POSTURE, type Capture, type Kind } from './capture.ts';

// Who did it, as consent, forgetting and promotion record it: a paired device by its id, the hub's
// own screen as "console".
const by = (w: Who) => (w.principal.kind === 'device' ? `device:${w.principal.device.id}` : w.principal.kind);

export function captureRoutes(capture: Capture): Route[] {
  const kind = (v: string | null): Kind | undefined => {
    if (v === null) return undefined;
    if (!(KINDS as readonly string[]).includes(v)) throw new CoreError('validation', `kind is one of ${KINDS.join(', ')}.`);
    return v as Kind;
  };
  const routes: Route[] = [
    {
      method: 'GET', path: '/capture', summary: 'Capture at a glance: whether anything is capturing, every source with its consent, the settings, and what each platform can capture.',
      handle: () => ({ status: capture.status(), sources: capture.sources(), settings: capture.settings(), posture: POSTURE }),
    },
    { method: 'GET', path: '/capture/status', summary: 'Whether any source is capturing right now (the indicator every page shows), and what needs the person.', handle: () => capture.status() },
    {
      method: 'GET', path: '/capture/events', summary: 'Captured events, newest first. ?unclassified=1, ?space=, ?kind=, ?device=, ?before=<time>, ?limit=.',
      handle: ({ query }) => capture.events({
        ...(query.get('device') ? { device: query.get('device')! } : {}),
        ...(query.get('kind') ? { kind: kind(query.get('kind'))! } : {}),
        ...(query.get('space') ? { space: query.get('space')! } : {}),
        ...(query.get('unclassified') === '1' ? { unclassified: true } : {}),
        ...(query.get('before') ? { before: query.get('before')! } : {}),
        ...(query.get('limit') ? { limit: Number(query.get('limit')) } : {}),
      }),
    },
    { method: 'GET', path: '/capture/events/{id}', summary: 'One captured event, with its consent and provenance.', handle: ({ params }) => capture.event(params.id!) },
    {
      method: 'POST', path: '/capture/events/{id}/space', summary: 'Say which space an event belongs to. remember: "app" also keeps that app as a signal for the space.', body: '{space, remember?: "app"}',
      handle: ({ params, body }) => capture.resolve(params.id!, body),
    },
    {
      method: 'DELETE', path: '/capture/events/{id}', summary: 'Forget a captured event for real: here, in backups and on the standby. A memory made from it is forgotten too unless ?keep_memory=1.',
      handle: ({ params, query, who }) => capture.forget([params.id!], by(who), { keep_memory: query.get('keep_memory') === '1' }),
    },
    {
      method: 'POST', path: '/capture/forget', summary: 'Forget several captured events at once (see DELETE /capture/events/{id}).', body: '{ids, keep_memory?}',
      handle: ({ body, who }) => capture.forget(body.ids as string[], by(who), { keep_memory: body.keep_memory === true }),
    },
    {
      method: 'POST', path: '/capture/promote', status: 201, summary: 'Make a memory from captured events, deliberately. Its provenance points back to them.', body: '{event_ids, content?, kind?, scope?}',
      handle: ({ body, who }) => capture.promote(body, by(who)),
    },
    { method: 'GET', path: '/capture/memory/{id}', summary: 'Where a memory came from in capture: the events it was promoted from, by whom and when, and whether each is still kept.', handle: ({ params }) => capture.promotions(params.id!) },
    { method: 'GET', path: '/capture/proposals', summary: 'What a triage decision proposed keeping as memory. Nothing becomes memory until the person accepts.', handle: () => capture.proposals() },
    { method: 'POST', path: '/capture/propose', summary: 'Triage the events not yet looked at now (it also happens on its own).', handle: () => capture.propose() },
    {
      method: 'POST', path: '/capture/proposals/{id}/accept', status: 201, summary: 'Accept a proposal: it becomes a memory, with provenance back to the event and the proposal.', body: '{content?, scope?}',
      handle: ({ params, body, who }) => capture.accept(params.id!, body, by(who)),
    },
    { method: 'POST', path: '/capture/proposals/{id}/dismiss', summary: 'Dismiss a proposal. The event stays as evidence.', handle: ({ params }) => capture.dismiss(params.id!) },
    {
      method: 'POST', path: '/capture/sources/screenpipe', status: 201, summary: 'Add a Screenpipe on this machine (or another of your devices) to take capture from. It stays off until you turn it on.', body: '{url?, name?}',
      handle: ({ body }) => capture.addScreenpipe(body),
    },
    { method: 'PATCH', path: '/capture/sources/{id}', summary: 'Change a Screenpipe source’s address, or how far back each pull asks again for items it reports late (lookback_minutes, 1 to 240; 5 by default).', body: '{url?, lookback_minutes?}', handle: ({ params, body }) => capture.configure(params.id!, body) },
    {
      method: 'POST', path: '/capture/sources/{id}/enable', summary: 'Consent: turn a source on. It captures from now; since asks for what it kept from an earlier time too. Refused under local-only for an address outside your devices.', body: '{since?}',
      handle: ({ params, body, who }) => capture.enable(params.id!, { by: by(who), since: body.since }),
    },
    { method: 'POST', path: '/capture/sources/{id}/disable', summary: 'Withdraw consent: turn a source off. What it captured stays until retention or a forget.', handle: ({ params }) => capture.disable(params.id!) },
    { method: 'POST', path: '/capture/sources/{id}/pause', summary: 'Pause a source. Nothing from the paused stretch is ever taken in.', handle: ({ params }) => capture.pause(params.id!) },
    { method: 'POST', path: '/capture/sources/{id}/resume', summary: 'Resume a paused source, from now.', handle: ({ params }) => capture.resume(params.id!) },
    { method: 'POST', path: '/capture/sources/{id}/pull', summary: 'Pull a Screenpipe source now.', handle: ({ params }) => capture.pull(params.id!) },
    { method: 'POST', path: '/capture/pause', summary: 'Pause (paused: true) or resume (false) every source at once.', body: '{paused}', handle: ({ body }) => capture.pauseAll(body.paused !== false) },
    {
      method: 'PUT', path: '/capture/settings', summary: 'Capture settings, each checked: retention_days, exclusions (app, site, space, time), signals (app, device, calendar), the explicit switch, spaces.',
      body: '{retention_days?, exclusions?, signals?, switch?, spaces?}', handle: ({ body }) => capture.setSettings(body),
    },
    { method: 'POST', path: '/capture/sweep', summary: 'Apply the retention policy now (it also runs on its own).', handle: () => capture.sweep() },
  ];
  // Tests and the M6 gate move capture's clock through the API; this route doesn't exist otherwise.
  if (process.env.NOVA_TEST_CLOCK === '1') {
    routes.push({
      method: 'POST', path: '/capture/tick', summary: 'Test only: one pass of capture (pull, retention, triage) as if it were the given time, which capture keeps as now.', body: '{now?}',
      handle: async ({ body }) => {
        const at = body.now === undefined ? undefined : new Date(String(body.now));
        if (at && Number.isNaN(at.getTime())) throw new CoreError('validation', 'now must be an ISO time.');
        return capture.tick(at);
      },
    });
  }
  return routes;
}
