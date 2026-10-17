// Computer-use control tiers (FR-207, docs/11 §5.1): what the agent may do in an app, by the app's
// class. Browsers are view-only (act through the browser tool), terminals, code editors and IDEs
// click-only (observe, left click, scroll), other apps full; system settings, password managers,
// credential UIs, security software and banking or payment apps get nothing (handed to the user).
// The controller reports each window's class tier (novad classifies by verified identity); the Hub
// also classifies by name and applies the user's overrides, and the lowest tier wins: users and
// managed policy can lower a tier, nothing raises one.
import type { ScreenAction, ScreenAppTier } from '../computers/types.ts';

export type ControlTier = 'none' | ScreenAppTier;

const RANK: Record<ControlTier, number> = { none: 0, view: 1, click: 2, full: 3 };

export const TIER_LABEL: Record<ControlTier, string> = {
  none: 'No control (handled by you)',
  view: 'View only',
  click: 'Click only',
  full: 'Full control',
};

/** The lowest of the tiers given; ignores null and undefined. */
export function lowestTier(...tiers: (ControlTier | null | undefined)[]): ControlTier {
  let out: ControlTier = 'full';
  for (const t of tiers) if (t && RANK[t] < RANK[out]) out = t;
  return out;
}

// Generic words only: the shipped list of real apps lives in novad and matches by verified
// identity, not by name. A match here can only lower the controller's tier.
const SENSITIVE =
  /\b(passwords?|password manager|keychain|credentials?|system settings|system preferences|control panel|bank|banking|payments?|wallet|antivirus|security)\b/;
const BROWSER = /\b(web browser|browser)\b/;
const SHELL = /\b(terminal|console|shell|command prompt)\b/;
const EDITOR = /\b(code editor|text editor|editor|ide)\b/;

/** The class tier an app's name implies, or null when the name says nothing. */
export function classTierOf(app: string): ControlTier | null {
  const n = app.toLowerCase();
  if (SENSITIVE.test(n)) return 'none';
  if (BROWSER.test(n)) return 'view';
  if (SHELL.test(n) || EDITOR.test(n)) return 'click';
  return null;
}

/** The tier the agent gets in an app: the lowest of the controller's, the name's and the user's. */
export function effectiveTier(
  app: string,
  reported: ControlTier,
  overrides: Readonly<Record<string, ControlTier>> = {},
): ControlTier {
  const override = Object.entries(overrides).find(
    ([name]) => name.trim().toLowerCase() === app.trim().toLowerCase(),
  )?.[1];
  return lowestTier(reported, classTierOf(app), override);
}

export type ScreenActionKind = ScreenAction['kind'];

/** Whether an input event is allowed at a tier (observing is always allowed, at any tier). */
export function allowedAt(tier: ControlTier, action: ScreenAction): boolean {
  switch (tier) {
    case 'none':
    case 'view':
      return false;
    case 'click':
      return (
        (action.kind === 'click' && (action.button ?? 'left') === 'left') ||
        action.kind === 'scroll'
      );
    case 'full':
      return true;
  }
}

/** What the agent may do at a tier, for errors and grant prompts. */
export function allowedList(tier: ControlTier): string[] {
  switch (tier) {
    case 'none':
      return [];
    case 'view':
      return ['observe'];
    case 'click':
      return ['observe', 'left click', 'scroll'];
    case 'full':
      return ['observe', 'click', 'type', 'keys', 'drag', 'scroll'];
  }
}

/** The tool to use instead of a refused action (docs/11 §5.1 "Use instead"). */
export function tierAlternative(
  tier: ControlTier,
  app: string,
): { tool: string; text: string } | null {
  switch (tier) {
    case 'none':
      return {
        tool: 'handoff',
        text: `Ask the user to do this step in ${app} themselves; Nova never controls it.`,
      };
    case 'view':
      return {
        tool: 'browser',
        text: 'Use the browser tools (browser.*) to act in web pages.',
      };
    case 'click':
      return {
        tool: 'shell',
        text: 'Use the shell and file tools (exec.run, fs.write, fs.edit) instead of typing here.',
      };
    case 'full':
      return null;
  }
}

/** A clear refusal naming the tier and what to use instead (FR-207). */
export function tierRefusal(
  app: string,
  tier: ControlTier,
  action: ScreenAction,
): { code: string; message: string; details: Record<string, unknown> } {
  const instead = tierAlternative(tier, app);
  const what = describeAction(action);
  const level =
    tier === 'none'
      ? `${app} is never controlled by Nova (tier: none)`
      : `${app} is ${TIER_LABEL[tier].toLowerCase()} for computer use (tier: ${tier}), so ${what} is not allowed`;
  return {
    code: tier === 'none' ? 'screen_handoff' : 'screen_tier',
    message: `${level}. ${instead?.text ?? ''}`.trim(),
    details: { app, tier, allowed: allowedList(tier), useInstead: instead?.tool ?? null },
  };
}

export function describeAction(action: ScreenAction): string {
  switch (action.kind) {
    case 'click':
      return action.button === 'right' ? 'a right click' : 'a click';
    case 'scroll':
      return 'scrolling';
    case 'type':
      return 'typing';
    case 'key':
      return 'pressing keys';
    case 'drag':
      return 'dragging';
  }
}
