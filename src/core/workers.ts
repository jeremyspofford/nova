// Workers do delegated work: they take a Brief and return a Report (CONTRACTS §1). A worker
// never talks to the person. Each declares where its data can go (`egress`), so the ledger can
// refuse to hand a local-only task to anything that would send it off this machine.
import type { Brief, EvidenceKind, PrivacyMode } from './envelope.ts';

// none: stays in this process. local: other devices in the person's mesh. remote: leaves the mesh.
export type Egress = 'none' | 'local' | 'remote';

export interface WorkerInfo {
  id: string;
  name: string;
  about: string;
  egress: Egress;
  evidence: EvidenceKind[];
}

export interface Worker extends WorkerInfo {
  // Returns a report candidate; the ledger validates it against the envelope before using it.
  run(brief: Brief, signal: AbortSignal): Promise<unknown>;
  health(): { ok: boolean; detail?: string };
  // How long one run may take before the ledger stops waiting; the ledger's default otherwise.
  timeoutMs?: number;
  // A worker whose reach depends on the brief (a browser task's declared hosts) says where this
  // brief's data would go; `egress` is then the most it could ever reach. It throws a validation
  // error for a brief it could never run, so a bad one is refused when it is delegated.
  egressFor?(brief: Brief): Egress;
}

export const egressOf = (w: Worker, brief: Brief): Egress => w.egressFor?.(brief) ?? w.egress;

const STRICTNESS: PrivacyMode[] = ['local-only', 'local-preferred', 'cloud-allowed'];
export const stricter = (a: PrivacyMode, b: PrivacyMode): PrivacyMode => (STRICTNESS.indexOf(a) <= STRICTNESS.indexOf(b) ? a : b);

// LOCAL-FIRST-AND-DEVICE-MESH §2: local-only never reaches beyond the mesh. The other modes may,
// and the context receipt (M2) discloses it.
export function permits(mode: PrivacyMode, egress: Egress): boolean {
  return mode === 'local-only' ? egress !== 'remote' : true;
}

export function info(w: Worker): WorkerInfo & { health: { ok: boolean; detail?: string } } {
  const { id, name, about, egress, evidence } = w;
  return { id, name, about, egress, evidence, health: w.health() };
}
