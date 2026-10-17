// Repository secret scanning (FR-101: "a secret-scanning check runs in CI"; docs/12 §5). It
// reuses the redactor's patterns so the scan and the runtime scrubber agree on what a secret
// looks like. `scripts/secret-scan.mjs` runs it over the tracked files.
//
// A token-shaped match (a provider key, a private key block) is a finding by itself. A context
// match (`password = …`, `Authorization: …`, `scheme://user:pass@`) is a finding only when the
// captured value is a plain literal, not code, a template or a `secret://` reference. Test
// fixtures stay quiet in two ways: values that are obviously fake (they say so, or contain a
// sequential run like `abcdef` / `012345` that real random keys practically never have), and an
// explicit `secret-scan: fake` marker on the line or the line above (`secret-scan: fake-file`
// in the first five lines exempts a whole fixture file). Private key blocks need the marker.
import { basename, extname } from 'node:path';
import { DEFAULT_RULES, type RedactionRule } from './redact.ts';

export interface ScanFinding {
  path: string;
  /** 1-based. */
  line: number;
  column: number;
  rule: string;
  /** A masked preview, safe to print in CI logs. */
  preview: string;
}

export const FAKE_MARKER = 'secret-scan: fake';
export const FAKE_FILE_MARKER = 'secret-scan: fake-file';

const FAKE_WORDS =
  /test|fake|example|dummy|sample|placeholder|redacted|wrong|invalid|changeme|your[-_]|xxxx|\*{4}|\.{3}|…/i;

const CONFIG_EXTENSIONS = new Set([
  '.env',
  '.ini',
  '.cfg',
  '.conf',
  '.properties',
  '.toml',
  '.yml',
  '.yaml',
  '.sh',
  '.bash',
  '.zsh',
]);
const CONFIG_NAMES = /^(?:\.env(?:\..+)?|\.npmrc|\.netrc|\.pypirc|credentials)$/;

/** Whether the file is configuration, where unquoted `key = value` assignments are common. */
export function isConfigFile(path: string): boolean {
  return CONFIG_EXTENSIONS.has(extname(path).toLowerCase()) || CONFIG_NAMES.test(basename(path));
}

/** An ascending run like `abcdef` or `345678`, or one character repeated. */
function hasRun(value: string, length: number): boolean {
  const s = value.toLowerCase();
  let up = 1;
  let same = 1;
  for (let i = 1; i < s.length; i++) {
    const prev = s.charCodeAt(i - 1);
    const cur = s.charCodeAt(i);
    const alnum = /[a-z0-9]/.test(s[i]!) && /[a-z0-9]/.test(s[i - 1]!);
    up = alnum && cur === prev + 1 ? up + 1 : 1;
    same = cur === prev ? same + 1 : 1;
    if (up >= length || same >= length) return true;
  }
  return false;
}

/** True for values that announce themselves as fixtures. Real keys are random. */
export function looksFake(value: string): boolean {
  return FAKE_WORDS.test(value) || hasRun(value, 6);
}

/** A plain literal worth reporting from a context rule (not code, a template or a reference). */
export function isPlainLiteral(value: string): boolean {
  if (value.length < 8) return false;
  if (/[\s$`{}()<>[\]\\]/.test(value)) return false;
  if (value.startsWith('secret://')) return false;
  return /[A-Za-z]/.test(value) && /[0-9]/.test(value);
}

function mask(value: string): string {
  const shown = value.slice(0, 4).replace(/[^\x20-\x7e]/g, '?');
  return `${shown}… (${value.length} chars)`;
}

function scanRules(rules: readonly RedactionRule[]): RedactionRule[] {
  return rules.filter((r) => r.scan !== undefined);
}

const RULES = scanRules(DEFAULT_RULES);

/** Find likely secrets in one file's text. `rules` defaults to the redactor's scan rules. */
export function scanText(
  path: string,
  text: string,
  rules: readonly RedactionRule[] = RULES,
): ScanFinding[] {
  const lines = text.split('\n');
  if (lines.slice(0, 5).some((l) => l.includes(FAKE_FILE_MARKER))) return [];
  const starts: number[] = [];
  let offset = 0;
  for (const l of lines) {
    starts.push(offset);
    offset += l.length + 1;
  }
  const lineOf = (index: number): number => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const config = isConfigFile(path);
  const findings: ScanFinding[] = [];
  // Matched spans, so overlapping rules (a key block and its header) report once.
  const spans: [number, number][] = [];
  for (const rule of scanRules(rules)) {
    if (rule.scan === 'config' && !config) continue;
    rule.pattern.lastIndex = 0;
    for (const m of text.matchAll(rule.pattern)) {
      const secret = rule.group === 'secret' ? m.groups?.secret : m[0];
      if (!secret) continue;
      if (rule.scan !== 'token' && !isPlainLiteral(secret)) continue;
      // Key blocks are exempt from the heuristic: DER bodies have long runs of `A` by nature,
      // so only the explicit marker silences a fixture key.
      if (!rule.id.startsWith('pem') && looksFake(secret)) continue;
      const at = m.index + (rule.group === 'secret' ? m[0].lastIndexOf(secret) : 0);
      const line = lineOf(at);
      if (lines[line]?.includes(FAKE_MARKER) || lines[line - 1]?.includes(FAKE_MARKER)) continue;
      if (spans.some(([s, e]) => at < e && at + secret.length > s)) continue;
      spans.push([at, at + secret.length]);
      findings.push({
        path,
        line: line + 1,
        column: at - starts[line]! + 1,
        rule: rule.id,
        preview: mask(secret),
      });
    }
  }
  return findings.sort((a, b) => a.line - b.line || a.column - b.column);
}
