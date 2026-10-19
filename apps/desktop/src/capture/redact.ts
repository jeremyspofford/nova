// Redaction of captured window text (FR-214, FR-101) with the default rules of @nova/security,
// counting what each rule masked. It runs in a utility process (redact-worker.ts) so a slow
// input never blocks the shell's main process.
import { DEFAULT_RULES, REDACTED, Redactor } from '@nova/security';

export interface RedactJob {
  title: string;
  text: string | null;
}

export interface RedactResult {
  title: string;
  text: string | null;
  redactions: { rule: string; count: number }[];
}

function countRedacted(s: string): number {
  return s.split(REDACTED).length - 1;
}

/** Redact text with every default rule, counting what each rule masked. */
export function redactText(text: string): {
  text: string;
  redactions: { rule: string; count: number }[];
} {
  let out = text;
  const redactions: { rule: string; count: number }[] = [];
  for (const rule of DEFAULT_RULES) {
    const before = countRedacted(out);
    out = new Redactor([rule]).redactString(out);
    const n = countRedacted(out) - before;
    if (n > 0) redactions.push({ rule: rule.id, count: n });
  }
  return { text: out, redactions };
}

/** One capture's title and text, redacted together. */
export function redactJob(job: RedactJob): RedactResult {
  const title = redactText(job.title);
  const text = job.text === null ? null : redactText(job.text);
  const counts = new Map<string, number>();
  for (const r of [...title.redactions, ...(text?.redactions ?? [])])
    counts.set(r.rule, (counts.get(r.rule) ?? 0) + r.count);
  return {
    title: title.text,
    text: text?.text ?? null,
    redactions: [...counts].map(([rule, count]) => ({ rule, count })),
  };
}
