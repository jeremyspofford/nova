// Test oracle reads the actual app view registration, independently of the navigation model.
import { readFileSync } from 'node:fs';

export function registeredViews(source = readFileSync(new URL('../../ui/js/app.js', import.meta.url), 'utf8')) {
  const literal = /(?:export\s+)?const VIEWS = (\{[^;]+\});/.exec(source)?.[1];
  // Fail closed if the registration stops being a plain object: update the oracle then.
  if (!literal || !/^\{(?:\s*[\w]+:\s*'[^']+'\s*,?)+\s*\}$/.test(literal)) throw new Error('App VIEWS registration must be inventoried before changing its shape');
  const views = [...literal.matchAll(/(?:^|[,{])\s*(\w+):/g)].map(match => match[1] ?? '').sort();
  if (!views.length || views.some(view => !view) || new Set(views).size !== views.length) throw new Error('Invalid app view registration');
  return views;
}

/** @param {string[]} registered @param {string[]} reached */
export function missingViews(registered, reached) {
  return registered.filter(view => !reached.includes(view));
}
