// Pure parts of the agents UI: the Hub client's methods and paths (contracts/hub-api.md, the routes
// in apps/hub/src/agents.ts), wording helpers, budget parsing, sorting and which event refreshes
// which section.
import { describe, expect, it, vi } from 'vitest';
import { agentsApi } from '../src/agents/api.ts';
import { parseGoalBudget, goalUsageLine } from '../src/agents/AgentGoal.tsx';
import { sortAgents } from '../src/agents/AgentList.tsx';
import { partsFor } from '../src/agents/AgentPage.tsx';
import { scheduleOrigin } from '../src/agents/AgentSchedules.tsx';
import { eventAgentId, eventThreadRef } from '../src/agents/events.ts';
import { budgetDraft, parseBudgets } from '../src/agents/fields.tsx';
import { agentPath, agentStateBadge, initial, matchText, splitList } from '../src/agents/format.ts';
import { scheduleOriginText } from '../src/work/ScheduledView.tsx';
import { agentView } from './fakes-m6-agents.ts';

describe('the agents client (contracts/hub-api.md)', () => {
  it('calls each route with its method, path and body', async () => {
    const call = vi.fn(() => Promise.resolve({}));
    const api = agentsApi(call as never);
    const cases: [() => Promise<unknown>, string, string, unknown?][] = [
      [() => api.listAgents(), 'GET', '/api/v1/agents'],
      [() => api.createAgent({ name: 'A' }), 'POST', '/api/v1/agents', { name: 'A' }],
      [() => api.getAgent('a/1'), 'GET', '/api/v1/agents/a%2F1'],
      [
        () => api.updateAgent('a1', { proactive: false }),
        'PATCH',
        '/api/v1/agents/a1',
        { proactive: false },
      ],
      [() => api.deleteAgent('a1'), 'DELETE', '/api/v1/agents/a1', { confirm: true }],
      [() => api.pauseAgent('a1'), 'POST', '/api/v1/agents/a1/pause', {}],
      [() => api.resumeAgent('a1'), 'POST', '/api/v1/agents/a1/resume', {}],
      [() => api.stopAgent('a1'), 'POST', '/api/v1/agents/a1/stop', {}],
      [() => api.researchAgent('a1'), 'POST', '/api/v1/agents/a1/research', {}],
      [() => api.agentActivity('a1'), 'GET', '/api/v1/agents/a1/activity'],
      [() => api.agentThreads('a1'), 'GET', '/api/v1/agents/a1/threads'],
      [() => api.agentBackground('a1'), 'GET', '/api/v1/agents/a1/background'],
      [() => api.listResponsibilities('a1'), 'GET', '/api/v1/agents/a1/responsibilities'],
      [
        () => api.addResponsibility('a1', { title: 'T' }),
        'POST',
        '/api/v1/agents/a1/responsibilities',
        { title: 'T' },
      ],
      [
        () => api.updateResponsibility('a1', 'r1', { status: 'done' }),
        'PATCH',
        '/api/v1/agents/a1/responsibilities/r1',
        { status: 'done' },
      ],
      [
        () => api.deleteResponsibility('a1', 'r1'),
        'DELETE',
        '/api/v1/agents/a1/responsibilities/r1',
      ],
      [() => api.listAgentRules('a1'), 'GET', '/api/v1/agents/a1/rules'],
      [
        () => api.createAgentRule('a1', { description: 'D', effect: 'ask' }),
        'POST',
        '/api/v1/agents/a1/rules',
        { description: 'D', effect: 'ask' },
      ],
      [
        () => api.updateAgentRule('a1', 'r1', { enabled: false }),
        'PATCH',
        '/api/v1/agents/a1/rules/r1',
        { enabled: false },
      ],
      [() => api.deleteAgentRule('a1', 'r1'), 'DELETE', '/api/v1/agents/a1/rules/r1'],
      [
        () => api.previewAgentRule('a1', 'r1', 20),
        'GET',
        '/api/v1/agents/a1/rules/r1/preview?limit=20',
      ],
      [() => api.listAgentMemory('a1'), 'GET', '/api/v1/agents/a1/memory'],
      [
        () => api.addAgentNote('a1', { content: 'C' }),
        'POST',
        '/api/v1/agents/a1/memory',
        { content: 'C' },
      ],
      [
        () => api.updateAgentMemory('a1', 'm1', { pinned: true }),
        'PATCH',
        '/api/v1/agents/a1/memory/m1',
        { pinned: true },
      ],
      [() => api.deleteAgentMemory('a1', 'm1'), 'DELETE', '/api/v1/agents/a1/memory/m1'],
      [() => api.listAgentSuggestions('a1'), 'GET', '/api/v1/agents/a1/suggestions'],
      [
        () => api.listAgentSuggestions('a1', 'open'),
        'GET',
        '/api/v1/agents/a1/suggestions?status=open',
      ],
      [
        () => api.decideAgentSuggestion('a1', 's1', 'accept'),
        'POST',
        '/api/v1/agents/a1/suggestions/s1/accept',
        {},
      ],
      [() => api.getAgentGoal('a1'), 'GET', '/api/v1/agents/a1/goal'],
      [
        () => api.setAgentGoal('a1', { objective: 'O' }),
        'PUT',
        '/api/v1/agents/a1/goal',
        { objective: 'O' },
      ],
      [() => api.clearAgentGoal('a1'), 'DELETE', '/api/v1/agents/a1/goal'],
      [() => api.listAgentSchedules('a1'), 'GET', '/api/v1/agents/a1/schedules'],
      [
        () =>
          api.createAgentSchedule('a1', {
            when: { cron: '0 9 * * *' },
            timezone: 'UTC',
            instructions: 'I',
          }),
        'POST',
        '/api/v1/agents/a1/schedules',
        { when: { cron: '0 9 * * *' }, timezone: 'UTC', instructions: 'I' },
      ],
      [() => api.listAgentChannels('a1'), 'GET', '/api/v1/channels?agentId=a1'],
      [() => api.getAgentComputer('c1'), 'GET', '/api/v1/computers/c1'],
      [() => api.listExternalAgents(), 'GET', '/api/v1/external-agents'],
      [
        () => api.addExternalAgent({ address: 'x' }),
        'POST',
        '/api/v1/external-agents',
        { address: 'x' },
      ],
      [() => api.removeExternalAgent('e1'), 'DELETE', '/api/v1/external-agents/e1'],
    ];
    for (const [run, method, path, body] of cases) {
      call.mockClear();
      await run();
      expect(call).toHaveBeenCalledWith(method, path, ...(body === undefined ? [] : [body]));
    }
    expect(api.agentAvatarUrl('a1')).toBe('/api/v1/agents/a1/avatar');
  });
});

describe('wording and parsing', () => {
  it('names states, scopes and origins in plain words', () => {
    expect(agentStateBadge({ status: 'active', pauseReason: null })).toBeNull();
    expect(agentStateBadge({ status: 'paused', pauseReason: 'user' })?.text).toBe('Paused');
    expect(agentStateBadge({ status: 'paused', pauseReason: 'safety' })?.text).toBe(
      'Paused for safety',
    );
    expect(agentStateBadge({ status: 'stopped', pauseReason: null })?.text).toBe('Stopped');
    expect(matchText({})).toBe('Every action');
    expect(
      matchText({
        actions: ['read', 'delete'],
        effects: ['purchase'],
        tools: ['a.b'],
        channels: [{ kind: 'slack', conversation: '#x' }, { kind: 'email' }],
      }),
    ).toBe('Reading, Deleting · effects: purchase · tools: a.b · channels: Slack #x, Email');
    expect(splitList(' a, b\nb ,, c ')).toEqual(['a', 'b', 'c']);
    expect(initial('  scout')).toBe('S');
    expect(initial('')).toBe('?');
    expect(agentPath('a 1', 'rules')).toBe('/agents/a%201?tab=rules');
    expect(scheduleOrigin({ origin: 'agent_self' }, 'Scout')).toBe('Set by Scout');
    expect(scheduleOrigin({ origin: 'agent' }, 'Scout')).toBe('Created by Scout');
    expect(scheduleOrigin({ origin: 'user' }, 'Scout')).toBe('Set by you');
    expect(scheduleOriginText({ origin: 'user', agentId: null }, undefined)).toBeNull();
    expect(scheduleOriginText({ origin: 'agent', agentId: 'a1' }, undefined)).toBe(
      'Created by an agent',
    );
  });

  it('parses agent budgets and goal budgets within the Hub limits', () => {
    expect(parseBudgets(budgetDraft({ timeSeconds: 1800, tokens: 5000, costUsd: null }))).toEqual({
      budgets: { timeSeconds: 1800, tokens: 5000, costUsd: null },
    });
    const bad = parseBudgets({ minutes: '0', tokens: '1e9', cost: '-1' });
    expect('errors' in bad && Object.keys(bad.errors).sort()).toEqual([
      'cost',
      'minutes',
      'tokens',
    ]);
    expect(parseGoalBudget('', '', '')).toEqual({ budgets: {} });
    expect(parseGoalBudget('10', '2000', '1.5')).toEqual({
      budgets: { timeSeconds: 600, tokens: 2000, costUsd: 1.5 },
    });
    expect(parseGoalBudget('x', '', '')).toEqual({ error: 'Enter whole minutes, at least 1.' });
    expect(parseGoalBudget('', '', 'abc')).toEqual({ error: 'Enter a cost in US dollars.' });
    expect(goalUsageLine({ budgets: { tokens: 10_000 }, usage: { tokens: 2_500 } })).toBe(
      '0 min · 2.5K of 10K tokens · $0.00',
    );
  });

  it('sorts agents by status, then by recent activity', () => {
    const list = sortAgents([
      agentView({ id: 'old', lastActiveAt: '2026-09-01T00:00:00.000Z' }),
      agentView({ id: 'new', lastActiveAt: '2026-10-01T00:00:00.000Z' }),
      agentView({ id: 'blocked', derived: { status: 'blocked', reason: null } }),
    ]);
    expect(list.map((a) => a.id)).toEqual(['blocked', 'new', 'old']);
  });

  it('routes events to the sections they change', () => {
    expect(partsFor('agent.rule.changed')).toContain('rules');
    expect(partsFor('agent.note.created')).toEqual(['memory']);
    expect(partsFor('memory.item.deleted')).toEqual(['memory']);
    expect(partsFor('agent.suggestion.created')).toContain('suggestions');
    expect(partsFor('agent.research.finding')).toContain('suggestions');
    expect(partsFor('agent.background.started')).toContain('background');
    expect(partsFor('goal.status.changed')).toContain('goal');
    expect(partsFor('schedule.wake.set')).toContain('schedules');
    expect(partsFor('run.completed')).toContain('background');
    expect(partsFor('agent.paused')).toContain('agent');
    const env = (payload: Record<string, unknown>, correlation?: Record<string, unknown>) => ({
      id: 'e',
      name: 'x',
      schemaVersion: 1,
      ts: '',
      actor: 'system',
      payload,
      ...(correlation ? { correlation } : {}),
    });
    expect(eventAgentId(env({ agentId: 'a1' }))).toBe('a1');
    expect(eventAgentId(env({}, { agentId: 'a2' }))).toBe('a2');
    expect(eventAgentId(env({}))).toBeNull();
    expect(eventThreadRef(env({ ref: { kind: 'thread', id: 't1' } }))).toBe('t1');
    expect(eventThreadRef(env({ ref: { kind: 'run', id: 'r1' } }))).toBeNull();
  });
});
