// A Health problem shaped like the owner's Duo cover screenshot (2026-11-08): a failed worker's
// playbook whose "What Nova did" holds the same event three times in a row, after one different
// event, and whose "What you can do" is a numbered list. The real server stays underneath; only
// GET /problems and the playbooks in GET /resilience are answered with this, in one browser
// context. Times sit before the fold gate's held clock (2026-10-31T12:00Z). Neutral placeholders.
import type { BrowserContext } from 'playwright-core';

export const HEALTH_PROBLEM_ID = 9001;
const at = (hm: string) => `2026-10-31T${hm}:00.000Z`;
const again = 'The chat model answers again. A failed task is yours to retry or cancel.';

export const healthProblem = {
  id: HEALTH_PROBLEM_ID, at: at('09:00'), source: 'tasks', message: 'A worker failed: the chat model stopped answering mid-task.',
  detail: 'worker: chat\nerror: the connection closed before the reply ended', task_id: null, stops: 0, resolved_at: null,
};

// provider-failed, as src/core/resilience/playbooks.ts defines it, with its repairs so far.
export const healthPlaybook = {
  id: 'provider-failed', title: 'A worker failed',
  repair: 'recheck-worker', automatic: 'Nova checks the worker again and, once it answers, runs the work again once, if nothing of it had happened yet.',
  steps: ['If the worker is a program on this computer, check it starts on its own.', 'Retry the task from Tasks, or cancel it.'],
  subject: 'chat',
  repairs: [
    { at: at('08:40'), name: 'recheck-worker', by: 'nova', ok: false, said: 'The chat model still isn’t answering.' },
    { at: at('08:50'), name: 'recheck-worker', by: 'nova', ok: true, said: again },
    { at: at('08:55'), name: 'recheck-worker', by: 'nova', ok: true, said: again },
    { at: at('09:00'), name: 'recheck-worker', by: 'person', ok: true, said: again },
  ],
};

// Every page in this context sees that one open problem, with its playbook.
export async function withHealthProblem(ctx: BrowserContext) {
  await ctx.route('**/api/v1/problems', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([healthProblem]) }));
  await ctx.route('**/api/v1/resilience', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, body: JSON.stringify({ ...body, playbooks: { [HEALTH_PROBLEM_ID]: healthPlaybook } }) });
  });
}
