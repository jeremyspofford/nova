// Plain words for policy outcomes, shared by Tools & MCP, Permissions and the onboarding tool step
// (docs/04 §2.6, docs/12 §2.1, §3, §4.1). The engine's ids never reach the user as-is. Messages
// (FR-016): each read translates in the active locale.
import { defineMessages } from '@nova/i18n';
import type {
  ActionEffectClass,
  ConfirmationTier,
  McpStatus,
  PermissionGrantView,
  PolicyEffect,
  ToolSource,
} from '@nova/shared';
import type { IconName } from '@nova/ui';

const POLICY_TEXT = defineMessages('settings.policy', {
  /** What a decision means, short enough for a chip. */
  effect: { allow: 'Allowed', ask: 'Asks first', handoff: 'Hand off to you', deny: 'Denied' },
  /** The rule vocabulary of docs/12 §3, used in the rule editor. */
  ruleEffect: {
    allow: 'Take action without asking',
    ask: 'Ask before taking action',
    handoff: 'Hand off to you',
    deny: 'Never take this action',
  },
  tier: {
    pre_approvable: 'Pre-approvable',
    confirm_at_action: 'Asked every time; cannot be pre-approved',
    handoff_required: 'You need to do this step',
  },
  commandDecision: { allow: 'Run without asking', ask: 'Ask first', deny: 'Never run' },
  source: {
    builtin: 'Built-in',
    mcp: 'MCP',
    plugin: 'Plugins',
    computer: 'Computer use',
    browser: 'Browser',
    page: 'Page tools',
    device: 'Devices',
  },
  effectClass: {
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
  },
  /** The same kinds of action inside a sentence or a summary ("tool x · writes files"). */
  effectClassPhrase: {
    external_communication: 'sends messages to others',
    purchase: 'buys something',
    account_change: 'changes an account',
    credential_change: 'changes a password or key',
    data_delete: 'deletes data',
    file_write: 'writes files',
    exec: 'runs commands',
    network: 'uses the network',
    install: 'installs software',
    security_bypass: 'bypasses a security check',
    captcha: 'solves a CAPTCHA',
    policy_change: 'changes permissions',
    secret_access: 'reads a secret',
  },
  mcpStatus: {
    connected: 'Connected',
    starting: 'Starting',
    error: 'Error',
    stopped: 'Stopped',
    disabled: 'Off',
  },
  forSession: 'For this session',
  untilRevoked: 'Until you revoke it',
  emptyPattern: 'Enter the words the command starts with.',
  emptyAlternative: '“{word}” has an empty alternative.',
});

/** What a decision means, short enough for a chip. */
export const EFFECT_TEXT: Readonly<Record<PolicyEffect, string>> = POLICY_TEXT.effect;

/** The rule vocabulary of docs/12 §3, used in the rule editor. */
export const RULE_EFFECT_TEXT: Readonly<Record<PolicyEffect, string>> = POLICY_TEXT.ruleEffect;

/** Chip tone per decision: icon plus text, never color alone (docs/04 §7). */
export const EFFECT_TONE: Record<PolicyEffect, { tone: string; icon: IconName }> = {
  allow: { tone: 'ready', icon: 'check' },
  ask: { tone: 'needs_input', icon: 'hand' },
  handoff: { tone: 'needs_input', icon: 'hand' },
  deny: { tone: 'blocked', icon: 'stop' },
};

export const TIER_TEXT: Readonly<Record<ConfirmationTier, string>> = POLICY_TEXT.tier;

export const COMMAND_DECISION_TEXT: Readonly<Record<'allow' | 'ask' | 'deny', string>> =
  POLICY_TEXT.commandDecision;

export const SOURCE_TEXT: Readonly<Record<ToolSource, string>> = POLICY_TEXT.source;

export const EFFECT_CLASS_TEXT: Readonly<Record<ActionEffectClass, string>> =
  POLICY_TEXT.effectClass;

/** Kinds of action as they read inside a summary, lowercase in English. */
export const EFFECT_CLASS_PHRASE: Readonly<Record<ActionEffectClass, string>> =
  POLICY_TEXT.effectClassPhrase;

/** A server status: its words (read in the active locale), chip tone and icon. */
function mcpStatus(status: McpStatus, tone: string | null, icon: IconName) {
  return {
    get text() {
      return POLICY_TEXT.mcpStatus[status];
    },
    tone,
    icon,
  };
}

export const MCP_STATUS: Record<
  McpStatus,
  { readonly text: string; tone: string | null; icon: IconName }
> = {
  connected: mcpStatus('connected', 'ready', 'check'),
  starting: mcpStatus('starting', 'running', 'refresh'),
  error: mcpStatus('error', 'blocked', 'alert'),
  stopped: mcpStatus('stopped', null, 'stop'),
  disabled: mcpStatus('disabled', null, 'stop'),
};

export function grantDurationText(g: PermissionGrantView): string {
  return g.duration === 'session' ? POLICY_TEXT.forSession : POLICY_TEXT.untilRevoked;
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
  if (!words.length) return { error: POLICY_TEXT.emptyPattern };
  const pattern: (string | string[])[] = [];
  for (const w of words) {
    if (!w.includes('|')) {
      pattern.push(w);
      continue;
    }
    const alts = w.split('|');
    if (alts.some((a) => !a)) return { error: POLICY_TEXT.emptyAlternative({ word: w }) };
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
