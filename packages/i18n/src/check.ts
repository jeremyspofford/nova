// `npm run i18n:check` (D9): reads every `defineMessages` call in the UI sources with the
// TypeScript compiler API (no type checking, just the syntax tree), writes or verifies the English
// source catalog, and checks the translation catalogs against it. Node-only: the web bundle never
// imports this module.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';
import { messageArgs, parseMessage, pluralKeys, type ArgKind } from './icu.ts';
import { KEY_PATTERN, NAMESPACE_PATTERN } from './messages.ts';

export interface CollectedMessage {
  id: string;
  namespace: string;
  key: string;
  source: string;
  file: string;
  line: number;
}

export interface Collected {
  messages: CollectedMessage[];
  /** One entry per `defineMessages` call: namespace and where. */
  namespaces: Array<{ namespace: string; file: string; line: number }>;
  problems: string[];
}

const CALLEE = 'defineMessages';

/** `x as const`, `x satisfies T` and `(x)` are still the literal `x`. */
function unwrap(node: ts.Expression): ts.Expression {
  let n = node;
  while (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isSatisfiesExpression(n))
    n = n.expression;
  return n;
}

/** Collect the messages of one source file. `file` is used in problem reports. */
export function collectFromSource(file: string, text: string): Collected {
  const out: Collected = { messages: [], namespaces: [], problems: [] };
  if (!text.includes(CALLEE)) return out;
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const where = (node: ts.Node) => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    return { file, line, at: `${file}:${line}` };
  };

  const literal = (node: ts.Expression): string | null => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isParenthesizedExpression(node)) return literal(node.expression);
    // Long messages may be split with `+` between literals.
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const a = literal(node.left);
      const b = literal(node.right);
      return a !== null && b !== null ? a + b : null;
    }
    return null;
  };

  const propName = (name: ts.PropertyName): string | null => {
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name))
      return name.text;
    if (ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
    return null;
  };

  const tree = (namespace: string, prefix: string, obj: ts.ObjectLiteralExpression) => {
    for (const prop of obj.properties) {
      const w = where(prop);
      if (!ts.isPropertyAssignment(prop)) {
        out.problems.push(
          `${w.at}: ${namespace}: only "key: 'message'" entries are allowed (no spreads, shorthand or methods)`,
        );
        continue;
      }
      const k = propName(prop.name);
      if (k === null) {
        out.problems.push(`${w.at}: ${namespace}: message keys must be literal (no computed keys)`);
        continue;
      }
      if (!KEY_PATTERN.test(k)) {
        out.problems.push(`${w.at}: ${namespace}: key "${k}" may not contain dots or spaces`);
        continue;
      }
      const key = prefix ? `${prefix}.${k}` : k;
      const init = unwrap(prop.initializer);
      if (ts.isObjectLiteralExpression(init)) {
        tree(namespace, key, init);
        continue;
      }
      const source = literal(init);
      if (source === null) {
        out.problems.push(
          `${w.at}: ${namespace}.${key}: the message must be a string literal, not an expression`,
        );
        continue;
      }
      try {
        parseMessage(source);
      } catch (err) {
        out.problems.push(`${w.at}: ${namespace}.${key}: ${(err as Error).message}`);
        continue;
      }
      out.messages.push({
        id: `${namespace}.${key}`,
        namespace,
        key,
        source,
        file,
        line: w.line,
      });
    }
  };

  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ((ts.isIdentifier(node.expression) && node.expression.text === CALLEE) ||
        (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === CALLEE))
    ) {
      const w = where(node);
      const [nsArg, rawObj] = node.arguments;
      const objArg = rawObj ? unwrap(rawObj) : undefined;
      const namespace = nsArg ? literal(nsArg) : null;
      if (namespace === null) {
        out.problems.push(
          `${w.at}: defineMessages needs a literal namespace as its first argument`,
        );
      } else if (!NAMESPACE_PATTERN.test(namespace)) {
        out.problems.push(
          `${w.at}: invalid namespace "${namespace}" (lower camel case, dots between)`,
        );
      } else if (!objArg || !ts.isObjectLiteralExpression(objArg)) {
        out.problems.push(`${w.at}: defineMessages("${namespace}") needs a literal object`);
      } else {
        out.namespaces.push({ namespace, file, line: w.line });
        tree(namespace, '', objArg);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|tsx)$/.test(name) && !/\.d\.ts$/.test(name) && !/\.test\.tsx?$/.test(name))
      out.push(path);
  }
  return out;
}

export interface I18nCheckOptions {
  /** Repository root; the other paths are relative to it. */
  root: string;
  /** Source folders to scan. */
  sources: readonly string[];
  /** The English catalog to write or verify. */
  catalog: string;
  /** Translation catalogs: `<locales>/<locale>/<namespace>.json`. */
  locales: string;
  write?: boolean;
}

export interface LocaleCoverage {
  locale: string;
  translated: number;
  total: number;
}

export interface I18nCheckReport {
  ok: boolean;
  problems: string[];
  coverage: LocaleCoverage[];
  messages: number;
  wrote: boolean;
}

/** The English catalog file contents: every id → source, sorted, stable. */
export function englishCatalog(messages: readonly CollectedMessage[]): string {
  const sorted = [...messages].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const obj: Record<string, string> = {};
  for (const m of sorted) obj[m.id] = m.source;
  return `${JSON.stringify(obj, null, 2)}\n`;
}

const kindName: Record<ArgKind, string> = {
  arg: 'a placeholder',
  plural: 'a plural',
  select: 'a select',
};

/** Compare a translation with its source: same placeholders, same kinds, valid plural forms. */
export function compareTranslation(
  source: string,
  translation: string,
  locale: string,
): string | null {
  let t: ReturnType<typeof parseMessage>;
  try {
    t = parseMessage(translation);
  } catch (err) {
    return (err as Error).message;
  }
  const want = messageArgs(parseMessage(source));
  const got = messageArgs(t);
  for (const [name, kind] of want) {
    const k = got.get(name);
    if (!k) return `missing {${name}}`;
    if ((kind === 'arg') !== (k === 'arg') || (kind !== 'arg' && k !== 'arg' && kind !== k))
      return `{${name}} is ${kindName[kind]} in English but ${kindName[k]} here`;
  }
  for (const name of got.keys()) if (!want.has(name)) return `unknown placeholder {${name}}`;
  let categories: Set<string>;
  try {
    categories = new Set(new Intl.PluralRules(locale).resolvedOptions().pluralCategories);
  } catch {
    categories = new Set(['other']);
  }
  for (const [name, keys] of pluralKeys(t)) {
    for (const k of keys) {
      if (!k.startsWith('=') && !categories.has(k))
        return `{${name}} uses the plural form "${k}", which ${locale} does not have`;
    }
  }
  return null;
}

export function runI18nCheck(opts: I18nCheckOptions): I18nCheckReport {
  const problems: string[] = [];
  const messages: CollectedMessage[] = [];
  const firstNs = new Map<string, string>();
  for (const dir of opts.sources) {
    for (const path of sourceFiles(join(opts.root, dir))) {
      const rel = relative(opts.root, path).split(sep).join('/');
      const c = collectFromSource(rel, readFileSync(path, 'utf8'));
      problems.push(...c.problems);
      for (const ns of c.namespaces) {
        const seen = firstNs.get(ns.namespace);
        if (seen)
          problems.push(
            `${ns.file}:${ns.line}: namespace "${ns.namespace}" is already used at ${seen}`,
          );
        else firstNs.set(ns.namespace, `${ns.file}:${ns.line}`);
      }
      messages.push(...c.messages);
    }
  }
  const byId = new Map<string, CollectedMessage>();
  for (const m of messages) {
    const seen = byId.get(m.id);
    if (seen)
      problems.push(
        `${m.file}:${m.line}: message id "${m.id}" is already used at ${seen.file}:${seen.line}`,
      );
    else byId.set(m.id, m);
  }

  // The English source catalog, for translators.
  const catalogPath = join(opts.root, opts.catalog);
  const text = englishCatalog([...byId.values()]);
  let wrote = false;
  if (opts.write) {
    const before = existsSync(catalogPath) ? readFileSync(catalogPath, 'utf8') : null;
    if (before !== text) {
      writeFileSync(catalogPath, text);
      wrote = true;
    }
  } else if (!existsSync(catalogPath) || readFileSync(catalogPath, 'utf8') !== text) {
    problems.push(`${opts.catalog} is out of date: run npm run i18n:write`);
  }

  // Translations.
  const coverage: LocaleCoverage[] = [];
  const localesDir = join(opts.root, opts.locales);
  const locales = existsSync(localesDir)
    ? readdirSync(localesDir)
        .filter((n) => statSync(join(localesDir, n)).isDirectory())
        .sort()
    : [];
  for (const locale of locales) {
    let translated = 0;
    const dir = join(localesDir, locale);
    for (const name of readdirSync(dir).sort()) {
      const rel = `${opts.locales}/${locale}/${name}`;
      if (!name.endsWith('.json')) {
        problems.push(`${rel}: only <namespace>.json files belong here`);
        continue;
      }
      const namespace = name.slice(0, -'.json'.length);
      let entries: unknown;
      try {
        entries = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      } catch (err) {
        problems.push(`${rel}: not valid JSON (${(err as Error).message})`);
        continue;
      }
      if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
        problems.push(`${rel}: expected an object of key → translation`);
        continue;
      }
      if (!firstNs.has(namespace)) {
        problems.push(`${rel}: no messages are defined in namespace "${namespace}"`);
        continue;
      }
      for (const [key, value] of Object.entries(entries as Record<string, unknown>)) {
        const source = byId.get(`${namespace}.${key}`);
        if (!source) {
          problems.push(`${rel}: "${key}" is not a message of ${namespace} (removed or renamed?)`);
          continue;
        }
        if (typeof value !== 'string') {
          problems.push(`${rel}: "${key}" must be a string`);
          continue;
        }
        const issue = compareTranslation(source.source, value, locale);
        if (issue) {
          problems.push(`${rel}: "${key}": ${issue}`);
          continue;
        }
        translated++;
      }
    }
    coverage.push({ locale, translated, total: byId.size });
  }

  return { ok: problems.length === 0, problems, coverage, messages: byId.size, wrote };
}
