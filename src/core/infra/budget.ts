// Budget guardrails (M10d): what a plan would cost a month, from the project's price sheet, against
// the project's monthly budget. Amounts are kept in cents. A change Nova can't price is never applied:
// what can't be priced can't be kept inside a budget. Pure, so it is unit-tested on its own.
import { CoreError } from '../errors.ts';
import type { ResourceChange } from './tool.ts';

// A resource type's monthly price: a flat amount, or one by the value of an attribute (a size).
export type Price = number | { by: string; prices: Record<string, number> };
export type PriceSheet = Record<string, Price>;
export type Level = 'ok' | 'warn' | 'over';
export const WARN_AT = 0.8;
const MAX_USD = 1_000_000;

const cents = (usd: number) => Math.round(usd * 100);
export const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
const okAmount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_USD;

// The price sheet the person gave, checked; every problem is listed.
export function validatePrices(v: unknown): PriceSheet {
  const errors: string[] = [];
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new CoreError('validation', 'prices is a price sheet: {"resource_type": monthly USD} or {"resource_type": {"by": "attribute", "prices": {"value": monthly USD}}}.');
  const out: PriceSheet = {};
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length > 500) errors.push('prices lists at most 500 resource types');
  for (const [type, p] of entries) {
    if (!/^[a-z0-9_]{1,100}$/.test(type)) { errors.push(`prices: “${type}” isn’t a resource type (lowercase letters, digits and underscores)`); continue; }
    if (okAmount(p)) { out[type] = p; continue; }
    const o = typeof p === 'object' && p !== null && !Array.isArray(p) ? p as Record<string, unknown> : null;
    const by = o?.by;
    const prices = o?.prices;
    if (!o || typeof by !== 'string' || !/^[a-z0-9_]{1,100}$/.test(by) || typeof prices !== 'object' || prices === null || Array.isArray(prices)
      || !Object.values(prices).every(okAmount) || Object.keys(o).some((k) => k !== 'by' && k !== 'prices')) {
      errors.push(`prices.${type} is a monthly amount in USD (0 to ${MAX_USD}), or {"by": "attribute", "prices": {"value": amount}}`);
      continue;
    }
    out[type] = { by, prices: prices as Record<string, number> };
  }
  if (errors.length) throw new CoreError('validation', 'The price sheet can’t be used.', errors);
  return out;
}

export function validateBudget(v: unknown): number {
  if (!okAmount(v)) throw new CoreError('validation', `budget_usd_month is the most this project may cost a month, in USD (0 to ${MAX_USD}). Every resource Nova provisions has one.`);
  return cents(v);
}

// A resource's monthly price in cents, or null when the sheet can't say.
export function priceOf(sheet: PriceSheet, type: string, attrs: Record<string, unknown> | null): number | null {
  const p = sheet[type];
  if (p === undefined) return null;
  if (typeof p === 'number') return cents(p);
  const key = attrs ? attrs[p.by] : undefined;
  if (typeof key !== 'string' && typeof key !== 'number') return null;
  const v = p.prices[String(key)];
  return v === undefined ? null : cents(v);
}

export interface PricedChange { address: string; type: string; action: ResourceChange['action']; before_cents: number | null; after_cents: number | null; delta_cents: number }
export interface Priced { lines: PricedChange[]; delta_cents: number; unpriced: string[] }

// Each change's price: what it adds or takes away a month. `current`: what Nova recorded for the
// project's resources (address → cents).
export function priceChanges(changes: ResourceChange[], sheet: PriceSheet, current: ReadonlyMap<string, number>): Priced {
  const lines: PricedChange[] = [];
  const unpriced: string[] = [];
  for (const c of changes) {
    if (c.action === 'read' || c.action === 'no-op') continue;
    const was = c.action === 'create' ? 0 : current.get(c.address) ?? priceOf(sheet, c.type, c.before) ?? 0;
    let now: number | null = 0;
    if (c.action !== 'delete') {
      now = priceOf(sheet, c.type, c.after);
      if (now === null) unpriced.push(`${c.address} (${c.type})`);
    }
    lines.push({ address: c.address, type: c.type, action: c.action, before_cents: c.action === 'create' ? null : was, after_cents: c.action === 'delete' ? null : now, delta_cents: (now ?? 0) - was });
  }
  return { lines, delta_cents: lines.reduce((s, l) => s + l.delta_cents, 0), unpriced };
}

export interface Verdict { level: Level; current_cents: number; projected_cents: number; budget_cents: number; blocks: boolean; words: string }

// Where the month would stand after the plan. A plan that adds cost and goes over is blocked; one
// that only takes cost away never is, even over budget (it brings the month down).
export function verdict(currentCents: number, deltaCents: number, budgetCents: number): Verdict {
  const projected = currentCents + deltaCents;
  const level: Level = projected > budgetCents ? 'over' : projected >= Math.ceil(budgetCents * WARN_AT) && projected > 0 ? 'warn' : 'ok';
  const blocks = level === 'over' && deltaCents > 0;
  const pct = budgetCents > 0 ? Math.round((projected / budgetCents) * 100) : projected > 0 ? Infinity : 0;
  const words = `${usd(projected)} a month of the ${usd(budgetCents)} budget${Number.isFinite(pct) ? ` (${pct} %)` : ''}`;
  return { level, current_cents: currentCents, projected_cents: projected, budget_cents: budgetCents, blocks, words };
}
