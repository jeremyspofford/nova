// What managed policy (FR-106, ADR-097 D4) does to installing things, in plain words, for the
// marketplace and the extensions page: unverified installs forbidden, kinds not allowed, the
// sideload switch, extensions limited to a list. The restrictions themselves come from the
// `managed.restrict` setting, which every view already has. Each locked control shows the shared
// "Managed by your organization" note (managed/ManagedNote.tsx, with `setting` set to the key or
// `restrict.<part>`), which reads where the policy comes from through the one managed-policy
// client (managed/store.ts).
import { defineMessages } from '@nova/i18n';
import type { ManagedRestrict } from '@nova/shared';
import { useSettings } from '../settings.tsx';

export const POLICY_TEXT = defineMessages('market.policy', {
  unverifiedOff:
    'Your organization allows only items signed by a publisher you trust. Unverified items cannot be installed.',
  extensionsLimited: 'Your organization limits which extensions may be installed.',
  failClosed:
    'Your organization’s policy could not be read, so Nova refuses agent tools until it can.',
});

/** The `restrict` blocks in force (the `managed.restrict` setting; both sources apply). */
export function useRestrictions(): { layers: ManagedRestrict[]; failClosed: string | null } {
  return useSettings().get('managed.restrict').value;
}

/** Whether any restrict block forbids unverified installs. */
export function unverifiedForbidden(layers: readonly ManagedRestrict[]): boolean {
  return layers.some((l) => l.unverifiedInstalls === false);
}

/** Whether a restrict block limits extensions (an allow or deny list). */
export function extensionsLimited(layers: readonly ManagedRestrict[]): boolean {
  return layers.some((l) => !!l.extensions?.allow || !!l.extensions?.deny?.length);
}
