// @nova/sdk: the typed `nova` API for Nova extension authors (FR-117; docs/14 §4). An extension
// is a plugin folder with `.nova-plugin/extension.json`; its entry module exports
// `activate(nova)`. The code runs in an isolated engine inside a worker of its own, so `nova` is
// the only thing it can reach: every call goes to the Hub and is checked against what
// extension.json declares. This package holds the types, `defineExtension`, and a test host that
// runs an extension's handlers in-process with the same permission checks, for unit tests.
// Apache-2.0 so extensions of any license can use it (it imports nothing else).

/** The SDK API version (`extension.json` `api`, `nova.api`). */
export const API_VERSION = 1 as const;

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** A JSON Schema of type object (a tool's input). */
export interface JsonSchema {
  type?: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

export type ActionClass = 'read' | 'write' | 'send' | 'delete' | 'execute';
export type ApprovalDefault = 'allow' | 'ask' | 'deny';

/** What every `register` returns: `ready` settles once the Hub accepted (or refused) it. */
export interface Registration {
  readonly ready: Promise<void>;
  dispose(): void;
}

export interface CommandContext {
  origin: 'user';
}

export interface Command<A = unknown> {
  /** Declared in extension.json `permissions.commands`. */
  id: string;
  title?: string;
  run(args: A, ctx: CommandContext): unknown;
}

export type PanelEntryPoint = 'global' | 'thread' | 'file';

export interface Panel {
  /** Declared in extension.json `permissions.panels` (which names the HTML file). */
  id: string;
  title?: string;
  resource: string;
  entryPoint: PanelEntryPoint;
  /** File panels only, e.g. `[".lcov"]`. */
  extensions?: string[];
}

export interface ToolContext {
  threadId: string;
  turnId: string;
  callId: string;
  projectId: string | null;
  origin: 'model' | 'ui' | 'hook' | 'mcp_client';
}

/** A tool's answer: text, MCP-style content, or any JSON (also given as structured content). */
export type ToolAnswer =
  | string
  | { content: { type: 'text'; text: string }[]; structuredContent?: unknown; isError?: boolean }
  | JsonValue;

export interface ToolAnnotations {
  readOnly?: boolean;
  destructive?: boolean;
  idempotent?: boolean;
  requiresNetwork?: boolean;
  costClass?: 'free' | 'metered';
}

export interface Tool<A = Record<string, unknown>> {
  /** Declared in extension.json `permissions.tools`; models see it as `ext:<id>/<name>`. */
  name: string;
  title?: string;
  description?: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  annotations?: ToolAnnotations;
  handler(args: A, ctx: ToolContext): ToolAnswer | Promise<ToolAnswer>;
}

export type HookEvent =
  | 'session.start'
  | 'session.end'
  | 'prompt.submit'
  | 'tool.pre'
  | 'permission.request'
  | 'tool.post'
  | 'compact.pre'
  | 'compact.post'
  | 'subagent.start'
  | 'subagent.stop'
  | 'stop'
  | 'interrupt';

/** What a hook receives (docs/08 §4.1), with secrets redacted. */
export interface HookPayload {
  event: HookEvent;
  hookId: string;
  threadId: string;
  turnId: string | null;
  projectId: string | null;
  tool?: string;
  arguments?: unknown;
  result?: string;
  prompt?: string;
  reply?: string;
  [key: string]: unknown;
}

/** A hook's answer; nothing (or `{}`) means no opinion. Hooks only tighten (ADR-068). */
export interface HookAnswer {
  block?: { reason: string };
  decision?: 'allow' | 'deny';
  context?: string;
  continue?: string;
}

export interface Hook {
  /** Declared in extension.json `permissions.hooks`; runs only once the owner trusted it. */
  id: string;
  event: HookEvent;
  matcher?: string | string[];
  handler(payload: HookPayload): HookAnswer | void | Promise<HookAnswer | void>;
}

/** contracts/schemas/theme.json. */
export interface Theme {
  schemaVersion: 1;
  id: string;
  name: string;
  variant: 'light' | 'dark' | 'system';
  extends?: string;
  tokens: Record<string, string>;
  fonts?: Record<string, string>;
}

export interface Keybinding {
  /** One of the extension's own commands. */
  command: string;
  key: string;
  when?: string;
}

/** Events an extension may observe (declared in `permissions.events`), and docs/14 aliases. */
export type ObservableEvent =
  | 'chat.message.created'
  | 'chat.message.completed'
  | 'chat.message.deleted'
  | 'thread.created'
  | 'thread.updated'
  | 'thread.deleted'
  | 'turn.started'
  | 'turn.completed'
  | 'turn.interrupted'
  | 'tool.call.started'
  | 'tool.call.completed'
  | 'run.created'
  | 'run.status.changed'
  | 'run.completed'
  | 'approval.requested'
  | 'approval.decided'
  | 'project.created'
  | 'project.updated'
  | 'project.deleted'
  | 'schedule.fired'
  | 'agent.status.changed'
  | 'thread.message'
  | 'run.end'
  | 'tool.call';

export interface NovaEvent {
  name: string;
  at: string;
  payload: Record<string, unknown>;
  correlation: Record<string, string>;
}

export type MenuPlace = 'thread' | 'message' | 'file' | 'composer' | 'sidebar';

export interface Menu {
  where: MenuPlace;
  items: { id?: string; title: string; command: string }[];
}

export interface StatusItemInput {
  id: string;
  text: string;
  /** A command id of the extension, or a function run on click. */
  onClick?: string | (() => unknown);
}

export interface StatusItem extends Registration {
  update(text: string): void;
}

export interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface FetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  readonly headers: Readonly<Record<string, string>>;
  /** The body was longer than 5 MB and was cut. */
  readonly truncated: boolean;
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
  /** Binary bodies, base64; null for text. */
  base64(): Promise<string | null>;
}

export interface FileEntry {
  name: string;
  kind: 'file' | 'dir' | 'other';
  size: number | null;
}

/** The `nova` object an extension's `activate` receives (also the global `nova`). */
export interface Nova {
  readonly api: typeof API_VERSION;
  readonly extensionId: string;
  readonly commands: { register<A = unknown>(command: Command<A>): Registration };
  readonly panels: { register(panel: Panel): Registration };
  readonly tools: {
    register<A = Record<string, unknown>>(tool: Tool<A>): Registration;
  };
  readonly hooks: { register(hook: Hook): Registration };
  readonly themes: { register(theme: Theme): Registration };
  readonly keybindings: { register(binding: Keybinding): Registration };
  readonly events: {
    on(name: ObservableEvent | `${string}.*`, listener: (e: NovaEvent) => unknown): Registration;
  };
  readonly menus: { register(menu: Menu): Registration };
  readonly status: { addItem(item: StatusItemInput): StatusItem };
  /** Declared hosts only (`permissions.network`), public addresses only. */
  readonly net: { fetch(url: string, init?: FetchInit): Promise<FetchResponse> };
  /** Declared scopes only (`permissions.fs`); `${extensionData}` is the extension's own folder. */
  readonly fs: {
    read(path: string): Promise<string>;
    write(path: string, text: string): Promise<void>;
    list(path: string): Promise<FileEntry[]>;
    remove(path: string): Promise<void>;
  };
  /** Declared names only (`permissions.secrets`); the owner stores the values. */
  readonly secrets: { get(name: string): Promise<string | null> };
  log(...values: unknown[]): void;
}

export interface Extension {
  activate(nova: Nova): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}

/** Type an extension (it returns its argument). */
export function defineExtension<T extends Extension>(extension: T): T {
  return extension;
}

// ---- extension.json ---------------------------------------------------------------------------

export interface ExtensionPanelDecl {
  id: string;
  title: string;
  resource: string;
  entryPoint: PanelEntryPoint;
  extensions?: string[];
  /** The HTML file in the extension that serves the resource. */
  file: string;
  connectDomains?: string[];
  resourceDomains?: string[];
  frameDomains?: string[];
}

export interface ExtensionPermissions {
  network?: string[];
  fs?: (string | { path: string; write?: boolean })[];
  secrets?: string[];
  commands?: string[];
  panels?: ExtensionPanelDecl[];
  tools?: Record<string, { action: ActionClass; default?: ApprovalDefault }>;
  actionDefaults?: Partial<Record<ActionClass, ApprovalDefault>>;
  hooks?: {
    id: string;
    event: HookEvent;
    matcher?: string | string[];
    failClosed?: boolean;
    timeoutMs?: number;
    statusMessage?: string;
  }[];
  events?: string[];
}

/** `.nova-plugin/extension.json`. */
export interface ExtensionManifest {
  api: typeof API_VERSION;
  /** The entry ES module, relative to the extension folder (`.js` or `.mjs`). */
  entry: string;
  permissions: ExtensionPermissions;
}

// ---- the test host -----------------------------------------------------------------------------

const EVENT_ALIASES: Record<string, string> = {
  'thread.message': 'chat.message.completed',
  'run.end': 'run.completed',
  'tool.call': 'tool.call.completed',
};

function hostMatches(pattern: string, host: string): boolean {
  const p = pattern.toLowerCase();
  const h = host.toLowerCase();
  if (p === '*') return true;
  if (p.startsWith('*.')) return h.endsWith(p.slice(1)) && h.length > p.length - 1;
  return p === h;
}

function eventCovered(declared: readonly string[], name: string): boolean {
  const want = EVENT_ALIASES[name] ?? name;
  return declared.some((d) => {
    const p = EVENT_ALIASES[d] ?? d;
    if (p === want) return true;
    if (p.endsWith('.*') && !want.endsWith('.*')) return want.startsWith(p.slice(0, -1));
    return p.endsWith('.*') && want.startsWith(p.slice(0, -1));
  });
}

/** Something the test host refused, as the Hub would (it would also turn the extension off). */
export class PermissionDeniedError extends Error {
  readonly code = 'policy_denied';
  constructor(message: string) {
    super(message);
    this.name = 'PermissionDeniedError';
  }
}

export interface TestHostOptions {
  extensionId?: string;
  /** Secret values by name (only declared names are readable). */
  secrets?: Record<string, string>;
  /** Files by path (`${extensionData}/…` or absolute), for `nova.fs`. */
  files?: Record<string, string>;
  /** What `nova.net.fetch` answers for a declared host. */
  fetch?: (url: string, init: FetchInit) => Promise<{ status: number; body: string }>;
}

export interface TestHost {
  readonly nova: Nova;
  readonly commands: Map<string, Command>;
  readonly tools: Map<string, Tool>;
  readonly hooks: Map<string, Hook>;
  readonly panels: Map<string, Panel>;
  readonly themes: Map<string, Theme>;
  readonly keybindings: Keybinding[];
  readonly menus: Menu[];
  readonly status: Map<string, StatusItemInput>;
  readonly files: Map<string, string>;
  /** Everything the host refused, in order. */
  readonly denied: string[];
  /** Console lines. */
  readonly logs: string[];
  run(commandId: string, args?: unknown): Promise<unknown>;
  callTool(name: string, args?: Record<string, unknown>): Promise<ToolAnswer>;
  runHook(id: string, payload?: Partial<HookPayload>): Promise<HookAnswer | void>;
  emit(name: string, payload?: Record<string, unknown>): Promise<void>;
}

/**
 * An in-process host for an extension's unit tests: `activate(host.nova)`, then run commands,
 * tools, hooks and events. It applies the same declared-permission rules as the Hub (commands,
 * panels, tools, hooks, events, hosts, files and secrets), so an undeclared request fails here
 * too. It does not isolate the code: that is the Hub's engine.
 */
export function createTestHost(manifest: ExtensionManifest, opts: TestHostOptions = {}): TestHost {
  const p = manifest.permissions;
  const extensionId = opts.extensionId ?? 'com.example.test';
  const denied: string[] = [];
  const logs: string[] = [];
  const commands = new Map<string, Command>();
  const tools = new Map<string, Tool>();
  const hooks = new Map<string, Hook>();
  const panels = new Map<string, Panel>();
  const themes = new Map<string, Theme>();
  const keybindings: Keybinding[] = [];
  const menus: Menu[] = [];
  const status = new Map<string, StatusItemInput>();
  const listeners = new Map<number, { name: string; fn: (e: NovaEvent) => unknown }>();
  const files = new Map(Object.entries(opts.files ?? {}));
  let nextListener = 1;

  const deny = (what: string): never => {
    denied.push(what);
    throw new PermissionDeniedError(`${extensionId} did not declare ${what}`);
  };
  const ok = (dispose: () => void): Registration => ({ ready: Promise.resolve(), dispose });
  const register = <T>(declared: boolean, what: string, map: Map<string, T>, key: string, v: T) => {
    if (!declared) deny(what);
    map.set(key, v);
    return ok(() => map.delete(key));
  };
  const fsScope = (path: string, write: boolean) => {
    const scopes = (p.fs ?? []).map((s) =>
      typeof s === 'string'
        ? { path: s, write: s === '${extensionData}' }
        : { path: s.path, write: s.write === true },
    );
    const hit = scopes.find(
      (s) => (path === s.path || path.startsWith(`${s.path}/`)) && (!write || s.write),
    );
    if (!hit || path.split('/').includes('..'))
      deny(`${write ? 'write' : 'read'} access to ${path}`);
  };
  const commandDeclared = (id: string) => (p.commands ?? []).includes(id);

  const nova: Nova = {
    api: API_VERSION,
    extensionId,
    commands: {
      register: (c) =>
        register(commandDeclared(c.id), `the command ${c.id}`, commands, c.id, c as Command),
    },
    panels: {
      register: (panel) =>
        register(
          (p.panels ?? []).some((d) => d.id === panel.id && d.resource === panel.resource),
          `the panel ${panel.id}`,
          panels,
          panel.id,
          panel,
        ),
    },
    tools: {
      register: (t) =>
        register(
          Object.hasOwn(p.tools ?? {}, t.name),
          `the tool ${t.name}`,
          tools,
          t.name,
          t as unknown as Tool,
        ),
    },
    hooks: {
      register: (h) =>
        register(
          (p.hooks ?? []).some((d) => d.id === h.id && d.event === h.event),
          `the hook ${h.id}`,
          hooks,
          h.id,
          h,
        ),
    },
    themes: {
      register: (t) => register(t.schemaVersion === 1, `the theme ${t.id}`, themes, t.id, t),
    },
    keybindings: {
      register: (b) => {
        if (!commandDeclared(b.command)) deny(`a keybinding for ${b.command}`);
        keybindings.push(b);
        return ok(() => keybindings.splice(keybindings.indexOf(b), 1));
      },
    },
    events: {
      on: (name, fn) => {
        if (!eventCovered(p.events ?? [], name)) deny(`the event ${name}`);
        const id = nextListener++;
        listeners.set(id, { name, fn });
        return ok(() => listeners.delete(id));
      },
    },
    menus: {
      register: (m) => {
        for (const i of m.items)
          if (!commandDeclared(i.command)) deny(`a menu item for ${i.command}`);
        menus.push(m);
        return ok(() => menus.splice(menus.indexOf(m), 1));
      },
    },
    status: {
      addItem: (item) => {
        if (typeof item.onClick === 'string' && !commandDeclared(item.onClick))
          deny(`a status item for ${item.onClick}`);
        status.set(item.id, { ...item });
        return {
          ...ok(() => status.delete(item.id)),
          update: (text: string) => {
            const s = status.get(item.id);
            if (s) s.text = text;
          },
        };
      },
    },
    net: {
      fetch: async (url, init = {}) => {
        const host = new URL(url).hostname;
        if (!(p.network ?? []).some((d) => hostMatches(d, host))) deny(`the host ${host}`);
        const r = opts.fetch ? await opts.fetch(url, init) : { status: 404, body: '' };
        return {
          ok: r.status >= 200 && r.status < 300,
          status: r.status,
          statusText: '',
          headers: {},
          truncated: false,
          text: () => Promise.resolve(r.body),
          json: <T>() => Promise.resolve(JSON.parse(r.body) as T),
          base64: () => Promise.resolve(null),
        };
      },
    },
    fs: {
      read: async (path) => {
        await Promise.resolve();
        fsScope(path, false);
        const v = files.get(path);
        if (v === undefined) throw new Error('no such file');
        return v;
      },
      write: async (path, text) => {
        await Promise.resolve();
        fsScope(path, true);
        files.set(path, text);
      },
      list: async (path) => {
        await Promise.resolve();
        fsScope(path, false);
        const prefix = `${path.replace(/\/$/, '')}/`;
        const names = [...files.keys()]
          .filter((f) => f.startsWith(prefix))
          .map((f) => f.slice(prefix.length).split('/')[0]!);
        return [...new Set(names)].map((name) => ({ name, kind: 'file' as const, size: null }));
      },
      remove: async (path) => {
        await Promise.resolve();
        fsScope(path, true);
        files.delete(path);
      },
    },
    secrets: {
      get: async (name) => {
        await Promise.resolve();
        if (!(p.secrets ?? []).includes(name)) deny(`the secret ${name}`);
        return opts.secrets?.[name] ?? null;
      },
    },
    log: (...values) => {
      logs.push(values.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(' '));
    },
  };

  const ctx: ToolContext = {
    threadId: 'test-thread',
    turnId: 'test-turn',
    callId: 'test-call',
    projectId: null,
    origin: 'model',
  };
  return {
    nova,
    commands,
    tools,
    hooks,
    panels,
    themes,
    keybindings,
    menus,
    status,
    files,
    denied,
    logs,
    run: async (id, args) => {
      const c = commands.get(id);
      if (!c) throw new Error(`the command ${id} is not registered`);
      return await Promise.resolve(c.run(args ?? null, { origin: 'user' }));
    },
    callTool: async (name, args = {}) => {
      const t = tools.get(name);
      if (!t) throw new Error(`the tool ${name} is not registered`);
      return t.handler(args, ctx);
    },
    runHook: async (id, payload = {}) => {
      const h = hooks.get(id);
      if (!h) throw new Error(`the hook ${id} is not registered`);
      return h.handler({
        event: h.event,
        hookId: id,
        threadId: 'test-thread',
        turnId: 'test-turn',
        projectId: null,
        ...payload,
      });
    },
    emit: async (name, payload = {}) => {
      for (const l of listeners.values()) {
        const want = EVENT_ALIASES[l.name] ?? l.name;
        const hit = want.endsWith('.*') ? name.startsWith(want.slice(0, -1)) : want === name;
        if (hit) await l.fn({ name, at: new Date(0).toISOString(), payload, correlation: {} });
      }
    },
  };
}
