// The fake Hub's M6 agents part: agents with responsibilities, rules, memory, suggestions, goals,
// schedules and self-set wakes, threads, background work, the agent's channel bindings and its
// computer, and external agents. It follows the Hub's rules: an autonomous agent needs a reviewer
// model (400), resume of an active agent answers 409, a rule naming hosts and channels or a
// command rule on another effect answers 400, a decided suggestion answers 409, research does not
// start while paused or already running, turning memory off purges what the agent derived, and
// pausing disables the agent's schedules until it resumes. Goals and schedules live in the M5 Work
// state, so /goals/:id and /schedules/:id act on them too. Views handed out are copies.
//
// Wiring into test/fakes.ts (done by the lead): `HubState` gets `m6agents: M6AgentsState`,
// `createHub` defaults it to `m6AgentsState({ work: <the hub's m5work> })`, and `impl` spreads
// `...m6AgentsImpl(state.m6agents, { id, ts: () => ts(), maybeFail, settings: () =>
// state.settings, threads: <add a thread to state.threads> })`. Until then tests use
// `renderWithAgents`, which builds the client from `createHub().api` and this part.
/* eslint-disable @typescript-eslint/require-await */
import { createElement, type ReactNode } from 'react';
import type { z } from 'zod';
import { render } from '@testing-library/react';
import { vi, type Mock } from 'vitest';
import {
  SETTINGS,
  createAgentNoteSchema,
  createAgentRuleSchema,
  createAgentSchema,
  externalAgentSchema,
  responsibilitySchema,
  scheduleSchema,
  setAgentGoalSchema,
  updateAgentMemorySchema,
  updateAgentRuleSchema,
  updateAgentSchema,
  updateResponsibilitySchema,
  type ActivityItemView,
  type AgentBackgroundView,
  type AgentMemoryItemView,
  type AgentResponsibilityView,
  type AgentRulePreviewItem,
  type AgentRuleView,
  type AgentSuggestionView,
  type AgentThreadView,
  type AgentView,
  type ChannelAdapterView,
  type ChannelBindingView,
  type ComputerView,
  type ExternalAgentView,
  type SettingKey,
} from '@nova/shared';
import { ToastProvider } from '@nova/ui';
import { ApiError } from '../src/api.ts';
import type { AgentsApi } from '../src/agents/api.ts';
import { AnnouncerProvider, ServicesProvider } from '../src/services.tsx';
import { SettingsProvider } from '../src/settings.tsx';
import { ModelsProvider, ThreadsProvider } from '../src/stores.tsx';
import {
  DONE_ONBOARDING,
  createHub,
  fakeEventSource,
  testRegistry,
  thread,
  type HubState,
} from './fakes.ts';
import { goalView, m5WorkState, scheduleView, type M5WorkState } from './fakes-m5-work.ts';

const T0 = '2026-10-01T12:00:00.000Z';
let n = 0;

export function responsibilityView(
  over: Partial<AgentResponsibilityView> = {},
): AgentResponsibilityView {
  return {
    id: `resp${++n}`,
    agentId: 'ag1',
    title: 'Watch the inbox',
    instructions: null,
    status: 'active',
    goalId: null,
    progressNote: null,
    position: 0,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

export function agentView(over: Partial<AgentView> = {}): AgentView {
  const id = over.id ?? `ag${++n}`;
  return {
    id,
    name: 'Scout',
    hasAvatar: false,
    instructions: 'Keep an eye on the team inbox.',
    status: 'active',
    pauseReason: null,
    statusDetail: null,
    autonomy: 'standard',
    model: null,
    computerId: null,
    primaryThreadId: `t-${id}`,
    proactive: { enabled: true, lastRunAt: null },
    memoryEnabled: true,
    budgets: { timeSeconds: 1_800, tokens: 500_000, costUsd: null },
    usage: { timeSeconds: 0, tokens: 0, costUsd: 0 },
    goalId: null,
    responsibilities: [],
    derived: { status: 'ready', reason: null },
    openSuggestions: 0,
    lastActiveAt: null,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

export function ruleView(over: Partial<AgentRuleView> = {}): AgentRuleView {
  return {
    id: `rule${++n}`,
    agentId: 'ag1',
    description: 'Ask before messaging customers',
    effect: 'ask',
    match: { actions: ['send'], hosts: ['*.customer.com'] },
    command: null,
    priority: 100,
    enabled: true,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

export function memoryView(over: Partial<AgentMemoryItemView> = {}): AgentMemoryItemView {
  return {
    id: `mem${++n}`,
    agentId: 'ag1',
    store: 'notes',
    kind: 'note',
    content: 'The weekly report goes out on Fridays.',
    author: 'user',
    source: 'manual',
    sourceThreadId: null,
    responsibilityId: null,
    pinned: false,
    originAudience: 'private',
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

export function suggestionView(over: Partial<AgentSuggestionView> = {}): AgentSuggestionView {
  return {
    id: `sug${++n}`,
    agentId: 'ag1',
    noteId: null,
    title: 'Two invoices are overdue',
    body: 'Acme and Globex have not paid. Want me to draft reminders?',
    status: 'open',
    threadId: null,
    createdAt: T0,
    decidedAt: null,
    ...over,
  };
}

export function agentThreadView(over: Partial<AgentThreadView> = {}): AgentThreadView {
  return {
    threadId: `t${++n}`,
    agentId: 'ag1',
    kind: 'main',
    bindingRef: null,
    audience: 'private',
    runId: null,
    title: null,
    createdAt: T0,
    ...over,
  };
}

export function backgroundView(over: Partial<AgentBackgroundView> = {}): AgentBackgroundView {
  return {
    runId: `run${++n}`,
    threadId: `t${++n}`,
    title: 'Summarize the vendor contracts',
    status: 'running',
    createdAt: T0,
    endedAt: null,
    ...over,
  };
}

export function bindingView(over: Partial<ChannelBindingView> = {}): ChannelBindingView {
  return {
    id: `cb${++n}`,
    agentId: 'ag1',
    kind: 'slack',
    label: '#support',
    externalRef: 'C0123',
    audience: 'shared',
    threadId: null,
    sharePrimaryThread: false,
    allowUnknown: false,
    rateLimit: { perMinute: 10, perHour: 100 },
    status: 'connected',
    statusDetail: null,
    config: {},
    credentials: [{ name: 'botToken', set: true }],
    sharesCredentialsWith: null,
    inboundPath: null,
    lastMessageAt: null,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

export function computerView(over: Partial<ComputerView> = {}): ComputerView {
  return {
    id: `cmp${++n}`,
    kind: 'cloud',
    agentId: 'ag1',
    deviceId: null,
    provider: 'container',
    state: 'running',
    substrate: 'container',
    detail: null,
    baseImage: 'nova/computer:1',
    snapshotCount: 0,
    createdAt: T0,
    updatedAt: T0,
    lastUsedAt: null,
    ...over,
  };
}

export function activityItem(over: Partial<ActivityItemView> = {}): ActivityItemView {
  return {
    id: `act${++n}`,
    ts: T0,
    kind: 'notice',
    title: 'Agent created',
    detail: null,
    status: null,
    callId: null,
    turnId: null,
    ...over,
  };
}

export interface M6AgentsState {
  agents: AgentView[];
  rules: AgentRuleView[];
  memory: AgentMemoryItemView[];
  suggestions: AgentSuggestionView[];
  threads: AgentThreadView[];
  /** Background runs per agent id, newest first. */
  background: Record<string, AgentBackgroundView[]>;
  /** Activity per agent id, oldest first. */
  activity: Record<string, ActivityItemView[]>;
  /** Rule previews per rule id. */
  previews: Record<string, AgentRulePreviewItem[]>;
  channels: ChannelBindingView[];
  adapters: ChannelAdapterView[];
  computers: ComputerView[];
  external: ExternalAgentView[];
  /** Agents whose proactive research is running now. */
  researching: string[];
  /** Goals and schedules: the Work state, so /goals and /schedules see them too. */
  work: M5WorkState;
  /** Called with each created agent (e.g. to add its main thread to the chat state). */
  onCreate?: (a: AgentView) => void;
}

export function m6AgentsState(init: Partial<M6AgentsState> = {}): M6AgentsState {
  return {
    agents: [],
    rules: [],
    memory: [],
    suggestions: [],
    threads: [],
    background: {},
    activity: {},
    previews: {},
    channels: [],
    adapters: [],
    computers: [],
    external: [],
    researching: [],
    work: m5WorkState(),
    ...init,
  };
}

const err = (status: number, code: string, message: string, details?: Record<string, unknown>) =>
  new ApiError(status, { code, message, retryable: false, ...(details ? { details } : {}) });

const notFound = (what = 'Not found') => err(404, 'not_found', what);

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success)
    throw err(400, 'validation', r.error.issues.map((i) => i.message).join('; ') || 'Invalid');
  return r.data;
}

/** The Hub's normalizeCounterpart (packages/core/src/agents/external.ts). */
function normalizeAddress(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}@._-]+/gu, ' ')
    .trim()
    .replace(/^the\s+/, '')
    .replace(/\s+/g, ' ')
    .slice(0, 200);
}

export function m6AgentsImpl(
  st: M6AgentsState,
  helpers: {
    id: (p: string) => string;
    ts: () => string;
    maybeFail: (name: keyof AgentsApi) => void;
    /** The Hub's settings (global layer); missing keys use their defaults. */
    settings: () => Record<string, unknown>;
  },
): AgentsApi {
  const { id, ts, maybeFail } = helpers;
  const setting = <T>(key: SettingKey): T =>
    (helpers.settings()[key] ?? SETTINGS[key].default) as T;

  const agentOf = (aid: string) => {
    const a = st.agents.find((x) => x.id === aid);
    if (!a) throw notFound('agent not found');
    return a;
  };
  const out = (a: AgentView): AgentView => {
    const goal = st.work.goals.find(
      (g) => g.agentId === a.id && g.status !== 'complete' && g.runId === null,
    );
    return {
      ...a,
      goalId: goal?.id ?? null,
      responsibilities: [...a.responsibilities].sort((x, y) => x.position - y.position),
      openSuggestions: st.suggestions.filter((s) => s.agentId === a.id && s.status === 'open')
        .length,
    };
  };
  const patch = (aid: string, p: Partial<AgentView>): AgentView => {
    const next = { ...agentOf(aid), ...p, updatedAt: ts() };
    st.agents = st.agents.map((a) => (a.id === aid ? next : a));
    return out(next);
  };
  const assertAutonomy = (autonomy: string) => {
    if (autonomy === 'autonomous' && !setting<string | null>('review.model'))
      throw err(
        400,
        'validation',
        'an autonomous agent needs a reviewer model: choose one in Settings',
        {
          field: 'autonomy',
          reason: 'review_model_required',
        },
      );
  };
  const rule = (aid: string, rid: string) => {
    const r = st.rules.find((x) => x.id === rid && x.agentId === aid);
    if (!r) throw notFound('rule not found');
    return r;
  };
  const checkRule = (r: Pick<AgentRuleView, 'effect' | 'match' | 'command'>) => {
    if (r.match.hosts?.length && r.match.channels?.length)
      throw err(400, 'validation', 'a rule names hosts or channels, not both', {
        field: 'match',
        reason: 'hosts_and_channels',
      });
    if (r.command && r.effect !== 'act' && r.effect !== 'ask')
      throw err(
        400,
        'validation',
        'a command prefix rule can only take action without asking or ask first',
        { field: 'effect', reason: 'command_effect' },
      );
  };
  const resp = (aid: string, rid: string) => {
    const r = agentOf(aid).responsibilities.find((x) => x.id === rid);
    if (!r) throw notFound('responsibility not found');
    return r;
  };
  const setResps = (aid: string, list: AgentResponsibilityView[]) => {
    st.agents = st.agents.map((a) => (a.id === aid ? { ...a, responsibilities: list } : a));
  };
  const openGoal = (aid: string) =>
    st.work.goals.find((g) => g.agentId === aid && g.runId === null && g.status !== 'complete');
  const agentSchedules = (aid: string) => st.work.schedules.filter((s) => s.agentId === aid);

  return {
    listAgents: async () => {
      maybeFail('listAgents');
      return { items: st.agents.map(out) };
    },
    createAgent: async (body) => {
      maybeFail('createAgent');
      const b = parse(createAgentSchema, body);
      const autonomy = b.autonomy ?? setting<AgentView['autonomy']>('agents.autonomy');
      assertAutonomy(autonomy);
      const defaults = setting<AgentView['budgets']>('agents.defaultBudgets');
      const proactive = setting<{ enabledByDefault: boolean }>('agents.proactive');
      const aid = id('ag');
      const at = ts();
      const a = agentView({
        id: aid,
        name: b.name.trim(),
        hasAvatar: !!b.avatar,
        instructions: b.instructions?.trim() ?? '',
        autonomy,
        model: b.model ?? null,
        primaryThreadId: id('t'),
        proactive: { enabled: b.proactive ?? proactive.enabledByDefault, lastRunAt: null },
        memoryEnabled: b.memoryEnabled ?? true,
        budgets: {
          timeSeconds: b.budgets?.timeSeconds ?? defaults.timeSeconds,
          tokens: b.budgets?.tokens ?? defaults.tokens,
          costUsd: b.budgets?.costUsd !== undefined ? b.budgets.costUsd : defaults.costUsd,
        },
        responsibilities: (b.responsibilities ?? []).map((r, i) =>
          responsibilityView({
            id: id('resp'),
            agentId: aid,
            title: r.title,
            instructions: r.instructions?.trim() || null,
            position: i,
            createdAt: at,
            updatedAt: at,
          }),
        ),
        createdAt: at,
        updatedAt: at,
      });
      st.agents = [...st.agents, a];
      st.threads = [
        ...st.threads,
        agentThreadView({ threadId: a.primaryThreadId ?? '', agentId: aid, kind: 'main' }),
      ];
      st.onCreate?.(a);
      return out(a);
    },
    getAgent: async (aid) => {
      maybeFail('getAgent');
      return out(agentOf(aid));
    },
    updateAgent: async (aid, body) => {
      maybeFail('updateAgent');
      const b = parse(updateAgentSchema, body);
      const cur = agentOf(aid);
      if (b.autonomy && b.autonomy !== cur.autonomy) assertAutonomy(b.autonomy);
      const p: Partial<AgentView> = {};
      if (b.name !== undefined) p.name = b.name.trim();
      if (b.instructions !== undefined) p.instructions = b.instructions.trim();
      if (b.autonomy !== undefined) p.autonomy = b.autonomy;
      if (b.model !== undefined) p.model = b.model;
      if (b.avatar !== undefined) p.hasAvatar = b.avatar !== null;
      if (b.proactive !== undefined) p.proactive = { ...cur.proactive, enabled: b.proactive };
      if (b.budgets)
        p.budgets = {
          timeSeconds: b.budgets.timeSeconds ?? cur.budgets.timeSeconds,
          tokens: b.budgets.tokens ?? cur.budgets.tokens,
          costUsd: b.budgets.costUsd !== undefined ? b.budgets.costUsd : cur.budgets.costUsd,
        };
      if (b.memoryEnabled !== undefined) {
        p.memoryEnabled = b.memoryEnabled;
        // Memory off purges what the agent derived; the user's own notes stay (FR-089).
        if (!b.memoryEnabled && cur.memoryEnabled)
          st.memory = st.memory.filter(
            (m) => m.agentId !== aid || (m.store === 'notes' && m.author === 'user'),
          );
      }
      return patch(aid, p);
    },
    deleteAgent: async (aid) => {
      maybeFail('deleteAgent');
      agentOf(aid);
      st.agents = st.agents.filter((a) => a.id !== aid);
      st.rules = st.rules.filter((r) => r.agentId !== aid);
      st.memory = st.memory.filter((m) => m.agentId !== aid);
      st.suggestions = st.suggestions.filter((s) => s.agentId !== aid);
      st.threads = st.threads.filter((t) => t.agentId !== aid);
      st.channels = st.channels.filter((c) => c.agentId !== aid);
      st.work.schedules = st.work.schedules.filter((s) => s.agentId !== aid);
      st.work.goals = st.work.goals.filter((g) => g.agentId !== aid);
      return { ok: true as const };
    },
    agentAvatarUrl: (aid) => `/api/v1/agents/${encodeURIComponent(aid)}/avatar`,
    pauseAgent: async (aid) => {
      maybeFail('pauseAgent');
      const cur = agentOf(aid);
      if (cur.status === 'paused') return out(cur);
      // Pausing stops its schedules and self-set wakes until it resumes.
      st.work.schedules = st.work.schedules.map((s) =>
        s.agentId === aid ? { ...s, enabled: false } : s,
      );
      return patch(aid, { status: 'paused', pauseReason: 'user', statusDetail: null });
    },
    resumeAgent: async (aid) => {
      maybeFail('resumeAgent');
      if (agentOf(aid).status === 'active') throw err(409, 'conflict', 'the agent is not paused');
      st.work.schedules = st.work.schedules.map((s) =>
        s.agentId === aid ? { ...s, enabled: true } : s,
      );
      return patch(aid, { status: 'active', pauseReason: null, statusDetail: null });
    },
    stopAgent: async (aid) => {
      maybeFail('stopAgent');
      const cur = agentOf(aid);
      st.background = {
        ...st.background,
        [aid]: (st.background[aid] ?? []).map((b) =>
          b.status === 'running' ? { ...b, status: 'cancelled', endedAt: ts() } : b,
        ),
      };
      if (cur.status !== 'active') return out(cur);
      return patch(aid, {
        status: 'stopped',
        statusDetail: 'stopped by the user',
        derived: { status: 'ready', reason: null },
      });
    },
    researchAgent: async (aid) => {
      maybeFail('researchAgent');
      const a = agentOf(aid);
      if (a.status === 'paused') return { started: false, reason: 'the agent is paused' };
      if (st.researching.includes(aid))
        return { started: false, reason: 'research is already running' };
      st.researching = [...st.researching, aid];
      return { started: true, reason: null };
    },
    agentActivity: async (aid) => {
      maybeFail('agentActivity');
      agentOf(aid);
      return { items: [...(st.activity[aid] ?? [])] };
    },
    agentThreads: async (aid) => {
      maybeFail('agentThreads');
      agentOf(aid);
      return { items: st.threads.filter((t) => t.agentId === aid).map((t) => ({ ...t })) };
    },
    agentBackground: async (aid) => {
      maybeFail('agentBackground');
      agentOf(aid);
      return { items: (st.background[aid] ?? []).map((b) => ({ ...b })) };
    },

    listResponsibilities: async (aid) => {
      maybeFail('listResponsibilities');
      return { items: out(agentOf(aid)).responsibilities };
    },
    addResponsibility: async (aid, body) => {
      maybeFail('addResponsibility');
      const b = parse(responsibilitySchema, body);
      const list = agentOf(aid).responsibilities;
      const at = ts();
      const r = responsibilityView({
        id: id('resp'),
        agentId: aid,
        title: b.title,
        instructions: b.instructions?.trim() || null,
        position: list.length,
        createdAt: at,
        updatedAt: at,
      });
      setResps(aid, [...list, r]);
      return { ...r };
    },
    updateResponsibility: async (aid, rid, body) => {
      maybeFail('updateResponsibility');
      const b = parse(updateResponsibilitySchema, body);
      const cur = resp(aid, rid);
      const next: AgentResponsibilityView = {
        ...cur,
        ...(b.title !== undefined ? { title: b.title } : {}),
        ...(b.instructions !== undefined ? { instructions: b.instructions?.trim() || null } : {}),
        ...(b.status !== undefined ? { status: b.status } : {}),
        ...(b.position !== undefined ? { position: b.position } : {}),
        updatedAt: ts(),
      };
      setResps(
        aid,
        agentOf(aid).responsibilities.map((r) => (r.id === rid ? next : r)),
      );
      return { ...next };
    },
    deleteResponsibility: async (aid, rid) => {
      maybeFail('deleteResponsibility');
      resp(aid, rid);
      setResps(
        aid,
        agentOf(aid).responsibilities.filter((r) => r.id !== rid),
      );
      return { ok: true as const };
    },

    listAgentRules: async (aid) => {
      maybeFail('listAgentRules');
      agentOf(aid);
      return { items: st.rules.filter((r) => r.agentId === aid).map((r) => ({ ...r })) };
    },
    createAgentRule: async (aid, body) => {
      maybeFail('createAgentRule');
      agentOf(aid);
      const b = parse(createAgentRuleSchema, body);
      const at = ts();
      const r = ruleView({
        id: id('rule'),
        agentId: aid,
        description: b.description,
        effect: b.effect,
        match: b.match,
        command: b.command ?? null,
        priority: b.priority ?? 100,
        enabled: b.enabled ?? true,
        createdAt: at,
        updatedAt: at,
      });
      checkRule(r);
      st.rules = [...st.rules, r];
      return { ...r };
    },
    updateAgentRule: async (aid, rid, body) => {
      maybeFail('updateAgentRule');
      const b = parse(updateAgentRuleSchema, body);
      const cur = rule(aid, rid);
      const next: AgentRuleView = {
        ...cur,
        ...(b.description !== undefined ? { description: b.description } : {}),
        ...(b.effect !== undefined ? { effect: b.effect } : {}),
        ...(b.match !== undefined ? { match: b.match } : {}),
        ...(b.command !== undefined ? { command: b.command } : {}),
        ...(b.priority !== undefined ? { priority: b.priority } : {}),
        ...(b.enabled !== undefined ? { enabled: b.enabled } : {}),
        updatedAt: ts(),
      };
      checkRule(next);
      st.rules = st.rules.map((r) => (r.id === rid ? next : r));
      return { ...next };
    },
    deleteAgentRule: async (aid, rid) => {
      maybeFail('deleteAgentRule');
      rule(aid, rid);
      st.rules = st.rules.filter((r) => r.id !== rid);
      return { ok: true as const };
    },
    previewAgentRule: async (aid, rid, limit = 50) => {
      maybeFail('previewAgentRule');
      rule(aid, rid);
      return { items: (st.previews[rid] ?? []).slice(0, limit) };
    },

    listAgentMemory: async (aid) => {
      maybeFail('listAgentMemory');
      agentOf(aid);
      const mine = st.memory.filter((m) => m.agentId === aid);
      const order = (list: AgentMemoryItemView[]) =>
        [...list].sort(
          (a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt),
        );
      return {
        items: [
          ...order(mine.filter((m) => m.store === 'notes')),
          ...order(mine.filter((m) => m.store === 'conversation')),
        ],
      };
    },
    addAgentNote: async (aid, body) => {
      maybeFail('addAgentNote');
      agentOf(aid);
      const b = parse(createAgentNoteSchema, body);
      if (b.responsibilityId) resp(aid, b.responsibilityId);
      const at = ts();
      const m = memoryView({
        id: id('mem'),
        agentId: aid,
        kind: b.kind,
        content: b.content,
        responsibilityId: b.responsibilityId ?? null,
        pinned: b.pinned ?? false,
        createdAt: at,
        updatedAt: at,
      });
      st.memory = [m, ...st.memory];
      return { ...m };
    },
    updateAgentMemory: async (aid, mid, body) => {
      maybeFail('updateAgentMemory');
      const b = parse(updateAgentMemorySchema, body);
      const cur = st.memory.find((m) => m.id === mid && m.agentId === aid);
      if (!cur) throw notFound('memory item not found');
      const next: AgentMemoryItemView = {
        ...cur,
        ...(b.content !== undefined
          ? { content: b.content, author: cur.store === 'notes' ? 'user' : cur.author }
          : {}),
        ...(b.pinned !== undefined ? { pinned: b.pinned } : {}),
        updatedAt: ts(),
      };
      st.memory = st.memory.map((m) => (m.id === mid ? next : m));
      return { ...next };
    },
    deleteAgentMemory: async (aid, mid) => {
      maybeFail('deleteAgentMemory');
      if (!st.memory.some((m) => m.id === mid && m.agentId === aid))
        throw notFound('memory item not found');
      st.memory = st.memory.filter((m) => m.id !== mid);
      return { ok: true as const };
    },

    listAgentSuggestions: async (aid, status) => {
      maybeFail('listAgentSuggestions');
      agentOf(aid);
      return {
        items: st.suggestions
          .filter((s) => s.agentId === aid && (!status || s.status === status))
          .map((s) => ({ ...s })),
      };
    },
    decideAgentSuggestion: async (aid, sid, action) => {
      maybeFail('decideAgentSuggestion');
      const cur = st.suggestions.find((s) => s.id === sid && s.agentId === aid);
      if (!cur) throw notFound('suggestion not found');
      if (cur.status !== 'open') throw err(409, 'conflict', 'the suggestion was already decided');
      const next: AgentSuggestionView = {
        ...cur,
        status: action === 'accept' ? 'accepted' : 'dismissed',
        decidedAt: ts(),
      };
      st.suggestions = st.suggestions.map((s) => (s.id === sid ? next : s));
      return { ...next };
    },

    getAgentGoal: async (aid) => {
      maybeFail('getAgentGoal');
      agentOf(aid);
      const g =
        openGoal(aid) ??
        [...st.work.goals].reverse().find((x) => x.agentId === aid && x.runId === null);
      return g ? { ...g } : null;
    },
    setAgentGoal: async (aid, body) => {
      maybeFail('setAgentGoal');
      const a = agentOf(aid);
      const b = parse(setAgentGoalSchema, body);
      if (b.responsibilityId) resp(aid, b.responsibilityId);
      const open = openGoal(aid);
      const budgets = { ...(b.budgets ?? {}) };
      if (open) {
        const next = { ...open, objective: b.objective, budgets, updatedAt: ts() };
        st.work.goals = st.work.goals.map((g) => (g.id === open.id ? next : g));
        return { ...next };
      }
      const g = goalView({
        id: id('goal'),
        agentId: aid,
        threadId: a.primaryThreadId,
        objective: b.objective,
        budgets,
        createdAt: ts(),
        updatedAt: ts(),
      });
      st.work.goals = [...st.work.goals, g];
      return { ...g };
    },
    clearAgentGoal: async (aid) => {
      maybeFail('clearAgentGoal');
      agentOf(aid);
      const open = openGoal(aid);
      if (open) st.work.goals = st.work.goals.filter((g) => g.id !== open.id);
      return { ok: true as const };
    },

    listAgentSchedules: async (aid) => {
      maybeFail('listAgentSchedules');
      agentOf(aid);
      return { items: agentSchedules(aid).map((s) => ({ ...s })) };
    },
    createAgentSchedule: async (aid, body) => {
      maybeFail('createAgentSchedule');
      agentOf(aid);
      const b = parse(scheduleSchema, body);
      const s = scheduleView({
        id: id('sch'),
        title: b.title ?? b.instructions.slice(0, 60),
        when: b.when,
        timezone: b.timezone,
        instructions: b.instructions,
        origin: 'user',
        agentId: aid,
        wakeReason: null,
        createdAt: ts(),
        updatedAt: ts(),
      });
      st.work.schedules = [...st.work.schedules, s];
      return { ...s };
    },

    listAgentChannels: async (aid) => {
      maybeFail('listAgentChannels');
      return {
        items: st.channels.filter((c) => c.agentId === aid).map((c) => ({ ...c })),
        adapters: [...st.adapters],
      };
    },
    getAgentComputer: async (cid) => {
      maybeFail('getAgentComputer');
      const c = st.computers.find((x) => x.id === cid);
      if (!c) throw notFound('computer not found');
      return { ...c };
    },

    listExternalAgents: async () => {
      maybeFail('listExternalAgents');
      return { items: st.external.map((e) => ({ ...e })) };
    },
    addExternalAgent: async (body) => {
      maybeFail('addExternalAgent');
      const b = parse(externalAgentSchema, body);
      const address = normalizeAddress(b.address);
      if (!address) throw err(400, 'validation', 'an address is required');
      const existing = st.external.find((e) => e.address === address);
      if (existing) return { ...existing };
      const e: ExternalAgentView = {
        id: id('ext'),
        address,
        label: b.label?.trim() || null,
        createdAt: ts(),
      };
      st.external = [...st.external, e];
      return { ...e };
    },
    removeExternalAgent: async (eid) => {
      maybeFail('removeExternalAgent');
      if (!st.external.some((e) => e.id === eid)) throw notFound('external agent not found');
      st.external = st.external.filter((e) => e.id !== eid);
      return { ok: true as const };
    },
  };
}

// ---- test helpers -----------------------------------------------------------------------------

let seq = 0;
const nextId = (p: string) => `${p}-${(++seq).toString().padStart(4, '0')}`;
let clock = 0;
const nextTs = () => new Date(Date.UTC(2026, 9, 2, 9, 0, clock++)).toISOString();

export type AgentsMocks = AgentsApi & Record<keyof AgentsApi, Mock<(...args: never[]) => unknown>>;

/**
 * A standalone fake over a main fake Hub: every method a spy over the in-memory implementation.
 * Goals and schedules share the hub's Work state; a created agent's main thread joins its chats.
 */
export function createAgentsHub(
  hub: { state: HubState },
  init: Partial<Omit<M6AgentsState, 'work'>> = {},
) {
  const state = m6AgentsState({ ...init, work: hub.state.m5work });
  const addThread = (threadId: string, title: string) => {
    if (hub.state.threads.some((t) => t.id === threadId)) return;
    hub.state.threads = [...hub.state.threads, thread({ id: threadId, mode: 'agent', title })];
    if (!hub.state.messages.has(threadId)) hub.state.messages.set(threadId, []);
  };
  for (const a of state.agents) if (a.primaryThreadId) addThread(a.primaryThreadId, a.name);
  for (const t of state.threads) addThread(t.threadId, t.title ?? 'Agent thread');
  state.onCreate = (a) => {
    if (a.primaryThreadId) addThread(a.primaryThreadId, a.name);
  };
  const failNext: Partial<Record<keyof AgentsApi, Error>> = {};
  const impl = m6AgentsImpl(state, {
    id: nextId,
    ts: nextTs,
    settings: () => hub.state.settings,
    maybeFail: (name) => {
      const e = failNext[name];
      if (e) {
        delete failNext[name];
        throw e;
      }
    },
  });
  const api = Object.fromEntries(
    Object.entries(impl).map(([k, fn]) => [k, vi.fn(fn as (...a: unknown[]) => unknown)]),
  ) as unknown as AgentsMocks;
  return { api, state, failNext };
}

/**
 * Render `ui` inside the providers the agents views need (the app's own: services, settings,
 * toasts, the announcer, threads and models), with the main fake Hub's client and the agents
 * part spread over it (what `createApi` will do).
 */
export async function renderWithAgents(
  ui: ReactNode,
  opts: {
    agents?: Partial<Omit<M6AgentsState, 'work'>>;
    hub?: Partial<HubState>;
    settings?: Record<string, unknown>;
    /** Values set by managed policy (locked). */
    managed?: Record<string, unknown>;
    /** Calls that fail the first time they are made. */
    failNext?: Partial<Record<keyof AgentsApi, Error>>;
  } = {},
) {
  const hub = createHub(opts.hub);
  hub.state.settings = { 'onboarding.state': DONE_ONBOARDING, ...opts.settings };
  hub.state.managed = { ...opts.managed };
  const agents = createAgentsHub(hub, opts.agents);
  Object.assign(agents.failNext, opts.failNext);
  const api = { ...hub.api, ...agents.api };
  const { settings } = await hub.api.settings();
  const inner = createElement(ToastProvider, {
    children: createElement(AnnouncerProvider, {
      children: createElement(ThreadsProvider, {
        api,
        children: createElement(ModelsProvider, { api, children: ui }),
      }),
    }),
  });
  const utils = render(
    createElement(ServicesProvider, {
      api,
      eventSource: fakeEventSource,
      registry: testRegistry(),
      children: createElement(SettingsProvider, { api, initial: settings, children: inner }),
    }),
  );
  return { hub, agents, api: agents.api, state: agents.state, ...utils };
}
