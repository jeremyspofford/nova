// The verification layer (WORK-LEDGER-AND-VERIFICATION): a report's evidence is checked against
// the brief's requirements before a task may be done. Nova checks the target itself rather than
// trusting the worker's claim; a kind of evidence Nova can't check yet fails, it never passes.
import type { Brief, Evidence, EvidenceRequirement, Report } from './envelope.ts';
import { sha256, type Workspace } from './workspace.ts';

export interface Check {
  requirement: EvidenceRequirement;
  evidence: Evidence | null;
  ok: boolean;
  why: string;
}

export interface Verification {
  ok: boolean;
  checks: Check[];
  at: string;
}

// The brief comes along so a checker can find what the task was about (where to look).
export type Checker = (e: Evidence, brief: Brief) => { ok: boolean; why: string };

export class Verifier {
  #checkers = new Map<string, Checker>();
  #tests = new Map<string, Checker>();
  #confirmations = new Map<string, Checker>();
  #now: () => Date;
  #ws: Workspace;

  constructor(ws: Workspace, now: () => Date = () => new Date()) {
    this.#now = now;
    this.#ws = ws;
    this.#checkers.set('read_back', (e) => {
      if (e.kind !== 'read_back') return { ok: false, why: 'Not a read-back.' };
      let data: Buffer | null;
      try {
        data = ws.read(e.target);
      } catch (err) {
        return { ok: false, why: (err as Error).message };
      }
      if (!data) return { ok: false, why: `Nova looked for ${e.target} and it isn't there.` };
      const actual = sha256(data);
      if (actual !== e.sha256 || data.length !== e.bytes) {
        return { ok: false, why: `Nova read ${e.target} itself and it doesn't match the report (${data.length} bytes, sha256 ${actual.slice(0, 12)}…; the report said ${e.bytes} bytes, ${e.sha256.slice(0, 12)}…).` };
      }
      return { ok: true, why: `Nova read ${e.target} itself: ${data.length} bytes, sha256 ${actual.slice(0, 12)}…, as reported.` };
    });
    // A test result counts only if the module that owns the test can run it again itself.
    this.#checkers.set('test_result', (e, brief) => {
      if (e.kind !== 'test_result') return { ok: false, why: 'Not a test result.' };
      const check = [...this.#tests].find(([prefix]) => e.name.startsWith(prefix))?.[1];
      if (!check) return { ok: false, why: `Nova can't re-run the test "${e.name}" yet, so it can't count as proof.` };
      return check(e, brief);
    });
    // A confirmation id counts only if Nova can look it up in that system itself.
    this.#checkers.set('confirmation', (e, brief) => {
      if (e.kind !== 'confirmation') return { ok: false, why: 'Not a confirmation.' };
      const check = this.#confirmations.get(e.system);
      if (!check) return { ok: false, why: `Nova can't check confirmations from ${e.system} yet, so it can't count as proof.` };
      return check(e, brief);
    });
  }

  // Lets another module check its own test results, by name prefix ("template:").
  registerTest(prefix: string, check: Checker): void {
    if (this.#tests.has(prefix)) throw new Error(`Tests named ${prefix}… already have a checker.`);
    this.#tests.set(prefix, check);
  }

  // Lets another module confirm ids from a system it can read itself ("nova-sessions").
  registerConfirmation(system: string, check: Checker): void {
    if (this.#confirmations.has(system)) throw new Error(`Confirmations from ${system} already have a checker.`);
    this.#confirmations.set(system, check);
  }

  // "notes/a.md" and "workspace:notes/a.md" are the same file.
  #same(a: string, b: string): boolean {
    if (a === b) return true;
    try {
      return this.#ws.target(this.#ws.resolve(a)) === this.#ws.target(this.#ws.resolve(b));
    } catch {
      return false;
    }
  }

  kinds(): string[] {
    return [...this.#checkers.keys()];
  }

  verify(brief: Brief, report: Report): Verification {
    const checks = brief.evidence_required.map((req): Check => {
      const candidates = report.evidence.filter((e) => e.kind === req.kind && (!req.target || ('target' in e && this.#same(e.target, req.target))));
      if (!candidates.length) return { requirement: req, evidence: null, ok: false, why: `The report has no ${req.kind.replace('_', '-')} evidence${req.target ? ` for ${req.target}` : ''}.` };
      const checker = this.#checkers.get(req.kind);
      if (!checker) return { requirement: req, evidence: candidates[0] ?? null, ok: false, why: `Nova can't check ${req.kind.replace('_', '-')} evidence yet, so it can't count as proof.` };
      const results = candidates.map((e) => ({ e, r: checker(e, brief) }));
      const best = results.find((x) => x.r.ok) ?? results[0]!;
      return { requirement: req, evidence: best.e, ok: best.r.ok, why: best.r.why };
    });
    const ok = checks.length > 0 && checks.every((c) => c.ok);
    return { ok, checks, at: this.#now().toISOString() };
  }
}
