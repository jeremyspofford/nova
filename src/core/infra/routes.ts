// Infrastructure's part of /api/v1 (M10d): projects (registered by the person, never from chat), and
// runs, started here or by the chat agent's infra_plan tool and approved through /tasks.
import type { Route } from '../api.ts';
import type { Infra } from './index.ts';

export function infraRoutes(x: Infra): Route[] {
  return [
    { method: 'GET', path: '/infra', summary: 'Infrastructure: whether the plan/apply tool is on this computer, the projects (each with its budget, price sheet, what Nova provisioned and what it costs a month) and the runs, newest first.', handle: () => x.list() },
    {
      method: 'POST', path: '/infra/projects', status: 201,
      summary: 'Register an infrastructure project: a folder with OpenTofu configuration, its monthly budget (every resource Nova provisions has one), a price sheet (what each resource type costs a month; a plan with a type it doesn’t list is never applied), the names of its provider secrets (their values go into the vault separately) and where the provider’s calls go.',
      body: '{name, folder, budget_usd_month, prices: {type: usd | {by, prices: {value: usd}}}, secrets?: [ENV_NAME], egress?: remote | local}',
      handle: ({ body }) => x.createProject(body),
    },
    { method: 'GET', path: '/infra/projects/{id}', summary: 'One project: its budget, price sheet, secrets (stored or not, never their values) and resources with their monthly prices.', handle: ({ params }) => x.project(params.id!) },
    { method: 'PUT', path: '/infra/projects/{id}', summary: 'A new budget or price sheet for a project. Nova checks every project against its budget again.', body: '{budget_usd_month?, prices?}', handle: ({ params, body }) => x.updateProject(params.id!, body) },
    { method: 'PUT', path: '/infra/projects/{id}/secrets/{name}', summary: 'Keep one of a project’s provider secrets in the vault. Nova hands it to the tool’s process only, at the moment of use, and never shows it again.', body: '{value}', handle: ({ params, body }) => x.setSecret(params.id!, params.name!, body.value) },
    {
      method: 'POST', path: '/infra/runs', status: 201,
      summary: 'Plan a project (tier 1: changes nothing). A plan inside the budget is then offered for apply, in full and priced, at tier 3, every time; one over budget, or with a resource Nova can’t price, is never offered, and Nova alerts. destroy: true plans destroying everything in it. Returns the run and its first task.',
      body: '{project, destroy?, privacy_mode?}',
      handle: ({ body }) => x.start(body),
    },
    { method: 'GET', path: '/infra/runs/{id}', summary: 'One run: the plan in full, each resource change with its monthly price, where the month would stand against the budget, and its tasks.', handle: ({ params }) => x.view(params.id!) },
    { method: 'POST', path: '/infra/runs/{id}/decline', summary: 'Don’t apply: the apply task is cancelled, and nothing changes.', handle: ({ params }) => x.decline(params.id!) },
  ];
}
