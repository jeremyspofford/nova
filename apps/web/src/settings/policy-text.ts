// Plain words for policy outcomes, shared by Tools & MCP, Permissions and the onboarding tool step
// (docs/04 §2.6, docs/12 §2.1, §3, §4.1). The engine's ids never reach the user as-is.
import type {
  ActionEffectClass,
  ConfirmationTier,
  McpStatus,
  PermissionGrantView,
  PolicyEffect,
  ToolSource,
} from '@nova/shared';
import type { IconName } from '@nova/ui';

/** What a decision means, short enough for a chip. */
export const EFFECT_TEXT: Record<PolicyEffect, string> = {
  allow: 'Allowed',
  ask: 'Asks first',
  handoff: 'Hand off to you',
  deny: 'Denied',
};

/** The rule vocabulary of docs/12 §3, used in the rule editor. */
export const RULE_EFFECT_TEXT: Record<PolicyEffect, string> = {
  allow: 'Take action without asking',
  ask: 'Ask before taking action',
  handoff: 'Hand off to you',
  deny: 'Never take this action',
};

/** Chip tone per decision: icon plus text, never color alone (docs/04 §7). */
export const EFFECT_TONE: Record<PolicyEffect, { tone: string; icon: IconName }> = {
  allow: { tone: 'ready', icon: 'check' },
  ask: { tone: 'needs_input', icon: 'hand' },
  handoff: { tone: 'needs_input', icon: 'hand' },
  deny: { tone: 'blocked', icon: 'stop' },
};

export const TIER_TEXT: Record<ConfirmationTier, string> = {
  pre_approvable: 'Pre-approvable',
  confirm_at_action: 'Asked every time; cannot be pre-approved',
  handoff_required: 'You need to do this step',
};

export const COMMAND_DECISION_TEXT: Record<'allow' | 'ask' | 'deny', string> = {
  allow: 'Run without asking',
  ask: 'Ask first',
  deny: 'Never run',
};

export const SOURCE_TEXT: Record<ToolSource, string> = {
  builtin: 'Built-in',
  mcp: 'MCP',
  plugin: 'Plugins',
  computer: 'Computer use',
  browser: 'Browser',
  page: 'Page tools',
  device: 'Devices',
};

export const EFFECT_CLASS_TEXT: Record<ActionEffectClass, string> = {
  external_communication: 'Sends messages to others',
  purchase: 'Buys something',
  account_change: 'Changes an account',
  credential_change: 'Changes a password or key',
  data_delete: 'Deletes data',
  file_write: 'Writes files',
  exec: 'Runs commands',
  network: 'Uses the network',
  install: 'Installs software',
  security_bypass: 'Bypasses a security check',
  captcha: 'Solves a CAPTCHA',
  policy_change: 'Changes permissions',
  secret_access: 'Reads a secret',
};

export const MCP_STATUS: Record<McpStatus, { text: string; tone: string | null; icon: IconName }> =
  {
    connected: { text: 'Connected', tone: 'ready', icon: 'check' },
    starting: { text: 'Starting', tone: 'running', icon: 'refresh' },
    error: { text: 'Error', tone: 'blocked', icon: 'alert' },
    stopped: { text: 'Stopped', tone: null, icon: 'stop' },
    disabled: { text: 'Off', tone: null, icon: 'stop' },
  };

export function grantDurationText(g: PermissionGrantView): string {
  return g.duration === 'session' ? 'For this session' : 'Until you revoke it';
}

/** A command-rule pattern as typed: words, with alternatives joined by `|`. */
export function patternText(pattern: readonly (string | readonly string[])[]): string {
  return pattern.map((p) => (typeof p === 'string' ? p : p.join('|'))).join(' ');
}

/**
 * Parse a typed pattern back into rule elements (contracts/schemas/command-rule.json): each
 * whitespace-separated word is a literal, and a word with `|` is a list of at least two
 * alternatives. Returns an error message for an empty pattern or an empty alternative.
 */
export function parsePattern(text: string): { pattern: (string | string[])[] } | { error: string } {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return { error: 'Enter the words the command starts with.' };
  const pattern: (string | string[])[] = [];
  for (const w of words) {
    if (!w.includes('|')) {
      pattern.push(w);
      continue;
    }
    const alts = w.split('|');
    if (alts.some((a) => !a)) return { error: `“${w}” has an empty alternative.` };
    pattern.push(alts);
  }
  return { pattern };
}

/** Non-empty trimmed lines. */
export function lines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}
