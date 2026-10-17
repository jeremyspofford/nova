// A small built-in syntax highlighter for code artifacts and code blocks (FR-038, docs/04 §4.2
// CodeBlock). One pass of a combined regular expression per language family classifies comments,
// strings, numbers, keywords and markup; everything else stays plain text. It only splits text
// into typed tokens: the caller renders them as text nodes, so nothing is ever parsed as HTML.

export type TokenType =
  'plain' | 'comment' | 'string' | 'number' | 'keyword' | 'literal' | 'tag' | 'attr';

export interface Token {
  type: TokenType;
  text: string;
}

export type CodeLanguage =
  | 'js'
  | 'json'
  | 'python'
  | 'bash'
  | 'css'
  | 'html'
  | 'sql'
  | 'go'
  | 'rust'
  | 'java'
  | 'c'
  | 'yaml'
  | 'toml';

const ALIASES: Record<string, CodeLanguage> = {
  js: 'js',
  jsx: 'js',
  mjs: 'js',
  cjs: 'js',
  javascript: 'js',
  ts: 'js',
  tsx: 'js',
  mts: 'js',
  typescript: 'js',
  json: 'json',
  jsonc: 'json',
  py: 'python',
  python: 'python',
  sh: 'bash',
  bash: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  css: 'css',
  scss: 'css',
  html: 'html',
  htm: 'html',
  xml: 'html',
  svg: 'html',
  sql: 'sql',
  go: 'go',
  golang: 'go',
  rs: 'rust',
  rust: 'rust',
  java: 'java',
  kotlin: 'java',
  kt: 'java',
  c: 'c',
  h: 'c',
  cpp: 'c',
  'c++': 'c',
  cc: 'c',
  hpp: 'c',
  cs: 'c',
  csharp: 'c',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
};

/** The language family for a name, alias or file extension; null when it is not supported. */
export function normalizeLanguage(name: string | null | undefined): CodeLanguage | null {
  if (!name) return null;
  const key = name
    .trim()
    .toLowerCase()
    .replace(/^\./, '')
    .replace(/^language-/, '');
  return ALIASES[key] ?? null;
}

/** Larger inputs are shown as plain text so highlighting never stalls the page. */
export const HIGHLIGHT_LIMIT = 200_000;

type Rule = readonly [TokenType, string];

interface Spec {
  /** Ordered: the first alternative that matches at a position wins. */
  rules: Rule[];
  keywords?: Set<string>;
  literals?: Set<string>;
  caseInsensitive?: boolean;
}

const words = (s: string) => new Set(s.split(/\s+/).filter(Boolean));

const LINE_SLASH = String.raw`\/\/[^\n]*`;
const BLOCK = String.raw`\/\*[\s\S]*?(?:\*\/|$)`;
const HASH = String.raw`#[^\n]*`;
const DQ = String.raw`"(?:[^"\\\n]|\\.)*"?`;
const SQ = String.raw`'(?:[^'\\\n]|\\.)*'?`;
const BT = String.raw`\x60(?:[^\x60\\]|\\.)*\x60?`;
const NUM = String.raw`\b(?:0[xX][\da-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)[nLuUfF]*\b`;
const WORD = String.raw`[A-Za-z_$][\w$]*`;

const C_LIKE_LITERALS = words('true false null undefined nil NaN Infinity this self super');

const SPECS: Record<CodeLanguage, Spec> = {
  js: {
    rules: [
      ['comment', LINE_SLASH],
      ['comment', BLOCK],
      ['string', DQ],
      ['string', SQ],
      ['string', BT],
      ['number', NUM],
      ['plain', WORD],
    ],
    keywords: words(
      'async await break case catch class const continue debugger default delete do else enum export extends finally for from function get if implements import in instanceof interface let new of package private protected public readonly return satisfies set static switch throw try type typeof var void while with yield as declare keyof namespace abstract',
    ),
    literals: C_LIKE_LITERALS,
  },
  json: {
    rules: [
      ['comment', LINE_SLASH],
      ['comment', BLOCK],
      ['attr', String.raw`"(?:[^"\\\n]|\\.)*"(?=\s*:)`],
      ['string', DQ],
      ['number', String.raw`-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?`],
      ['plain', WORD],
    ],
    literals: words('true false null'),
  },
  python: {
    rules: [
      ['comment', HASH],
      ['string', String.raw`[rbfuRBFU]{0,2}"""[\s\S]*?(?:"""|$)`],
      ['string', String.raw`[rbfuRBFU]{0,2}'''[\s\S]*?(?:'''|$)`],
      ['string', String.raw`[rbfuRBFU]{0,2}${DQ}`],
      ['string', String.raw`[rbfuRBFU]{0,2}${SQ}`],
      ['number', NUM],
      ['attr', String.raw`@[\w.]+`],
      ['plain', WORD],
    ],
    keywords: words(
      'and as assert async await break class continue def del elif else except finally for from global if import in is lambda match case nonlocal not or pass raise return try while with yield',
    ),
    literals: words('True False None self cls'),
  },
  bash: {
    rules: [
      ['comment', String.raw`(?:^|(?<=\s))#[^\n]*`],
      ['string', DQ],
      ['string', SQ],
      ['attr', String.raw`\$\{[^}\n]*\}?|\$[\w@#?*!$-]+`],
      ['number', String.raw`\b\d+\b`],
      ['plain', String.raw`[A-Za-z_][\w-]*`],
    ],
    keywords: words(
      'if then else elif fi for while until do done case esac function in return local export readonly declare select time break continue exit set unset source alias',
    ),
    literals: words('true false'),
  },
  css: {
    rules: [
      ['comment', BLOCK],
      ['string', DQ],
      ['string', SQ],
      ['keyword', String.raw`@[\w-]+`],
      ['number', String.raw`#[\da-fA-F]{3,8}\b`],
      ['attr', String.raw`--?[A-Za-z][\w-]*(?=\s*:)|[A-Za-z][\w-]*(?=\s*:[^:{};]*;)`],
      ['number', String.raw`-?\d*\.?\d+(?:px|em|rem|%|vh|vw|vmin|vmax|ch|ex|s|ms|deg|fr|dpi)?\b`],
      ['plain', String.raw`[A-Za-z_][\w-]*`],
    ],
    keywords: words('important inherit initial unset revert'),
  },
  html: {
    rules: [
      ['comment', String.raw`<!--[\s\S]*?(?:-->|$)`],
      ['keyword', String.raw`<![A-Za-z][^>\n]*>?`],
      ['tag', String.raw`<\/?[A-Za-z][\w:.-]*|\/?>`],
      ['attr', String.raw`[A-Za-z_:@][\w:.-]*(?=\s*=)`],
      ['string', String.raw`"[^"]*"?`],
      ['string', String.raw`'[^']*'?`],
    ],
  },
  sql: {
    rules: [
      ['comment', String.raw`--[^\n]*`],
      ['comment', BLOCK],
      ['string', String.raw`'(?:[^']|'')*'?`],
      ['attr', String.raw`"(?:[^"]|"")*"?`],
      ['number', NUM],
      ['plain', WORD],
    ],
    keywords: words(
      'select from where insert into values update set delete create table view index primary key foreign references join left right inner outer full cross on group by order having limit offset and or not is in as distinct union all exists between like ilike case when then else end drop alter add column default unique check begin commit rollback transaction with returning asc desc if replace trigger cascade using natural integer int text real blob varchar boolean date timestamp',
    ),
    literals: words('true false null'),
    caseInsensitive: true,
  },
  go: {
    rules: [
      ['comment', LINE_SLASH],
      ['comment', BLOCK],
      ['string', DQ],
      ['string', BT],
      ['string', String.raw`'(?:\\.|[^\\'\n])'`],
      ['number', NUM],
      ['plain', WORD],
    ],
    keywords: words(
      'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var any error string int int64 int32 uint byte rune bool float64',
    ),
    literals: words('true false nil iota'),
  },
  rust: {
    rules: [
      ['comment', LINE_SLASH],
      ['comment', BLOCK],
      ['string', String.raw`b?r#*"[\s\S]*?(?:"#*|$)`],
      ['string', DQ],
      ['string', String.raw`'(?:\\.|[^\\'\n])'`],
      ['attr', String.raw`#!?\[[^\]\n]*\]?|'[A-Za-z_]\w*\b`],
      ['number', NUM],
      ['plain', WORD],
    ],
    keywords: words(
      'as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return static struct super trait type unsafe use where while Self String Vec Option Result Box usize isize u8 u16 u32 u64 i32 i64 f32 f64 bool str',
    ),
    literals: words('true false self None Some Ok Err'),
  },
  java: {
    rules: [
      ['comment', LINE_SLASH],
      ['comment', BLOCK],
      ['string', String.raw`"""[\s\S]*?(?:"""|$)`],
      ['string', DQ],
      ['string', String.raw`'(?:\\.|[^\\'\n])'`],
      ['attr', String.raw`@\w+`],
      ['number', NUM],
      ['plain', WORD],
    ],
    keywords: words(
      'abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for fun goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized throw throws transient try val var void volatile while when object data sealed override',
    ),
    literals: words('true false null this'),
  },
  c: {
    rules: [
      ['comment', LINE_SLASH],
      ['comment', BLOCK],
      ['keyword', String.raw`^\s*#\s*\w+`],
      ['string', DQ],
      ['string', String.raw`'(?:\\.|[^\\'\n])*'`],
      ['number', NUM],
      ['plain', WORD],
    ],
    keywords: words(
      'auto break case char class const constexpr continue default delete do double else enum explicit extern float for friend goto if inline int long namespace new operator private protected public register return short signed sizeof static struct switch template this throw try typedef typename union unsigned using virtual void volatile while bool auto override final noexcept nullptr_t size_t std string var async await',
    ),
    literals: words('true false NULL nullptr null'),
  },
  yaml: {
    rules: [
      ['comment', String.raw`(?:^|(?<=\s))#[^\n]*`],
      ['attr', String.raw`[\w.-]+(?=\s*:(?:\s|$))`],
      ['string', DQ],
      ['string', SQ],
      ['keyword', String.raw`^---$|^\.\.\.$|[&*][\w-]+|![\w!/-]+`],
      ['number', String.raw`-?\b\d+(?:\.\d+)?\b`],
      ['plain', WORD],
    ],
    literals: words('true false null yes no on off'),
  },
  toml: {
    rules: [
      ['comment', HASH],
      ['tag', String.raw`^\s*\[\[?[^\]\n]*\]?\]?`],
      ['attr', String.raw`[\w.-]+(?=\s*=)`],
      ['string', String.raw`"""[\s\S]*?(?:"""|$)`],
      ['string', DQ],
      ['string', SQ],
      ['number', String.raw`[+-]?\b\d[\d_:.TZ+-]*\b`],
      ['plain', WORD],
    ],
    literals: words('true false inf nan'),
  },
};

const compiled = new Map<CodeLanguage, RegExp>();

function regexFor(lang: CodeLanguage): RegExp {
  let re = compiled.get(lang);
  if (!re) {
    re = new RegExp(SPECS[lang].rules.map(([, src]) => `(${src})`).join('|'), 'gm');
    compiled.set(lang, re);
  }
  return re;
}

/** Split `code` into typed tokens. Unknown languages and very long inputs come back as plain. */
export function highlight(code: string, language: string | null | undefined): Token[] {
  const lang = normalizeLanguage(language);
  if (!code) return [];
  if (!lang || code.length > HIGHLIGHT_LIMIT) return [{ type: 'plain', text: code }];
  const spec = SPECS[lang];
  const re = regexFor(lang);
  re.lastIndex = 0;
  const out: Token[] = [];
  const push = (type: TokenType, text: string) => {
    if (!text) return;
    const last = out.at(-1);
    if (last && last.type === type) last.text += text;
    else out.push({ type, text });
  };
  let at = 0;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    if (m[0] === '') {
      // An empty match (an anchored rule) must not stall the scan.
      re.lastIndex++;
      continue;
    }
    if (m.index > at) push('plain', code.slice(at, m.index));
    const group = m.findIndex((g, i) => i > 0 && g !== undefined);
    const type = spec.rules[group - 1]?.[0] ?? 'plain';
    push(type === 'plain' ? classifyWord(m[0], spec) : type, m[0]);
    at = m.index + m[0].length;
  }
  if (at < code.length) push('plain', code.slice(at));
  return out;
}

function classifyWord(word: string, spec: Spec): TokenType {
  const key = spec.caseInsensitive ? word.toLowerCase() : word;
  if (spec.keywords?.has(key)) return 'keyword';
  if (spec.literals?.has(key)) return 'literal';
  return 'plain';
}
