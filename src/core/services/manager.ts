// The Service Manager (docs/plans/M10-orchestration.md, Point 1): one place that knows which services
// Nova runs, at which version, and how healthy each is. It keeps the registry of definitions (one
// file per service and version, ADR-4), validates each one, picks the driver, and moves a version
// through the stages in their order, each at its tier (NOVA-SPEC §6, the ADR's table):
//   - deploy: installed and started alongside, with no production traffic, then its contract tests
//     and health (tier 1: nothing serves from it, and undoing it removes it);
//   - promote: traffic moves to it (tier 2, or 3 for the console and anything with secrets or OS
//     permissions), only for a version that passed; the previous one is kept for its soak;
//   - rollback: the kept version again in one step (tier 2 when asked; tier 1 when the driver does it
//     by itself after failed health).
// The supervisor driver is the default; nothing here knows how a driver runs anything.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promotionTier, validate, type DeviceView, type ServiceDefinition } from './definition.ts';
import type { Outcome, Plan, Say, ServiceDriver, ServiceStatus } from './driver.ts';

export interface ManagerOptions {
  // The registry's folder: <dir>/<service>/<version>.json.
  dir: string;
  // In order of preference: the first is the default.
  drivers: ServiceDriver[];
  // What the validator may know about devices (M10f gives them roles).
  devices?: () => DeviceView[];
}

export class ServiceManager {
  readonly dir: string;
  readonly drivers: readonly ServiceDriver[];
  #devices: () => DeviceView[] | undefined;

  constructor(o: ManagerOptions) {
    if (!o.drivers.length) throw new Error('The Service Manager needs a driver.');
    this.dir = o.dir;
    this.drivers = o.drivers;
    this.#devices = o.devices ?? (() => undefined);
  }

  // The definition as Nova would use it, or every reason it can't be, in plain words.
  check(input: unknown): { ok: true; def: ServiceDefinition } | { ok: false; problems: string[] } {
    const devices = this.#devices();
    return validate(input, devices ? { devices } : {});
  }

  // Which driver would run it, and how: the first one that can. With none, the default's refusal.
  plan(input: unknown): { ok: false; problems: string[] } | { ok: true; def: ServiceDefinition; plan: Plan; driver: ServiceDriver } {
    const v = this.check(input);
    if (!v.ok) return v;
    let first: { plan: Plan; driver: ServiceDriver } | null = null;
    for (const driver of this.drivers) {
      if (!driver.available().ok) continue;
      const plan = driver.plan(v.def);
      if (plan.ok) return { ok: true, def: v.def, plan, driver };
      first ??= { plan, driver };
    }
    if (first) return { ok: true, def: v.def, ...first };
    return { ok: false, problems: this.drivers.map((d) => `${d.name}: ${d.available().said}`) };
  }

  // Tier 1: started alongside, tested, never given traffic.
  async deploy(input: unknown, say: Say = () => {}): Promise<Outcome> {
    const p = this.plan(input);
    if (!p.ok) return { ok: false, said: `The definition can’t be used: ${p.problems.join(' ')}` };
    if (!p.plan.ok) return { ok: false, said: `The ${p.driver.name} driver can’t run ${p.def.service} ${p.def.version}: ${p.plan.refused.join(' ')}` };
    const known = this.definition(p.def.service, p.def.version);
    if (known && JSON.stringify(known) !== JSON.stringify(p.def)) {
      return { ok: false, said: `${p.def.service} ${p.def.version} is already registered with a different definition. A changed service is a new version.` };
    }
    this.#save(p.def);
    return p.driver.apply(p.def, say);
  }

  // Tier 2 or 3: asked every time. `confirm` is what the person typed: <service>@<version>.
  async promote(service: string, version: string, confirm: unknown, say: Say = () => {}): Promise<Outcome & { tier?: 2 | 3 }> {
    const def = this.definition(service, version);
    if (!def) return { ok: false, said: `${service} ${version} isn’t registered: deploy it first.` };
    const tier = promotionTier(def);
    if (confirm !== `${service}@${version}`) {
      return { ok: false, tier, said: `Promoting ${service} ${version} ${tier === 3 ? 'changes Nova itself or something with secrets or OS permissions (tier 3), so it is confirmed every time' : 'moves its traffic (tier 2), so it asks first'}: type ${service}@${version}.` };
    }
    const found = this.#find(service);
    if (!found) return { ok: false, tier, said: `No driver runs ${service}.` };
    const v = found.status.versions.find((x) => x.version === version);
    // Only a version that passed its contract tests and health is ever offered.
    if (!v || v.status !== 'ready') return { ok: false, tier, said: `${service} ${version} isn’t ready to promote${v ? ` (it is ${v.status.replace('_', ' ')}${v.said ? `: ${v.said}` : ''})` : ''}. Only a version that passed its contract tests and health takes traffic.` };
    return { tier, ...(await found.driver.switch(service, version, say)) };
  }

  // Tier 2: asked. `confirm` is the word "rollback".
  async rollback(service: string, confirm: unknown, say: Say = () => {}): Promise<Outcome> {
    if (confirm !== 'rollback') return { ok: false, said: `Going back to ${service}’s previous version asks first: type rollback.` };
    const found = this.#find(service);
    if (!found) return { ok: false, said: `No driver runs ${service}.` };
    if (!found.status.previous) return { ok: false, said: `${service} has no previous version kept to go back to.` };
    return found.driver.rollback(service, { auto: false, reason: 'You asked to go back.' }, say);
  }

  status(): ServiceStatus[] {
    return this.drivers.flatMap((d) => (d.available().ok ? d.status() : []));
  }

  // ---- the registry ------------------------------------------------------------------------------

  definition(service: string, version: string): ServiceDefinition | null {
    const file = join(this.dir, service, `${version}.json`);
    if (!/^[a-z][a-z0-9-]*$/.test(service) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(version) || !existsSync(file)) return null;
    try { return JSON.parse(readFileSync(file, 'utf8')) as ServiceDefinition; } catch { return null; }
  }

  versions(service: string): string[] {
    const d = join(this.dir, service);
    if (!/^[a-z][a-z0-9-]*$/.test(service) || !existsSync(d)) return [];
    return readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
  }

  #save(def: ServiceDefinition): void {
    const d = join(this.dir, def.service);
    mkdirSync(d, { recursive: true, mode: 0o700 });
    const file = join(d, `${def.version}.json`);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(def, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  }

  #find(service: string): { driver: ServiceDriver; status: ServiceStatus } | null {
    for (const driver of this.drivers) {
      if (!driver.available().ok) continue;
      const status = driver.status(service).find((s) => s.service === service);
      if (status) return { driver, status };
    }
    return null;
  }
}
