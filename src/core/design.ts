// Design systems (DESIGN-SYSTEM, ADR-12): the token schema, package validation, CSS generation,
// and which package is applied, for the person and per device. A design system is data, never
// code: an extension of kind `design-system` whose tokens become CSS variables at runtime, so the
// app re-skins with no rebuild, reload or restart. This file is the one place the schema lives;
// the UI reads it from GET /api/v1/design-systems/schema.
import { EventEmitter } from 'node:events';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CoreError } from './errors.ts';
import { validateManifest, type Extensions, type Installed, type Manifest } from './extensions.ts';
import type { Profile } from './profile.ts';

// ---- the schema (DESIGN-SYSTEM §2, plus the weights, line heights, durations and easing M3 adds) ----

export type Group = 'color' | 'type' | 'space' | 'motion' | 'layout';
export type Syntax = 'color' | 'font' | 'size' | 'weight' | 'line' | 'length' | 'shadow' | 'duration' | 'easing';

const entries: [string, Group, Syntax][] = [
  ...['bg/base', 'bg/raised', 'bg/overlay', 'surface/card', 'surface/card-hover', 'text/primary', 'text/secondary', 'text/faint',
    'border/subtle', 'border/strong', 'accent/primary', 'accent/secondary', 'status/ok', 'status/working', 'status/waiting',
    'status/attention', 'status/error', 'orb/core', 'orb/glow', 'orb/listening', 'orb/attention'].map((n): [string, Group, Syntax] => [n, 'color', 'color']),
  ...['font/display', 'font/body', 'font/mono'].map((n): [string, Group, Syntax] => [n, 'type', 'font']),
  ...['type/h1', 'type/h2', 'type/h3', 'type/body', 'type/small', 'type/caption'].map((n): [string, Group, Syntax] => [n, 'type', 'size']),
  ['type/weight-regular', 'type', 'weight'], ['type/weight-strong', 'type', 'weight'],
  ['type/line-tight', 'type', 'line'], ['type/line-body', 'type', 'line'],
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((n): [string, Group, Syntax] => [`space/${n}`, 'space', 'length']),
  ['radius/card', 'space', 'length'], ['radius/pill', 'space', 'length'], ['radius/input', 'space', 'length'],
  ['shadow/card', 'space', 'shadow'], ['shadow/raised', 'space', 'shadow'], ['blur/glass', 'space', 'length'],
  ...['motion/breathe', 'motion/pulse', 'motion/transition', 'motion/duration-fast', 'motion/duration-slow'].map((n): [string, Group, Syntax] => [n, 'motion', 'duration']),
  ['motion/ease', 'motion', 'easing'],
  ['layout/rail-width', 'layout', 'length'], ['layout/content-max', 'layout', 'length'], ['layout/card-gap', 'layout', 'length'],
];

export const TOKENS: Readonly<Record<string, { group: Group; syntax: Syntax }>> = Object.freeze(Object.fromEntries(entries.map(([n, group, syntax]) => [n, { group, syntax }])));
export const TOKEN_NAMES: readonly string[] = Object.freeze(entries.map(([n]) => n));

// `bg/base` → `--bg-base`.
export const cssVar = (name: string) => `--${name.replace(/\//g, '-')}`;

export const DEFAULT_DESIGN_SYSTEM = 'orb-teal';
// DESIGN-SYSTEM §3: the two packages made for Nova, dark first.
export const STARTERS: readonly string[] = Object.freeze(['orb-teal', 'companion-light']);
export const BUILTIN_DIR = fileURLToPath(new URL('../../design-systems', import.meta.url));
export const MODES = ['light', 'dark', 'auto'] as const;
export type Mode = (typeof MODES)[number];

// DESIGN-SYSTEM §5 (owner decision 2026-10-31, option C): whether the installed iPhone app draws
// behind the status bar. `translucent` (apple-mobile-web-app-status-bar-style black-translucent):
// Nova's background runs to the top edge, and iOS draws the time and battery in white over it, so
// only a dark look can have it. `default`: iOS keeps its own strip above Nova, readable over any
// look. A package with a light and a dark look declares each ({ light, dark }); one look, one word.
export const IOS_STATUS_BARS = ['translucent', 'default'] as const;
export type IosStatusBar = (typeof IOS_STATUS_BARS)[number];
export const IOS_STATUS_BAR_META: Readonly<Record<IosStatusBar, string>> = Object.freeze({ translucent: 'black-translucent', default: 'default' });
// What a package that declares nothing gets: what iOS does with no tag, never white text on a
// light page. The runtime applies it (with a warning); the authoring gate (scripts/check-themes.js)
// refuses a package that leaves it out.
export const IOS_STATUS_BAR_UNDECLARED: IosStatusBar = 'default';

// DESIGN-SYSTEM §6 as numbers and switches. A package may tighten these, never loosen them.
export const CONTENT_RULES = Object.freeze({
  card_max_lines: 3,
  card_max_actions: 1,
  notification_max_lines: 1,
  notification_max_actions: 1,
  technical_detail_on_demand: true,
  numbers_show_basis: true,
});

// DESIGN-SYSTEM §7, plus `app` (the page itself). Any other component a package binds is an extra
// and must be declared in extras[].
export const COMPONENTS = Object.freeze(['app', 'orb', 'brief-card', 'handling-card', 'task-row', 'verified-result-card', 'looking-into-it-card',
  'device-row', 'device-mesh-card', 'health-card', 'memory-highlight-card', 'approval-sheet', 'trigger-row', 'chat-bubble', 'composer',
  'toast', 'proactive-banner', 'settings-row', 'empty-state']);

// [foreground, background, minimum ratio, what it guards]. Checked in every mode a package has.
export const CONTRAST_PAIRS: readonly (readonly [string, string, number, string])[] = Object.freeze([
  ['text/primary', 'bg/base', 4.5, 'text on the background'],
  ['text/primary', 'bg/raised', 4.5, 'text on raised surfaces'],
  ['text/primary', 'surface/card', 4.5, 'text on cards'],
  ['text/secondary', 'bg/base', 4.5, 'secondary text on the background'],
  ['text/secondary', 'surface/card', 4.5, 'secondary text on cards'],
  ['text/faint', 'bg/base', 3, 'faint labels on the background'],
  ['text/faint', 'surface/card', 3, 'faint labels on cards'],
  ['accent/primary', 'bg/base', 3, 'focus rings and active markers'],
  ['accent/primary', 'bg/raised', 4.5, 'links on raised surfaces'],
  ['status/ok', 'surface/card', 3, 'the Verified status on cards'],
  ['status/working', 'surface/card', 3, 'the Working status on cards'],
  ['status/waiting', 'surface/card', 3, 'the Waiting status on cards'],
  ['status/attention', 'surface/card', 3, 'the Needs you status on cards'],
  ['status/error', 'surface/card', 4.5, 'error text on cards'],
] as const);
// A label on an accent button uses whichever of these reads best; one of them must reach 4.5:1.
const ACCENT_LABELS = ['bg/base', 'text/primary', 'surface/card'];

// The live check in Settings › Appearance (Amendment 2026-10-30-C Part 1 §5): stricter than
// validation, which a package needs only to be applied. Body text (and timestamps, which use
// text/secondary) at 4.5:1 on every surface it sits on; control outlines and focus markers at
// 3:1 (WCAG 1.4.3, 1.4.11): every colour the UI draws as a control's outline is here, and a test
// reads those from the CSS (tests/ui-review.test.js). It warns; it never blocks.
export type CheckKind = 'text' | 'control';
export const LIVE_CHECKS: readonly (readonly [string, string, number, CheckKind, string])[] = Object.freeze([
  ['text/primary', 'bg/base', 4.5, 'text', 'Text on the background'],
  ['text/primary', 'bg/raised', 4.5, 'text', 'Text on raised surfaces'],
  ['text/primary', 'surface/card', 4.5, 'text', 'Text on cards'],
  ['text/secondary', 'bg/base', 4.5, 'text', 'Secondary text and timestamps'],
  ['text/secondary', 'bg/raised', 4.5, 'text', 'Secondary text on raised surfaces'],
  ['text/secondary', 'surface/card', 4.5, 'text', 'Secondary text on cards'],
  // M9: the states a control is drawn in, as the browser audit found them (tests/ui/m9-contrast).
  ['text/primary', 'surface/card-hover', 4.5, 'text', 'Text on a hovered or selected row'],
  ['text/secondary', 'surface/card-hover', 4.5, 'text', 'Secondary text on a hovered row, and labels'],
  ['text/secondary', 'bg/overlay', 4.5, 'text', 'Secondary text in a popover or a sheet'],
  ['accent/primary', 'surface/card', 4.5, 'text', 'Links on cards'],
  ['border/strong', 'bg/base', 3, 'control', 'Outlines of fields and buttons'],
  ['border/strong', 'bg/raised', 3, 'control', 'Outlines of fields on raised surfaces'],
  ['accent/primary', 'bg/base', 3, 'control', 'Focus rings and selected markers'],
  ['status/attention', 'bg/base', 3, 'control', 'Outlines of things that need you'],
  ['status/error', 'bg/base', 3, 'control', 'Outlines of buttons that erase'],
] as const);

// Under prefers-reduced-motion the core always emits these; a package may only shorten them.
export const REDUCED_MOTION: Readonly<Record<string, string>> = Object.freeze({
  'motion/breathe': '0s', 'motion/pulse': '0s', 'motion/transition': '1ms', 'motion/duration-fast': '1ms', 'motion/duration-slow': '1ms',
});
export const REDUCED_MOTION_MAX_MS = 200;
const LOOPS = ['motion/breathe', 'motion/pulse'];
// Amendment 2026-10-30-C Part 2 (M9): a transition or a one-off animation takes 150–300 ms, and its
// curve never overshoots (no bounce or elastic). The two loops (the orb breathing, a working pulse)
// show a state for as long as it lasts, so they aren't held to the range; they stop under reduced
// motion.
export const MOTION_MIN_MS = 150;
export const MOTION_MAX_MS = 300;
export const TRANSITION_TOKENS: readonly string[] = Object.freeze(['motion/transition', 'motion/duration-fast', 'motion/duration-slow']);
// A cubic-bezier whose y control points leave [0, 1] overshoots its end (or its start): a bounce.
// What Nova uses for a motion token (M9): a transition within 150–300 ms, a curve with its y values
// clipped to [0, 1]. Everything else (the loops, reduced motion) as given.
export function motionValue(name: string, v: string): string {
  if (TRANSITION_TOKENS.includes(name) && /^\d*\.?\d+(?:ms|s)$/.test(v)) {
    const t = v.endsWith('ms') ? Number(v.slice(0, -2)) : Number(v.slice(0, -1)) * 1000;
    return t < MOTION_MIN_MS ? `${MOTION_MIN_MS}ms` : t > MOTION_MAX_MS ? `${MOTION_MAX_MS}ms` : v;
  }
  if (name === 'motion/ease' && overshoots(v)) {
    const n = /^cubic-bezier\(([^)]*)\)$/.exec(v.trim())![1]!.split(',').map((x) => Number(x.trim()));
    const c = (y: number) => Math.min(1, Math.max(0, y));
    return `cubic-bezier(${n[0]}, ${c(n[1]!)}, ${n[2]}, ${c(n[3]!)})`;
  }
  return v;
}
export function overshoots(easing: string): boolean {
  const m = /^cubic-bezier\(([^)]*)\)$/.exec(easing.trim());
  if (!m) return false;
  const [, y1, , y2] = m[1]!.split(',').map((x) => Number(x.trim()));
  return [y1!, y2!].some((y) => y < 0 || y > 1);
}

// ---- the designed scales (DESIGN-SYSTEM §0 and §2.1; owner direction 2026-11-01) ------------------
// The scales' structure is the system's, so every package has the same skeleton and only re-expresses
// values in it: the spacing scale itself (spacing is layout, and a package never changes layout), the
// type scale's shape (six steps on one ratio), two elevation levels, radius by component size class,
// one motion family. A package picks its own body size, ratio, radii, shadows and durations within
// those rules. Orb Teal is the lead package: it is held to them first, and a package is presented as
// Nova's own only once it is at the bar (AT_THE_BAR: these rules, and the owner's approval of its
// rendered styleguide).
export const LEAD_DESIGN_SYSTEM = 'orb-teal';
export const AT_THE_BAR: readonly string[] = Object.freeze(['orb-teal']);
// 4pt spacing, with a name for each step. Off-scale spacing is a lint error in ui/ (lint:tokens).
export const SPACE_SCALE: Readonly<Record<string, { px: number; name: string }>> = Object.freeze({
  'space/1': { px: 4, name: 'hair' }, 'space/2': { px: 8, name: 'tight' }, 'space/3': { px: 12, name: 'snug' }, 'space/4': { px: 16, name: 'base' },
  'space/5': { px: 24, name: 'roomy' }, 'space/6': { px: 32, name: 'group' }, 'space/7': { px: 48, name: 'section' }, 'space/8': { px: 64, name: 'page' },
});
// The type scale: each step is body × ratio^n, rounded to a whole pixel.
export const TYPE_STEPS: readonly (readonly [string, number])[] = Object.freeze([['type/caption', -2], ['type/small', -1], ['type/body', 0], ['type/h3', 1], ['type/h2', 2], ['type/h1', 3]] as const);
export const TYPE_RATIO = Object.freeze({ min: 1.125, max: 1.333 });
export const TYPE_MIN_PX = 11;
// Radius by component size class, never by rendered height: a container (card, sheet, panel,
// bubble) takes radius/card, a control (button, field, the composer, a row) radius/input, and only a
// token whose height is fixed (a status pill, a chip, a dot, a round icon button) radius/pill.
export const RADIUS_CLASSES = Object.freeze({ container: 'radius/card', control: 'radius/input', token: 'radius/pill' });
// The one icon set (ui/js/components.js ICONS): a 24-unit grid, drawn at one stroke weight.
export const ICON_STROKE = 1.5;
// At the bar: named by the owner, and on the scales in every look.
export const atTheBar = (id: string, pkg: { tokens?: unknown; modes?: unknown }) => AT_THE_BAR.includes(id) && packageScaleFindings(pkg).length === 0;

const px = (v: unknown) => (typeof v === 'string' && /^\d*\.?\d+px$/.test(v) ? Number.parseFloat(v) : v === '0' ? 0 : null);
const shadowLayers = (v: string) => (v === 'none' ? [] : topLevel(v).map((part) => {
  const lens = (RE.shadow.exec(part)?.[1] ?? '').trim().split(/\s+/).map((x) => Number.parseFloat(x) || 0);
  return { y: lens[1] ?? 0, blur: lens[2] ?? 0 };
}));

// What keeps one resolved token set off the designed scales, in words. Empty: it is on them.
export function scaleFindings(tokens: Record<string, unknown>): string[] {
  const out: string[] = [];
  // Spacing: the scale itself, and the card gap one of its steps.
  for (const [name, { px: want, name: word }] of Object.entries(SPACE_SCALE)) {
    if (px(tokens[name]) !== want) out.push(`${name} (${word}) is ${say(tokens[name])}; the spacing scale is the system’s, ${want}px.`);
  }
  const gap = px(tokens['layout/card-gap']);
  if (gap === null || !Object.values(SPACE_SCALE).some((x) => x.px === gap)) out.push(`layout/card-gap is ${say(tokens['layout/card-gap'])}; it must be a step of the spacing scale.`);
  // Type: six steps on one ratio, nothing under the floor, and real weight contrast.
  const sizes = TYPE_STEPS.map(([n]) => px(tokens[n]));
  if (sizes.some((x) => x === null)) out.push('The type scale must be in whole pixels, so its ratio can be checked.');
  else {
    const [lo, hi] = [sizes[0]!, sizes.at(-1)!];
    const ratio = (hi / lo) ** (1 / (TYPE_STEPS.length - 1));
    const body = sizes[2]!;
    if (ratio < TYPE_RATIO.min || ratio > TYPE_RATIO.max) out.push(`The type scale’s ratio is ${ratio.toFixed(3)}; it must be ${TYPE_RATIO.min}–${TYPE_RATIO.max}, so the hierarchy is real and not shouting.`);
    for (const [[n, k], got] of TYPE_STEPS.map((x, i) => [x, sizes[i]!] as const)) {
      const want = body * ratio ** k;
      if (Math.abs(got - want) > 0.75) out.push(`${n} is ${got}px; on a ${ratio.toFixed(3)} scale from a ${body}px body it is ${want.toFixed(1)}px.`);
    }
    if (lo < TYPE_MIN_PX) out.push(`type/caption is ${lo}px; nothing is set under ${TYPE_MIN_PX}px.`);
  }
  const [reg, strong] = [Number(tokens['type/weight-regular']), Number(tokens['type/weight-strong'])];
  if (!(strong - reg >= 200)) out.push(`type/weight-strong (${say(tokens['type/weight-strong'])}) must be at least 200 heavier than type/weight-regular (${say(tokens['type/weight-regular'])}).`);
  if (!(Number(tokens['type/line-tight']) < Number(tokens['type/line-body']))) out.push('type/line-tight must be tighter than type/line-body.');
  // Elevation: two levels, each at most two layers, the raised one visibly above the card.
  const [card, raised] = [tokens['shadow/card'], tokens['shadow/raised']].map((v) => (typeof v === 'string' && validValue('shadow', v) ? shadowLayers(v) : null));
  if (!card || !raised) out.push('shadow/card and shadow/raised must both be valid shadows.');
  else {
    if (card.length > 2 || raised.length > 2) out.push('Each elevation level is at most two shadow layers.');
    const reach = (ls: { y: number; blur: number }[]) => Math.max(0, ...ls.map((l) => l.y + l.blur));
    if (!raised.length || reach(raised) <= reach(card)) out.push('shadow/raised must sit visibly above shadow/card: there are two levels, card and raised.');
  }
  // Radius: by size class, on the 4pt grid; a container rounder than a control; the pill always a pill.
  const [rc, ri, rp] = [px(tokens['radius/card']), px(tokens['radius/input']), px(tokens['radius/pill'])];
  if (rc === null || ri === null || rc % 4 || ri % 4) out.push(`radius/card (${say(tokens['radius/card'])}) and radius/input (${say(tokens['radius/input'])}) are steps of the 4pt grid.`);
  else if (!(ri < rc)) out.push(`radius/input (${ri}px) must be smaller than radius/card (${rc}px): a control sits inside a container.`);
  if (rp === null || rp < 999) out.push(`radius/pill is ${say(tokens['radius/pill'])}; it is always a full pill (999px), and only fixed-height tokens take it.`);
  // Motion: one family. Fast, standard and slow in order; the loops whole multiples of slow.
  const d = (n: string) => (typeof tokens[n] === 'string' && validValue('duration', tokens[n]) ? ms(tokens[n] as string) : NaN);
  const [fast, std, slow, pulse, breathe] = ['motion/duration-fast', 'motion/transition', 'motion/duration-slow', 'motion/pulse', 'motion/breathe'].map(d);
  // (Their range, 150–300 ms, is M9's own warning above; here, only that they are one ordered family.)
  if (!(fast! < std! && std! < slow!)) out.push(`The durations are one family, in order: motion/duration-fast < motion/transition < motion/duration-slow; got ${fast}, ${std} and ${slow}ms.`);
  for (const [n, v] of [['motion/pulse', pulse], ['motion/breathe', breathe]] as const) if (!(v! > 0 && slow! > 0 && v! % slow! === 0)) out.push(`${n} (${v}ms) must be a whole multiple of motion/duration-slow (${slow}ms), so the loops belong to the same family.`);
  if (typeof tokens['motion/ease'] !== 'string' || !/^cubic-bezier\(/.test(tokens['motion/ease']) || overshoots(tokens['motion/ease'])) out.push('motion/ease is the one curve: a cubic-bezier that never overshoots.');
  return out;
}

// Each look of a package (its own tokens, and each mode on top) against the scales.
export function packageScaleFindings(pkg: { tokens?: unknown; modes?: unknown }): string[] {
  const tokens = isObj(pkg.tokens) ? pkg.tokens : {};
  const modes = isObj(pkg.modes) ? pkg.modes : {};
  const out = scaleFindings(tokens);
  for (const m of ['light', 'dark']) {
    if (!isObj(modes[m])) continue;
    for (const f of scaleFindings({ ...tokens, ...modes[m] })) if (!out.includes(f)) out.push(`In ${m} mode, ${f[0]!.toLowerCase()}${f.slice(1)}`);
  }
  return out;
}

// ---- the orb's states (DESIGN-SYSTEM §1 and §7; owner decision 2026-10-31) ----------------------
// The set is fixed and its meanings are the system's: a design system expresses every state in its
// own visual language (its colours, and which motion, light and mark each state shows), and can't
// add a state, remove one or give one another meaning. Red is reserved for what stops Nova; amber
// is for what needs the person while Nova keeps running.
export const ORB_STATES = Object.freeze(['idle', 'listening', 'working', 'speaking', 'needs-you', 'stopped', 'offline'] as const);
export type OrbState = (typeof ORB_STATES)[number];
export const ORB_MEANINGS: Readonly<Record<OrbState, string>> = Object.freeze({
  idle: 'Nothing is happening; Nova is there.',
  listening: 'The person is talking to Nova.',
  working: 'Nova is doing something.',
  speaking: 'A reply is arriving.',
  'needs-you': 'Something needs the person while Nova keeps running: an approval waiting, a problem worth a look, capture running degraded. Amber.',
  stopped: 'Something stopped Nova: work can’t proceed, a dead-man’s switch fired, or a security refusal. Red, and nothing else is.',
  offline: 'Nova isn’t reachable.',
});
// The colour a state must take, where its meaning fixes it: stopped is the status vocabulary's
// Failed colour, needs-you its Needs you colour. No other state may take status/error.
export const ORB_STATE_COLORS: Readonly<Partial<Record<OrbState, readonly string[]>>> = Object.freeze({ stopped: ['status/error'], 'needs-you': ['orb/attention', 'status/attention'] });
// What the renderer can draw, by name. A state's look is one of each: a motion (how it moves), a
// light (how bright it is) and a mark (a ring around it, or none). Light and mark are its brightness
// pattern, so they are what is left under reduced motion, where nothing moves.
export const ORB_MOTIONS = Object.freeze(['breathe', 'swirl', 'pulse', 'ripple', 'beckon', 'alarm', 'still'] as const);
export const ORB_LIGHTS = Object.freeze(['soft', 'full', 'bright', 'stark', 'dim'] as const);
export const ORB_MARKS = Object.freeze(['none', 'ring', 'dashed'] as const);
export type OrbMotion = (typeof ORB_MOTIONS)[number];
export type OrbLight = (typeof ORB_LIGHTS)[number];
export type OrbMark = (typeof ORB_MARKS)[number];
export interface OrbLook { color: string; motion: OrbMotion; light: OrbLight; mark: OrbMark; reduced: { light: OrbLight; mark: OrbMark } }

// Each name as CSS custom properties the orb's layers read (ui/styles/components.css draws them; the
// keyframes are there too). Only these strings ever reach the CSS: a package picks names, not CSS.
const GLOW_BREATHE = 'orb-breathe var(--motion-breathe) var(--motion-ease) infinite alternate';
const MOTION_VARS: Readonly<Record<OrbMotion, Record<string, string>>> = {
  breathe: { 'glow-anim': GLOW_BREATHE, 'swirl-anim': 'none', 'swirl-op': '0' },
  swirl: { 'glow-anim': GLOW_BREATHE, 'swirl-anim': 'orb-swirl var(--motion-breathe) linear infinite', 'swirl-op': '1' },
  pulse: { 'glow-anim': 'orb-pulse var(--motion-pulse) var(--motion-ease) infinite', 'swirl-anim': 'none', 'swirl-op': '0' },
  ripple: { 'glow-anim': 'orb-ripple var(--motion-pulse) var(--motion-ease) infinite', 'swirl-anim': 'none', 'swirl-op': '0' },
  beckon: { 'glow-anim': 'orb-beckon calc(var(--motion-pulse) * 2) var(--motion-ease) infinite', 'swirl-anim': 'none', 'swirl-op': '0' },
  alarm: { 'glow-anim': 'orb-alarm var(--motion-pulse) step-end infinite', 'swirl-anim': 'none', 'swirl-op': '0' },
  still: { 'glow-anim': 'none', 'swirl-anim': 'none', 'swirl-op': '0' },
};
const LIGHT_VARS: Readonly<Record<OrbLight, Record<string, string>>> = {
  soft: { 'glow-op': '0.7', 'glow-scale': '1', filter: 'brightness(0.92)', fade: '1' },
  full: { 'glow-op': '1', 'glow-scale': '1', filter: 'brightness(1)', fade: '1' },
  bright: { 'glow-op': '1', 'glow-scale': '1.08', filter: 'brightness(1.15)', fade: '1' },
  stark: { 'glow-op': '1', 'glow-scale': '1.12', filter: 'contrast(1.2)', fade: '1' },
  dim: { 'glow-op': '0.6', 'glow-scale': '1', filter: 'grayscale(1)', fade: '0.7' },
};
const MARK_VARS: Readonly<Record<OrbMark, Record<string, string>>> = { none: { mark: 'none' }, ring: { mark: 'solid' }, dashed: { mark: 'dashed' } };
// Every custom property a state's look sets on the orb (ui/styles/components.css declares each).
export const ORB_STATE_VARS: readonly string[] = Object.freeze(['c', 'g', 'hi', ...Object.keys(MOTION_VARS.breathe), ...Object.keys(LIGHT_VARS.soft), ...Object.keys(MARK_VARS.none)].map((k) => `--orb-${k}`));

// A state's look, as the channels that aren't hue: with motion, and under reduced motion.
const moving = (l: OrbLook) => `${l.motion}/${l.light}/${l.mark}`;
const resting = (l: OrbLook) => `${l.reduced.light}/${l.reduced.mark}`;

// The orb's rules (DESIGN-SYSTEM §1): the seven states, no more, no fewer; each a colour from the
// schema, a motion, a light and a mark, and a reduced-motion equivalent; no two states the same
// apart from their colour, with motion or without; stopped unlike every other state in every
// channel; and the colours their meanings fix.
export function checkOrbStates(input: unknown): string[] {
  const out: string[] = [];
  if (!isObj(input)) return [`orb_states must be an object with the orb’s ${ORB_STATES.length} states: ${ORB_STATES.join(', ')}.`];
  for (const s of Object.keys(input)) if (!(ORB_STATES as readonly string[]).includes(s)) out.push(`orb_states.${s} isn’t one of the orb’s states (${ORB_STATES.join(', ')}); a design system can’t add one.`);
  const looks: [OrbState, OrbLook][] = [];
  for (const s of ORB_STATES) {
    const l = input[s];
    if (l === undefined) { out.push(`orb_states.${s} is missing: every design system shows all ${ORB_STATES.length} of the orb’s states.`); continue; }
    if (!isObj(l)) { out.push(`orb_states.${s} must be an object: color, motion, light, mark and reduced.`); continue; }
    const before = out.length;
    for (const k of Object.keys(l)) if (!['color', 'motion', 'light', 'mark', 'reduced'].includes(k)) out.push(`orb_states.${s}.${k} isn’t part of a state’s look (color, motion, light, mark, reduced).`);
    if (typeof l.color !== 'string' || TOKENS[l.color]?.syntax !== 'color') out.push(`orb_states.${s}.color must name a colour token from the schema; got ${say(l.color)}.`);
    if (!(ORB_MOTIONS as readonly unknown[]).includes(l.motion)) out.push(`orb_states.${s}.motion must be one of ${ORB_MOTIONS.join(', ')}; got ${say(l.motion)}.`);
    if (!(ORB_LIGHTS as readonly unknown[]).includes(l.light)) out.push(`orb_states.${s}.light must be one of ${ORB_LIGHTS.join(', ')}; got ${say(l.light)}.`);
    if (!(ORB_MARKS as readonly unknown[]).includes(l.mark)) out.push(`orb_states.${s}.mark must be one of ${ORB_MARKS.join(', ')}; got ${say(l.mark)}.`);
    const r = l.reduced;
    if (!isObj(r)) out.push(`orb_states.${s}.reduced is missing: every state needs a reduced-motion equivalent, a light and a mark.`);
    else {
      if (!(ORB_LIGHTS as readonly unknown[]).includes(r.light)) out.push(`orb_states.${s}.reduced.light must be one of ${ORB_LIGHTS.join(', ')}; got ${say(r.light)}.`);
      if (!(ORB_MARKS as readonly unknown[]).includes(r.mark)) out.push(`orb_states.${s}.reduced.mark must be one of ${ORB_MARKS.join(', ')}; got ${say(r.mark)}.`);
    }
    const fixed = ORB_STATE_COLORS[s];
    if (fixed && typeof l.color === 'string' && !fixed.includes(l.color)) out.push(`orb_states.${s}.color must be ${fixed.join(' or ')}: that colour is what ${s} means.`);
    if (!fixed && l.color === 'status/error') out.push(`orb_states.${s}.color can’t be status/error: red is reserved for stopped.`);
    if (out.length === before) looks.push([s, l as unknown as OrbLook]);
  }
  // More than hue: with motion, and under reduced motion (where only the brightness pattern is left).
  for (let i = 0; i < looks.length; i++) {
    for (let j = i + 1; j < looks.length; j++) {
      const [a, la] = looks[i]!;
      const [b, lb] = looks[j]!;
      if (moving(la) === moving(lb)) out.push(`orb_states: ${a} and ${b} look the same apart from their colour (${moving(la)}); colour alone isn’t a safe channel, so give one a different motion, light or mark.`);
      if (resting(la) === resting(lb)) out.push(`orb_states: under reduced motion, ${a} and ${b} look the same apart from their colour (${resting(la)}); give one a different reduced light or mark.`);
    }
  }
  // Stopped is unmistakable: no other state shares its motion, its light or its mark, moving or not.
  const stopped = looks.find(([s]) => s === 'stopped')?.[1];
  if (stopped) {
    const others = looks.filter(([s]) => s !== 'stopped');
    const shared = (get: (l: OrbLook) => string) => others.filter(([, l]) => get(l) === get(stopped)).map(([s]) => s);
    for (const [what, get] of [['motion', (l: OrbLook) => l.motion], ['light', (l: OrbLook) => l.light], ['mark', (l: OrbLook) => l.mark],
      ['reduced light', (l: OrbLook) => l.reduced.light], ['reduced mark', (l: OrbLook) => l.reduced.mark]] as const) {
      const with_ = shared(get);
      if (with_.length) out.push(`orb_states: stopped must be unmistakable, so no other state shares its ${what} (${get(stopped)}); ${with_.join(', ')} ${with_.length === 1 ? 'does' : 'do'}.`);
    }
  }
  return out;
}

// One state's look as the custom properties the orb reads, and the reduced-motion part on its own.
export function orbStateVars(l: OrbLook): { moving: Record<string, string>; resting: Record<string, string> } {
  const own = l.color === 'orb/core' || l.color === 'orb/listening';
  return {
    moving: {
      c: `var(${cssVar(l.color)})`,
      // The default glow and highlight suit the orb's own colours; any other colour lights itself.
      g: own ? 'var(--orb-glow)' : `color-mix(in srgb, var(${cssVar(l.color)}) 50%, transparent)`,
      hi: own ? 'var(--orb-listening)' : `var(${cssVar(l.color)})`,
      ...MOTION_VARS[l.motion], ...LIGHT_VARS[l.light], ...MARK_VARS[l.mark],
    },
    resting: { ...LIGHT_VARS[l.reduced.light], ...MARK_VARS[l.reduced.mark] },
  };
}

// ---- value syntax --------------------------------------------------------------------------

export type Rgba = [number, number, number, number];

export function parseColor(v: unknown): Rgba | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  let m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s);
  if (m) {
    const h = m[1]!.length <= 4 ? [...m[1]!].map((c) => c + c).join('') : m[1]!;
    const n = [0, 2, 4, 6].map((i) => (i < h.length ? parseInt(h.slice(i, i + 2), 16) : 255));
    return [n[0]!, n[1]!, n[2]!, n[3]! / 255];
  }
  const num = '(\\d{1,3}(?:\\.\\d+)?)';
  m = new RegExp(`^rgba?\\(\\s*${num}\\s*,\\s*${num}\\s*,\\s*${num}\\s*(?:,\\s*(0|1|0?\\.\\d+|1\\.0+)\\s*)?\\)$`, 'i').exec(s);
  if (m) {
    const c = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (c.some((x) => x > 255)) return null;
    return [c[0]!, c[1]!, c[2]!, m[4] === undefined ? 1 : Number(m[4])];
  }
  return null;
}

const N = '-?\\d*\\.?\\d+';
const LEN = '(?:0|\\d*\\.?\\d+(?:px|rem|em|%|vw|vh))';
const FONT_ITEM = `(?:"[A-Za-z0-9 -]+"|'[A-Za-z0-9 -]+'|-?[A-Za-z][A-Za-z0-9-]*(?: [A-Za-z][A-Za-z0-9-]*)*)`;
const RE = {
  font: new RegExp(`^${FONT_ITEM}(?:\\s*,\\s*${FONT_ITEM})*$`),
  size: /^\d*\.?\d+(?:px|rem|em)$/,
  weight: /^[1-9]\d{2}$/,
  line: /^\d*\.?\d+$/,
  length: new RegExp(`^${LEN}$`),
  duration: /^\d*\.?\d+(?:ms|s)$/,
  easing: new RegExp(`^(?:linear|ease|ease-in|ease-out|ease-in-out|cubic-bezier\\(\\s*${N}\\s*,\\s*${N}\\s*,\\s*${N}\\s*,\\s*${N}\\s*\\))$`),
  shadow: new RegExp(`^(?:inset\\s+)?((?:-?${LEN}\\s+){1,3}-?${LEN})\\s+(.+)$`),
};

const HINT: Record<Syntax, string> = {
  color: 'must be a colour, like #1b1f24 or rgba(0, 0, 0, 0.5)',
  font: 'must be a list of font names, like "Iowan Old Style", Georgia, serif',
  size: 'must be a size in px, rem or em, like 15px',
  weight: 'must be a weight from 100 to 900, like 600',
  line: 'must be a plain number, like 1.5',
  length: 'must be a length, like 16px (or 0)',
  shadow: 'must be "none" or shadows made of lengths and a colour, like 0 1px 2px rgba(0, 0, 0, 0.2)',
  duration: 'must be a duration in ms or s, like 200ms',
  easing: 'must be an easing: linear, ease, ease-in, ease-out, ease-in-out or cubic-bezier(…)',
};

// Splits on commas outside parentheses: "0 1px red, 0 2px rgba(0, 0, 0, 0.1)" → two shadows.
const topLevel = (s: string) => {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim());
};

export function validValue(syntax: Syntax, v: unknown): boolean {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (s !== v || !s) return false;
  switch (syntax) {
    case 'color': return parseColor(s) !== null;
    case 'weight': return RE.weight.test(s) && Number(s) >= 100 && Number(s) <= 900;
    case 'line': return RE.line.test(s) && Number(s) >= 0.8 && Number(s) <= 3;
    case 'shadow': return s === 'none' || topLevel(s).every((part) => { const m = RE.shadow.exec(part); return !!m && parseColor(m[2]) !== null; });
    default: return RE[syntax].test(s);
  }
}

const ms = (d: string) => (d.endsWith('ms') ? Number(d.slice(0, -2)) : Number(d.slice(0, -1)) * 1000);

// ---- contrast (the WCAG math from Era 2's scripts/check-themes.js) ------------------------------------

const over = (fg: Rgba, bg: Rgba): Rgba => [0, 1, 2].map((i) => fg[i]! * fg[3] + bg[i]! * (1 - fg[3])).concat(1) as Rgba;

function luminance([r, g, b]: number[]): number {
  const f = (c: number) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!);
}

export function contrast(a: number[], b: number[]): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
}

// Translucent text sits on its background.
// A see-through surface is seen over the page. Validation, as before M9, sees it over bg/base. The
// live check (`page: true`, M9) sees it over both ends of the page's gradient, bg/raised to bg/base:
// measured in the browser, the raised end is often the worse one. That stricter view warns and offers
// the fix; it never disables a design that was valid (review of PR #234).
function ratio(tokens: Record<string, unknown>, fg: string, bg: string, page = false): number | null {
  const base = parseColor(tokens['bg/base']);
  const b0 = parseColor(tokens[bg]);
  const f0 = parseColor(tokens[fg]);
  if (!base || !b0 || !f0 || base[3] < 1) return null;
  const r0 = parseColor(tokens['bg/raised']);
  const pages = [base, ...(page && r0 ? [r0[3] < 1 ? over(r0, base) : r0] : [])];
  const backs = b0[3] < 1 ? pages.map((u) => over(b0, u)) : [b0];
  return Math.min(...backs.map((b) => contrast(f0[3] < 1 ? over(f0, b) : f0, b)));
}

// The label colour for an accent button: the candidate with the best contrast on accent/primary.
function accentLabel(tokens: Record<string, unknown>): { token: string; ratio: number } | null {
  let best: { token: string; ratio: number } | null = null;
  for (const t of ACCENT_LABELS) {
    const c = parseColor(tokens[t]);
    if (!c || c[3] < 1) continue;
    const r = ratio(tokens, t, 'accent/primary');
    if (r !== null && (!best || r > best.ratio)) best = { token: t, ratio: r };
  }
  return best;
}

// ---- the live check and its one-tap fix -------------------------------------------------------------

export interface CheckResult { fg: string; bg: string; min: number; kind: CheckKind; what: string; ratio: number; ok: boolean }

// Every live check on one resolved token set. `margin` is the worst ratio over its minimum: under
// 1 means something fails.
export function liveCheck(tokens: Record<string, unknown>): { ok: boolean; margin: number; results: CheckResult[] } {
  const results: CheckResult[] = [];
  for (const [fg, bg, min, kind, what] of LIVE_CHECKS) {
    const r = ratio(tokens, fg, bg, true);
    if (r === null) continue;
    results.push({ fg, bg, min, kind, what, ratio: Math.round(r * 100) / 100, ok: r >= min });
  }
  const margin = results.reduce((m, x) => Math.min(m, x.ratio / x.min), Infinity);
  return { ok: results.every((x) => x.ok), margin: Number.isFinite(margin) ? Math.round(margin * 1000) / 1000 : 1, results };
}

// A package's token sets as a device can see them: its own values, and each mode's on top.
export function looks(pkg: DesignPackage): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = { default: { ...pkg.tokens } };
  for (const m of ['light', 'dark'] as const) if (pkg.modes?.[m] && Object.keys(pkg.modes[m]!).length) out[m] = { ...pkg.tokens, ...pkg.modes[m]! };
  return out;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const fmt = ([r, g, b, a]: Rgba) => (a >= 1 ? `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}` : `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${round2(a)})`);

// A foreground moved part of the way (k, 0 to 1) towards a stronger colour: the package's own
// primary text, or for primary text itself, black or white, whichever is further from the
// background. Only the one token moves; nothing else in the package changes.
function nudged(tokens: Record<string, string>, token: string, k: number): string {
  const fg = parseColor(tokens[token])!;
  const target: Rgba = token === 'text/primary'
    ? (scheme(tokens) === 'dark' ? [255, 255, 255, 1] : [0, 0, 0, 1])
    : parseColor(tokens['text/primary'])!;
  const mix = [0, 1, 2, 3].map((i) => fg[i]! + (target[i]! - fg[i]!) * k) as Rgba;
  return fmt(mix);
}

export const NUDGE_STEP = 0.05;

// The smallest nudge, in steps of NUDGE_STEP, that makes every live check of each failing
// foreground pass in every look the package has. Tokens that already pass are left alone; a
// token that can't be fixed this way is left out, and reported.
export function contrastNudge(pkg: DesignPackage): { nudge: Record<string, number>; unfixable: string[] } {
  const sets = Object.values(looks(pkg));
  const failing = [...new Set(sets.flatMap((t) => liveCheck(t).results.filter((r) => !r.ok).map((r) => r.fg)))];
  const nudge: Record<string, number> = {};
  const unfixable: string[] = [];
  for (const token of failing) {
    let found: number | null = null;
    for (let step = 1; step * NUDGE_STEP <= 1 + 1e-9 && found === null; step++) {
      const k = round2(step * NUDGE_STEP);
      const passes = sets.every((t) => liveCheck({ ...t, [token]: nudged(t, token, k) }).results.every((r) => r.fg !== token || r.ok));
      if (passes) found = k;
    }
    if (found === null) unfixable.push(token); else nudge[token] = found;
  }
  return { nudge, unfixable };
}

// Tokens with a device's nudge applied, computed on the set they belong to.
export function applyNudge(tokens: Record<string, string>, nudge: Record<string, number> = {}): Record<string, string> {
  const out = { ...tokens };
  for (const [token, k] of Object.entries(nudge)) if (TOKENS[token]?.syntax === 'color' && token in tokens && k > 0 && k <= 1) out[token] = nudged(tokens, token, k);
  return out;
}

// ---- package validation -------------------------------------------------------------------------

export interface Extra { id: string; name: string; description: string }
export interface DesignPackage extends Manifest {
  description?: string;
  tokens: Record<string, string>;
  modes?: { light?: Record<string, string>; dark?: Record<string, string> };
  reduced_motion?: Record<string, string>;
  orb_states: Record<OrbState, OrbLook>;
  components?: Record<string, Record<string, string | string[]>>;
  content_rules?: Record<string, number | boolean>;
  extras?: Extra[];
  preview?: string[];
  ios_status_bar?: IosStatusBar | { light: IosStatusBar; dark: IosStatusBar };
}

// The status bar each appearance gets: `light` is what the light (or auto-light) look shows, `dark`
// the dark one. A package with one look has the same word for both.
export function iosStatusBar(pkg: { ios_status_bar?: unknown }): { light: IosStatusBar; dark: IosStatusBar; declared: boolean } {
  const ok = (v: unknown): v is IosStatusBar => IOS_STATUS_BARS.includes(v as IosStatusBar);
  const d = pkg.ios_status_bar;
  if (ok(d)) return { light: d, dark: d, declared: true };
  if (isObj(d) && ok(d.light) && ok(d.dark)) return { light: d.light, dark: d.dark, declared: true };
  return { light: IOS_STATUS_BAR_UNDECLARED, dark: IOS_STATUS_BAR_UNDECLARED, declared: false };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const say = (v: unknown) => JSON.stringify(v) ?? String(v);
const ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

// The manifest promises every design system makes. Checked at install by the extension host too.
export function manifestRules(m: { permissions?: unknown; secrets?: unknown; on_remove?: unknown }): string[] {
  const out: string[] = [];
  if (Array.isArray(m.permissions) && m.permissions.length) out.push('A design system asks for no permissions.');
  if (Array.isArray(m.secrets) && m.secrets.length) out.push('A design system uses no secrets.');
  const r = m.on_remove;
  if (isObj(r) && ((Array.isArray(r.keep) && r.keep.length) || (Array.isArray(r.export) && r.export.length))) out.push('A design system keeps nothing when it is removed.');
  return out;
}

function checkValues(values: Record<string, unknown>, where: string, out: string[]) {
  for (const [name, v] of Object.entries(values)) {
    const t = TOKENS[name];
    if (!t) { out.push(`${where}${name} isn’t a token in the schema.`); continue; }
    if (!validValue(t.syntax, v)) out.push(`${where}${name} ${HINT[t.syntax]}; got ${say(v)}.`);
  }
}

// `problems` stop a package being applied; `warnings` don't (M9's motion range, say: a design made
// before it is clamped when its CSS is generated, never refused).
export function validatePackage(input: unknown): { ok: boolean; problems: string[]; warnings: string[] } {
  const out: string[] = [];
  const warn: string[] = [];
  if (!isObj(input)) return { ok: false, problems: ['A design system must be an object.'], warnings: [] };
  const p = input;
  try { validateManifest(p); } catch (e) { out.push(...((e as CoreError).details?.length ? (e as CoreError).details : [(e as Error).message])); }
  if (p.kind !== 'design-system') out.push('kind must be design-system.');
  out.push(...manifestRules(p));
  if (p.description !== undefined && typeof p.description !== 'string') out.push('description must be text.');

  // Completeness and syntax.
  if (!isObj(p.tokens)) out.push('tokens must be an object holding every token in the schema.');
  const tokens = isObj(p.tokens) ? p.tokens : {};
  for (const name of TOKEN_NAMES) if (!(name in tokens)) out.push(`Missing token ${name}.`);
  checkValues(tokens, '', out);

  // Modes: partial overrides for light and dark.
  const modes: Record<string, Record<string, unknown>> = {};
  if (p.modes !== undefined && !isObj(p.modes)) out.push('modes must be an object with light and dark, each optional.');
  for (const [mode, values] of Object.entries(isObj(p.modes) ? p.modes : {})) {
    if (mode !== 'light' && mode !== 'dark') { out.push(`modes can only be light and dark; ${mode} isn’t one.`); continue; }
    if (!isObj(values)) { out.push(`modes.${mode} must be an object of tokens.`); continue; }
    checkValues(values, `modes.${mode}: `, out);
    modes[mode] = values;
  }

  // Contrast, in the default set and in each mode.
  const base = parseColor(tokens['bg/base']);
  if (base && base[3] < 1) out.push('bg/base must be solid (no transparency), because everything else is measured against it.');
  for (const [mode, set] of [['', tokens], ...Object.entries(modes).map(([m, v]) => [m, { ...tokens, ...v }])] as [string, Record<string, unknown>][]) {
    const lead = mode ? `In ${mode} mode, ` : '';
    for (const [fg, bg, min, what] of CONTRAST_PAIRS) {
      const r = ratio(set, fg, bg);
      if (r !== null && r < min) out.push(`${lead}${fg} on ${bg} is ${r.toFixed(2)}:1; it needs ${min}:1 (${what}).`);
    }
    const label = accentLabel(set);
    if (label && label.ratio < 4.5) out.push(`${lead}nothing reads on accent/primary: the best of ${ACCENT_LABELS.join(', ')} is ${label.ratio.toFixed(2)}:1; it needs 4.5:1 (labels on accent buttons).`);
  }

  // Motion: transitions in 150–300 ms, and no curve that bounces, in the default set and each mode.
  // A warning: the generated CSS clamps it (motionValue), so a design made before M9 still applies.
  for (const [mode, set] of [['', tokens], ...Object.entries(modes).map(([m, v]) => [m, v])] as [string, Record<string, unknown>][]) {
    const lead = mode ? `In ${mode} mode, ` : '';
    for (const name of TRANSITION_TOKENS) {
      const v = set[name];
      if (typeof v !== 'string' || !validValue('duration', v)) continue;
      if (ms(v) < MOTION_MIN_MS || ms(v) > MOTION_MAX_MS) warn.push(`${lead}${name} should be ${MOTION_MIN_MS}–${MOTION_MAX_MS}ms (calm, and never felt as a wait); got ${v}, so Nova uses ${motionValue(name, v)}.`);
    }
    const ease = set['motion/ease'];
    if (typeof ease === 'string' && validValue('easing', ease) && overshoots(ease)) warn.push(`${lead}motion/ease overshoots (${ease}): no bounce or elastic motion, so Nova uses ${motionValue('motion/ease', ease)}.`);
  }

  // The designed scales (§0, §2.1): a warning, never a refusal, so a package made before them still
  // applies. The authoring gate (scripts/check-themes.js) holds the packages at the bar to them.
  if (isObj(p.tokens)) for (const f of packageScaleFindings(p)) warn.push(`Off the designed scales: ${f}`);

  // Reduced motion: loops stop, transitions stay short.
  if (p.reduced_motion !== undefined && !isObj(p.reduced_motion)) out.push('reduced_motion must be an object of motion tokens.');
  for (const [name, v] of Object.entries(isObj(p.reduced_motion) ? p.reduced_motion : {})) {
    const t = TOKENS[name];
    if (!t || t.group !== 'motion') { out.push(`reduced_motion can only set motion tokens; ${name} isn’t one.`); continue; }
    if (!validValue(t.syntax, v)) { out.push(`reduced_motion: ${name} ${HINT[t.syntax]}; got ${say(v)}.`); continue; }
    if (t.syntax !== 'duration') continue;
    if (LOOPS.includes(name) && ms(v as string) !== 0) out.push(`Under reduced motion, ${name} must be 0s because it repeats; got ${v}.`);
    else if (ms(v as string) > REDUCED_MOTION_MAX_MS) out.push(`Under reduced motion, ${name} can be at most ${REDUCED_MOTION_MAX_MS}ms; got ${v}.`);
  }

  // The orb's states: all seven, each its own in more than colour, stopped unmistakable.
  out.push(...checkOrbStates(p.orb_states));

  // Content rules: tighten only.
  if (p.content_rules !== undefined && !isObj(p.content_rules)) out.push('content_rules must be an object.');
  for (const [rule, v] of Object.entries(isObj(p.content_rules) ? p.content_rules : {})) {
    const limit = (CONTENT_RULES as Record<string, number | boolean>)[rule];
    if (limit === undefined) { out.push(`content_rules.${rule} isn’t a content rule.`); continue; }
    if (typeof limit === 'boolean') { if (v !== true) out.push(`content_rules: ${rule} can’t be turned off.`); continue; }
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) out.push(`content_rules.${rule} must be a whole number.`);
    else if (v > limit) out.push(`content_rules can only tighten the defaults: ${rule} can be at most ${limit}; got ${v}.`);
  }

  // Extras and component bindings.
  if (p.extras !== undefined && !Array.isArray(p.extras)) out.push('extras must be a list.');
  const extras = Array.isArray(p.extras) ? p.extras : [];
  if (!extras.every((x) => isObj(x) && typeof x.id === 'string' && ID.test(x.id) && typeof x.name === 'string' && x.name.trim() && typeof x.description === 'string' && x.description.trim())) {
    out.push('Each extra needs an id, a name and a description.');
  }
  const declared = new Set(extras.filter(isObj).map((x) => x.id));
  if (p.components !== undefined && !isObj(p.components)) out.push('components must be an object of per-component token bindings.');
  for (const [component, bindings] of Object.entries(isObj(p.components) ? p.components : {})) {
    if (!COMPONENTS.includes(component) && !declared.has(component)) out.push(`components.${component} isn’t a standard component, so it must be declared in extras.`);
    if (!isObj(bindings)) { out.push(`components.${component} must be an object of token bindings.`); continue; }
    for (const [prop, v] of Object.entries(bindings)) {
      const list = Array.isArray(v) ? v : [v];
      const bad = list.length ? list.find((t) => typeof t !== 'string' || !TOKENS[t]) : v;
      if (bad !== undefined) out.push(`components.${component}.${prop} must name tokens from the schema; ${say(bad)} isn’t one.`);
    }
  }

  // The iPhone status bar (DESIGN-SYSTEM §5): a word, or one per appearance, and white status text
  // only over a dark look. Each appearance is the package's tokens with that mode's on top, as
  // generateCss resolves it.
  const bar = p.ios_status_bar;
  const word = (v: unknown) => IOS_STATUS_BARS.includes(v as IosStatusBar);
  if (bar === undefined) warn.push(`ios_status_bar isn’t declared, so an installed iPhone app keeps iOS’s own status bar strip (${IOS_STATUS_BAR_UNDECLARED}).`);
  else if (!(word(bar) || (isObj(bar) && Object.keys(bar).sort().join() === 'dark,light' && word(bar.light) && word(bar.dark)))) {
    out.push(`ios_status_bar must be ${IOS_STATUS_BARS.join(' or ')}, or { light, dark } with one of those each; got ${say(bar)}.`);
  } else {
    // Unreadable white status text is a problem; a dark look that keeps iOS's strip only a warning
    // (the owner's rule says dark designs draw behind it, but nothing is unreadable either way).
    // A one-look package's light and dark are the same set, so each finding is said once.
    const declared = iosStatusBar(p);
    const [bad, odd] = [new Set<string>(), new Set<string>()];
    for (const m of ['light', 'dark'] as const) {
      const set = { ...tokens, ...(modes[m] ?? {}) } as Record<string, string>;
      if (!parseColor(set['bg/base'])) continue;
      const look = scheme(set);
      const lead = isObj(bar) ? `ios_status_bar.${m}` : 'ios_status_bar';
      if (declared[m] === 'translucent' && look === 'light') bad.add(`${lead} is translucent over a light look: iOS then draws the status bar’s time and battery in white, so it must be default.`);
      if (declared[m] === 'default' && look === 'dark') odd.add(`${lead} is default over a dark look: dark designs draw behind the status bar (translucent), so Nova’s background reaches the top edge.`);
    }
    out.push(...bad);
    warn.push(...odd);
  }

  if (p.preview !== undefined && !(Array.isArray(p.preview) && p.preview.every((x) => typeof x === 'string' && /^(?!\/)(?!.*\.\.)[\w./-]+\.(png|jpe?g|webp)$/.test(x)))) {
    out.push('preview must be a list of image paths inside the package, like previews/home.png.');
  }
  return { ok: out.length === 0, problems: out, warnings: warn };
}

// ---- CSS generation -------------------------------------------------------------------------------

const scheme = (tokens: Record<string, string>) => (luminance(parseColor(tokens['bg/base'])!) < 0.2 ? 'dark' : 'light');

function block(selector: string, lines: string[], indent = '') {
  return `${indent}${selector} {\n${lines.map((l) => `${indent}  ${l}`).join('\n')}\n${indent}}`;
}

// Tokens (and modes) → CSS variables. `auto` follows the system's light/dark preference; `light`
// and `dark` pick that mode's values. Reduced motion is always honoured. Only a valid package
// becomes CSS, so no value can carry anything but what its token family allows.
// `nudge` is a device's contrast fix (Design.fixContrast): each named colour moved towards a
// stronger one, computed on each look's own values.
export function generateCss(input: unknown, o: { mode?: Mode; nudge?: Record<string, number> } = {}): string {
  const v = validatePackage(input);
  const name = isObj(input) && typeof input.name === 'string' ? input.name : 'This design system';
  if (!v.ok) throw new CoreError('validation', `${name} isn’t valid, so Nova won’t turn it into CSS.`, v.problems);
  const pkg = input as unknown as DesignPackage;
  const mode = o.mode ?? 'auto';
  const nudge = o.nudge ?? {};
  const fixed = Object.keys(nudge).length > 0;
  const resolved = applyNudge(mode === 'auto' ? pkg.tokens : { ...pkg.tokens, ...(pkg.modes?.[mode] ?? {}) }, nudge);
  // Type sizes go out in rem (M9: 200% text), so a person's own text size scales Nova's text: a
  // package's 16px is 1rem, the same at the browser's default and twice as big at 200%.
  const css = (n: string, v: string) => (TOKENS[n]?.syntax === 'size' && /^\d*\.?\d+px$/.test(v) ? `${Number((parseFloat(v) / 16).toFixed(4))}rem` : v);
  const vars = (t: Record<string, string>, motion = true) => TOKEN_NAMES.filter((n) => n in t).map((n) => `${cssVar(n)}: ${css(n, motion ? motionValue(n, t[n]!) : t[n]!)};`);
  const safe = `${name} ${pkg.version} (${pkg.id})`.replace(/[^\w .,'’()-]/g, '');

  const root = [`color-scheme: ${scheme(resolved)};`, ...vars(resolved)];
  const parts = [`/* ${safe}, mode ${mode}${fixed ? ', with this device’s contrast fix' : ''}. Generated by Nova from the package’s tokens; don’t edit. */`, block(':root', root)];
  if (mode === 'auto') {
    for (const m of ['light', 'dark'] as const) {
      const over = pkg.modes?.[m];
      if (!over || !Object.keys(over).length) continue;
      const t = { ...pkg.tokens, ...over };
      const fixedT = applyNudge(t, nudge);
      const changed = { ...over, ...Object.fromEntries(Object.keys(nudge).filter((n) => n in fixedT).map((n) => [n, fixedT[n]!])) };
      parts.push(`@media (prefers-color-scheme: ${m}) {\n${block(':root', [`color-scheme: ${scheme(t)};`, ...vars(changed)], '  ')}\n}`);
    }
  }
  // The orb's states: the package's look for each, as the custom properties the orb's layers read.
  const orbVars = (v: Record<string, string>) => Object.entries(v).map(([k, x]) => `--orb-${k}: ${x};`);
  const looksOf = ORB_STATES.map((s) => [s, orbStateVars(pkg.orb_states[s])] as const);
  for (const [s, v] of looksOf) parts.push(block(`.orb[data-state="${s}"]`, orbVars(v.moving)));
  const reduced = { ...REDUCED_MOTION, ...(pkg.reduced_motion ?? {}) };
  parts.push(`@media (prefers-reduced-motion: reduce) {\n${[block(':root', vars(reduced, false), '  '), ...looksOf.map(([s, v]) => block(`.orb[data-state="${s}"]`, orbVars(v.resting), '  '))].join('\n')}\n}`);
  return `${parts.join('\n')}\n`;
}

// ---- selection: which package is applied, for the person and per device -------------------------------

export type Scope = 'user' | 'device';
export interface Appearance {
  design_system: string | null;
  previous: string | null;
  mode: Mode;
  device_overrides: Record<string, string>;
  // Per-device rollback: what the device showed before its last override (null: no override).
  device_previous: Record<string, string | null>;
  // Per-device contrast fixes: for one design system, the colours nudged on that device only.
  device_fixes: Record<string, DeviceFix>;
  // Which paired device (registry id) each appearance id belongs to, so revoking the device
  // forgets its appearance too. The hub's own screen has none.
  device_owners: Record<string, string>;
}
export interface DeviceFix { design_system: string; nudge: Record<string, number> }
// `ios_status_bar`: what the installed iPhone app's status bar is in each appearance (§5); the page
// picks light or dark as its CSS does (the mode, or the system's preference under auto).
export interface Active { id: string; name: string; scope: 'device' | 'user' | 'default'; mode: Mode; device_id?: string; fix?: Record<string, number>; ios_status_bar: { light: IosStatusBar; dark: IosStatusBar } }

// The app page's status bar tag (ui/index.html) as it ships: iOS's own strip, and the words a
// script just after it reads to pick light or dark. The server writes the device's design's words
// in before sending the page, so the value is in place when iOS reads it, at launch.
export const STATUS_BAR_TAG = '<meta name="apple-mobile-web-app-status-bar-style" id="ios-status-bar" content="default" data-light="default" data-dark="default" data-mode="auto">';
export function statusBarTag(a: Pick<Active, 'mode' | 'ios_status_bar'>): string {
  const { light, dark } = a.ios_status_bar;
  // Under auto with two different words, the script decides from the system's preference.
  const now = a.mode === 'dark' ? dark : a.mode === 'light' || light === dark ? light : IOS_STATUS_BAR_UNDECLARED;
  return `<meta name="apple-mobile-web-app-status-bar-style" id="ios-status-bar" content="${IOS_STATUS_BAR_META[now]}" data-light="${light}" data-dark="${dark}" data-mode="${a.mode}">`;
}

const DEVICE = /^[A-Za-z0-9_-]{8,64}$/;

export class Design extends EventEmitter {
  readonly dir: string;
  #extensions: Extensions;
  #profile: Profile;
  #builtins: Map<string, DesignPackage>;

  constructor(o: { extensions: Extensions; profile: Profile; dir?: string }) {
    super();
    this.#extensions = o.extensions;
    this.#profile = o.profile;
    this.dir = o.dir ?? BUILTIN_DIR;
    this.#builtins = new Map(readdirSync(this.dir).filter((f) => f.endsWith('.json')).sort().map((f) => {
      const pkg = JSON.parse(readFileSync(join(this.dir, f), 'utf8')) as DesignPackage;
      return [pkg.id, pkg];
    }));
    this.#extensions.defineKind('design-system', {
      check: manifestRules,
      protect: (x) => (this.#builtins.has(x.id) ? `${x.manifest.name} is built in, so it can’t be removed. Choose another design system instead.` : null),
    });
    // Removing or turning off a package that is in use falls back to what came before it, and
    // open pages hear about it. Turning one on can change what shows where it is the fallback.
    this.#extensions.on('change', (c: { id: string; state: string }) => {
      if (c.state === 'removed') return this.#forget(c.id, 'removed'); // already gone: a no-op unless it was in use
      if (!this.#installed().some((x) => x.id === c.id)) return; // another kind of extension
      if (c.state === 'disabled') this.#forget(c.id, 'turned-off');
      else if (c.state === 'enabled') this.#changed('turned-on', this.active().id, null);
    });
  }

  // Built-ins are present on every install without the person doing anything, and are updated
  // in place when Nova ships a newer version. The person's choice is never touched.
  // Returns what went wrong, in plain words, so the caller can report it as a problem; a broken
  // built-in never stops Nova from starting.
  ensureBuiltins(): string[] {
    const problems: string[] = [];
    for (const pkg of this.#builtins.values()) {
      try {
        const installed = this.#extensions.list().find((x) => x.id === pkg.id);
        if (!installed) {
          this.#extensions.install(pkg, { builtin: true });
          this.#extensions.enable(pkg.id);
        } else if (installed.version !== pkg.version || JSON.stringify(installed.manifest) !== JSON.stringify(pkg)) {
          this.#extensions.update(pkg, { builtin: true });
        }
      } catch (e) {
        const details = e instanceof CoreError && e.details.length ? ` ${e.details.join(' ')}` : '';
        problems.push(`The built-in design system ${pkg.name ?? pkg.id} couldn’t be installed: ${(e as Error).message}${details}`);
      }
    }
    return problems;
  }

  schema() {
    return {
      tokens: TOKEN_NAMES.map((name) => ({ name, css: cssVar(name), group: TOKENS[name]!.group, syntax: TOKENS[name]!.syntax, rule: HINT[TOKENS[name]!.syntax] })),
      modes: MODES,
      components: COMPONENTS,
      content_rules: CONTENT_RULES,
      contrast: CONTRAST_PAIRS.map(([fg, bg, min, what]) => ({ fg, bg, min, what })),
      live_checks: LIVE_CHECKS.map(([fg, bg, min, kind, what]) => ({ fg, bg, min, kind, what })),
      reduced_motion: { always: REDUCED_MOTION, max_ms: REDUCED_MOTION_MAX_MS },
      // The designed scales (§0, §2.1): the structure every package re-expresses, for the styleguide.
      scales: {
        lead: LEAD_DESIGN_SYSTEM, at_the_bar: AT_THE_BAR,
        space: Object.entries(SPACE_SCALE).map(([token, v]) => ({ token, ...v })),
        type: { steps: TYPE_STEPS.map(([token, step]) => ({ token, step })), ratio: TYPE_RATIO, min_px: TYPE_MIN_PX },
        elevation: ['shadow/card', 'shadow/raised'], radius: RADIUS_CLASSES,
        motion: ['motion/duration-fast', 'motion/transition', 'motion/duration-slow', 'motion/pulse', 'motion/breathe', 'motion/ease'],
        icon_stroke: ICON_STROKE,
      },
      orb_states: { states: ORB_STATES.map((name) => ({ name, meaning: ORB_MEANINGS[name], ...(ORB_STATE_COLORS[name] ? { color: ORB_STATE_COLORS[name] } : {}) })), motions: ORB_MOTIONS, lights: ORB_LIGHTS, marks: ORB_MARKS },
    };
  }

  list() {
    const active = this.active().id;
    return this.#installed().map((x) => ({ ...this.#summary(x), active: x.id === active }));
  }

  get(id: string) {
    const x = this.#find(id);
    return { ...this.#summary(x), active: this.active().id === id, manifest: x.manifest };
  }

  validate(id: string) {
    return validatePackage(this.#find(id).manifest);
  }

  install(input: unknown) {
    if (!isObj(input) || input.kind !== 'design-system') throw new CoreError('validation', 'This isn’t a design system: its kind must be design-system.');
    let installed;
    try {
      installed = this.#extensions.install(input);
    } catch (e) {
      if (e instanceof CoreError && e.details.length) throw new CoreError(e.code, `This design system can’t be installed: ${e.details.join(' ')}`, e.details);
      throw e;
    }
    const { extension, review } = installed;
    return { design_system: this.#summary(extension), review };
  }

  appearance(): Appearance {
    const a = this.#profile.section('appearance');
    return {
      design_system: typeof a.design_system === 'string' ? a.design_system : null,
      previous: typeof a.previous === 'string' ? a.previous : null,
      mode: MODES.includes(a.mode as Mode) ? (a.mode as Mode) : 'auto',
      device_overrides: isObj(a.device_overrides) ? (a.device_overrides as Record<string, string>) : {},
      device_previous: isObj(a.device_previous) ? (a.device_previous as Record<string, string | null>) : {},
      device_fixes: isObj(a.device_fixes) ? (a.device_fixes as Record<string, DeviceFix>) : {},
      device_owners: isObj(a.device_owners) ? (a.device_owners as Record<string, string>) : {},
    };
  }

  // What a device shows: its own override, else the person's choice, else the default.
  active(deviceId?: string | null): Active {
    const a = this.appearance();
    const named = (id: string, scope: Active['scope'], extra: Partial<Active> = {}): Active => {
      const m = this.#installed().find((x) => x.id === id)?.manifest;
      const { light, dark } = iosStatusBar((m ?? {}) as { ios_status_bar?: unknown });
      return { id, name: m?.name ?? id, scope, mode: a.mode, ...extra, ios_status_bar: { light, dark } };
    };
    const device = deviceId && DEVICE.test(deviceId) ? deviceId : null;
    const override = device ? a.device_overrides[device] : undefined;
    // This device's contrast fix, while it shows the design system the fix was made for.
    const fix = (id: string): Partial<Active> => {
      const f = device ? a.device_fixes[device] : undefined;
      return f && f.design_system === id && isObj(f.nudge) && Object.keys(f.nudge).length ? { fix: f.nudge } : {};
    };
    if (device && override && this.#usable(override)) return named(override, 'device', { device_id: device, ...fix(override) });
    if (a.design_system && this.#usable(a.design_system)) return named(a.design_system, 'user', fix(a.design_system));
    const fallback = [DEFAULT_DESIGN_SYSTEM, ...this.#builtins.keys()].find((id) => this.#usable(id)) ?? DEFAULT_DESIGN_SYSTEM;
    return named(fallback, 'default', fix(fallback));
  }

  state(deviceId?: string | null) {
    return { appearance: this.appearance(), active: this.active(deviceId) };
  }

  css(deviceId?: string | null): string {
    const a = this.active(deviceId);
    return generateCss(this.#find(a.id).manifest, { mode: a.mode, nudge: a.fix });
  }

  // The live check's one-tap fix, for one device: the failing colours of what it shows, nudged
  // just far enough to pass (contrastNudge). Kept per device and per design system, so other
  // devices and other designs are untouched; undoFix takes it away.
  fixContrast(o: { device_id?: string | null }) {
    const device = this.#scope({ scope: 'device', device_id: o.device_id });
    const active = this.active(device);
    const pkg = this.#find(active.id).manifest as DesignPackage;
    const { nudge, unfixable } = contrastNudge(pkg);
    if (!Object.keys(nudge).length) {
      throw new CoreError('conflict', unfixable.length ? `Nova can’t make ${active.name} readable by adjusting its colours. Choose another design.` : `Nothing to fix: every text and control in ${active.name} already passes.`);
    }
    this.#set('device_fixes', { ...this.appearance().device_fixes, [device!]: { design_system: active.id, nudge } });
    return { ...this.#changed('contrast-fix', active.id, device), fixed: Object.keys(nudge), unfixable };
  }

  undoFix(o: { device_id?: string | null }) {
    const device = this.#scope({ scope: 'device', device_id: o.device_id })!;
    const fixes = { ...this.appearance().device_fixes };
    if (!(device in fixes)) throw new CoreError('conflict', 'There’s no contrast fix on this device.');
    delete fixes[device];
    this.#set('device_fixes', fixes);
    return this.#changed('contrast-fix', this.active(device).id, device);
  }

  // For a sandboxed frame: any valid package, rendered without applying it.
  previewCss(id: string, mode?: string | null): string {
    const x = this.#applicable(id);
    const m = mode ? this.#mode(mode) : this.appearance().mode;
    return generateCss(x.manifest, { mode: m });
  }

  apply(id: string, o: { scope: Scope; device_id?: string | null }) {
    const device = this.#scope(o);
    this.#applicable(id);
    const a = this.appearance();
    if (device) {
      this.#set('device_previous', { ...a.device_previous, [device]: a.device_overrides[device] ?? null });
      this.#set('device_overrides', { ...a.device_overrides, [device]: id });
    } else {
      const current = this.active().id;
      if (current !== id) this.#set('previous', current);
      this.#set('design_system', id);
    }
    return this.#changed('apply', id, device);
  }

  // A device drops its own choice and shows the person's again. Rollback on that device brings
  // its own choice back.
  follow(o: { device_id?: string | null }) {
    const device = this.#scope({ scope: 'device', device_id: o.device_id })!;
    const a = this.appearance();
    const own = a.device_overrides[device];
    if (!own) return this.state(device);
    const overrides = { ...a.device_overrides };
    delete overrides[device];
    this.#set('device_previous', { ...a.device_previous, [device]: own });
    this.#set('device_overrides', overrides);
    return this.#changed('apply', this.active(device).id, device);
  }

  // A paired device used this appearance id: remember whose it is.
  own(appearanceId: string, registryId: string) {
    if (!DEVICE.test(appearanceId) || typeof registryId !== 'string' || !registryId) return;
    const owners = this.appearance().device_owners;
    if (owners[appearanceId] !== registryId) this.#set('device_owners', { ...owners, [appearanceId]: registryId });
  }

  // A device was revoked: its own design, its rollback and its contrast fix go with it.
  forgetDevice(registryId: string) {
    const a = this.appearance();
    const gone = Object.entries(a.device_owners).filter(([, r]) => r === registryId).map(([id]) => id);
    if (!gone.length) return;
    const drop = <T>(o: Record<string, T>) => Object.fromEntries(Object.entries(o).filter(([k]) => !gone.includes(k)));
    this.#set('device_overrides', drop(a.device_overrides));
    this.#set('device_previous', drop(a.device_previous));
    this.#set('device_fixes', drop(a.device_fixes));
    this.#set('device_owners', drop(a.device_owners));
    for (const id of gone) this.#changed('removed', this.active(id).id, id);
  }

  // One step back. Rolling back twice goes forward again.
  rollback(o: { scope: Scope; device_id?: string | null }) {
    const device = this.#scope(o);
    const a = this.appearance();
    if (device) {
      if (!(device in a.device_previous)) throw new CoreError('conflict', 'There’s nothing to go back to on this device yet.');
      const back = a.device_previous[device] ?? null;
      const overrides = { ...a.device_overrides };
      const current = overrides[device] ?? null;
      if (back) overrides[device] = back; else delete overrides[device];
      this.#set('device_overrides', overrides);
      this.#set('device_previous', { ...a.device_previous, [device]: current });
      return this.#changed('rollback', back ?? this.active().id, device);
    }
    if (!a.previous || !this.#usable(a.previous)) throw new CoreError('conflict', 'There’s nothing to go back to yet.');
    const current = this.active().id;
    this.#set('design_system', a.previous);
    this.#set('previous', current);
    return this.#changed('rollback', a.previous, null);
  }

  setMode(mode: unknown) {
    this.#set('mode', this.#mode(mode));
    return this.#changed('mode', this.active().id, null);
  }

  #mode(mode: unknown): Mode {
    if (!MODES.includes(mode as Mode)) throw new CoreError('validation', 'mode must be light, dark or auto.');
    return mode as Mode;
  }

  #scope(o: { scope: Scope; device_id?: string | null }): string | null {
    if (o.scope !== 'user' && o.scope !== 'device') throw new CoreError('validation', 'scope must be user or device.');
    if (o.scope === 'user') return null;
    if (typeof o.device_id !== 'string' || !DEVICE.test(o.device_id)) throw new CoreError('validation', 'A device choice needs a device_id: 8 to 64 letters, numbers, dashes or underscores.');
    return o.device_id;
  }

  #changed(action: 'apply' | 'rollback' | 'mode' | 'removed' | 'turned-off' | 'turned-on' | 'contrast-fix', id: string, device: string | null) {
    const out = { action, id, scope: device ? 'device' : 'user', ...(device ? { device_id: device } : {}), mode: this.appearance().mode };
    this.emit('change', out);
    return this.state(device);
  }

  #set(key: keyof Appearance, value: unknown) {
    this.#profile.set('appearance', key, value, 'settings');
  }

  #installed(): Installed[] {
    return this.#extensions.list().filter((x) => x.kind === 'design-system');
  }

  #find(id: string): Installed {
    const x = this.#installed().find((d) => d.id === id);
    if (!x) throw new CoreError('not_found', `No design system "${id}" is installed.`);
    return x;
  }

  #summary(x: Installed) {
    const v = validatePackage(x.manifest);
    const m = x.manifest as DesignPackage;
    // How each look reads (the live check) and a few colours for the picker's thumbnail.
    const seen = v.ok ? Object.fromEntries(Object.entries(looks(m)).map(([k, t]) => {
      const c = liveCheck(t);
      return [k, { scheme: scheme(t), ok: c.ok, margin: c.margin, swatch: { bg: t['bg/base'], raised: t['bg/raised'], card: t['surface/card'], text: t['text/primary'], accent: t['accent/primary'], orb: t['orb/core'] } }];
    })) : {};
    // What the one-tap fix could do for it: the colours it would move, and those it can't fix.
    const fix = v.ok ? contrastNudge(m) : { nudge: {}, unfixable: [] };
    return { id: x.id, name: m.name, version: x.version, description: m.description ?? '', state: x.state, builtin: this.#builtins.has(x.id), starter: STARTERS.includes(x.id), lead: x.id === LEAD_DESIGN_SYSTEM, at_bar: atTheBar(x.id, m), valid: v.ok, problems: v.problems, warnings: v.warnings, extras: m.extras ?? [], preview: m.preview ?? [], looks: seen, fixable: Object.keys(fix.nudge), unfixable: fix.unfixable };
  }

  #usable(id: string): boolean {
    const x = this.#installed().find((d) => d.id === id);
    return !!x && x.state !== 'disabled' && validatePackage(x.manifest).ok;
  }

  #applicable(id: string): Installed {
    const x = this.#find(id);
    if (x.state === 'disabled') throw new CoreError('conflict', `${x.manifest.name} is turned off. Turn it on before using it.`);
    const v = validatePackage(x.manifest);
    if (!v.ok) throw new CoreError('validation', `${x.manifest.name} can’t be applied until its problems are fixed.`, v.problems);
    return x;
  }

  #forget(id: string, action: 'removed' | 'turned-off') {
    const before = this.active().id;
    const a = this.appearance();
    let touched = false;
    if (a.design_system === id) {
      this.#set('design_system', a.previous && a.previous !== id && this.#usable(a.previous) ? a.previous : null);
      this.#set('previous', null);
      touched = true;
    } else if (a.previous === id) this.#set('previous', null);
    const overrides = Object.fromEntries(Object.entries(a.device_overrides).filter(([, v]) => v !== id));
    const previous = Object.fromEntries(Object.entries(a.device_previous).filter(([, v]) => v !== id));
    if (Object.keys(overrides).length !== Object.keys(a.device_overrides).length) { this.#set('device_overrides', overrides); touched = true; }
    if (Object.keys(previous).length !== Object.keys(a.device_previous).length) this.#set('device_previous', previous);
    const fixes = Object.fromEntries(Object.entries(a.device_fixes).filter(([, f]) => f.design_system !== id));
    if (Object.keys(fixes).length !== Object.keys(a.device_fixes).length) this.#set('device_fixes', fixes);
    // Also when it was only the fallback (a built-in turned off): what shows has changed.
    if (touched || before === id) this.#changed(action, this.active().id, null);
  }
}
