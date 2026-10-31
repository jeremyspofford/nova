// The amendment's closing rule: no capability may be claimed in onboarding, docs or the UI that
// the eval suite can't demonstrate. A register of the claims Nova makes (each with its file and
// exact words, re-found on every check so the register can't drift from the copy) is compared with
// what the suite demonstrates: the `demonstrates` tags of REGRESSION tasks (a capability task is
// expected to fail sometimes, so it backs nothing). Unbacked claims are reported, not removed.
import type { TaskBase } from './types.ts';

export interface Claim {
  id: string;
  // The file, from the repository root, and the claim's exact words in it.
  where: string;
  text: string;
  // The tags that would back it. Empty: nothing in the suite does yet.
  needs: string[];
  note?: string;
}

// Tag → the regression tasks that demonstrate it (only those that passed, when `passed` is given).
export function demonstrated(tasks: readonly TaskBase[], passed?: ReadonlySet<string>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const t of tasks) {
    if (t.suite !== 'regression' || (passed && !passed.has(t.id))) continue;
    for (const tag of t.demonstrates) out.set(tag, [...(out.get(tag) ?? []), t.id]);
  }
  return new Map([...out].sort(([a], [b]) => a.localeCompare(b)));
}

export interface ClaimsReport {
  backed: { claim: Claim; by: string[] }[];
  unbacked: { claim: Claim; missing: string[] }[];
  // The register is wrong: a claim's words aren't in its file any more, or it names a tag that no
  // task anywhere carries (a typo, or a task that was removed).
  drift: { claim: Claim; why: string }[];
}

export function checkClaims(claims: readonly Claim[], shown: Map<string, string[]>, o: { read: (file: string) => string | null; knownTags: ReadonlySet<string> }): ClaimsReport {
  const report: ClaimsReport = { backed: [], unbacked: [], drift: [] };
  const flat = (s: string) => s.replace(/\s+/g, ' ');
  for (const c of claims) {
    const text = o.read(c.where);
    if (text === null) { report.drift.push({ claim: c, why: `${c.where} isn’t there` }); continue; }
    if (!flat(text).includes(flat(c.text))) { report.drift.push({ claim: c, why: `“${c.text}” is no longer in ${c.where}` }); continue; }
    const unknown = c.needs.filter((t) => !o.knownTags.has(t));
    if (unknown.length) { report.drift.push({ claim: c, why: `no task carries ${unknown.join(', ')}` }); continue; }
    const missing = c.needs.filter((t) => !shown.has(t));
    if (!c.needs.length || missing.length) report.unbacked.push({ claim: c, missing: c.needs.length ? missing : ['(no task demonstrates this)'] });
    else report.backed.push({ claim: c, by: [...new Set(c.needs.flatMap((t) => shown.get(t) ?? []))] });
  }
  return report;
}
