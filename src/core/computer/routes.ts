// Nova Computer's part of /api/v1 (M10a): the workspaces and their state, and every change asked for
// as a Work Ledger task (followed and approved through /tasks). The console surface; no UI in M10a.
import type { Route } from '../api.ts';
import { IMAGE, IMAGE_ABOUT, REGISTRIES } from './policy.ts';
import type { NovaComputer } from './index.ts';

export function computerRoutes(c: NovaComputer): Route[] {
  return [
    {
      method: 'GET', path: '/computer', summary: 'Nova Computer: whether it can run here (Docker and its image, or why not), the image, what “registries” reaches, and the workspaces with their state.',
      handle: async () => ({ ...(await c.status()), image: IMAGE, about: IMAGE_ABOUT, registries: REGISTRIES, workspaces: c.list() }),
    },
    {
      method: 'POST', path: '/computer/workspaces', status: 201,
      summary: 'Make a workspace: a machine of Nova’s own with one project folder. No folder: a new empty one (tier 1). A folder of yours: asks first (tier 2). Egress other than none: asks every time (tier 3), and never while Nova is local-only. A folder is resolved once, and the task names its real path, device, inode and birth time: only that folder is ever used. Its .git is read-only inside unless git_writable (asks first). Returns the ledger task.',
      body: '{name, folder?, egress?: {mode: none | registries | hosts, hosts?}, git_writable?}',
      handle: ({ body }) => c.request('create', body),
    },
    { method: 'GET', path: '/computer/workspaces/{id}', summary: 'One workspace: its state, folder, egress, checkpoints and recent commands.', handle: ({ params }) => c.view(params.id!) },
    {
      method: 'POST', path: '/computer/workspaces/{id}/exec', status: 201,
      summary: 'Run a command (argv, never a shell string) as a ledger task; its output is kept as evidence and screened. access read: automatic, and checked to change nothing. write (the default): a checkpoint first, then it runs and can be undone (tier 1). In a workspace that may reach outside: asks every time (tier 3).',
      body: '{argv: string[], access?: read | write, timeout_s?}',
      handle: ({ params, body }) => c.request('exec', body, params.id!),
    },
    { method: 'POST', path: '/computer/workspaces/{id}/checkpoints', status: 201, summary: 'Checkpoint the workspace: its machine’s image and a copy of its folder.', body: '{label?}', handle: ({ params, body }) => c.request('checkpoint', body, params.id!) },
    {
      method: 'POST', path: '/computer/workspaces/{id}/reset', status: 201,
      summary: 'Reset the workspace to a checkpoint (its clean state by default): the machine made again from the image and the folder put back byte for byte. What it was is checkpointed first, so a reset can be undone.',
      body: '{checkpoint?}', handle: ({ params, body }) => c.request('reset', body, params.id!),
    },
    { method: 'POST', path: '/computer/workspaces/{id}/destroy', status: 201, summary: 'Delete the workspace, its machine and its checkpoints (tier 3). A folder of yours stays as it is.', handle: ({ params }) => c.request('destroy', {}, params.id!) },
    { method: 'GET', path: '/computer/runs/{task}', summary: 'A computer task’s record; for a command, the screen it passed and what it reached outside, and its raw output only if the ingest gate passed it (otherwise the gate’s extract).', handle: ({ params }) => c.run(params.task!) },
    { method: 'POST', path: '/computer/runs/{task}/undo', status: 201, summary: 'Undo a command: reset its workspace to the checkpoint taken just before it.', handle: ({ params }) => c.undo(params.task!) },
  ];
}
