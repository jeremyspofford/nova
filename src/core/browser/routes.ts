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

export function browserRoutes(b: Browser, o: { home: string; holder: (w: Who) => Holder }): Route[] {
  return [
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
