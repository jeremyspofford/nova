// Display helpers for agents (docs/04 §1.1, §2.5, §7; docs/09 §8; docs/12 §3). Pure functions and
// word lists, so the views and their tests share one wording.
import type {
  AgentActionClass,
  AgentMemoryItemView,
  AgentRuleEffect,
  AgentRuleMatch,
  AgentThreadView,
  AgentView,
  ChannelBindingKind,
  ComputerStateView,
  RunAutonomy,
} from '@nova/shared';
import type { IconName } from '@nova/ui';

export const AGENTS_PATH = '/agents';
export const NEW_AGENT_PATH = '/agents/new';

export function agentPath(id: string, tab?: string): string {
  const base = `${AGENTS_PATH}/${encodeURIComponent(id)}`;
  return tab ? `${base}?tab=${encodeURIComponent(tab)}` : base;
}

/** The Settings page that holds channel bindings (owned by the channels area). */
export const CHANNELS_SETTINGS_PATH = '/settings/channels';

export function computerPath(id: string): string {
  return `/computers/${encodeURIComponent(id)}`;
}

/**
 * The agent's own state as a badge beside its status chip: badges add detail without changing
 * the status (docs/04 §1.1). Null for an active agent.
 */
export function agentStateBadge(
  a: Pick<AgentView, 'status' | 'pauseReason'>,
): { text: string; icon: IconName } | null {
  if (a.status === 'paused')
    return a.pauseReason === 'safety'
      ? { text: 'Paused for safety', icon: 'shield' }
      : { text: 'Paused', icon: 'clock' };
  if (a.status === 'stopped') return { text: 'Stopped', icon: 'stop' };
  return null;
}

/** Autonomy as an agent uses it: the same three levels as a Work run (docs/09 §2). */
export const AGENT_AUTONOMY_TEXT: Record<RunAutonomy, { label: string; description: string }> = {
  ask_first: {
    label: 'Ask first',
    description: 'Asks before every change it makes.',
  },
  standard: {
    label: 'Standard',
    description: 'Follows your permissions: reads freely and asks before consequential actions.',
  },
  autonomous: {
    label: 'Autonomous',
    description:
      'A reviewer model checks consequential actions and can only make a decision stricter. Needs a reviewer model in Settings.',
  },
};

/** The rule vocabulary of docs/12 §3. */
export const RULE_EFFECT_TEXT: Record<AgentRuleEffect, { label: string; description: string }> = {
  act: {
    label: 'Take action without asking',
    description: 'Allowed for what the rule matches.',
  },
  act_on_request: {
    label: 'Take action when you say so',
    description: 'Allowed only while you asked for this action; otherwise it asks.',
  },
  ask: {
    label: 'Ask before taking action',
    description: 'Asks you every time.',
  },
  handoff: {
    label: 'Hand off to you',
    description: 'The agent cannot do it; you do this step.',
  },
};

export const RULE_EFFECT_ICON: Record<AgentRuleEffect, IconName> = {
  act: 'check',
  act_on_request: 'chat',
  ask: 'hand',
  handoff: 'hand',
};

export const ACTION_TEXT: Record<AgentActionClass, string> = {
  read: 'Reading',
  write: 'Any change',
  send: 'Sending messages',
  delete: 'Deleting',
  execute: 'Running commands',
};

/** Effects a kind of action already covers (packages/core/src/agents/rules.ts). */
export const EFFECTS_OF_ACTIONS: readonly string[] = [
  'external_communication',
  'data_delete',
  'exec',
];

export const CHANNEL_KIND_TEXT: Record<ChannelBindingKind | 'telegram', string> = {
  inapp: 'In-app',
  slack: 'Slack',
  teams: 'Teams',
  email: 'Email',
  webhook: 'Webhook',
  telegram: 'Telegram',
};

export const CHANNEL_KIND_ICON: Record<ChannelBindingKind, IconName> = {
  inapp: 'chat',
  slack: 'at',
  teams: 'at',
  email: 'send',
  webhook: 'external',
};

export const THREAD_KIND_TEXT: Record<AgentThreadView['kind'], string> = {
  main: 'Main thread',
  proactive: 'Proactive research',
  binding: 'Channel thread',
  background: 'Background work',
};

export const THREAD_KIND_ICON: Record<AgentThreadView['kind'], IconName> = {
  main: 'chat',
  proactive: 'search',
  binding: 'at',
  background: 'work',
};

export const MEMORY_KIND_TEXT: Record<AgentMemoryItemView['kind'], string> = {
  note: 'Note',
  fact: 'Fact',
  preference: 'Preference',
  observation: 'Observation',
};

export const MEMORY_SOURCE_TEXT: Record<AgentMemoryItemView['source'], string> = {
  manual: 'Added by you',
  tool: 'Written by the agent',
  proactive: 'From proactive research',
  conversation: 'Learned in conversation',
};

export const COMPUTER_STATE_TEXT: Record<ComputerStateView, { text: string; icon: IconName }> = {
  starting: { text: 'Starting', icon: 'refresh' },
  running: { text: 'Running', icon: 'check' },
  stopped: { text: 'Stopped', icon: 'stop' },
  degraded: { text: 'Degraded', icon: 'alert' },
  error: { text: 'Error', icon: 'alert' },
};

/** What a rule matches, in words: "Sends messages · hosts *.customer.com · tools email.send". */
export function matchText(m: AgentRuleMatch): string {
  const parts: string[] = [];
  if (m.actions?.length) parts.push(m.actions.map((a) => ACTION_TEXT[a]).join(', '));
  if (m.effects?.length) parts.push(`effects: ${m.effects.join(', ')}`);
  if (m.tools?.length) parts.push(`tools: ${m.tools.join(', ')}`);
  if (m.hosts?.length) parts.push(`hosts: ${m.hosts.join(', ')}`);
  if (m.channels?.length)
    parts.push(
      `channels: ${m.channels
        .map((c) => `${CHANNEL_KIND_TEXT[c.kind]}${c.conversation ? ` ${c.conversation}` : ''}`)
        .join(', ')}`,
    );
  return parts.length ? parts.join(' · ') : 'Every action';
}

/** The first letter of a name, for an avatar without an image. */
export function initial(name: string): string {
  return (name.trim().slice(0, 1) || '?').toUpperCase();
}

/** Comma- or line-separated words, trimmed, without blanks or duplicates. */
export function splitList(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}
