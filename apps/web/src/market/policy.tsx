// What managed policy (FR-106, ADR-097 D4) does to installing things, in plain words, for the
// marketplace and the extensions page: unverified installs forbidden, kinds not allowed, the
// sideload switch, extensions limited to a list; each locked control says "Managed by your
// organization" and where the policy comes from (the policy file on the Hub or the remote policy,
// `GET /api/v1/managed`). The restrictions themselves come from the `managed.restrict` setting,
// which every view already has; the source is read once per page.
import { useEffect, useState } from 'react';
import type { ManagedChannel, ManagedPolicyView, ManagedRestrict } from '@nova/shared';
import { Icon, MANAGED_TEXT } from '@nova/ui';
import { useSettings } from '../settings.tsx';
import { useMarketApi } from './api-m8.ts';

export const POLICY_TEXT = {
  unverifiedOff:
    'Your organization allows only items signed by a publisher you trust. Unverified items cannot be installed.',
  extensionsLimited: 'Your organization limits which extensions may be installed.',
  failClosed:
    'Your organization’s policy could not be read, so Nova refuses agent tools until it can.',
  fromFile: (path: string) => `set by the policy file ${path}`,
  fromRemote: (url: string) => `set by the remote policy from ${url}`,
  fromBoth: 'set by the policy file and the remote policy',
  managedWith: (source: string) => `${MANAGED_TEXT} (${source})`,
} as const;

/** The `restrict` blocks in force (the `managed.restrict` setting; both sources apply). */
export function useRestrictions(): { layers: ManagedRestrict[]; failClosed: string | null } {
  return useSettings().get('managed.restrict').value;
}

/** Where managed policy comes from, read once while mounted; null until known (or not readable). */
export function useManagedSources(active: boolean): ManagedPolicyView | null {
  const api = useMarketApi();
  const [view, setView] = useState<ManagedPolicyView | null>(null);
  useEffect(() => {
    if (!active || !api) return;
    let alive = true;
    api.marketPolicySources().then(
      (v) => alive && setView(v),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [api, active]);
  return view;
}

function channelText(view: ManagedPolicyView, channel: ManagedChannel | 'both'): string | null {
  if (channel === 'both') return POLICY_TEXT.fromBoth;
  const src = view.sources.find((s) => s.channel === channel);
  if (!src) return null;
  return channel === 'local'
    ? POLICY_TEXT.fromFile(src.location)
    : POLICY_TEXT.fromRemote(src.location);
}

/** Where a managed setting (or a restriction part, `restrict.<part>`) comes from, in words. */
export function managedSourceText(view: ManagedPolicyView | null, key: string): string | null {
  if (!view) return null;
  if (key.startsWith('restrict.')) {
    const part = key.slice('restrict.'.length) as keyof ManagedRestrict;
    const channels = view.restrict
      .filter((r) => r.restrict[part] !== undefined)
      .map((r) => r.channel);
    if (channels.length === 0) return null;
    return channelText(view, channels.length > 1 ? 'both' : channels[0]!);
  }
  const s = view.settings.find((x) => x.key === key);
  return s ? channelText(view, s.channel) : null;
}

/** "Managed by your organization", with where it comes from when known. */
export function ManagedNote({
  view,
  sourceKey,
  id,
}: {
  view: ManagedPolicyView | null;
  /** The setting key, or `restrict.<part>`. */
  sourceKey: string;
  id?: string;
}) {
  const source = managedSourceText(view, sourceKey);
  return (
    <span id={id} className="nv-field-hint nv-field-lock market-managed">
      <Icon name="shield" /> {source ? POLICY_TEXT.managedWith(source) : MANAGED_TEXT}
    </span>
  );
}

/** Whether any restrict block forbids unverified installs. */
export function unverifiedForbidden(layers: readonly ManagedRestrict[]): boolean {
  return layers.some((l) => l.unverifiedInstalls === false);
}

/** Whether a restrict block limits extensions (an allow or deny list). */
export function extensionsLimited(layers: readonly ManagedRestrict[]): boolean {
  return layers.some((l) => !!l.extensions?.allow || !!l.extensions?.deny?.length);
}
