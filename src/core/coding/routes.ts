// Coding through chat's part of /api/v1 (M10c): coding runs, started here or by the chat agent's
// code_change tool, and followed and approved through /tasks like every other task.
import type { Route } from '../api.ts';
import type { Coding } from './index.ts';

export function codingRoutes(c: Coding): Route[] {
  return [
    { method: 'GET', path: '/coding', summary: 'Coding runs, newest first: each one’s state, its repository and branch, and its steps (write, check, merge) as ledger tasks.', handle: () => ({ runs: c.list() }) },
    {
      method: 'POST', path: '/coding', status: 201,
      summary: 'Start a coding run: a coding agent writes the change in a git worktree of Nova’s own (tier 1, undone by discard); Nova runs test_command and preview_command on it after your OK (tier 2: it runs the agent’s code, as you); then it asks every time before it merges into your branch (tier 3). Nothing is written to your repository before the merge, and nothing is pushed. Returns the run and its first task.',
      body: '{repo, goal, test_command, branch?, preview_command?, agent?, editable?, privacy_mode?, title?}',
      handle: ({ body }) => c.start(body),
    },
    { method: 'GET', path: '/coding/runs/{id}', summary: 'One coding run: its steps and tasks, the reviewed diff, Nova’s test record and the preview.', handle: ({ params }) => c.view(params.id!) },
    { method: 'POST', path: '/coding/runs/{id}/decline', summary: 'Don’t merge: the merge task is cancelled, and your branch stays as it is. The preview stops and Nova removes its worktree.', handle: ({ params }) => c.decline(params.id!) },
    { method: 'POST', path: '/coding/runs/{id}/discard', summary: 'Undo the change (tier 1): Nova removes its worktree and its branch, and cancels the run’s open steps. Not after a merge.', handle: ({ params }) => c.discard(params.id!) },
  ];
}
