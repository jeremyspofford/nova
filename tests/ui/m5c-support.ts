// Browser work with takeover (M5c), shared by its tests and the M5 gate: the local form site, the
// plans that fill it, and the calls that delegate a browser task and take it over. Nova's own
// browser worker runs inside the server process with the same Chromium the tests use.
import { startFormSite } from '../../scripts/form-site.js';
import { sleep } from '../acceptance/support.ts';
import { blank, chromiumPath } from './support.ts';

export type Site = Awaited<ReturnType<typeof startFormSite>>;
export { startFormSite };

// The server's environment for browser work: this Chromium, without its own sandbox (the
// container has no user namespaces for it), and the test clock untouched.
export const browserEnv = () => ({ NOVA_CHROMIUM: chromiumPath(), NOVA_CHROMIUM_SANDBOX: '0' });

export interface PlanOptions { person?: boolean; delay?: number; name?: string; email?: string }

// The sign-up form, start to finish. With `person`, the step the site says a person must do is
// marked for a person; the worker asks for a takeover there.
export function formPlan(site: Site, o: PlanOptions = {}) {
  const name = o.name ?? 'Ada Example';
  const email = o.email ?? 'ada@example.test';
  const person = o.person ?? true;
  const q = new URLSearchParams({ ...(person ? {} : { person: '0' }), ...(o.delay ? { delay: String(o.delay) } : {}) }).toString();
  return {
    allowed_hosts: [site.host],
    steps: [
      { do: 'navigate', url: `${site.url}/start${q ? `?${q}` : ''}` },
      { do: 'fill', selector: '#name', value: name },
      { do: 'fill', selector: '#email', value: email },
      { do: 'click', selector: '#next' },
      ...(person ? [{ do: 'person', why: 'Type the code shown in the picture, then press Confirm.', done_when: '#plan' }] : []),
      { do: 'select', selector: '#plan', value: 'plus' },
      { do: 'fill', selector: '#note', value: 'Mornings are best.' },
      { do: 'click', selector: '#review' },
      { do: 'click', selector: '#submit' },
      { do: 'read', selector: '#status', expect: 'Received' },
    ],
    // A plan that sends something is proven by a page it names, fetched by Nova itself: the
    // site's own list of what it received.
    verify: { url: `${site.url}/records`, expect: [name, email] },
  };
}

export function browserTask(plan: unknown, title = 'Sign up on the example site') {
  return {
    title, owner: 'browser', goal: 'Fill in the example sign-up form and send it.',
    evidence_required: [{ kind: 'screenshot' }, { kind: 'url' }], inputs: plan,
  };
}

type M = ReturnType<typeof blank>;

// Delegates a browser task and gives the OK a form plan asks for (tier 2), as the person would.
export async function delegate(m: M, plan: unknown, title?: string) {
  const r = await m.send('POST', '/api/v1/tasks', browserTask(plan, title));
  if (r.status === 201 && r.body.state === 'waiting' && r.body.approval_tier >= 2 && !r.body.approved_at) {
    const ok = await m.send('POST', `/api/v1/tasks/${r.body.id}/approve`, r.body.approval_tier === 3 ? { confirm: true } : {});
    if (ok.status !== 200) throw new Error(`approve: ${JSON.stringify(ok.body)}`);
  }
  return r;
}
type Task = { id: string; state: string; reason: string | null; verification: { ok: boolean; checks: { ok: boolean; why: string; requirement: { kind: string } }[] } | null; report: any };

export async function waitTask(m: M, id: string, done: (t: Task) => boolean, ms = 60_000): Promise<Task> {
  const until = Date.now() + ms;
  let t: Task = await m.get(`/api/v1/tasks/${id}`);
  while (!done(t) && Date.now() < until) {
    await sleep(100);
    t = await m.get(`/api/v1/tasks/${id}`);
  }
  return t;
}

export const settled = (t: Task) => ['done', 'failed', 'cancelled'].includes(t.state);
export const events = (m: M, id: string) => m.get(`/api/v1/tasks/${id}/events`) as Promise<{ kind: string; to_state: string | null; detail: any }[]>;
