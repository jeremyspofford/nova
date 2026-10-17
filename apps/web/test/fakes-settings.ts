// Test data for the M3 settings surfaces (Tools & MCP, Permissions, Notifications, Diagnostics,
// memory consolidation). The fake Hub behind them is test/fakes-m3.ts.
import type {
  AuditEntryView,
  CommandRuleView,
  ConsolidationRunView,
  LogEntryView,
  McpServerView,
  NotificationView,
  PermissionGrantView,
  PolicyRuleView,
  ToolDescriptor,
  ToolView,
} from '@nova/shared';

let n = 0;
const at = (s = 0) => new Date(Date.UTC(2026, 9, 1, 12, 0, s)).toISOString();

export function toolView(over: Partial<ToolView> = {}): ToolView {
  return {
    name: `tool${++n}`,
    title: '',
    description: 'Does a thing.',
    source: 'builtin',
    inputSchema: { type: 'object' },
    userDefault: null,
    effective: {
      effect: 'ask',
      reason: 'Tool default for this tool: ask.',
      tier: 'pre_approvable',
    },
    ...over,
  };
}

export function toolDescriptor(over: Partial<ToolDescriptor> = {}): ToolDescriptor {
  return {
    name: `mcp:srv.tool${++n}`,
    title: '',
    description: 'An MCP tool.',
    source: 'mcp',
    inputSchema: { type: 'object' },
    ...over,
  };
}

export function mcpServer(over: Partial<McpServerView> = {}): McpServerView {
  return {
    id: `mcp-x${++n}`,
    name: 'files',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'some-mcp-server'],
    url: null,
    envKeys: [],
    enabled: true,
    status: 'connected',
    lastError: null,
    protocolVersion: '2025-11-25',
    serverInfo: { name: 'files-server', version: '1.2.0' },
    counts: { tools: 2, resources: 0, prompts: 1 },
    toolTimeoutMs: 60_000,
    startupTimeoutMs: 30_000,
    defaultApproval: null,
    enabledTools: null,
    disabledTools: [],
    createdAt: at(),
    updatedAt: at(),
    ...over,
  };
}

export function notification(over: Partial<NotificationView> = {}): NotificationView {
  return {
    id: `ntf-x${++n}`,
    kind: 'completion',
    title: 'Reply finished',
    body: null,
    href: null,
    read: false,
    createdAt: at(n),
    ...over,
  };
}

export function policyRule(over: Partial<PolicyRuleView> = {}): PolicyRuleView {
  return {
    id: `rule-x${++n}`,
    scopeKind: 'global',
    scopeRef: null,
    match: { tool: 'fs.write' },
    effect: 'ask',
    label: null,
    priority: 100,
    source: 'user',
    enabled: true,
    createdAt: at(),
    ...over,
  };
}

export function commandRule(over: Partial<CommandRuleView> = {}): CommandRuleView {
  return {
    id: `cmd-x${++n}`,
    scopeKind: 'global',
    scopeRef: null,
    pattern: ['git', ['status', 'diff']],
    decision: 'allow',
    justification: 'Read-only Git inspection.',
    matchExamples: ['git status'],
    notMatchExamples: ['git push'],
    priority: 100,
    source: 'user',
    enabled: true,
    createdAt: at(),
    ...over,
  };
}

export function grant(over: Partial<PermissionGrantView> = {}): PermissionGrantView {
  return {
    id: `grant-x${++n}`,
    duration: 'always',
    label: 'Tool fs.write',
    tool: 'fs.write',
    host: null,
    commandRuleId: null,
    scopeKind: null,
    scopeRef: null,
    expiresAt: null,
    createdAt: at(),
    ...over,
  };
}

export function auditEntry(over: Partial<AuditEntryView> = {}): AuditEntryView {
  return {
    id: `aud-x${++n}`,
    actor: 'user:a1',
    kind: 'approval',
    action: 'Allowed fs.write once',
    resource: 'notes/plan.md',
    decision: 'allow_once',
    result: null,
    threadId: null,
    turnId: null,
    createdAt: at(),
    hash: `h${n}`,
    ...over,
  };
}

export function logEntry(over: Partial<LogEntryView> = {}): LogEntryView {
  return {
    ts: at(++n),
    level: 'info',
    module: 'hub',
    msg: 'listening',
    fields: {},
    ...over,
  };
}

export function consolidationRun(over: Partial<ConsolidationRunView> = {}): ConsolidationRunView {
  return {
    id: `run-x${++n}`,
    scopeKind: 'global',
    scopeRef: null,
    phase: 'consolidate',
    status: 'completed',
    threadsScanned: 4,
    itemsCreated: 2,
    itemsUpdated: 1,
    itemsAged: 1,
    summaryTokens: 640,
    error: null,
    startedAt: at(),
    endedAt: at(30),
    ...over,
  };
}
