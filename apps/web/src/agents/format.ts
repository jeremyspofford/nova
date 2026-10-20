// Display helpers for agents (docs/04 §1.1, §2.5, §7; docs/09 §8; docs/12 §3). Pure functions and
// word lists, so the views and their tests share one wording. The words are messages (FR-016):
// read them at render time so they follow the active locale.
import { defineMessages, fmt } from '@nova/i18n';
import type {
  AgentRuleEffect,
  AgentRuleMatch,
  AgentThreadView,
  AgentView,
  ChannelBindingKind,
  ComputerStateView,
} from '@nova/shared';
import type { IconName } from '@nova/ui';

/** Words the agents screens share. */
export const AGENTS_TEXT = defineMessages('agents', {
  agents: 'Agents',
  breadcrumb: 'Breadcrumb',
  retry: 'Retry',
  cancel: 'Cancel',
  save: 'Save',
  edit: 'Edit',
  delete: 'Delete',
  add: 'Add',
  remove: 'Remove',
  loading: 'Loading…',
  shared: 'Shared',
  private: 'Private',
  name: 'Name',
  nameRequired: 'Give the agent a name.',
  instructions: 'Instructions',
  memory: 'Memory',
  proactive: 'Proactive research',
  model: 'Model',
  defaultModel: 'The default chat model',
  resumeFirst: 'Resume the agent first',
  /** "Active 5 minutes ago": when the agent last did something. */
  active: 'Active {when}',
  notActive: 'Not active yet',
});

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

/** The agent's own state, as its badge and as read after its name in the sidebar. */
export const AGENT_STATE_TEXT = defineMessages('agents.state', {
  pausedSafety: 'Paused for safety',
  paused: 'Paused',
  stopped: 'Stopped',
  /** Read after the agent's name by screen readers. */
  after: {
    pausedSafety: ', paused for safety',
    paused: ', paused',
    stopped: ', stopped',
  },
});

/**
 * The agent's own state as a badge beside its status chip: badges add detail without changing
 * the status (docs/04 §1.1). `after` is what screen readers hear after its name. Null for an
 * active agent.
 */
export function agentStateBadge(
  a: Pick<AgentView, 'status' | 'pauseReason'>,
): { text: string; after: string; icon: IconName } | null {
  const S = AGENT_STATE_TEXT;
  if (a.status === 'paused')
    return a.pauseReason === 'safety'
      ? { text: S.pausedSafety, after: S.after.pausedSafety, icon: 'shield' }
      : { text: S.paused, after: S.after.paused, icon: 'clock' };
  if (a.status === 'stopped') return { text: S.stopped, after: S.after.stopped, icon: 'stop' };
  return null;
}

/** Autonomy as an agent uses it: the same three levels as a Work run (docs/09 §2). */
export const AGENT_AUTONOMY_TEXT = defineMessages('agents.autonomy', {
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
});

/** The rule vocabulary of docs/12 §3. */
export const RULE_EFFECT_TEXT = defineMessages('agents.ruleEffects', {
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
});

export const RULE_EFFECT_ICON: Record<AgentRuleEffect, IconName> = {
  act: 'check',
  act_on_request: 'chat',
  ask: 'hand',
  handoff: 'hand',
};

export const ACTION_TEXT = defineMessages('agents.actions', {
  read: 'Reading',
  write: 'Any change',
  send: 'Sending messages',
  delete: 'Deleting',
  execute: 'Running commands',
});

/** Effects a kind of action already covers (packages/core/src/agents/rules.ts). */
export const EFFECTS_OF_ACTIONS: readonly string[] = [
  'external_communication',
  'data_delete',
  'exec',
];

export const CHANNEL_KIND_TEXT = defineMessages('agents.channelKinds', {
  inapp: 'In-app',
  slack: 'Slack',
  teams: 'Teams',
  email: 'Email',
  webhook: 'Webhook',
  telegram: 'Telegram',
});

export const CHANNEL_KIND_ICON: Record<ChannelBindingKind, IconName> = {
  inapp: 'chat',
  slack: 'at',
  teams: 'at',
  email: 'send',
  webhook: 'external',
};

export const THREAD_KIND_TEXT = defineMessages('agents.threadKinds', {
  main: 'Main thread',
  proactive: 'Proactive research',
  binding: 'Channel thread',
  background: 'Background work',
});

export const THREAD_KIND_ICON: Record<AgentThreadView['kind'], IconName> = {
  main: 'chat',
  proactive: 'search',
  binding: 'at',
  background: 'work',
};

export const MEMORY_KIND_TEXT = defineMessages('agents.memoryKinds', {
  note: 'Note',
  fact: 'Fact',
  preference: 'Preference',
  observation: 'Observation',
});

export const MEMORY_SOURCE_TEXT = defineMessages('agents.memorySources', {
  manual: 'Added by you',
  tool: 'Written by the agent',
  proactive: 'From proactive research',
  conversation: 'Learned in conversation',
});

export const COMPUTER_STATE_TEXT = defineMessages('agents.computerStates', {
  starting: 'Starting',
  running: 'Running',
  stopped: 'Stopped',
  degraded: 'Degraded',
  error: 'Error',
});

export const COMPUTER_STATE_ICON: Record<ComputerStateView, IconName> = {
  starting: 'refresh',
  running: 'check',
  stopped: 'stop',
  degraded: 'alert',
  error: 'alert',
};

/** What a rule matches. Effects, tools, hosts and conversations are names, shown as they are. */
export const MATCH_TEXT = defineMessages('agents.match', {
  every: 'Every action',
  effects: 'effects: {list}',
  tools: 'tools: {list}',
  hosts: 'hosts: {list}',
  channels: 'channels: {list}',
  /** A channel kind and one conversation in it: "Slack #help". */
  channelIn: '{kind} {conversation}',
});

/** What a rule matches, in words: "Sending messages · hosts: *.customer.com · tools: email.send". */
export function matchText(m: AgentRuleMatch): string {
  const S = MATCH_TEXT;
  const list = (items: readonly string[]) => fmt.list(items, { type: 'unit', style: 'short' });
  const parts: string[] = [];
  if (m.actions?.length) parts.push(list(m.actions.map((a) => ACTION_TEXT[a])));
  if (m.effects?.length) parts.push(S.effects({ list: list(m.effects) }));
  if (m.tools?.length) parts.push(S.tools({ list: list(m.tools) }));
  if (m.hosts?.length) parts.push(S.hosts({ list: list(m.hosts) }));
  if (m.channels?.length)
    parts.push(
      S.channels({
        list: list(
          m.channels.map((c) =>
            c.conversation
              ? S.channelIn({ kind: CHANNEL_KIND_TEXT[c.kind], conversation: c.conversation })
              : CHANNEL_KIND_TEXT[c.kind],
          ),
        ),
      }),
    );
  return parts.length ? parts.join(' · ') : S.every;
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
