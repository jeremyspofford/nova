// Builders and setup for the M3 chat tests: tool calls, approvals, artifacts, mentions, activity.
import { screen, waitFor } from '@testing-library/react';
import { expect, vi } from 'vitest';
import type {
  ApprovalView,
  ArtifactView,
  MessageView,
  ThreadView,
  ToolCallPartView,
} from '@nova/shared';
import { m3State, type M3State } from './fakes-m3.ts';
import { FakeEventSource, createHub, thread, type HubState } from './fakes.ts';
import { renderApp } from './render.tsx';

export function toolPart(over: Partial<ToolCallPartView> = {}): ToolCallPartView {
  return {
    type: 'tool_call',
    callId: 'call1',
    tool: 'fs.read',
    title: 'Read file',
    source: 'builtin',
    status: 'ok',
    argsPreview: '{"path":"notes/a.md"}',
    resultPreview: 'line one',
    error: null,
    approvalId: null,
    durationMs: 120,
    ...over,
  };
}

export function approvalView(threadId: string, over: Partial<ApprovalView> = {}): ApprovalView {
  return {
    id: 'ap1',
    threadId,
    turnId: 'turn1',
    callId: 'call1',
    action: 'Write notes/plan.md',
    tool: 'fs.write',
    argsPreview: '{"path":"notes/plan.md"}',
    reason: 'Writing files asks first.',
    tier: 'pre_approvable',
    risk: 'medium',
    userAsked: true,
    ruleId: null,
    options: [
      'allow_once',
      'allow_session',
      'allow_always',
      'deny_continue',
      'deny_stop',
      'handoff',
    ],
    alwaysScopes: [
      { kind: 'tool', label: 'This tool (fs.write) in this project', tool: 'fs.write' },
      {
        kind: 'prefix_rule',
        label: 'Commands starting with npm test',
        rule: {
          pattern: ['npm', ['test', 't']],
          matchExamples: ['npm test', 'npm t -- --watch'],
          notMatchExamples: ['npm publish'],
        },
      },
      { kind: 'host', label: 'Network host api.example.com', host: 'api.example.com' },
    ],
    status: 'pending',
    decision: null,
    decidedBy: null,
    createdAt: '2026-10-01T12:00:00.000Z',
    expiresAt: new Date(Date.now() + 2 * 3600_000 + 30 * 60_000).toISOString(),
    decidedAt: null,
    ...over,
  };
}

export function artifactView(threadId: string, over: Partial<ArtifactView> = {}): ArtifactView {
  return {
    id: 'art1',
    threadId,
    messageId: null,
    kind: 'markdown',
    title: 'Plan',
    mime: 'text/markdown',
    language: null,
    version: 1,
    live: false,
    size: 120,
    createdAt: '2026-10-01T12:00:00.000Z',
    updatedAt: '2026-10-01T12:00:00.000Z',
    ...over,
  };
}

/** An assistant reply waiting on approval `ap1` for call `call1` (a running turn). */
export function waitingReply(tid: string, over: Partial<MessageView> = {}): MessageView {
  return {
    id: 'm-reply',
    threadId: tid,
    turnId: 'turn1',
    role: 'assistant',
    status: 'streaming',
    parts: [
      { type: 'text', text: 'I will write the plan.' },
      toolPart({
        callId: 'call1',
        tool: 'fs.write',
        title: 'Write file',
        status: 'awaiting_approval',
        approvalId: 'ap1',
        resultPreview: null,
        durationMs: null,
      }),
    ],
    model: 'pa1/mock-fast',
    usage: null,
    createdAt: '2026-10-01T12:00:01.000Z',
    ...over,
  };
}

export interface OpenSetup {
  thread?: Partial<ThreadView>;
  messages?: (tid: string) => MessageView[];
  m3?: (tid: string) => Partial<M3State>;
  path?: (tid: string) => string;
  hub?: Partial<HubState>;
}

/** Open one chat on a fake Hub whose M3 state is built for that chat's id. */
export async function openWith(setup: OpenSetup = {}) {
  const t = thread({ title: 'Billing questions', ...setup.thread });
  const hub = createHub({ ...setup.hub, threads: [t], m3: m3State(setup.m3?.(t.id)) });
  hub.state.messages.set(t.id, setup.messages?.(t.id) ?? []);
  const r = await renderApp({ hub, path: setup.path?.(t.id) ?? `/chat/${t.id}` });
  await waitFor(() => expect(hub.api.getThread).toHaveBeenCalled());
  const es = FakeEventSource.for(`/threads/${t.id}/stream`);
  return { ...r, t, es };
}

export const inspector = () => screen.getByRole('complementary', { name: 'Inspector' });
export const chatLog = () => screen.getByRole('log', { name: 'Messages' });
export const announcer = () => screen.getByTestId('announcer').textContent?.trim() ?? '';

/** Serve artifact bytes through a stubbed `fetch` (text artifacts load with fetch). */
export function stubFetch(files: Record<string, string | { status: number }>) {
  const fn = vi.fn((url: string) => {
    const path = url.split('?')[0]!;
    const body = files[path];
    if (body === undefined || typeof body !== 'string') {
      const status = typeof body === 'object' ? body.status : 404;
      return Promise.resolve({
        ok: false,
        status,
        statusText: 'Server error',
        text: () => Promise.resolve(''),
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: () => Promise.resolve(body),
    });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}
