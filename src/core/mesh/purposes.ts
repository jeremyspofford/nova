// Device roles (docs/plans/M10-orchestration.md, Point 9; docs/plans/M10f.md §1): what a device is
// FOR, chosen at pairing, confirmed on the hub's approval screen, editable in Settings › Devices.
// In code they are `purposes`, because `role` is already the mesh role (client, spoke, standby,
// hub). On screen they are "Roles". They are labels: hardware stays in `device_hardware`, and the
// placement resolver (services/placement.ts) reads both.
//
// Tiers (the ADR's table): widening a device's roles is tier 3, because it changes what may run
// there; narrowing is tier 2, because it may stop services there, and Nova says which. Hub candidate
// is itself tier 3 every time (Decision 2), with its own confirmation, because the candidate's key is
// then pinned in the roster. The hub stays elected: a candidacy only makes a device eligible.
import { CoreError } from '../errors.ts';

export const PURPOSES = Object.freeze(['thin-client', 'hub-candidate', 'compute', 'storage', 'capture-source', 'general-server'] as const);
export type Purpose = (typeof PURPOSES)[number];
// The roles a workload can be placed by. A device with none of these never receives one.
export const WORKLOAD_PURPOSES: readonly Purpose[] = Object.freeze(['compute', 'storage', 'capture-source', 'general-server']);

export const PURPOSE_WORDS: Readonly<Record<Purpose, { label: string; note: string }>> = Object.freeze({
  'thin-client': { label: 'Thin client', note: 'A screen onto Nova. It never runs anything for Nova.' },
  'hub-candidate': { label: 'Hub candidate', note: 'It could become the hub one day. Its key is pinned for that, so this is confirmed every time.' },
  compute: { label: 'Compute', note: 'Runs models and other heavy work.' },
  storage: { label: 'Storage', note: 'Keeps models and data.' },
  'capture-source': { label: 'Capture source', note: 'May run capture. Capture itself stays off until you turn it on.' },
  'general-server': { label: 'General server', note: 'Runs other services Nova manages.' },
});

export type DeviceKindForPurposes = 'browser' | 'phone' | 'computer' | 'standby';

// What a kind of device may hold. A phone or browser runs no device agent, so it is a screen only.
// A standby is a hub candidate by what it is (it keeps a live copy to take over), and may run work.
export function allowedPurposes(kind: DeviceKindForPurposes, o: { hub?: boolean } = {}): Purpose[] {
  if (o.hub) return ['hub-candidate', 'compute', 'storage', 'capture-source', 'general-server'];
  if (kind === 'phone' || kind === 'browser') return ['thin-client'];
  if (kind === 'standby') return ['hub-candidate', 'compute', 'storage', 'capture-source', 'general-server'];
  return [...PURPOSES];
}

// What a kind must hold, whatever the person picks: the hub runs Nova and its services; a standby
// can take over.
export function fixedPurposes(kind: DeviceKindForPurposes, o: { hub?: boolean } = {}): Purpose[] {
  if (o.hub) return ['hub-candidate', 'general-server'];
  if (kind === 'phone' || kind === 'browser') return ['thin-client'];
  if (kind === 'standby') return ['hub-candidate'];
  return [];
}

// What a device gets when nobody said: computers get no workload role until the person picks one.
export function defaultPurposes(kind: DeviceKindForPurposes, o: { hub?: boolean } = {}): Purpose[] {
  return fixedPurposes(kind, o);
}

const ORDER = new Map(PURPOSES.map((p, i) => [p, i]));
export const sortPurposes = (list: readonly Purpose[]): Purpose[] => [...new Set(list)].sort((a, b) => ORDER.get(a)! - ORDER.get(b)!);

// The roles as given, checked for this kind: known names only, what the kind may hold, and what it
// must hold added. Thin client means a screen only, so it never comes with a workload role.
export function checkPurposes(input: unknown, kind: DeviceKindForPurposes, o: { hub?: boolean; what?: string } = {}): Purpose[] {
  const what = o.what ?? 'purposes';
  if (!Array.isArray(input) || input.length > PURPOSES.length * 2 || !input.every((x) => typeof x === 'string')) {
    throw new CoreError('validation', `${what} is a list of roles: ${PURPOSES.join(', ')}.`);
  }
  const unknown = input.filter((x) => !(PURPOSES as readonly string[]).includes(x));
  if (unknown.length) throw new CoreError('validation', `${unknown.map((u) => JSON.stringify(u)).join(', ')} ${unknown.length === 1 ? 'isn’t a role' : 'aren’t roles'}. The roles are ${PURPOSES.join(', ')}.`);
  const allowed = allowedPurposes(kind, o);
  const list = sortPurposes([...(input as Purpose[]), ...fixedPurposes(kind, o)]);
  const refused = list.filter((p) => !allowed.includes(p));
  if (refused.length) {
    const who = o.hub ? 'The hub' : kind === 'phone' || kind === 'browser' ? `A ${kind}` : `A ${kind}`;
    const why = kind === 'phone' || kind === 'browser' ? ' It runs no device agent, so it is a thin client: a screen onto Nova.' : '';
    throw new CoreError('validation', `${who} can’t be ${refused.map((p) => PURPOSE_WORDS[p].label.toLowerCase()).join(' or ')}.${why}`);
  }
  if (list.includes('thin-client') && list.some((p) => WORKLOAD_PURPOSES.includes(p) || p === 'hub-candidate')) {
    throw new CoreError('validation', 'A thin client is a screen only, so it can’t also run work or become the hub. Pick one or the other.');
  }
  return list;
}

// True when a device may receive workloads at all: it holds at least one workload role.
export const mayRunWork = (purposes: readonly string[]): boolean => purposes.some((p) => (WORKLOAD_PURPOSES as readonly string[]).includes(p));

export interface PurposeChange { added: Purpose[]; removed: Purpose[]; tier: 0 | 2 | 3; candidacy: 'added' | 'removed' | null }

// What a change of roles is, and its tier: any widening is tier 3; narrowing alone is tier 2.
export function purposeChange(before: readonly Purpose[], after: readonly Purpose[]): PurposeChange {
  const added = sortPurposes(after.filter((p) => !before.includes(p)));
  const removed = sortPurposes(before.filter((p) => !after.includes(p)));
  const candidacy = added.includes('hub-candidate') ? 'added' : removed.includes('hub-candidate') ? 'removed' : null;
  return { added, removed, tier: added.length ? 3 : removed.length ? 2 : 0, candidacy };
}

export const purposeWords = (list: readonly string[]): string => (list.length ? list.map((p) => PURPOSE_WORDS[p as Purpose]?.label ?? p).join(', ') : 'No roles yet');
