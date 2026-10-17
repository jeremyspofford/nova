// Command prefix rules (FR-191, docs/12 §3.1). Commands are split into simple commands and words
// by a shell-grammar parser that never expands anything. A rule matches a command's leading words.
//   - A compound command (`;`, `&&`, `||`, `|`, `&`, newline, subshells, groups) matches an
//     allow rule only if every part does; an ask or deny rule applies if any part matches.
//   - Anything that cannot be parsed with certainty (command or process substitution, eval,
//     unbalanced quoting, here-documents with expansion, control structures, function
//     definitions) never matches an allow rule.
//   - Wrappers (sudo, env, nice, timeout, nohup, xargs, `sh -c`, `cmd /c`, `powershell -Command`,
//     ...) and leading VAR=value assignments are looked through for deny and ask rules and never
//     match an allow rule unless the rule names the wrapper.
//   - A path as the command name matches an allow rule only when the rule lists it in
//     `hostExecutables`; deny and ask rules compare its base name.
// An allow decides only whether to ask: it never removes the sandbox (ADR-059).
import type { CommandExample, CommandPatternElement, CommandRule } from './types.ts';

export interface ParsedCommand {
  /** Simple commands, each as its words (quotes removed, nothing expanded). */
  parts: string[][];
  /** False when something could not be parsed with certainty; see `problems`. */
  certain: boolean;
  problems: string[];
}

type Token = { t: 'word'; v: string; quoted: boolean } | { t: 'op'; v: string };

const RESERVED = new Set([
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'do',
  'done',
  'while',
  'until',
  'for',
  'case',
  'esac',
  'in',
  'select',
  'function',
  'coproc',
  '!',
  '[[',
  ']]',
]);
const SEPARATORS = new Set([';', '&&', '||', '|', '|&', '&', '\n', ';;', ';&', ';;&']);
const REDIRECTS = new Set(['>', '>>', '<', '<>', '>|', '>&', '<&', '&>', '&>>', '<<<']);
const OPERATORS = [
  '&>>',
  ';;&',
  '<<<',
  '<<-',
  '&&',
  '||',
  '|&',
  ';;',
  ';&',
  '>>',
  '<<',
  '<>',
  '>|',
  '>&',
  '<&',
  '&>',
  '<(',
  '>(',
  ';',
  '|',
  '&',
  '(',
  ')',
  '<',
  '>',
  '\n',
];
const MAX_DEPTH = 8;

/** Split a command line into simple commands and words without expanding anything. */
export function parseCommand(line: string, depth = 0): ParsedCommand {
  const problems: string[] = [];
  const tokens = tokenize(line, problems);
  const parts: string[][] = [];
  let current: string[] = [];
  let paren = 0;
  const flush = () => {
    if (current.length) parts.push(current);
    current = [];
  };
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok.t === 'op') {
      if (SEPARATORS.has(tok.v)) {
        flush();
      } else if (tok.v === '(') {
        if (current.length) problems.push('function definition');
        flush();
        paren++;
      } else if (tok.v === ')') {
        flush();
        paren--;
        if (paren < 0) problems.push('unbalanced parentheses');
      } else if (tok.v === '<(' || tok.v === '>(') {
        problems.push('process substitution');
      } else if (REDIRECTS.has(tok.v) || tok.v === '<<' || tok.v === '<<-') {
        // The target (or here-document delimiter) is not a command word.
        if (tokens[i + 1]?.t === 'word') i++;
        else problems.push('redirection without a target');
      }
      continue;
    }
    if (current.length === 0 && (tok.v === '{' || tok.v === '}') && !tok.quoted) continue;
    if (current.length === 0 && RESERVED.has(tok.v) && !tok.quoted) {
      problems.push('shell control structure');
      continue;
    }
    current.push(tok.v);
  }
  flush();
  if (paren !== 0 && !problems.includes('unbalanced parentheses'))
    problems.push('unbalanced parentheses');
  for (const p of parts) if (p[0] === 'eval') problems.push('eval');
  if (depth > MAX_DEPTH) problems.push('nested too deeply');
  return { parts, certain: problems.length === 0, problems: [...new Set(problems)] };
}

function tokenize(src: string, problems: string[]): Token[] {
  const out: Token[] = [];
  const heredocs: { delim: string; quoted: boolean; strip: boolean }[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    if (c === ' ' || c === '\t' || c === '\r') {
      i++;
      continue;
    }
    if (c === '\\' && src[i + 1] === '\n') {
      i += 2;
      continue;
    }
    if (c === '#') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '\n' && heredocs.length) {
      out.push({ t: 'op', v: '\n' });
      i = readHeredocs(src, i + 1, heredocs, problems);
      heredocs.length = 0;
      continue;
    }
    const op = OPERATORS.find((o) => src.startsWith(o, i));
    if (op) {
      out.push({ t: 'op', v: op });
      i += op.length;
      if (op === '<<' || op === '<<-') {
        while (src[i] === ' ' || src[i] === '\t') i++;
        const w = readWord(src, i, problems);
        if (w.text === '' && !w.quoted) {
          problems.push('here-document without a delimiter');
        } else {
          heredocs.push({ delim: w.text, quoted: w.quoted, strip: op === '<<-' });
          out.push({ t: 'word', v: w.text, quoted: w.quoted });
        }
        i = w.end;
      }
      continue;
    }
    // An fd number right before a redirection (`2>&1`) belongs to the redirection.
    const fd = /^\d+(?=[<>])/.exec(src.slice(i));
    if (fd) {
      i += fd[0].length;
      continue;
    }
    const w = readWord(src, i, problems);
    out.push({ t: 'word', v: w.text, quoted: w.quoted });
    i = w.end;
  }
  if (heredocs.length) problems.push('unterminated here-document');
  return out;
}

function readHeredocs(
  src: string,
  start: number,
  docs: { delim: string; quoted: boolean; strip: boolean }[],
  problems: string[],
): number {
  let i = start;
  for (const doc of docs) {
    let found = false;
    let body = '';
    while (i <= src.length) {
      const nl = src.indexOf('\n', i);
      const end = nl === -1 ? src.length : nl;
      const raw = src.slice(i, end);
      i = end + 1;
      if ((doc.strip ? raw.replace(/^\t+/, '') : raw) === doc.delim) {
        found = true;
        break;
      }
      body += `${raw}\n`;
      if (nl === -1) break;
    }
    if (!found) problems.push('unterminated here-document');
    if (!doc.quoted && /[$`]/.test(body)) problems.push('here-document with expansion');
  }
  return Math.min(i, src.length);
}

const WORD_END = /[\s;&|<>()]/;

function readWord(
  src: string,
  start: number,
  problems: string[],
): { text: string; quoted: boolean; end: number } {
  let i = start;
  let text = '';
  let quoted = false;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    if (WORD_END.test(c)) break;
    if (c === "'") {
      quoted = true;
      const close = src.indexOf("'", i + 1);
      if (close === -1) {
        problems.push('unbalanced quotes');
        text += src.slice(i + 1);
        i = n;
        break;
      }
      text += src.slice(i + 1, close);
      i = close + 1;
      continue;
    }
    if (c === '"') {
      quoted = true;
      i++;
      let closed = false;
      while (i < n) {
        const d = src[i]!;
        if (d === '"') {
          closed = true;
          i++;
          break;
        }
        if (d === '\\' && i + 1 < n) {
          const e = src[i + 1]!;
          if (e === '\n') {
            i += 2;
            continue;
          }
          text += '$`"\\'.includes(e) ? e : `\\${e}`;
          i += 2;
          continue;
        }
        if (d === '`' || (d === '$' && src[i + 1] === '(')) problems.push('command substitution');
        text += d;
        i++;
      }
      if (!closed) problems.push('unbalanced quotes');
      continue;
    }
    if (c === '\\') {
      if (src[i + 1] === '\n') {
        i += 2;
        continue;
      }
      if (i + 1 < n) text += src[i + 1];
      i += 2;
      continue;
    }
    if (c === '`') {
      problems.push('command substitution');
      const close = src.indexOf('`', i + 1);
      if (close === -1) problems.push('unbalanced quotes');
      text += src.slice(i, close === -1 ? n : close + 1);
      i = close === -1 ? n : close + 1;
      continue;
    }
    if (c === '$' && src[i + 1] === '(') {
      problems.push('command substitution');
      let depth = 0;
      let j = i + 1;
      for (; j < n; j++) {
        if (src[j] === '(') depth++;
        else if (src[j] === ')' && --depth === 0) break;
      }
      if (j >= n) problems.push('unbalanced parentheses');
      text += src.slice(i, Math.min(j + 1, n));
      i = j + 1;
      continue;
    }
    if (c === '$' && src[i + 1] === '{') {
      const close = src.indexOf('}', i + 2);
      const inner = src.slice(i, close === -1 ? n : close + 1);
      if (close === -1) problems.push('unbalanced braces');
      if (/[`]|\$\(/.test(inner)) problems.push('command substitution');
      text += inner;
      i = close === -1 ? n : close + 1;
      continue;
    }
    text += c;
    i++;
  }
  return { text, quoted, end: i };
}

// ---- wrappers ----------------------------------------------------------------------------------

/** Options (of each wrapper) that take a separate argument. */
const WRAPPER_ARGS: Record<string, ReadonlySet<string>> = {
  sudo: new Set(['-u', '-g', '-h', '-p', '-C', '-U', '-r', '-t', '-D', '-R', '-T']),
  doas: new Set(['-u', '-C']),
  env: new Set(['-u', '-C', '--unset', '--chdir']),
  nice: new Set(['-n', '--adjustment']),
  timeout: new Set(['-s', '-k', '--signal', '--kill-after']),
  xargs: new Set(['-I', '-n', '-P', '-d', '-E', '-L', '-s', '-a', '--max-args', '--delimiter']),
  stdbuf: new Set(['-i', '-o', '-e']),
  ionice: new Set(['-c', '-n', '-t', '-p']),
  exec: new Set(['-a']),
};
const SIMPLE_WRAPPERS = new Set([
  'sudo',
  'doas',
  'env',
  'nice',
  'timeout',
  'nohup',
  'xargs',
  'time',
  'command',
  'builtin',
  'exec',
  'stdbuf',
  'ionice',
  'setsid',
  'busybox',
]);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'fish', 'mksh']);
const POWERSHELLS = new Set(['powershell', 'pwsh']);
const INTERPRETERS = new Set([
  'python',
  'python2',
  'python3',
  'node',
  'nodejs',
  'deno',
  'bun',
  'ruby',
  'perl',
  'php',
  'lua',
  'irb',
  'R',
  'Rscript',
  'osascript',
  'tclsh',
]);

/** The command name as deny and ask rules compare it: base name, no Windows extension. */
export function programName(word: string): string {
  const base = word.replace(/\\/g, '/').split('/').at(-1) ?? word;
  return base.replace(/\.(exe|cmd|bat|com)$/i, '');
}

/** What kind of program a command runs; shells and interpreters run whatever they are given. */
export function classifyProgram(words: readonly string[]): 'shell' | 'interpreter' | 'program' {
  const name = programName(words[0] ?? '');
  if (SHELLS.has(name) || POWERSHELLS.has(name.toLowerCase()) || name.toLowerCase() === 'cmd')
    return 'shell';
  if (INTERPRETERS.has(name) || /^python\d(\.\d+)?$/.test(name)) return 'interpreter';
  return 'program';
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Every word list a deny or ask rule is checked against: the part itself, then what each wrapper
 * runs (recursively, including `sh -c` scripts). `problems` collects anything uncertain found in
 * nested scripts.
 */
export function lookThrough(
  words: readonly string[],
  problems: string[] = [],
  depth = 0,
): string[][] {
  const out: string[][] = [[...words]];
  if (depth > MAX_DEPTH || words.length === 0) return out;
  let rest: string[] | null = null;
  if (ASSIGNMENT.test(words[0]!)) {
    let k = 0;
    while (k < words.length && ASSIGNMENT.test(words[k]!)) k++;
    rest = words.slice(k);
  } else {
    const name = programName(words[0]!);
    const lower = name.toLowerCase();
    if (SIMPLE_WRAPPERS.has(name)) {
      rest = afterOptions(name, words.slice(1), problems, depth);
    } else if (name === 'eval') {
      problems.push('eval');
      return [...out, ...nested(words.slice(1).join(' '), problems, depth)];
    } else if (SHELLS.has(name)) {
      const idx = words.findIndex((w, k) => k > 0 && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(w));
      if (idx > 0 && words[idx + 1] !== undefined) {
        return [...out, ...nested(words[idx + 1]!, problems, depth)];
      }
    } else if (lower === 'cmd') {
      const idx = words.findIndex((w) => /^\/[ck]$/i.test(w));
      if (idx > 0) return [...out, ...nested(words.slice(idx + 1).join(' '), problems, depth)];
    } else if (POWERSHELLS.has(lower)) {
      const idx = words.findIndex(
        (w, k) => k > 0 && /^-(c|co|com|comm|comma|comman|command)$/i.test(w),
      );
      if (idx > 0) return [...out, ...nested(words.slice(idx + 1).join(' '), problems, depth)];
      if (words.some((w) => /^-(e|ec|enc|encodedcommand)$/i.test(w)))
        problems.push('encoded command');
    }
  }
  if (rest && rest.length) out.push(...lookThrough(rest, problems, depth + 1));
  return out;
}

function nested(script: string, problems: string[], depth: number): string[][] {
  const parsed = parseCommand(script, depth + 1);
  problems.push(...parsed.problems);
  return parsed.parts.flatMap((p) => lookThrough(p, problems, depth + 1));
}

function afterOptions(
  name: string,
  args: string[],
  problems: string[],
  depth: number,
): string[] | null {
  const takesArg = WRAPPER_ARGS[name] ?? new Set<string>();
  let k = 0;
  while (k < args.length) {
    const a = args[k]!;
    if (a === '--') {
      k++;
      break;
    }
    if (name === 'env' && (a === '-S' || a.startsWith('--split-string'))) {
      const script = a.includes('=') ? a.slice(a.indexOf('=') + 1) : args[k + 1];
      if (script !== undefined) {
        const parsed = parseCommand(script, depth + 1);
        problems.push(...parsed.problems);
        return [...(parsed.parts[0] ?? []), ...args.slice(k + (a.includes('=') ? 1 : 2))];
      }
      return null;
    }
    if (name === 'env' && ASSIGNMENT.test(a)) {
      k++;
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      k += takesArg.has(a) ? 2 : 1;
      continue;
    }
    // `nice -10 cmd` and `timeout 5 cmd`: a bare number or duration before the command.
    if ((name === 'timeout' || name === 'nice') && /^\d+(\.\d+)?[smhd]?$/.test(a)) {
      k++;
      continue;
    }
    break;
  }
  return args.slice(k);
}

// ---- matching -----------------------------------------------------------------------------------

function elementMatches(el: CommandPatternElement, word: string): boolean {
  return typeof el === 'string' ? el === word : el.includes(word);
}

/** Allow semantics: the raw words start with the pattern; a path command needs hostExecutables. */
export function prefixMatchesRaw(
  pattern: readonly CommandPatternElement[],
  words: readonly string[],
  hostExecutables: readonly string[] = [],
): boolean {
  if (words.length < pattern.length || pattern.length === 0) return false;
  return pattern.every((el, i) => {
    const w = words[i]!;
    if (i === 0 && /[/\\]/.test(w)) {
      return hostExecutables.includes(w) && elementMatches(el, programName(w));
    }
    return elementMatches(el, w);
  });
}

/** Deny/ask semantics: the command name is compared by base name, case-insensitively. */
function prefixMatchesLoose(
  pattern: readonly CommandPatternElement[],
  words: readonly string[],
): boolean {
  if (words.length < pattern.length || pattern.length === 0) return false;
  return pattern.every((el, i) => {
    if (i > 0) return elementMatches(el, words[i]!);
    const w = programName(words[0]!).toLowerCase();
    return typeof el === 'string'
      ? programName(el).toLowerCase() === w
      : el.some((x) => programName(x).toLowerCase() === w);
  });
}

function toParsed(example: CommandExample): ParsedCommand {
  if (typeof example === 'string') return parseCommand(example);
  return { parts: [[...example]], certain: true, problems: [] };
}

function restrictMatch(rule: Pick<CommandRule, 'pattern'>, parsed: ParsedCommand): boolean {
  const problems: string[] = [];
  return parsed.parts.some((p) =>
    lookThrough(p, problems).some((v) => prefixMatchesLoose(rule.pattern, v)),
  );
}

/**
 * Whether a command matches one rule under that rule's semantics: an allow rule must cover every
 * part of a command parsed with certainty; an ask or deny rule applies if any part (or anything a
 * wrapper in it runs) starts with its pattern.
 */
export function commandMatchesRule(
  rule: Pick<CommandRule, 'pattern' | 'decision' | 'hostExecutables'>,
  command: CommandExample,
): boolean {
  const parsed = toParsed(command);
  if (rule.decision === 'allow') {
    if (!parsed.certain || parsed.parts.length === 0) return false;
    const nestedProblems: string[] = [];
    for (const p of parsed.parts) lookThrough(p, nestedProblems);
    if (nestedProblems.length) return false;
    return parsed.parts.every((p) => prefixMatchesRaw(rule.pattern, p, rule.hostExecutables));
  }
  return restrictMatch(rule, parsed);
}

export type CommandRuleProblem =
  | { kind: 'pattern'; message: string }
  | { kind: 'example'; example: string; expected: 'match' | 'no_match'; message: string };

function exampleText(e: CommandExample): string {
  return typeof e === 'string' ? e : e.join(' ');
}

/** Check one rule's shape and its examples (docs/12 §3.1 load-time examples). */
export function checkCommandRule(
  rule: Pick<
    CommandRule,
    'pattern' | 'decision' | 'hostExecutables' | 'matchExamples' | 'notMatchExamples'
  >,
): CommandRuleProblem | null {
  if (rule.pattern.length === 0)
    return { kind: 'pattern', message: 'the pattern needs at least one word' };
  for (const el of rule.pattern) {
    const alts = typeof el === 'string' ? [el] : el;
    if (typeof el !== 'string' && (el.length < 2 || new Set(el).size !== el.length))
      return { kind: 'pattern', message: 'alternatives need at least two different words' };
    if (alts.some((w) => w.length === 0 || /\s/.test(w)))
      return { kind: 'pattern', message: 'pattern words cannot be empty or contain spaces' };
  }
  if (rule.matchExamples.length === 0 || rule.notMatchExamples.length === 0)
    return {
      kind: 'pattern',
      message: 'a rule needs at least one match and one non-match example',
    };
  for (const ex of rule.matchExamples) {
    if (!commandMatchesRule(rule, ex))
      return {
        kind: 'example',
        example: exampleText(ex),
        expected: 'match',
        message: `the example "${exampleText(ex)}" should match the rule but does not`,
      };
  }
  for (const ex of rule.notMatchExamples) {
    if (commandMatchesRule(rule, ex))
      return {
        kind: 'example',
        example: exampleText(ex),
        expected: 'no_match',
        message: `the example "${exampleText(ex)}" should not match the rule but does`,
      };
  }
  return null;
}

/**
 * Load a rule file: every rule's examples must pass, or the whole set is rejected (the caller
 * keeps its previous version).
 */
export function loadCommandRules(
  rules: readonly CommandRule[],
): { ok: true; rules: CommandRule[] } | { ok: false; ruleId: string; problem: CommandRuleProblem } {
  for (const r of rules) {
    const problem = checkCommandRule(r);
    if (problem) return { ok: false, ruleId: r.id, problem };
  }
  return { ok: true, rules: [...rules] };
}

export interface CommandEvaluation {
  decision: 'allow' | 'ask' | 'deny' | null;
  ruleId: string | null;
  /** The justification of the deciding rule, or why nothing decided. */
  reason: string;
  program: 'shell' | 'interpreter' | 'program';
  certain: boolean;
}

/**
 * Evaluate a command against rules already filtered to the call's scope and tool, in precedence
 * order (most specific scope first, then priority). Per part: any matching deny wins, else the
 * first matching ask or allow. Then any deny part denies, any ask part asks, and only a command
 * whose every part is allowed is allowed; otherwise no rule decides (null).
 */
export function evaluateCommand(command: string, rules: readonly CommandRule[]): CommandEvaluation {
  const parsed = parseCommand(command);
  const nestedProblems: string[] = [];
  const variants = parsed.parts.map((p) => lookThrough(p, nestedProblems));
  const certain = parsed.certain && nestedProblems.length === 0;
  const program = classifyProgram(parsed.parts[0] ?? []);
  const active = rules.filter((r) => r.enabled !== false);
  const results = parsed.parts.map((part, i) => {
    const deny = active.find(
      (r) => r.decision === 'deny' && variants[i]!.some((v) => prefixMatchesLoose(r.pattern, v)),
    );
    if (deny) return deny;
    return (
      active.find((r) =>
        r.decision === 'ask'
          ? variants[i]!.some((v) => prefixMatchesLoose(r.pattern, v))
          : r.decision === 'allow' &&
            certain &&
            prefixMatchesRaw(r.pattern, part, r.hostExecutables),
      ) ?? null
    );
  });
  const base = { program, certain };
  const why = (r: CommandRule, fallback: string) => r.justification ?? fallback;
  const deny = results.find((r) => r?.decision === 'deny');
  if (deny)
    return {
      ...base,
      decision: 'deny',
      ruleId: deny.id,
      reason: why(deny, 'a command rule denies this command'),
    };
  const ask = results.find((r) => r?.decision === 'ask');
  if (ask)
    return {
      ...base,
      decision: 'ask',
      ruleId: ask.id,
      reason: why(ask, 'a command rule asks before this command'),
    };
  if (results.length > 0 && results.every((r) => r?.decision === 'allow')) {
    const first = results[0]!;
    return {
      ...base,
      decision: 'allow',
      ruleId: first.id,
      reason: why(first, 'allowed by a command rule'),
    };
  }
  let reason = 'no command rule covers this command';
  if (!certain) {
    reason = `the command could not be parsed with certainty (${[...new Set([...parsed.problems, ...nestedProblems])].join(', ')})`;
  } else {
    const uncovered = parsed.parts.find((_, i) => results[i] === null);
    if (uncovered && results.some((r) => r !== null))
      reason = `"${uncovered.join(' ')}" is not covered by a command rule`;
  }
  return { ...base, decision: null, ruleId: null, reason };
}

/** Whether a grant's prefix covers a command (allow semantics). */
export function commandCoveredBy(
  pattern: readonly CommandPatternElement[],
  command: string,
): boolean {
  return commandMatchesRule({ pattern, decision: 'allow' }, command);
}

const PLAIN_WORD = /^[A-Za-z0-9][A-Za-z0-9_.:@+-]*$/;
const RUNNER_WORDS = new Set(['run', 'exec', 'compose']);
const OTHER_WORDS = ['install', 'push', 'publish', 'rm'];

/**
 * The prefix rule an "Always allow" card suggests for a command (docs/12 §3.1): the leading plain
 * words (up to 2, or 3 for `npm run x`-style runners and `python -m module`), the approved
 * command as a match example and one command the rule will not cover. Null when no safe prefix
 * exists: an uncertain parse, a compound command, a wrapper, a shell, an interpreter running
 * inline code or nothing at all, or a path as the command.
 */
export function suggestPrefixRule(
  command: string,
): { pattern: string[]; matchExamples: string[]; notMatchExamples: string[] } | null {
  const parsed = parseCommand(command);
  if (!parsed.certain || parsed.parts.length !== 1) return null;
  const words = parsed.parts[0]!;
  const first = words[0]!;
  if (!PLAIN_WORD.test(first) || ASSIGNMENT.test(first) || SIMPLE_WRAPPERS.has(first)) return null;
  const kind = classifyProgram(words);
  if (kind === 'shell' || first === 'eval') return null;
  let pattern: string[];
  if (kind === 'interpreter') {
    const second = words[1];
    if (second === '-m' && words[2] && PLAIN_WORD.test(words[2])) pattern = [first, '-m', words[2]];
    else if (second && !second.startsWith('-') && PLAIN_WORD.test(second))
      pattern = [first, second];
    else return null;
  } else {
    pattern = [first];
    const max = RUNNER_WORDS.has(words[1] ?? '') ? 3 : 2;
    for (let i = 1; i < words.length && pattern.length < max; i++) {
      const w = words[i]!;
      if (w.startsWith('-') || !PLAIN_WORD.test(w)) break;
      pattern.push(w);
    }
  }
  const last = pattern.at(-1)!;
  const other =
    pattern.length >= 2
      ? [...pattern.slice(0, -1), OTHER_WORDS.find((w) => w !== last)!].join(' ')
      : `sudo ${first}`;
  return { pattern, matchExamples: [command.trim()], notMatchExamples: [other] };
}
