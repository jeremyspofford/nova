// Immutable definitions only. Cluster state/approvals/queues do not live in this registry.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validate, type ServiceDefinition } from '../definition.ts';
export interface K3sDefinitionRecord { schema: 1; definition: ServiceDefinition }
export class K3sRegistry {
  readonly directory: string;
  constructor(directory: string) { this.directory = directory; }
  #path(service: string, version: string) { return join(this.directory, `${createHash('sha256').update(JSON.stringify([service, version])).digest('hex')}.json`); }
  get(service: string, version: string): ServiceDefinition | null {
    try {
      const row = JSON.parse(readFileSync(this.#path(service, version), 'utf8')) as K3sDefinitionRecord;
      const checked = validate(row.definition);
      if (row.schema !== 1 || !checked.ok || row.definition.service !== service || row.definition.version !== version) throw new Error('Invalid immutable K3s definition.');
      return structuredClone(checked.def);
    } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
  }
  register(definition: ServiceDefinition): void {
    const checked = validate(definition);
    if (!checked.ok) throw new Error('Invalid immutable K3s definition.');
    const existing = this.get(definition.service, definition.version);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(checked.def)) throw new Error('A registered version is immutable; use a new version.');
      return;
    }
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    try { writeFileSync(this.#path(definition.service, definition.version), JSON.stringify({ schema: 1, definition: checked.def }), { flag: 'wx', mode: 0o600 }); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      if (JSON.stringify(this.get(definition.service, definition.version)) !== JSON.stringify(checked.def)) throw new Error('A registered version is immutable; use a new version.');
    }
  }
}
