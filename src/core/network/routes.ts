// Networking's part of /api/v1 (M10d): targets (registered by the person, never from chat), and
// changes, started here or by the chat agent's network_change tool and approved through /tasks.
import type { Route } from '../api.ts';
import type { Network } from './index.ts';

export function networkRoutes(n: Network): Route[] {
  return [
    { method: 'GET', path: '/network', summary: 'Networking: the dead-man’s switch’s window, the devices whose contact counts, the targets and the changes, newest first.', handle: () => n.list() },
    {
      method: 'POST', path: '/network/targets', status: 201,
      summary: 'Register a network target: something whose configuration Nova may change (a router, DNS, a firewall, a tailnet’s policy), through an adapter. Its token goes into the vault separately.',
      body: '{name, kind: router | dns | firewall | tailnet, url, adapter?: http-config}',
      handle: ({ body }) => n.createTarget(body),
    },
    { method: 'GET', path: '/network/targets/{id}', summary: 'One target: its adapter, address and whether its token is stored (never the token).', handle: ({ params }) => n.target(params.id!) },
    { method: 'PUT', path: '/network/targets/{id}/token', summary: 'Keep a target’s token in the vault. Nova sends it only to that target, and never shows it again.', body: '{value}', handle: ({ params, body }) => n.setToken(params.id!, body.value) },
    {
      method: 'POST', path: '/network/changes', status: 201,
      summary: 'Propose a change to a target’s configuration, as a JSON merge patch. In order: a snapshot and the diff (tier 1, nothing changes); the apply (tier 3, every time), after a checkpoint; then the dead-man’s switch: without contact from one of your devices within the window, Nova puts the snapshot back by itself. A patch that sets a secret is refused. Needs a paired device.',
      body: '{target, patch, title?, privacy_mode?}',
      handle: ({ body }) => n.start(body),
    },
    { method: 'GET', path: '/network/changes/{id}', summary: 'One change: the diff against the snapshot (secret values masked), the switch’s deadline, whether contact was confirmed, and its tasks.', handle: ({ params }) => n.view(params.id!) },
    { method: 'POST', path: '/network/changes/{id}/decline', summary: 'Don’t apply: the apply task is cancelled, and nothing changes.', handle: ({ params }) => n.decline(params.id!) },
    { method: 'POST', path: '/network/changes/{id}/settle', summary: 'Settle a change Nova couldn’t put back (its revert found someone else’s change, or failed): you checked the target yourself and it is as you want it (tier 3: needs {confirm: true}). The target takes new changes again, and the problem closes.', body: '{confirm: true}', handle: ({ params, body }) => n.settle(params.id!, body ?? {}) },
    { method: 'POST', path: '/network/changes/{id}/revert', status: 201, summary: 'Put a kept change back to its snapshot: a network change of its own, so it asks at tier 3.', handle: ({ params }) => n.revert(params.id!) },
  ];
}
