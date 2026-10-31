// The browser's part of /api/v1 (M5 plan §3). Anyone the person uses can watch a browser task;
// only the hub's own screen and devices allowed to approve can take it over, drive it and hand it
// back (mesh/access.ts: the `approver` scope).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CoreError } from '../errors.ts';
import { Raw, type Route, type Who } from '../api.ts';
import { SCREENSHOT, taskDir } from './evidence.ts';
import type { Browser } from './worker.ts';
import type { Holder } from './session.ts';

export function browserRoutes(b: Browser, o: { home: string; holder: (w: Who) => Holder; stop: (id: string, why: string) => unknown }): Route[] {
  return [
    // ---- Nova Browser (M10b) ----
    {
      method: 'POST', path: '/browser/tasks/{id}/pause', access: 'approver', summary: 'Pause the browser: the worker stops at its next step and waits, with nobody driving. Records paused with who.',
      handle: ({ params, who }) => b.pause(params.id!, o.holder(who)),
    },
    {
      method: 'POST', path: '/browser/tasks/{id}/resume', access: 'approver', summary: 'Let a paused browser carry on. Records resumed with who and how long.',
      handle: ({ params, who }) => b.resume(params.id!, o.holder(who)),
    },
    {
      method: 'POST', path: '/browser/tasks/{id}/stop', access: 'approver', summary: 'Stop a browser task now: it is cancelled and its browser closes.',
      handle: ({ params, who }) => o.stop(params.id!, `Stopped by ${o.holder(who).label}.`),
    },
    {
      method: 'GET', path: '/browser/sites', summary: 'The sites Nova’s own browser keeps something for: a saved sign-in, or cookies and storage in its profile. Never a value.',
      handle: () => ({ sites: b.sites(), kept: 'Sign-ins are kept per site between tasks, and each can be forgotten here (the owner’s open question 3 has the proposed default).' }),
    },
    {
      method: 'PUT', path: '/browser/logins/{host}', access: 'approver', summary: 'Save a sign-in for a site (host or host:port), in the vault. Nova types it only into a page on that host, at the moment of use; it is never shown again, never in chat.',
      body: '{username, password}', handle: ({ params, body }) => b.saveLogin(params.host!, body),
    },
    {
      method: 'DELETE', path: '/browser/logins/{host}', access: 'approver', summary: 'Delete a saved sign-in (tier 3: needs {confirm: true}, every time).',
      body: '{confirm: true}', handle: ({ params, body }) => b.deleteLogin(params.host!, body?.confirm === true),
    },
    {
      method: 'POST', path: '/browser/logins/{host}/pending', access: 'approver', summary: 'A new password an account step sent but couldn’t see take (M10d): keep: true makes it the site’s password, keep: false drops it (tier 3: needs {confirm: true}, every time). Never shown.',
      body: '{keep, confirm: true}', handle: ({ params, body }) => b.settlePending(params.host!, body ?? {}),
    },
    {
      method: 'POST', path: '/browser/accounts', status: 201, summary: 'An account change in Nova’s browser (M10d): change a password, create an account, or change two-step sign-in, as a step plan on one site. Tier 3, every time, and it runs only while you’re there; Nova types saved sign-ins and the new password it makes itself, and you type any code. A plan never holds a password.',
      body: '{change: password | create | mfa, site, steps, verify: {url, expect}, allowed_hosts?, title?}', handle: ({ body }) => b.account(body ?? {}),
    },
    {
      method: 'POST', path: '/browser/sites/{host}/forget', access: 'approver', summary: 'Forget a site: its cookies and storage leave Nova’s browser profile, and with login: true its saved sign-in too (tier 3: needs {confirm: true}, every time).',
      body: '{confirm: true, login?}', handle: ({ params, body }) => b.forgetSite(params.host!, body ?? {}),
    },
    { method: 'GET', path: '/browser/flows', summary: 'The site templates Nova learnt from flows that succeeded: id, version, state, how many steps and uses.', handle: () => ({ flows: b.flows() }) },
    {
      method: 'GET', path: '/browser', summary: 'Whether browser work is available (which Chromium, or why there is none), and the browser tasks running now.',
      handle: () => {
        const f = b.chromium();
        return { chromium: { available: !!f.path, path: f.path, detail: f.detail }, sessions: b.list() };
      },
    },
    { method: 'GET', path: '/browser/tasks/{id}', summary: 'A browser task’s live state: its step, page, who has taken over, and what it refused. {live: false} once its browser is closed.', handle: ({ params }) => b.view(params.id!) },
    {
      method: 'GET', path: '/browser/tasks/{id}/frames', summary: 'The browser’s live picture as server-sent events: `state` (as GET /browser/tasks/{id}), then `frame` ({seq, jpeg (base64), width, height}). Never cached.',
      handle: ({ params }) => b.frames(params.id!),
    },
    {
      method: 'POST', path: '/browser/tasks/{id}/takeover', access: 'approver', summary: 'Take the browser over: the worker stops and waits until you hand back. Records takeover_started with who.',
      handle: ({ params, who }) => b.takeOver(params.id!, o.holder(who)),
    },
    {
      method: 'POST', path: '/browser/tasks/{id}/input', access: 'approver', summary: 'Your pointer or keys, while you hold the browser. x and y are fractions (0 to 1) of the picture.',
      body: '{type: click | move | scroll | text | key, x?, y?, dx?, dy?, text?, key?}',
      handle: ({ params, body, who }) => b.input(params.id!, o.holder(who), body),
    },
    {
      method: 'POST', path: '/browser/tasks/{id}/handback', access: 'approver', summary: 'Hand the browser back: the worker carries on from the page as you left it. Records takeover_ended with who and how long.',
      handle: ({ params, who }) => b.handBack(params.id!, o.holder(who)),
    },
    {
      method: 'GET', path: '/browser/tasks/{id}/screenshot', summary: 'The screenshot Nova took at the end of a browser task (its evidence), as PNG.',
      handle: ({ params }) => {
        try {
          return new Raw('image/png', readFileSync(join(taskDir(o.home, params.id!), SCREENSHOT)));
        } catch {
          throw new CoreError('not_found', 'This task has no screenshot.');
        }
      },
    },
  ];
}
