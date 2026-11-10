// Approval tiers as settings: the routes (owner ruling 2026-11-09, decision 8). Any paired person
// may read them and raise a tier. Lowering one loosens a gate: only the hub's own screen or a device
// allowed to approve may (owner ruling 2026-11-10, D1), and it needs {confirm: true}; on Nova's own
// screen the core's approval hook asks for the passkey with it, and an approver device sends the
// confirm alone. A body flag is never the authorization. The screen for this waits on the owner's design.
import { CoreError } from '../errors.ts';
import type { Route, Who } from '../api.ts';
import { allows } from '../mesh/access.ts';
import type { Approvals } from './index.ts';

const by = (who: Who): string => (who.principal.kind === 'device' ? `device:${who.principal.device.id}` : who.principal.kind);

export function approvalRoutes(a: Approvals): Route[] {
  return [
    {
      method: 'GET', path: '/approvals', summary: 'Approval tiers, per capability: the default, the floor no setting goes below (and why), your setting, and the tier in effect, each in words; and what no setting changes (Nova never presses pay; after outside content a guarded step asks).',
      handle: () => a.list(),
    },
    {
      method: 'PUT', path: '/approvals/{capability}', summary: 'Set a capability’s approval tier (1 does it and tells you, 2 asks first, 3 confirms every time; null for the default). Raising is free; lowering needs {confirm: true}. Below the floor is refused.',
      body: '{tier: 0 | 1 | 2 | 3 | null, confirm?}',
      handle: ({ params, body, who }) => {
        if (!('tier' in body)) throw new CoreError('validation', 'Send tier: 1, 2 or 3, or null for the default.');
        return a.set(params.capability!, body.tier, { confirm: body.confirm === true, by: by(who), approver: allows('approver', who.principal) === 'ok' });
      },
    },
  ];
}
