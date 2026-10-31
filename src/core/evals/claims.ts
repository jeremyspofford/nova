// The amendment's closing rule: no capability may be claimed in onboarding, docs or the UI that
// the eval suite can't demonstrate. A register of the claims Nova makes (each with its file and
// exact words, re-found on every check so the register can't drift from the copy) is compared with
// what the suite demonstrates: the `demonstrates` tags of REGRESSION tasks (a capability task is
// expected to fail sometimes, so it backs nothing).
//
// The owner's decision of 2026-10-31: a claim the suite can't back doesn't stand in user-facing
// text. It is softened to what the evidence supports, and the register keeps its old, strong
// words (`strong`, which must not be in its file any more) and names the eval case that would
// prove them (`eval`, built by Track 3). When that eval passes, the strong words may return,
// citing it (its tag goes in `needs`). An instruction to the model ("never promise ...") is not a
// claim to the person: it stays, and is listed with the eval that would show it is followed.
import type { TaskBase } from './types.ts';

export interface Claim {
  id: string;
  // The file, from the repository root, and the claim's exact words in it.
  where: string;
  text: string;
  // The tags that would back it. Empty: nothing in the suite does yet.
  needs: string[];
  note?: string;
  // Softened: the words it had before, which claimed more than the suite shows.
  strong?: string;
  // The eval case that would prove the strong words, `claim.<slug>` (Track 3's backlog).
  eval?: string;
  // How load-bearing the claim is: 1 safety, privacy and approvals; 2 a capability the person
  // relies on; 3 the rest.
  priority?: 1 | 2 | 3;
  // An instruction to the model rather than a claim to the person.
  kind?: 'claim' | 'instruction';
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
  // Softened to what the evidence supports; the strong words wait for their eval.
  softened: { claim: Claim }[];
  // Instructions to the model, waiting for the eval that shows they are followed.
  instructions: { claim: Claim }[];
  // Claims in user-facing text the suite can't back, and that weren't softened: the closing rule
  // fails CI on any of these (tests/core/evals.test.ts).
  unbacked: { claim: Claim; missing: string[] }[];
  // The register is wrong: a claim's words aren't in its file any more, or it names a tag that no
  // task anywhere carries (a typo, or a task that was removed).
  drift: { claim: Claim; why: string }[];
}

export function checkClaims(claims: readonly Claim[], shown: Map<string, string[]>, o: { read: (file: string) => string | null; knownTags: ReadonlySet<string> }): ClaimsReport {
  const report: ClaimsReport = { backed: [], softened: [], instructions: [], unbacked: [], drift: [] };
  const flat = (s: string) => s.replace(/\s+/g, ' ');
  for (const c of claims) {
    const text = o.read(c.where);
    if (text === null) { report.drift.push({ claim: c, why: `${c.where} isn’t there` }); continue; }
    if (!flat(text).includes(flat(c.text))) { report.drift.push({ claim: c, why: `“${c.text}” is no longer in ${c.where}` }); continue; }
    const unknown = c.needs.filter((t) => !o.knownTags.has(t));
    if (unknown.length) { report.drift.push({ claim: c, why: `no task carries ${unknown.join(', ')}` }); continue; }
    const missing = c.needs.filter((t) => !shown.has(t));
    const backed = c.needs.length > 0 && !missing.length;
    // The strong words came back to the file without an eval backing them.
    if (c.strong && !backed && flat(text).includes(flat(c.strong))) { report.drift.push({ claim: c, why: `the strong words “${c.strong}” are back in ${c.where} without an eval backing them` }); continue; }
    if (backed) report.backed.push({ claim: c, by: [...new Set(c.needs.flatMap((t) => shown.get(t) ?? []))] });
    else if (c.kind === 'instruction') report.instructions.push({ claim: c });
    else if (c.strong) report.softened.push({ claim: c });
    else report.unbacked.push({ claim: c, missing: c.needs.length ? missing : ['(no task demonstrates this)'] });
  }
  return report;
}
