// Approval tiers as settings (NOVA-SPEC §6: "Tiers are policy, configurable per user and per
// capability — the mechanism is core, the settings are profile"; owner ruling 2026-11-09, decision 8,
// docs/builder-packet/INPUT-2026-11-09-TIER-RULING.md: "she should be able to do most or all without
// asking, or at least have settings to allow that"; and the owner's scope, 2026-11-09: "There will be
// other things people add ... whatever service they ask nova to build will require to be managed the
// same way").
//
// A registry, not a fixed list. Anything that acts registers its capabilities at runtime: Nova's own
// workers (BUILTINS, below), a connector (its manifest's `approvals`, connectors/index.ts), an
// extension (the same manifest field, on install; dropped on removal), and whatever Nova builds later
// through the same manifest. Each registration says what the capability is in words and its EFFECT
// CLASS; Nova derives the floor (the lowest a setting may reach) and the starting default from the
// class, not from the registrant. A registrant may ask for a stricter default or floor, never a looser
// one; only Nova's own code (origin core) sets a default below its class's, which is how the owner's
// rulings (a home change is tier 1) stand. The person's overrides live in the profile
// (policy.approvals, {capability: tier}), kept by id, so they survive a reinstall.
// effective = max(floor, override ?? default), on every read.
//
// Two protections are not tiers and are not here (the integrator's constraints, told to the owner):
// Nova never presses pay (browser/plan.ts PAY_REFUSAL), and after outside content a guarded step asks
// whatever the tier (src/runner.js GUARDED, and every registered capability's chat tool through
// guardWords below). Both apply at any effective tier.
import { CoreError } from '../errors.ts';
import type { Tier } from '../envelope.ts';
import type { Log } from '../log.ts';
import type { Profile } from '../profile.ts';

export const TIER_WORDS: Record<Tier, string> = {
  0: 'Silent: does it without telling you',
  1: 'Does it and tells you',
  2: 'Asks first',
  3: 'Confirms every time',
};

// What a capability does, and so how far Nova lets its tier go. The floor and the default a
// registrant gets are Nova's, by class.
export const EFFECTS = {
  read: { floor: 0 as Tier, default: 1 as Tier, words: 'it only reads: nothing changes' },
  reversible: { floor: 1 as Tier, default: 2 as Tier, words: 'it changes something that can be undone' },
  irreversible: { floor: 1 as Tier, default: 3 as Tier, words: 'it acts outside or can’t be undone: sending, spending, devices, accounts, running code' },
  delete: { floor: 3 as Tier, default: 3 as Tier, words: 'it deletes data or credentials, which can’t be brought back' },
} as const;
export type Effect = keyof typeof EFFECTS;
export const EFFECT_NAMES = Object.keys(EFFECTS) as Effect[];
// Why the floor is where it is, said when a setting below it is refused.
const FLOOR_WHY: Record<Tier, string> = {
  0: 'it only reads, so there is nothing below it',
  1: 'tier 0 (silent, without telling you) isn’t offered yet; that is the owner’s to decide',
  2: 'it needs you there',
  3: 'it deletes data or credentials, which can’t be brought back (the vault ruling, decision 2)',
};

// What a registrant says. `default`, `floor`: what it asks for (Nova may make them stricter).
// `tools`: the chat tools that act on it, which the outside-content guard covers automatically;
// `guard`: the words for that ask ("change your home"). `targets`: finer-grained things the person
// can mark "confirm every time" (a connector's domains), with the ones marked now.
export interface Registration {
  id: string;
  area: string;
  name: string;
  effect: Effect;
  default?: Tier;
  floor?: Tier;
  floor_why?: string;
  tiers?: readonly Tier[];
  tools?: readonly string[];
  guard?: string;
  targets?: { words: string; marked: () => readonly string[] };
}
// Who registered it: Nova's own code, or an extension (by its manifest id). A connector built into
// Nova registers as core with the manifest it came from, so that manifest's install isn't a clash.
export type Origin = { kind: 'core'; manifest?: string } | { kind: 'extension'; id: string };

export interface Capability {
  id: string; area: string; name: string; effect: Effect;
  default: Tier; floor: Tier; floor_why: string; tiers: readonly Tier[];
  tools: readonly string[]; guard: string | null;
  targets: Registration['targets'] | null;
  origin: Origin;
}

// The capability as a manifest declares it (extensions.ts validates the shape); its id is local to
// the extension, and registered as `<manifest id>.<id>`.
export interface ManifestApproval {
  id: string; name: string; effect: Effect; default?: Tier; floor?: Tier; tiers?: Tier[]; tools?: string[]; guard?: string; targets?: string;
}

const ID = /^[a-z0-9][a-z0-9_-]*(\.[a-z0-9][a-z0-9_-]*)+$/;
const ALL: readonly Tier[] = [0, 1, 2, 3];
const isTier = (v: unknown): v is Tier => v === 0 || v === 1 || v === 2 || v === 3;
const ownerOf = (o: Origin) => (o.kind === 'core' ? 'core' : `extension:${o.id}`);

// Nova derives the floor, the default and the allowed tiers; the registrant only tightens them.
export function derive(r: Registration, origin: Origin): Capability {
  const bad = (m: string) => new CoreError('validation', `The capability ${r.id} can’t be registered: ${m}`);
  if (typeof r.id !== 'string' || !ID.test(r.id) || r.id.length > 120) throw bad('its id is dotted lowercase words, like coding.merge.');
  if (!Object.hasOwn(EFFECTS, r.effect)) throw bad(`its effect is one of ${EFFECT_NAMES.join(', ')}.`);
  if (typeof r.name !== 'string' || !r.name.trim() || typeof r.area !== 'string' || !r.area.trim()) throw bad('it needs a name and an area, in words.');
  if (origin.kind === 'extension' && !r.id.startsWith(`${origin.id}.`)) throw bad(`an extension’s capabilities are named ${origin.id}.<name>.`);
  for (const t of [r.default, r.floor, ...(r.tiers ?? [])]) if (t !== undefined && !isTier(t)) throw bad('a tier is 0, 1, 2 or 3.');
  const cls = EFFECTS[r.effect];
  const floor = Math.max(cls.floor, r.floor ?? 0) as Tier;
  let def: Tier;
  if (origin.kind === 'core') {
    def = r.default ?? cls.default;
    if (def < floor) throw bad(`its default (${def}) is below its floor (${floor}).`);
  } else {
    // Never looser than the class's: a service can't declare itself low-risk.
    def = Math.max(cls.default, floor, r.default ?? cls.default) as Tier;
  }
  const tiers = (r.tiers ?? ALL).filter((t) => t >= floor);
  if (!tiers.length) throw bad('none of its tiers is at or above its floor.');
  if (!tiers.includes(def)) def = tiers.find((t) => t >= def) ?? tiers.at(-1)!;
  return {
    id: r.id, area: r.area.trim(), name: r.name.trim(), effect: r.effect, default: def, floor,
    floor_why: r.floor !== undefined && r.floor > cls.floor && r.floor_why ? r.floor_why : FLOOR_WHY[floor],
    tiers, tools: [...(r.tools ?? [])], guard: r.guard ?? null, targets: r.targets ?? null, origin,
  };
}

// Nova's own workers: registered through the same call as everything else. Each default is the tier
// the code used before tiers were settings (a test pins them).
export const BUILTINS: readonly Registration[] = [
  { id: 'browser.send', area: 'Browser', name: 'Sign in, type, choose and click on a task’s own sites', effect: 'irreversible', default: 1 },
  { id: 'browser.checkout', area: 'Browser', name: 'Go through a checkout to the itemised total (Nova never presses pay)', effect: 'irreversible', default: 3 },
  { id: 'browser.account', area: 'Browser', name: 'Change an account: a new password, a new account, two-step sign-in', effect: 'irreversible', default: 3, tools: ['account_change'], guard: 'change an account',
    floor: 2, floor_why: 'it runs only while you’re there, soon after your OK, so you can type any code' },
  { id: 'coding.write', area: 'Coding', name: 'Write a change on Nova’s own branch', effect: 'reversible', default: 1, tools: ['code_change'], guard: 'change code in a repository' },
  { id: 'coding.update', area: 'Coding', name: 'Bring Nova’s branch up to date with yours', effect: 'reversible', default: 1 },
  { id: 'coding.check', area: 'Coding', name: 'Run the tests and the preview on the agent’s code, as you', effect: 'irreversible', default: 2 },
  { id: 'coding.merge', area: 'Coding', name: 'Merge the reviewed change into your branch (never pushed)', effect: 'irreversible', default: 3 },
  { id: 'infra.plan', area: 'Infrastructure', name: 'Plan an infrastructure change', effect: 'read', default: 1, tools: ['infra_plan'], guard: 'plan infrastructure' },
  { id: 'infra.apply', area: 'Infrastructure', name: 'Apply the reviewed plan', effect: 'irreversible', default: 3 },
  { id: 'network.prepare', area: 'Network', name: 'Snapshot a network target and work out the diff', effect: 'read', default: 1, tools: ['network_change'], guard: 'change your network' },
  { id: 'network.apply', area: 'Network', name: 'Apply a network change, or put one back that you ask for', effect: 'irreversible', default: 3 },
  { id: 'computer.read', area: 'Nova’s computer', name: 'Run a read-only command in a workspace', effect: 'read', default: 0 },
  { id: 'computer.write', area: 'Nova’s computer', name: 'Run a command that changes a workspace (checkpointed first)', effect: 'reversible', default: 1 },
  { id: 'computer.outside', area: 'Nova’s computer', name: 'Run or create a workspace that reaches outside', effect: 'irreversible', default: 3 },
  { id: 'computer.create', area: 'Nova’s computer', name: 'Make a workspace in Nova’s own folder', effect: 'reversible', default: 1 },
  { id: 'computer.create_shared', area: 'Nova’s computer', name: 'Make a workspace on a folder of yours, or one whose .git it may change', effect: 'irreversible', default: 2 },
  { id: 'computer.checkpoint', area: 'Nova’s computer', name: 'Checkpoint a workspace', effect: 'reversible', default: 1 },
  { id: 'computer.reset', area: 'Nova’s computer', name: 'Put a workspace back to a checkpoint', effect: 'reversible', default: 1 },
  { id: 'computer.reset_discard', area: 'Nova’s computer', name: 'Put a workspace back without checkpointing what is there', effect: 'irreversible', default: 2 },
  { id: 'computer.destroy', area: 'Nova’s computer', name: 'Remove a workspace and its checkpoints', effect: 'delete', default: 3 },
  { id: 'providers.enable', area: 'Providers', name: 'Turn a provider on, with the permissions it asks for', effect: 'reversible', default: 2 },
  { id: 'providers.loosen', area: 'Providers', name: 'Give a provider more room: looser permissions, or tests run without asking', effect: 'irreversible', default: 3 },
  { id: 'vault.delete', area: 'Vault', name: 'Delete a secret from the vault', effect: 'delete', default: 3 },
  { id: 'vault.reset', area: 'Vault', name: 'Start a new, empty vault', effect: 'delete', default: 3 },
];
export type BuiltinId = 'browser.send' | 'browser.checkout' | 'browser.account' | 'coding.write' | 'coding.update' | 'coding.check' | 'coding.merge'
  | 'infra.plan' | 'infra.apply' | 'network.prepare' | 'network.apply' | 'computer.read' | 'computer.write' | 'computer.outside' | 'computer.create'
  | 'computer.create_shared' | 'computer.checkpoint' | 'computer.reset' | 'computer.reset_discard' | 'computer.destroy' | 'providers.enable'
  | 'providers.loosen' | 'vault.delete' | 'vault.reset';
// Back-compat name for the built-in ids.
export type CapabilityId = BuiltinId;

const BUILTIN_DEFS = new Map(BUILTINS.map((r) => [r.id, derive(r, { kind: 'core' })]));
export function builtin(id: string): Capability {
  const c = BUILTIN_DEFS.get(id);
  if (!c) throw new CoreError('not_found', `There is no built-in capability called ${id}.`);
  return c;
}

export function effectiveOf(c: Pick<Capability, 'floor' | 'default'>, override: Tier | null | undefined): Tier {
  return Math.max(c.floor, override ?? c.default) as Tier;
}

// What a worker asks: the tier a capability runs at now.
export interface Tiers { effective(id: string): Tier }
// With no overrides: every built-in's default. Workers made without settings (tests, tools) use this.
export const DEFAULT_TIERS: Tiers = { effective: (id) => builtin(id).default };

// Words that follow the tier: tier 3 confirms every time, 2 asks first, 1 or 0 doesn't ask.
export function byTier<T>(tier: Tier, w: { confirm: T; ok: T; free: T }): T {
  return tier >= 3 ? w.confirm : tier === 2 ? w.ok : w.free;
}

// What no setting changes, said with the list so a screen can say it too.
export const FIXED = [
  { id: 'pay', words: 'Nova never presses pay: a checkout stops at the itemised total, whatever its tier.' },
  { id: 'outside_content', words: 'After Nova has read outside content (mail, web pages), a step that could act for you asks first, whatever its tier.' },
] as const;

export interface CapabilityView {
  id: string; area: string; name: string; effect: Effect; effect_words: string; origin: string;
  default: Tier; floor: Tier; floor_why: string; override: Tier | null; effective: Tier; tiers: readonly Tier[];
  words: { default: string; floor: string; override: string | null; effective: string };
  targets?: { words: string; confirm_every_time: readonly string[] };
}

const KEY = 'approvals';

export class Approvals implements Tiers {
  #profile: Profile;
  #log: Log;
  #all = new Map<string, Capability>();

  constructor(o: { profile: Profile; log: Log }) {
    this.#profile = o.profile;
    this.#log = o.log;
    for (const r of BUILTINS) this.register(r, { kind: 'core' });
  }

  // ---- registration ------------------------------------------------------------------------

  // Registers (or, for the same owner, replaces) a capability. Another owner's id is refused.
  register(r: Registration, origin: Origin): Capability {
    const c = derive(r, origin);
    const have = this.#all.get(c.id);
    // Nova's own code for a manifest takes over what that manifest's install registered (a built-in
    // connector's record in the extension host, read at startup before the connector registers).
    const takeover = have?.origin.kind === 'extension' && origin.kind === 'core' && origin.manifest === have.origin.id;
    if (have && !takeover && ownerOf(have.origin) !== ownerOf(origin)) throw new CoreError('conflict', `A capability called ${c.id} is already registered, by ${ownerOf(have.origin)}.`);
    this.#all.set(c.id, c);
    return c;
  }

  // A manifest's declared capabilities, as registrations. A connector built into Nova registers them
  // as core; an installed extension, as itself.
  registerManifest(m: { id: string; name: string; approvals?: ManifestApproval[] }, origin: Origin, targets?: (local: string) => readonly string[]): Capability[] {
    return (m.approvals ?? []).map((a) => this.register({
      id: `${m.id}.${a.id}`, area: m.name, name: a.name, effect: a.effect,
      ...(a.default !== undefined ? { default: a.default } : {}), ...(a.floor !== undefined ? { floor: a.floor } : {}), ...(a.tiers ? { tiers: a.tiers } : {}),
      ...(a.tools ? { tools: a.tools } : {}), ...(a.guard ? { guard: a.guard } : {}),
      ...(a.targets ? { targets: { words: a.targets, marked: () => targets?.(a.id) ?? [] } } : {}),
    }, origin));
  }

  // An installed extension's declared capabilities, as itself. One Nova ships (a built-in
  // connector's manifest, installed when it is connected) already registered them as core: those stay.
  registerExtension(m: { id: string; name: string; approvals?: ManifestApproval[] }): Capability[] {
    const own = (m.approvals ?? []).filter((a) => this.#all.get(`${m.id}.${a.id}`)?.origin.kind !== 'core');
    return this.registerManifest({ ...m, approvals: own }, { kind: 'extension', id: m.id });
  }

  // Problems with a manifest's declared capabilities before it is installed: a clash with one already
  // registered by something else (Nova's own, or another extension), or a declaration Nova can't take.
  check(m: { id: string; approvals?: ManifestApproval[] }): string[] {
    const out: string[] = [];
    for (const a of m.approvals ?? []) {
      const id = `${m.id}.${a.id}`;
      const have = this.#all.get(id);
      const same = have && ((have.origin.kind === 'core' && have.origin.manifest === m.id) || (have.origin.kind === 'extension' && have.origin.id === m.id));
      if (have && !same) out.push(`The capability ${id} is already Nova’s or another extension’s.`);
      try { derive({ ...a, id, area: 'x' } as Registration, { kind: 'extension', id: m.id }); } catch (e) { out.push((e as Error).message); }
    }
    return out;
  }

  unregister(id: string): boolean {
    return this.#all.delete(id);
  }

  // An extension removed: everything it registered goes. The person's overrides stay, by id, so a
  // reinstall of the same extension finds them (still never below its floor).
  unregisterOwner(origin: Origin): string[] {
    const owner = ownerOf(origin);
    const gone = [...this.#all.values()].filter((c) => ownerOf(c.origin) === owner).map((c) => c.id);
    for (const id of gone) this.#all.delete(id);
    return gone;
  }

  has(id: string): boolean {
    return this.#all.has(id);
  }

  capability(id: string): Capability {
    const c = this.#all.get(id);
    if (!c) throw new CoreError('not_found', `There is no capability called ${id}. GET /api/v1/approvals lists them.`);
    return c;
  }

  // The words the outside-content guard asks with for a chat tool that acts on a registered
  // capability, or null (a read, or no capability names the tool).
  guardWords(tool: string): string | null {
    for (const c of this.#all.values()) {
      if (c.effect !== 'read' && c.tools.includes(tool)) return c.guard ?? `take this step (${c.name.toLowerCase()})`;
    }
    for (const c of this.#all.values()) if (c.tools.includes(tool) && c.guard) return c.guard;
    return null;
  }

  // ---- settings ----------------------------------------------------------------------------

  #stored(): Record<string, unknown> {
    const v = this.#profile.get<Record<string, unknown>>('policy', KEY);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  }

  override(id: string): Tier | null {
    const c = this.capability(id);
    const v = this.#stored()[c.id];
    // A value below the floor (written around the checks, or kept from a looser registration)
    // counts as the floor.
    return isTier(v) ? (Math.max(c.floor, v) as Tier) : null;
  }

  effective(id: string): Tier {
    return effectiveOf(this.capability(id), this.override(id));
  }

  view(id: string): CapabilityView {
    const c = this.capability(id);
    const override = this.override(c.id);
    const effective = effectiveOf(c, override);
    return {
      id: c.id, area: c.area, name: c.name, effect: c.effect, effect_words: EFFECTS[c.effect].words, origin: ownerOf(c.origin),
      default: c.default, floor: c.floor, floor_why: c.floor_why, override, effective, tiers: c.tiers,
      words: { default: TIER_WORDS[c.default], floor: TIER_WORDS[c.floor], override: override === null ? null : TIER_WORDS[override], effective: TIER_WORDS[effective] },
      ...(c.targets ? { targets: { words: c.targets.words, confirm_every_time: c.targets.marked() } } : {}),
    };
  }

  list(): { capabilities: CapabilityView[]; tiers: Record<Tier, string>; effects: typeof EFFECTS; fixed: typeof FIXED } {
    return { capabilities: [...this.#all.keys()].map((id) => this.view(id)), tiers: TIER_WORDS, effects: EFFECTS, fixed: FIXED };
  }

  // tier: a tier, or null for the default. Raising is free; lowering loosens a gate, so it needs
  // {confirm: true} (on Nova's own screen the approval hook asks for the passkey with it).
  set(id: string, tier: unknown, o: { confirm?: boolean; by?: string } = {}): CapabilityView {
    const c = this.capability(id);
    if (tier !== null && !isTier(tier)) throw new CoreError('validation', 'A tier is 0, 1, 2 or 3 (or null for the default): 1 does it and tells you, 2 asks first, 3 confirms every time.');
    if (tier !== null && tier < c.floor) throw new CoreError('validation', `“${c.name}” can’t go below tier ${c.floor} (${TIER_WORDS[c.floor].toLowerCase()}): ${c.floor_why}.`);
    if (tier !== null && !c.tiers.includes(tier)) throw new CoreError('validation', `“${c.name}” is ${c.tiers.join(' or ')}.`);
    const from = this.effective(c.id);
    const to = effectiveOf(c, tier);
    if (to < from && o.confirm !== true) throw new CoreError('validation', `Lowering “${c.name}” from tier ${from} to ${to} (${TIER_WORDS[to].toLowerCase()}) loosens a gate: send confirm: true to do that.`);
    this.#write(c.id, tier);
    this.#log.info('approvals', `${c.name}: tier ${from} → ${to}${tier === null ? ' (the default)' : ''}.`, { capability: c.id, from, to, override: tier, confirmed: o.confirm === true, by: o.by ?? 'core' });
    return this.view(c.id);
  }

  // A setting kept somewhere older (a connector's own settings file) moves here once, as it was,
  // unless the person already has one here. Recorded like any change.
  adopt(id: string, tier: Tier): void {
    const c = this.capability(id);
    if (this.override(c.id) !== null || !c.tiers.includes(tier)) return;
    this.#write(c.id, tier);
    this.#log.info('approvals', `${c.name}: tier ${tier}, kept from its earlier setting.`, { capability: c.id, override: tier, by: 'migration' });
  }

  #write(id: string, tier: Tier | null): void {
    const next = { ...this.#stored() };
    if (tier === null) delete next[id]; else next[id] = tier;
    this.#profile.set('policy', KEY, next, 'settings');
  }
}
