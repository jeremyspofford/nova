// Test oracle reads the actual app view registration, independently of the navigation model.
import { readFileSync } from 'node:fs';

const appSource = () => readFileSync(new URL('../../ui/js/app.js', import.meta.url), 'utf8');

/** @param {string} source */
function viewEntries(source) {
  const literal = /(?:export\s+)?const VIEWS = (\{[^;]+\});/.exec(source)?.[1];
  // Fail closed if the registration stops being a plain object: update the oracle then.
  if (!literal || !/^\{(?:\s*[\w]+:\s*'[^']+'\s*,?)+\s*\}$/.test(literal)) throw new Error('App VIEWS registration must be inventoried before changing its shape');
  const entries = [...literal.matchAll(/(?:^|[,{])\s*(\w+):\s*'([^']+)'/g)].map(match => [match[1] ?? '', match[2] ?? '']);
  const views = entries.map(([view]) => view ?? '');
  if (!views.length || views.some(view => !view) || new Set(views).size !== views.length) throw new Error('Invalid app view registration');
  return entries;
}

export function registeredViews(source = appSource()) {
  return viewEntries(source).map(([view]) => view ?? '').sort();
}

// setView resolves VIEWS values through el, whose DOM IDs need not equal the view names.
export function registeredViewRoots(source = appSource()) {
  const views = viewEntries(source);
  const literal = /const el = (\{[\s\S]*?\n\});/.exec(source)?.[1];
  if (!literal || !/^\{(?:\s*\w+:\s*\$\('[\w-]+'\)\s*,?)+\s*\}$/.test(literal)) throw new Error('App el mapping must be inventoried before changing its shape');
  const entries = [...literal.matchAll(/(\w+):\s*\$\('([\w-]+)'\)/g)].map(match => [match[1] ?? '', match[2] ?? '']);
  if (new Set(entries.map(([key]) => key)).size !== entries.length) throw new Error('Duplicate app el mapping');
  const elements = Object.fromEntries(entries);
  const roots = Object.fromEntries(views.map(([view, key]) => {
    if (!elements[key]) throw new Error(`Unresolved app view mapping: ${view} -> ${key}`);
    return [view, elements[key]];
  }));
  if (new Set(Object.values(roots)).size !== views.length) throw new Error('Duplicate app view root mapping');
  return roots;
}

/** @param {string[]} registered @param {string[]} reached */
export function missingViews(registered, reached) {
  return registered.filter(view => !reached.includes(view));
}
