// In-memory M3 surfaces for the fake Hub (test/fakes.ts): approvals, policy, tools, MCP,
// notifications, audit, diagnostics, artifacts, mentions and memory consolidation. Each web area
// extends the part it owns.
/* eslint-disable @typescript-eslint/require-await */
import type {
  ActivityItemView,
  ApprovalView,
  ArtifactView,
  AuditEntryView,
  CommandRuleView,
  ConsolidationRunView,
  DiagnosticsSnapshot,
  LogEntryView,
  McpLogLine,
  McpServerView,
  MemorySummaryView,
  MentionCandidate,
  NotificationView,
  PermissionGrantView,
  PermissionProfileView,
  PolicyRuleView,
  ToolDescriptor,
  ToolView,
} from '@nova/shared';
import { ApiError, type Api } from '../src/api.ts';

export interface M3State {
  approvals: ApprovalView[];
  rules: PolicyRuleView[];
  commandRules: CommandRuleView[];
  grants: PermissionGrantView[];
  profiles: PermissionProfileView[];
  tools: ToolView[];
  mcpServers: McpServerView[];
  mcpLogs: Map<string, McpLogLine[]>;
  mcpTools: Map<string, ToolDescriptor[]>;
  notifications: NotificationView[];
  audit: AuditEntryView[];
  activity: Map<string, ActivityItemView[]>;
  diagnostics: DiagnosticsSnapshot;
  logs: LogEntryView[];
  artifacts: ArtifactView[];
  mentions: MentionCandidate[];
  summary: MemorySummaryView;
  consolidations: ConsolidationRunView[];
  topics: { topic: string; preference: 'more' | 'less' | 'default' }[];
}

export const BUILTIN_PROFILES: PermissionProfileView[] = [
  {
    id: 'read-only',
    name: 'read-only',
    builtin: true,
    fs: [{ path: ':project', access: 'read' }],
    network: { mode: 'off', allow: [], deny: [] },
    requiresSubstrate: null,
    hash: 'h-ro',
  },
  {
    id: 'workspace',
    name: 'workspace',
    builtin: true,
    fs: [{ path: ':project', access: 'write' }],
    network: { mode: 'off', allow: [], deny: [] },
    requiresSubstrate: null,
    hash: 'h-ws',
  },
];

export function m3State(init: Partial<M3State> = {}): M3State {
  return {
    approvals: [],
    rules: [],
    commandRules: [],
    grants: [],
    profiles: BUILTIN_PROFILES,
    tools: [],
    mcpServers: [],
    mcpLogs: new Map(),
    mcpTools: new Map(),
    notifications: [],
    audit: [],
    activity: new Map(),
    diagnostics: {
      hub: {
        version: '0.1.0',
        uptimeSeconds: 10,
        dataDir: '/data',
        encryptedAtRest: { blobs: true, volume: 'unknown' },
      },
      providers: [],
      nodes: [],
      mcp: [],
      sandbox: { substrate: null, available: false, detail: 'No sandbox in the fake Hub' },
      secrets: { backend: 'vault', detail: 'Encrypted vault' },
      warnings: [],
    },
    logs: [],
    artifacts: [],
    mentions: [],
    summary: {
      scopeKind: 'global',
      scopeRef: null,
      summary: null,
      summaryTokens: 0,
      runId: null,
      updatedAt: null,
    },
    consolidations: [],
    topics: [],
    ...init,
  };
}

type M3Api = Pick<
  Api,
  | 'listApprovals'
  | 'getApproval'
  | 'decideApproval'
  | 'handoffDone'
  | 'listPolicyRules'
  | 'createPolicyRule'
  | 'updatePolicyRule'
  | 'deletePolicyRule'
  | 'previewPolicy'
  | 'listCommandRules'
  | 'createCommandRule'
  | 'updateCommandRule'
  | 'deleteCommandRule'
  | 'testCommandRules'
  | 'listGrants'
  | 'revokeGrant'
  | 'listProfiles'
  | 'listTools'
  | 'setToolDefault'
  | 'invokeTool'
  | 'listMcpServers'
  | 'createMcpServer'
  | 'updateMcpServer'
  | 'deleteMcpServer'
  | 'restartMcpServer'
  | 'mcpServerLogs'
  | 'mcpServerTools'
  | 'listNotifications'
  | 'markNotificationsRead'
  | 'deleteNotification'
  | 'listAudit'
  | 'verifyAudit'
  | 'auditExportUrl'
  | 'activity'
  | 'diagnostics'
  | 'logs'
  | 'logsExportUrl'
  | 'listArtifacts'
  | 'getArtifact'
  | 'artifactContentUrl'
  | 'mentions'
  | 'memorySummary'
  | 'consolidateMemory'
  | 'listConsolidations'
  | 'listMemoryTopics'
  | 'setMemoryTopic'
>;

export function m3Impl(
  st: M3State,
  helpers: { id: (prefix: string) => string; ts: () => string; maybeFail: (n: keyof Api) => void },
): M3Api {
  const { id, ts, maybeFail } = helpers;
  const notFound = () =>
    new ApiError(404, { code: 'not_found', message: 'Not found', retryable: false });
  const find = <T extends { id: string }>(list: T[], key: string): T => {
    const v = list.find((x) => x.id === key);
    if (!v) throw notFound();
    return v;
  };
  // Settings surfaces (Tools & MCP, Permissions, Diagnostics): the Hub checks command-rule
  // examples on save, so does the fake, with a plain word-prefix match (docs/12 §3.1).
  const words = (cmd: string) => cmd.trim().split(/\s+/).filter(Boolean);
  const matches = (pattern: (string | string[])[], cmd: string) => {
    const w = words(cmd);
    return (
      w.length >= pattern.length &&
      pattern.every((p, i) => (Array.isArray(p) ? p.includes(w[i]!) : p === w[i]))
    );
  };
  const checkExamples = (
    r: Pick<CommandRuleView, 'pattern' | 'matchExamples' | 'notMatchExamples'>,
  ) => {
    const bad = (field: string, example: string, message: string) =>
      new ApiError(400, {
        code: 'validation',
        message,
        retryable: false,
        details: { field, example },
      });
    for (const e of r.matchExamples)
      if (!matches(r.pattern, e))
        throw bad('matchExamples', e, `Match example "${e}" does not match the rule.`);
    for (const e of r.notMatchExamples)
      if (matches(r.pattern, e))
        throw bad('notMatchExamples', e, `Not-match example "${e}" matches the rule.`);
  };
  // What a tool decided before any user default, so clearing the default restores it.
  const baseEffective = new Map<string, ToolView['effective']>();
  const LEVELS = ['debug', 'info', 'warn', 'error'];
  const unread = () => st.notifications.filter((n) => !n.read).length;
  return {
    listApprovals: async (q = {}) => {
      maybeFail('listApprovals');
      return {
        items: st.approvals.filter(
          (a) =>
            (q.status !== 'pending' || a.status === 'pending') &&
            (!q.threadId || a.threadId === q.threadId),
        ),
      };
    },
    getApproval: async (aid) => {
      maybeFail('getApproval');
      return find(st.approvals, aid);
    },
    decideApproval: async (body) => {
      maybeFail('decideApproval');
      const a = find(st.approvals, body.approvalId);
      // The first valid answer wins; a handed-off step stays pending until it is marked done.
      if (a.status !== 'pending' || a.decision === 'handoff')
        throw new ApiError(409, {
          code: 'conflict',
          message: 'This approval was already answered.',
          retryable: false,
        });
      if (
        !a.options.includes(body.decision) ||
        (body.decision === 'allow_always' && !body.alwaysScope)
      )
        throw new ApiError(400, {
          code: 'validation',
          message: 'That decision is not offered for this approval.',
          retryable: false,
        });
      const next: ApprovalView = {
        ...a,
        status: body.decision === 'handoff' ? 'pending' : 'decided',
        decision: body.decision,
        decidedBy: 'user',
        decidedAt: ts(),
      };
      st.approvals = st.approvals.map((x) => (x.id === a.id ? next : x));
      return next;
    },
    handoffDone: async (aid) => {
      maybeFail('handoffDone');
      const a = find(st.approvals, aid);
      if (a.status !== 'pending' || a.decision !== 'handoff')
        throw new ApiError(409, {
          code: 'conflict',
          message: 'Nothing is handed off.',
          retryable: false,
        });
      const next: ApprovalView = { ...a, status: 'decided', decidedAt: ts() };
      st.approvals = st.approvals.map((x) => (x.id === a.id ? next : x));
      return next;
    },
    listPolicyRules: async () => {
      maybeFail('listPolicyRules');
      return { items: st.rules };
    },
    createPolicyRule: async (body) => {
      maybeFail('createPolicyRule');
      const r: PolicyRuleView = {
        id: id('rule'),
        scopeKind: body.scopeKind,
        scopeRef: body.scopeRef ?? null,
        match: body.match,
        effect: body.effect,
        label: body.label ?? null,
        priority: body.priority ?? 100,
        source: 'user',
        enabled: true,
        createdAt: ts(),
      };
      st.rules = [...st.rules, r];
      return r;
    },
    updatePolicyRule: async (rid, body) => {
      maybeFail('updatePolicyRule');
      const next = { ...find(st.rules, rid), ...body };
      st.rules = st.rules.map((x) => (x.id === rid ? next : x));
      return next;
    },
    deletePolicyRule: async (rid) => {
      maybeFail('deletePolicyRule');
      st.rules = st.rules.filter((x) => x.id !== rid);
      return { ok: true } as const;
    },
    previewPolicy: async (body) => {
      maybeFail('previewPolicy');
      const tool = st.tools.find((t) => t.name === body.tool);
      return {
        effect: tool?.effective.effect ?? 'ask',
        tier: tool?.effective.tier ?? 'pre_approvable',
        reason: tool?.effective.reason ?? 'No rule matched; the tool asks by default.',
        source: 'tool_default',
        ruleId: null,
      };
    },
    listCommandRules: async () => {
      maybeFail('listCommandRules');
      return { items: st.commandRules };
    },
    createCommandRule: async (body) => {
      maybeFail('createCommandRule');
      checkExamples(body);
      const r: CommandRuleView = {
        id: id('cmd'),
        scopeKind: body.scopeKind ?? 'global',
        scopeRef: body.scopeRef ?? null,
        pattern: body.pattern,
        decision: body.decision,
        justification: body.justification ?? null,
        matchExamples: body.matchExamples,
        notMatchExamples: body.notMatchExamples,
        priority: body.priority ?? 100,
        source: 'user',
        enabled: true,
        createdAt: ts(),
      };
      st.commandRules = [...st.commandRules, r];
      return r;
    },
    updateCommandRule: async (rid, body) => {
      maybeFail('updateCommandRule');
      const next = { ...find(st.commandRules, rid), ...body };
      checkExamples(next);
      st.commandRules = st.commandRules.map((x) => (x.id === rid ? next : x));
      return next;
    },
    deleteCommandRule: async (rid) => {
      maybeFail('deleteCommandRule');
      st.commandRules = st.commandRules.filter((x) => x.id !== rid);
      return { ok: true } as const;
    },
    testCommandRules: async (command) => {
      maybeFail('testCommandRules');
      const hit = st.commandRules.find((r) => r.enabled && matches(r.pattern, command));
      return hit
        ? { decision: hit.decision, ruleId: hit.id, reason: hit.justification ?? 'Matched a rule' }
        : { decision: null, ruleId: null, reason: 'No rule matches' };
    },
    listGrants: async () => {
      maybeFail('listGrants');
      return { items: st.grants };
    },
    revokeGrant: async (gid) => {
      maybeFail('revokeGrant');
      st.grants = st.grants.filter((g) => g.id !== gid);
      return { ok: true } as const;
    },
    listProfiles: async () => {
      maybeFail('listProfiles');
      return { items: st.profiles };
    },
    listTools: async () => {
      maybeFail('listTools');
      return { items: st.tools };
    },
    setToolDefault: async (name, value) => {
      maybeFail('setToolDefault');
      const t = st.tools.find((x) => x.name === name);
      if (!t) throw notFound();
      if (!baseEffective.has(name)) baseEffective.set(name, t.effective);
      const base = baseEffective.get(name)!;
      const next: ToolView = {
        ...t,
        userDefault: value,
        effective: value
          ? { ...base, effect: value, reason: `Your default for ${name}: ${value}.` }
          : base,
      };
      st.tools = st.tools.map((x) => (x.name === name ? next : x));
      return { tool: name, default: value };
    },
    invokeTool: async () => {
      maybeFail('invokeTool');
      return { ok: true, text: 'done' };
    },
    listMcpServers: async () => {
      maybeFail('listMcpServers');
      return { items: st.mcpServers };
    },
    createMcpServer: async (body) => {
      maybeFail('createMcpServer');
      const s: McpServerView = {
        id: id('mcp'),
        name: body.name,
        transport: body.transport,
        command: body.command ?? null,
        args: body.args ?? [],
        url: body.url ?? null,
        envKeys: Object.keys(body.env ?? {}),
        enabled: body.enabled ?? true,
        status: 'starting',
        lastError: null,
        protocolVersion: null,
        serverInfo: null,
        counts: { tools: 0, resources: 0, prompts: 0 },
        toolTimeoutMs: body.toolTimeoutMs ?? 60_000,
        startupTimeoutMs: body.startupTimeoutMs ?? 10_000,
        defaultApproval: body.defaultApproval ?? null,
        enabledTools: body.enabledTools ?? null,
        disabledTools: body.disabledTools ?? [],
        readOnlyTools: body.readOnlyTools ?? [],
        createdAt: ts(),
        updatedAt: ts(),
      };
      st.mcpServers = [...st.mcpServers, s];
      return s;
    },
    updateMcpServer: async (sid, body) => {
      maybeFail('updateMcpServer');
      const cur = find(st.mcpServers, sid);
      // `env` on a PATCH is the complete set of names; values go to the vault (never kept here).
      const next: McpServerView = {
        ...cur,
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.transport !== undefined ? { transport: body.transport } : {}),
        ...(body.command !== undefined ? { command: body.command } : {}),
        ...(body.args !== undefined ? { args: body.args } : {}),
        ...(body.url !== undefined ? { url: body.url } : {}),
        ...(body.env !== undefined ? { envKeys: Object.keys(body.env) } : {}),
        ...(body.enabled !== undefined
          ? { enabled: body.enabled, status: body.enabled ? 'starting' : 'disabled' }
          : {}),
        ...(body.toolTimeoutMs !== undefined ? { toolTimeoutMs: body.toolTimeoutMs } : {}),
        ...(body.startupTimeoutMs !== undefined ? { startupTimeoutMs: body.startupTimeoutMs } : {}),
        ...(body.defaultApproval !== undefined ? { defaultApproval: body.defaultApproval } : {}),
        ...(body.enabledTools !== undefined ? { enabledTools: body.enabledTools } : {}),
        ...(body.disabledTools ? { disabledTools: body.disabledTools } : {}),
        ...(body.readOnlyTools ? { readOnlyTools: body.readOnlyTools } : {}),
        updatedAt: ts(),
      };
      st.mcpServers = st.mcpServers.map((x) => (x.id === sid ? next : x));
      return next;
    },
    deleteMcpServer: async (sid) => {
      maybeFail('deleteMcpServer');
      st.mcpServers = st.mcpServers.filter((x) => x.id !== sid);
      return { ok: true } as const;
    },
    restartMcpServer: async (sid) => {
      maybeFail('restartMcpServer');
      const next: McpServerView = { ...find(st.mcpServers, sid), status: 'starting' };
      st.mcpServers = st.mcpServers.map((x) => (x.id === sid ? next : x));
      return next;
    },
    mcpServerLogs: async (sid) => {
      maybeFail('mcpServerLogs');
      return { items: st.mcpLogs.get(sid) ?? [] };
    },
    mcpServerTools: async (sid) => {
      maybeFail('mcpServerTools');
      return { items: st.mcpTools.get(sid) ?? [] };
    },
    listNotifications: async (q = {}) => {
      maybeFail('listNotifications');
      return {
        items: st.notifications.filter((n) => !q.unread || !n.read),
        unread: unread(),
      };
    },
    markNotificationsRead: async (body) => {
      maybeFail('markNotificationsRead');
      st.notifications = st.notifications.map((n) =>
        body.all || body.ids?.includes(n.id) ? { ...n, read: true } : n,
      );
      return { unread: unread() };
    },
    deleteNotification: async (nid) => {
      maybeFail('deleteNotification');
      st.notifications = st.notifications.filter((n) => n.id !== nid);
      return { ok: true } as const;
    },
    listAudit: async (q = {}) => {
      maybeFail('listAudit');
      const start = Number(q.cursor ?? 0);
      const end = start + (q.limit ?? 50);
      return {
        items: st.audit.slice(start, end),
        nextCursor: end < st.audit.length ? String(end) : null,
      };
    },
    verifyAudit: async () => {
      maybeFail('verifyAudit');
      return { ok: true, checked: st.audit.length, brokenAt: null };
    },
    auditExportUrl: () => '/api/v1/audit/export',
    activity: async (tid) => {
      maybeFail('activity');
      return { items: st.activity.get(tid) ?? [] };
    },
    diagnostics: async () => {
      maybeFail('diagnostics');
      return st.diagnostics;
    },
    logs: async (q = {}) => {
      maybeFail('logs');
      // `level` is the minimum level shown.
      const min = q.level ? LEVELS.indexOf(q.level) : 0;
      const items = st.logs.filter(
        (l) => LEVELS.indexOf(l.level) >= min && (!q.module || l.module === q.module),
      );
      return { items: q.limit ? items.slice(-q.limit) : items };
    },
    logsExportUrl: () => '/api/v1/diagnostics/logs/export',
    listArtifacts: async (tid) => {
      maybeFail('listArtifacts');
      return { items: st.artifacts.filter((a) => a.threadId === tid) };
    },
    getArtifact: async (aid) => {
      maybeFail('getArtifact');
      return find(st.artifacts, aid);
    },
    artifactContentUrl: (aid) => `/api/v1/artifacts/${aid}/content`,
    mentions: async (q) => {
      maybeFail('mentions');
      const needle = q.toLowerCase();
      return { items: st.mentions.filter((m) => m.label.toLowerCase().includes(needle)) };
    },
    memorySummary: async () => {
      maybeFail('memorySummary');
      return st.summary;
    },
    consolidateMemory: async () => {
      maybeFail('consolidateMemory');
      const run: ConsolidationRunView = {
        id: id('run'),
        scopeKind: 'global',
        scopeRef: null,
        phase: 'consolidate',
        status: 'running',
        threadsScanned: 0,
        itemsCreated: 0,
        itemsUpdated: 0,
        itemsAged: 0,
        summaryTokens: null,
        error: null,
        startedAt: ts(),
        endedAt: null,
      };
      st.consolidations = [run, ...st.consolidations];
      return run;
    },
    listConsolidations: async () => {
      maybeFail('listConsolidations');
      return { items: st.consolidations };
    },
    listMemoryTopics: async () => {
      maybeFail('listMemoryTopics');
      return { items: st.topics };
    },
    setMemoryTopic: async (topic, preference) => {
      maybeFail('setMemoryTopic');
      st.topics = [...st.topics.filter((t) => t.topic !== topic), { topic, preference }];
      return { topic, preference };
    },
  };
}
