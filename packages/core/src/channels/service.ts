// Channel bindings (FR-088, docs/13 §4, ADR-070): one external conversation → one thread of an
// agent. Inbound deliveries are verified by their adapter, routed to the binding of their
// conversation, checked (identity mapping, loop prevention, dedupe, addressed, rate caps) and only
// then start a turn: trigger `channel`, no authority (origin `channel`, FR-189), the text marked
// as not the user's. The reply goes back through the adapter; in a shared channel it first passes
// the private-to-shared check (default ask the owner). Approvals a channel turn waits for are
// posted to the channel and can be answered there by the owner's mapped identity, except
// `confirm_at_action` and `handoff_required`, which need an authenticated Nova client. Secrets
// live in the secret store under the binding's `secret_ref` prefix; bindings of one app share it.
// M7 (FR-110): Telegram (webhook or long polling) and email (IMAP and SMTP) bindings; approval
// prompts with buttons (Slack, Telegram) answered by the presser's mapped identity, and signed
// one-use links for email (never reply text); email attachments become thread attachments; and
// the message log (`messages`). Pollers (pollers.ts) feed `receiveFrom` with verified messages.
import {
  NovaError,
  uuidv7,
  type ApprovalView,
  type ChannelAdapterViewM7,
  type ChannelBindingViewM7,
  type ChannelIdentityViewM7,
  type ChannelKindM7,
  type ChannelMessageView,
  type ChannelMessagesPageView,
  type ChannelMessagesQuery,
  type ChannelRole,
  type CreateChannelBindingM7Request,
  type SettingKey,
  type SettingValue,
  type UpdateChannelBindingRequest,
} from '@nova/shared';
import type { SecretStore } from '@nova/secrets';
import { defaultRedactor, type Redactor } from '@nova/security';
import type { NovaDatabase } from '@nova/storage';
import type { Logger } from '@nova/telemetry';
import type { EventSink } from '../events.ts';
import type { ApprovalRequests } from '../requests/broker.ts';
import type { StartedTurn, TurnOutcome, TurnStarter } from '../runtime/types.ts';
import { prepareAttachments, writeAttachmentBlob } from '../attachments.ts';
import { webhookUrlProblem } from '../scheduler/delivery.ts';
import { afterTimeCursor, encodeTimeCursor } from '../time-cursor.ts';
import type { AuditSink } from '../tools/types.ts';
import {
  HUB_ONLY_TEXT,
  answerableFromChannel,
  answeredText,
  approvalCode,
  approvalEmailText,
  approvalPrompt,
  parseAnswer,
} from './answers.ts';
import type {
  BindingCredentials,
  ChannelAction,
  InboundAttachment,
  NovaChannelAdapter,
  NovaInboundMessage,
  NovaOutboundMessage,
  OutboundApproval,
} from './adapters/common.ts';
import { assertSecure } from './adapters/mail/imap.ts';
import { ApprovalLinks } from './approval-links.ts';
import { overlapPrivacyCheck, type PrivateOriginCheck, type PrivateSource } from './privacy.ts';
import { sha256Hex, type Headers } from './signing.ts';
import type { ChannelKind, ChannelReceipt, ChannelSender, InboundMessage } from './types.ts';

export interface BindingRow {
  id: string;
  account_id: string;
  agent_id: string | null;
  kind: ChannelKind;
  label: string;
  external_ref: string;
  audience: 'private' | 'shared';
  thread_id: string | null;
  share_primary_thread: number;
  allow_unknown: number;
  config_json: string | null;
  secret_ref: string | null;
  rate_per_minute: number;
  rate_per_hour: number;
  enabled: number;
  status_detail: string | null;
  last_message_at: string | null;
  created_at: string;
  updated_at: string;
}

/** What the agents area needs to know of a binding to pick its thread. */
export interface ChannelBindingInfo {
  id: string;
  kind: ChannelKind;
  label: string;
  externalRef: string;
  audience: 'private' | 'shared';
  sharePrimaryThread: boolean;
  threadId: string | null;
}

/**
 * The agents area's `threadFor(accountId, agentId, binding)` (ADR-070): one thread per binding, or
 * the agent's primary thread for a private binding that shares it.
 */
export type BindingThreadResolver = (input: {
  accountId: string;
  agentId: string | null;
  binding: ChannelBindingInfo;
}) => Promise<string>;

/** Ask the owner whether private content may go to a shared channel (docs/13 §4). */
export type ShareAsk = (input: {
  accountId: string;
  threadId: string;
  bindingId: string;
  label: string;
  sources: PrivateSource[];
}) => Promise<'allow' | 'deny'>;

export type ChannelSetting = <K extends SettingKey>(key: K) => Promise<SettingValue<K>>;

/** Messages of an unbound or bound conversation, for `connector_event` triggers (FR-056). */
export type ConnectorListener = (input: {
  accountId: string;
  /** The binding the delivery came through and its credential group. */
  bindingId: string;
  credentialGroup: string | null;
  /** The bound binding of the conversation, if any. */
  targetBindingId: string | null;
  message: InboundMessage;
}) => Promise<void>;

/**
 * The external-agent rule (FR-194, the agents area's ExternalAgentGuard.inbound): content another
 * AI agent wrote never starts a turn as an instruction.
 */
export interface ChannelInboundGuard {
  inbound(input: {
    accountId: string;
    agentId?: string | null;
    threadId?: string | null;
    source: 'channel';
    text: string;
    sender?: { id: string; name?: string | null; isBot?: boolean } | null;
  }): Promise<{ accept: true } | { accept: false; reason: string }>;
}

export interface ChannelServiceOptions {
  db: NovaDatabase;
  events: EventSink;
  secrets: SecretStore;
  setting: ChannelSetting;
  /** Adapters by kind (the Hub builds Slack, Teams, webhook, email and in-app). */
  adapters: (credentials: BindingCredentials) => Partial<Record<ChannelKind, NovaChannelAdapter>>;
  /** Creates a binding's thread when no agents-area resolver is bound. */
  createThread?: (
    accountId: string,
    input: { title: string; mode: 'chat' | 'agent' },
  ) => Promise<string>;
  audit?: AuditSink;
  log?: Logger;
  now?: () => Date;
  /** How long an outbound send may take (default 30 s). */
  sendTimeoutMs?: number;
  /** Secrets are redacted from everything sent out (default redactor). */
  redactor?: Redactor;
  /** Where inbound attachments are stored (the Hub data directory); none: they are dropped. */
  dataDir?: string;
  /** The public Hub address approval links point at (`channels.publicUrl`, else the Hub's). */
  publicBase?: () => Promise<string>;
}

export interface ReceiveOutcome {
  status: 'started' | 'answered' | 'ignored' | 'duplicate' | 'dropped';
  reason?: string;
  /** A body the service expects back (Slack URL verification). */
  reply?: Record<string, unknown>;
  bindingId?: string;
  threadId?: string;
  turnId?: string;
}

/** The context of a turn a channel message started: where its reply and approvals go. */
interface TurnContext {
  accountId: string;
  bindingId: string;
  threadId: string;
  turnId: string;
  conversation: string;
  threadRef: string | null;
  visibility: 'private' | 'shared';
  /** Email: the message the reply answers, and its subject. */
  replyTo?: string | null;
  subject?: string | null;
  /** Who wrote the message that started the turn (approval links go to the owner only). */
  role?: ChannelRole | 'guest';
}

/** The decisions a channel can carry (the card's others need a Nova client). */
const CHANNEL_DECISIONS = new Set(['allow_once', 'allow_session', 'deny_continue', 'deny_stop']);

const KIND_LABEL: Record<ChannelKind, string> = {
  inapp: 'Nova',
  slack: 'Slack',
  teams: 'Microsoft Teams',
  email: 'email',
  webhook: 'a webhook',
  telegram: 'Telegram',
};

/** Settings each kind may hold (no secrets); learned values included. */
const CONFIG_KEYS: Partial<Record<ChannelKind, readonly string[]>> = {
  slack: ['botUserId', 'teamId'],
  teams: ['appId', 'serviceUrl'],
  webhook: ['callbackUrl'],
};
const REMEMBERED = new Set(['serviceUrl']);
/** Kinds whose deliveries are posted to `/api/v1/channels/:id/inbound`. */
const INBOUND_KINDS = new Set<ChannelKind>(['slack', 'teams', 'webhook', 'telegram']);
/** Kinds whose bindings share one app's (bot's, mailbox's) credentials. */
const SHARED_SECRET_KINDS = new Set<ChannelKind>(['slack', 'teams', 'telegram', 'email']);
const ADAPTER_KINDS: ChannelKindM7[] = ['inapp', 'slack', 'teams', 'email', 'webhook', 'telegram'];

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function parseConfig(json: string | null): Record<string, string | null> {
  if (!json) return {};
  try {
    const v = JSON.parse(json) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const out: Record<string, string | null> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>))
      out[k] = typeof x === 'string' ? x : null;
    return out;
  } catch {
    return {};
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class ChannelService implements ChannelSender {
  readonly #o: ChannelServiceOptions;
  readonly #db: NovaDatabase;
  readonly #now: () => Date;
  readonly #adapters: Partial<Record<ChannelKind, NovaChannelAdapter>>;
  readonly #pending = new Set<Promise<unknown>>();
  readonly #turns = new Map<string, TurnContext>();
  #starter: TurnStarter | null = null;
  #approvals: ApprovalRequests | null = null;
  #resolver: BindingThreadResolver | null = null;
  #privacy: PrivateOriginCheck;
  #ask: ShareAsk | null = null;
  #connector: ConnectorListener | null = null;
  #guard: ChannelInboundGuard | null = null;
  readonly #links: ApprovalLinks;
  readonly #listeners = new Set<(change: { bindingId: string; kind: ChannelKind }) => void>();

  constructor(opts: ChannelServiceOptions) {
    this.#o = opts;
    this.#db = opts.db;
    this.#now = opts.now ?? (() => new Date());
    this.#privacy = overlapPrivacyCheck(opts.db);
    this.#adapters = opts.adapters(this.credentials);
    this.#links = new ApprovalLinks({ db: opts.db, secrets: opts.secrets, now: this.#now });
  }

  /** Binding changes, for the pollers (pollers.ts). */
  onBindingChange(fn: (change: { bindingId: string; kind: ChannelKind }) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  /** An adapter by kind, for the pollers. */
  adapterOf(kind: ChannelKind): NovaChannelAdapter | null {
    return this.#adapters[kind] ?? null;
  }

  // ---- late-bound collaborators -------------------------------------------------------------

  /** The chat loop that runs channel turns. */
  useTurns(starter: TurnStarter): void {
    this.#starter = starter;
  }

  /** The approvals flow (policy area) for approvals answered from a channel. */
  useApprovals(approvals: ApprovalRequests): void {
    this.#approvals = approvals;
  }

  /** The agents area's `threadFor`; without it each binding gets its own thread here. */
  useThreads(resolver: BindingThreadResolver): void {
    this.#resolver = resolver;
  }

  /** The agents area's `memory.originOf`; replaces the default overlap check. */
  usePrivacy(check: PrivateOriginCheck): void {
    this.#privacy = check;
  }

  /** How the owner is asked about private content in a shared channel; unset, it is denied. */
  useShareAsk(ask: ShareAsk): void {
    this.#ask = ask;
  }

  /** `connector_event` triggers (FR-056): every verified message, addressed or not. */
  useConnectorEvents(listener: ConnectorListener): void {
    this.#connector = listener;
  }

  /** The agents area's external-agent rule (FR-194) for inbound messages. */
  useInboundGuard(guard: ChannelInboundGuard): void {
    this.#guard = guard;
  }

  // ---- credentials ----------------------------------------------------------------------------

  /** Adapters read a binding's secrets and settings through this. */
  readonly credentials: BindingCredentials = {
    secret: async (bindingId, name) => {
      const row = this.#rowById(bindingId);
      if (!row?.secret_ref) return null;
      return this.#o.secrets.get(`${row.secret_ref}/${name}`);
    },
    config: (bindingId) => {
      const row = this.#rowById(bindingId);
      if (!row) return Promise.resolve({});
      return Promise.resolve({ ...parseConfig(row.config_json), externalRef: row.external_ref });
    },
    remember: async (bindingId, key, value) => {
      if (!REMEMBERED.has(key)) return;
      const row = this.#rowById(bindingId);
      if (!row) return;
      // A learned setting (the Teams service URL) applies to every binding of the app.
      const rows = row.secret_ref
        ? (this.#db.raw
            .prepare('SELECT * FROM channel_binding WHERE account_id = ? AND secret_ref = ?')
            .all(row.account_id, row.secret_ref) as unknown as BindingRow[])
        : [row];
      const now = this.#now().toISOString();
      await this.#db.transaction(() => {
        for (const r of rows) {
          const config = { ...parseConfig(r.config_json), [key]: value };
          this.#db.raw
            .prepare('UPDATE channel_binding SET config_json = ?, updated_at = ? WHERE id = ?')
            .run(JSON.stringify(config), now, r.id);
        }
      });
    },
  };

  // ---- adapters -------------------------------------------------------------------------------

  adapterViews(): ChannelAdapterViewM7[] {
    return ADAPTER_KINDS.map((kind) => {
      const a = this.#adapters[kind];
      if (!a) return { kind, available: false, detail: `${KIND_LABEL[kind]} is not set up` };
      const av = a.availability?.() ?? { available: true, detail: null };
      return { kind, available: av.available, detail: av.detail };
    });
  }

  #adapter(kind: ChannelKind): NovaChannelAdapter {
    const a = this.#adapters[kind];
    if (!a)
      throw new NovaError('capability_missing', `${KIND_LABEL[kind]} channels are not set up`);
    return a;
  }

  // ---- bindings -------------------------------------------------------------------------------

  #rowById(id: string): BindingRow | null {
    return (
      (this.#db.raw.prepare('SELECT * FROM channel_binding WHERE id = ?').get(id) as
        BindingRow | undefined) ?? null
    );
  }

  #row(accountId: string, id: string): BindingRow {
    const row = this.#rowById(id);
    if (!row || row.account_id !== accountId)
      throw new NovaError('not_found', 'channel binding not found');
    return row;
  }

  async list(accountId: string, opts: { agentId?: string } = {}): Promise<ChannelBindingViewM7[]> {
    const rows = (opts.agentId
      ? this.#db.raw
          .prepare(
            'SELECT * FROM channel_binding WHERE account_id = ? AND agent_id = ? ORDER BY created_at, id',
          )
          .all(accountId, opts.agentId)
      : this.#db.raw
          .prepare('SELECT * FROM channel_binding WHERE account_id = ? ORDER BY created_at, id')
          .all(accountId)) as unknown as BindingRow[];
    const out: ChannelBindingViewM7[] = [];
    for (const r of rows) out.push(await this.#view(r));
    return out;
  }

  async get(accountId: string, id: string): Promise<ChannelBindingViewM7> {
    return this.#view(this.#row(accountId, id));
  }

  /** The audience of a thread's binding (for memory labels, ADR-070); null when unbound. */
  audienceOf(accountId: string, threadId: string): 'private' | 'shared' | null {
    const rows = this.#db.raw
      .prepare('SELECT audience, kind FROM channel_binding WHERE account_id = ? AND thread_id = ?')
      .all(accountId, threadId) as { audience: 'private' | 'shared'; kind: ChannelKind }[];
    if (!rows.length) return null;
    return rows.some((r) => r.audience === 'shared' && r.kind !== 'inapp') ? 'shared' : 'private';
  }

  /** The binding a thread belongs to, if any (several when bindings share the primary thread). */
  bindingsOfThread(accountId: string, threadId: string): ChannelBindingInfo[] {
    const rows = this.#db.raw
      .prepare('SELECT * FROM channel_binding WHERE account_id = ? AND thread_id = ?')
      .all(accountId, threadId) as unknown as BindingRow[];
    return rows.map(info);
  }

  async #view(r: BindingRow): Promise<ChannelBindingViewM7> {
    const adapter = this.#adapters[r.kind];
    const names = adapter?.credentialNames ?? [];
    const credentials: { name: string; set: boolean }[] = [];
    for (const name of names)
      credentials.push({
        name,
        set: r.secret_ref ? await this.#o.secrets.has(`${r.secret_ref}/${name}`) : false,
      });
    const own = `secret://channel/${r.id}`;
    const configured =
      credentials.every((c) => c.set) && (adapter?.availability?.().available ?? true);
    return {
      id: r.id,
      agentId: r.agent_id,
      kind: r.kind,
      label: r.label,
      externalRef: r.external_ref,
      audience: r.audience,
      threadId: r.thread_id,
      sharePrimaryThread: r.share_primary_thread === 1,
      allowUnknown: r.allow_unknown === 1,
      rateLimit: { perMinute: r.rate_per_minute, perHour: r.rate_per_hour },
      status: !r.enabled ? 'disconnected' : configured ? 'connected' : 'not_configured',
      statusDetail: r.status_detail,
      config: parseConfig(r.config_json),
      credentials,
      sharesCredentialsWith:
        r.secret_ref && r.secret_ref !== own
          ? r.secret_ref.slice('secret://channel/'.length)
          : null,
      inboundPath:
        INBOUND_KINDS.has(r.kind) &&
        (r.kind !== 'telegram' || parseConfig(r.config_json).mode === 'webhook')
          ? `/api/v1/channels/${r.id}/inbound`
          : null,
      lastMessageAt: r.last_message_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  async create(
    accountId: string,
    req: CreateChannelBindingM7Request,
  ): Promise<ChannelBindingViewM7> {
    const adapter = this.#adapter(req.kind);
    const av = adapter.availability?.();
    if (av && !av.available)
      throw new NovaError(
        'capability_missing',
        av.detail ?? `${KIND_LABEL[req.kind]} channels are not available`,
      );
    const id = uuidv7();
    const now = this.#now().toISOString();
    const audience = req.kind === 'inapp' ? 'private' : (req.audience ?? 'shared');
    if (req.sharePrimaryThread && audience !== 'private')
      throw fieldError('sharePrimaryThread', 'only a private binding can share the primary thread');
    const ref =
      req.externalRef ?? (req.kind === 'inapp' ? `agent:${req.agentId ?? 'default'}` : '');
    // Email addresses compare in lower case (mail is matched to bindings by its sender).
    const externalRef = req.kind === 'email' ? ref.trim().toLowerCase() : ref;
    let secretRef: string | null = null;
    let credentials: Record<string, string> = {};
    let inherited: Record<string, string | null> = {};
    if (
      req.kind === 'slack' ||
      req.kind === 'teams' ||
      req.kind === 'telegram' ||
      req.kind === 'email'
    ) {
      if (req.shareCredentialsWith) {
        if (req.credentials)
          throw fieldError('credentials', 'give credentials or shareCredentialsWith, not both');
        const other = this.#row(accountId, req.shareCredentialsWith);
        if (other.kind !== req.kind || !other.secret_ref)
          throw fieldError('shareCredentialsWith', `that binding is not a ${req.kind} binding`);
        secretRef = other.secret_ref;
        // A bot or mailbox shared is shared with its settings (mode, mailbox servers, bot ids).
        if (req.kind === 'telegram' || req.kind === 'email')
          inherited = parseConfig(other.config_json);
      } else if (req.credentials) {
        secretRef = `secret://channel/${id}`;
        credentials = { ...req.credentials };
        // The Hub makes these secrets (Telegram's webhook secret); a client never sets them.
        for (const [name, make] of Object.entries(adapter.generatedCredentials ?? {})) {
          if (name in credentials)
            throw fieldError(`credentials.${name}`, `the Hub makes the ${name} itself`);
          credentials[name] = make();
        }
      } else throw fieldError('credentials', `a ${KIND_LABEL[req.kind]} binding needs credentials`);
    } else if (req.kind === 'webhook') {
      secretRef = `secret://channel/${id}`;
      credentials = { ...req.credentials };
    }
    const config: Record<string, string> = {};
    for (const [k, v] of Object.entries(inherited)) if (typeof v === 'string') config[k] = v;
    if ('config' in req && req.config)
      for (const [k, v] of Object.entries(req.config as Record<string, unknown>))
        if (typeof v === 'string') config[k] = v;
        else if (typeof v === 'number' && Number.isFinite(v)) config[k] = String(v);
    if (req.kind === 'email') {
      mailboxCheck(config);
      if (config.senderCheck === 'none' && !req.confirmSenderCheckNone) throw senderCheckOff();
    }
    if (req.kind === 'teams' && !config.appId) {
      // Sharing an app's credentials shares its app id.
      const sibling = secretRef ? this.#sibling(accountId, secretRef) : null;
      const appId = sibling ? parseConfig(sibling.config_json).appId : null;
      if (!appId) throw fieldError('config.appId', 'a Teams binding needs the app id');
      config.appId = appId;
    }
    if (req.kind === 'webhook' && config.callbackUrl) {
      const problem = webhookUrlProblem(config.callbackUrl);
      if (problem) throw fieldError('config.callbackUrl', problem);
    }
    if (secretRef && this.#duplicate(accountId, req.kind, secretRef, externalRef, null))
      throw new NovaError('conflict', 'this conversation is already bound', {
        details: { field: 'externalRef' },
      });
    for (const [name, value] of Object.entries(credentials))
      await this.#o.secrets.put(`${secretRef}/${name}`, value);
    const row: BindingRow = {
      id,
      account_id: accountId,
      agent_id: req.agentId ?? null,
      kind: req.kind,
      label: req.label ?? defaultLabel(req.kind, externalRef),
      external_ref: externalRef,
      audience,
      thread_id: null,
      share_primary_thread: req.sharePrimaryThread ? 1 : 0,
      allow_unknown: req.allowUnknown ? 1 : 0,
      config_json: Object.keys(config).length ? JSON.stringify(config) : null,
      secret_ref: secretRef,
      rate_per_minute: req.rateLimit?.perMinute ?? 10,
      rate_per_hour: req.rateLimit?.perHour ?? 120,
      enabled: req.enabled === false ? 0 : 1,
      status_detail: null,
      last_message_at: null,
      created_at: now,
      updated_at: now,
    };
    await this.#db.transaction(() => {
      this.#db.raw
        .prepare(
          `INSERT INTO channel_binding (id, account_id, agent_id, kind, label, external_ref,
             audience, thread_id, share_primary_thread, allow_unknown, config_json, secret_ref,
             rate_per_minute, rate_per_hour, enabled, status_detail, last_message_at, created_at,
             updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.id,
          row.account_id,
          row.agent_id,
          row.kind,
          row.label,
          row.external_ref,
          row.audience,
          row.thread_id,
          row.share_primary_thread,
          row.allow_unknown,
          row.config_json,
          row.secret_ref,
          row.rate_per_minute,
          row.rate_per_hour,
          row.enabled,
          row.status_detail,
          row.last_message_at,
          row.created_at,
          row.updated_at,
        );
    });
    await this.#audit(accountId, 'user', 'channel.create', row, {
      kind: row.kind,
      audience: row.audience,
      sharesCredentials: 'shareCredentialsWith' in req && !!req.shareCredentialsWith,
    });
    if (row.kind === 'email' && config.senderCheck === 'none')
      await this.#audit(accountId, 'user', 'channel.email.sender_check_off', row, {
        address: config.address ?? null,
      });
    await this.#changed(row, 'created');
    return this.#view(row);
  }

  #sibling(accountId: string, secretRef: string): BindingRow | null {
    return (
      (this.#db.raw
        .prepare(
          'SELECT * FROM channel_binding WHERE account_id = ? AND secret_ref = ? ORDER BY created_at LIMIT 1',
        )
        .get(accountId, secretRef) as BindingRow | undefined) ?? null
    );
  }

  #duplicate(
    accountId: string,
    kind: ChannelKind,
    secretRef: string,
    externalRef: string,
    except: string | null,
  ): boolean {
    const row = this.#db.raw
      .prepare(
        `SELECT id FROM channel_binding WHERE account_id = ? AND kind = ? AND secret_ref = ?
           AND external_ref = ? AND id IS NOT ?`,
      )
      .get(accountId, kind, secretRef, externalRef, except);
    return !!row;
  }

  async update(
    accountId: string,
    id: string,
    patch: UpdateChannelBindingRequest,
    opts: { confirmSenderCheckNone?: boolean } = {},
  ): Promise<ChannelBindingViewM7> {
    const row = this.#row(accountId, id);
    const audience = patch.audience ?? row.audience;
    const share =
      patch.sharePrimaryThread ?? (audience === 'private' && row.share_primary_thread === 1);
    if (share && audience !== 'private')
      throw fieldError('sharePrimaryThread', 'only a private binding can share the primary thread');
    if (row.kind === 'inapp' && audience !== 'private')
      throw fieldError('audience', 'the in-app channel is private');
    const config = parseConfig(row.config_json);
    if (patch.config) {
      const allowed = this.#adapters[row.kind]?.configKeys ?? CONFIG_KEYS[row.kind] ?? [];
      for (const [k, v] of Object.entries(patch.config)) {
        if (!allowed.includes(k)) throw fieldError(`config.${k}`, `unknown setting ${k}`);
        if (k === 'callbackUrl' && v) {
          const problem = webhookUrlProblem(v);
          if (problem) throw fieldError('config.callbackUrl', problem);
        }
        if (v === null) delete config[k];
        else config[k] = v;
      }
      if (row.kind === 'email') mailboxCheck(config);
    }
    // Turning the email sender check off must be confirmed, and is audited.
    const checkOff =
      row.kind === 'email' &&
      config.senderCheck === 'none' &&
      parseConfig(row.config_json).senderCheck !== 'none';
    if (checkOff && !opts.confirmSenderCheckNone) throw senderCheckOff();
    if (patch.credentials) {
      const adapter = this.#adapters[row.kind];
      const names = adapter?.credentialNames ?? [];
      if (!row.secret_ref) throw fieldError('credentials', 'this binding has no credentials');
      for (const name of Object.keys(patch.credentials)) {
        if (!names.includes(name))
          throw fieldError(`credentials.${name}`, `unknown credential ${name}`);
        // A secret the Hub made (Telegram's webhook secret) is never replaced by hand.
        if (adapter?.generatedCredentials && name in adapter.generatedCredentials)
          throw fieldError(`credentials.${name}`, `the Hub makes the ${name} itself`);
      }
      for (const [name, value] of Object.entries(patch.credentials))
        await this.#o.secrets.put(`${row.secret_ref}/${name}`, value);
    }
    const now = this.#now().toISOString();
    await this.#db.transaction(() => {
      this.#db.raw
        .prepare(
          `UPDATE channel_binding SET label = ?, audience = ?, share_primary_thread = ?,
             allow_unknown = ?, rate_per_minute = ?, rate_per_hour = ?, config_json = ?,
             updated_at = ? WHERE id = ?`,
        )
        .run(
          patch.label ?? row.label,
          audience,
          share ? 1 : 0,
          patch.allowUnknown === undefined ? row.allow_unknown : patch.allowUnknown ? 1 : 0,
          patch.rateLimit?.perMinute ?? row.rate_per_minute,
          patch.rateLimit?.perHour ?? row.rate_per_hour,
          Object.keys(config).length ? JSON.stringify(config) : null,
          now,
          id,
        );
    });
    const next = this.#row(accountId, id);
    await this.#audit(accountId, 'user', 'channel.update', next, {
      changed: Object.keys(patch),
    });
    if (checkOff)
      await this.#audit(accountId, 'user', 'channel.email.sender_check_off', next, {
        address: config.address ?? null,
      });
    await this.#changed(next, 'updated');
    return this.#view(next);
  }

  /**
   * Connect or disconnect at once (docs/13 §4). Disconnecting stops inbound turns and outbound
   * messages and cancels the turns this binding started. Connecting probes the credentials.
   */
  async setEnabled(accountId: string, id: string, enabled: boolean): Promise<ChannelBindingViewM7> {
    const row = this.#row(accountId, id);
    let detail: string | null = null;
    let learned: Record<string, string> = {};
    if (enabled) {
      const probe = await this.#adapters[row.kind]
        ?.probe?.(row.id, AbortSignal.timeout(this.#o.sendTimeoutMs ?? 30_000))
        .catch((err: unknown) => ({ ok: false, detail: errText(err) }));
      if (probe) {
        detail = probe.ok ? null : probe.detail;
        learned = ('learned' in probe ? probe.learned : undefined) ?? {};
      }
    }
    const now = this.#now().toISOString();
    const config = { ...parseConfig(row.config_json), ...learned };
    await this.#db.transaction(() => {
      this.#db.raw
        .prepare(
          `UPDATE channel_binding SET enabled = ?, status_detail = ?, config_json = ?,
             updated_at = ? WHERE id = ?`,
        )
        .run(
          enabled ? 1 : 0,
          detail,
          Object.keys(config).length ? JSON.stringify(config) : null,
          now,
          id,
        );
    });
    if (!enabled) {
      for (const ctx of [...this.#turns.values()]) {
        if (ctx.bindingId !== id) continue;
        this.#turns.delete(ctx.turnId);
        await this.#starter?.cancel(accountId, ctx.threadId).catch(() => undefined);
      }
    }
    const next = this.#row(accountId, id);
    await this.#audit(accountId, 'user', enabled ? 'channel.connect' : 'channel.disconnect', next, {
      ...(detail ? { problem: detail } : {}),
    });
    await this.#changed(next, enabled ? 'connected' : 'disconnected');
    return this.#view(next);
  }

  async remove(accountId: string, id: string): Promise<void> {
    const row = this.#row(accountId, id);
    for (const ctx of [...this.#turns.values()])
      if (ctx.bindingId === id) this.#turns.delete(ctx.turnId);
    await this.#db.transaction(() => {
      this.#db.raw.prepare('DELETE FROM channel_binding WHERE id = ?').run(id);
    });
    // Secrets go with the last binding that uses them.
    if (row.secret_ref && !this.#sibling(accountId, row.secret_ref))
      for (const ref of await this.#o.secrets.list(`${row.secret_ref}/`))
        await this.#o.secrets.delete(ref);
    await this.#audit(accountId, 'user', 'channel.delete', row, { kind: row.kind });
    await this.#changed(row, 'removed');
  }

  /** Remove every binding of an agent (the agents area calls this before deleting it). */
  async removeForAgent(accountId: string, agentId: string): Promise<number> {
    const rows = this.#db.raw
      .prepare('SELECT id FROM channel_binding WHERE account_id = ? AND agent_id = ?')
      .all(accountId, agentId) as { id: string }[];
    for (const r of rows) await this.remove(accountId, r.id);
    return rows.length;
  }

  /** Send a test message to the binding's conversation (Settings → Channels). */
  async test(accountId: string, id: string, text?: string): Promise<ChannelReceipt> {
    const row = this.#row(accountId, id);
    if (!row.enabled) throw new NovaError('conflict', 'the channel is disconnected');
    const receipt = await this.#send(
      row,
      { conversation: row.external_ref, text: text ?? 'Nova is connected to this conversation.' },
      row.thread_id,
    );
    await this.#audit(accountId, 'user', 'channel.test', row, { receipt: receipt.id });
    return receipt;
  }

  // ---- identities ---------------------------------------------------------------------------

  listIdentities(accountId: string): ChannelIdentityViewM7[] {
    const rows = this.#db.raw
      .prepare('SELECT * FROM channel_identity WHERE account_id = ? ORDER BY kind, external_id')
      .all(accountId) as unknown as IdentityRow[];
    return rows.map(identityView);
  }

  async addIdentity(
    accountId: string,
    input: {
      kind: ChannelKindM7;
      externalId: string;
      displayName?: string;
      role: ChannelRole;
    },
  ): Promise<ChannelIdentityViewM7> {
    const now = this.#now().toISOString();
    const id = uuidv7();
    // Email addresses compare in lower case (the parser lowers the sender too).
    const externalId =
      input.kind === 'email' ? input.externalId.trim().toLowerCase() : input.externalId;
    await this.#db.transaction(() => {
      this.#db.raw
        .prepare(
          `INSERT INTO channel_identity (id, account_id, kind, external_id, display_name, role, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (account_id, kind, external_id)
           DO UPDATE SET display_name = excluded.display_name, role = excluded.role`,
        )
        .run(id, accountId, input.kind, externalId, input.displayName ?? null, input.role, now);
    });
    const row = this.#db.raw
      .prepare(
        'SELECT * FROM channel_identity WHERE account_id = ? AND kind = ? AND external_id = ?',
      )
      .get(accountId, input.kind, externalId) as unknown as IdentityRow;
    await this.#o.audit?.append({
      accountId,
      actor: 'user',
      kind: 'channel',
      action: 'channel.identity.set',
      resource: `${input.kind}:${externalId}`,
      detail: { role: input.role },
    });
    return identityView(row);
  }

  async removeIdentity(accountId: string, id: string): Promise<void> {
    const row = this.#db.raw
      .prepare('SELECT * FROM channel_identity WHERE id = ? AND account_id = ?')
      .get(id, accountId) as IdentityRow | undefined;
    if (!row) throw new NovaError('not_found', 'identity not found');
    await this.#db.transaction(() => {
      this.#db.raw.prepare('DELETE FROM channel_identity WHERE id = ?').run(id);
    });
    await this.#o.audit?.append({
      accountId,
      actor: 'user',
      kind: 'channel',
      action: 'channel.identity.remove',
      resource: `${row.kind}:${row.external_id}`,
    });
  }

  #identity(accountId: string, kind: ChannelKind, externalId: string): IdentityRow | null {
    return (
      (this.#db.raw
        .prepare(
          'SELECT * FROM channel_identity WHERE account_id = ? AND kind = ? AND external_id = ?',
        )
        .get(accountId, kind, externalId) as IdentityRow | undefined) ?? null
    );
  }

  // ---- inbound --------------------------------------------------------------------------------

  /**
   * An inbound delivery on a binding's public endpoint. Authentication failures throw (401);
   * everything after it is an outcome, so the service is answered 200 and does not retry.
   */
  async receive(
    bindingId: string,
    req: { headers: Headers; rawBody: Uint8Array },
  ): Promise<ReceiveOutcome> {
    const via = this.#rowById(bindingId);
    if (!via || !INBOUND_KINDS.has(via.kind))
      throw new NovaError('not_found', 'channel binding not found');
    const adapter = this.#adapter(via.kind);
    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.headers))
      headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
    const msg: NovaInboundMessage | null = await adapter.parse({
      bindingId: via.id,
      headers,
      rawBody: req.rawBody,
    });
    if (!msg) {
      const reply = adapter.handshake?.(req.rawBody) ?? null;
      return reply
        ? { status: 'ignored', reason: 'handshake', reply }
        : { status: 'ignored', reason: 'not_a_message' };
    }
    return this.#handle(via, msg);
  }

  /**
   * A message a poller read with the binding's own credentials (Telegram `getUpdates`, the email
   * mailbox): authenticated by that call, then handled like a verified delivery.
   */
  async receiveFrom(bindingId: string, msg: NovaInboundMessage): Promise<ReceiveOutcome> {
    const via = this.#rowById(bindingId);
    if (!via) throw new NovaError('not_found', 'channel binding not found');
    return this.#handle(via, msg);
  }

  async #handle(via: BindingRow, msg: NovaInboundMessage): Promise<ReceiveOutcome> {
    // Route to the binding of the conversation among bindings of the same app.
    const target =
      msg.conversation === via.external_ref
        ? via
        : via.secret_ref && SHARED_SECRET_KINDS.has(via.kind)
          ? ((this.#db.raw
              .prepare(
                `SELECT * FROM channel_binding WHERE account_id = ? AND kind = ? AND secret_ref = ?
                   AND external_ref = ? ORDER BY created_at LIMIT 1`,
              )
              .get(via.account_id, via.kind, via.secret_ref, msg.conversation) as
              BindingRow | undefined) ?? null)
          : via;
    // Loop prevention for watchers too: our own sends never count as events.
    const own = this.#isOwn(target ?? via, msg);
    if (!own && this.#connector) {
      await this.#connector({
        accountId: via.account_id,
        bindingId: via.id,
        credentialGroup: via.secret_ref,
        targetBindingId: target?.id ?? null,
        message: msg,
      }).catch((err: unknown) => this.#o.log?.warn('connector event failed', { err }));
    }
    if (!target) return { status: 'ignored', reason: 'unbound_conversation' };
    if (own) return this.#drop(target, msg, 'own_message');
    if (!target.enabled) return this.#drop(target, msg, 'disconnected');
    // Dedupe: a redelivered message (retries, message + app_mention) is recorded once.
    const logId = uuidv7();
    const inserted = await this.#record(target, {
      id: logId,
      direction: 'in',
      externalId: msg.messageId,
      conversation: msg.conversation,
      threadRef: msg.threadRef,
      sender: msg.sender.externalId,
      status: 'ignored',
      reason: 'received',
      text: msg.text,
    });
    if (!inserted) return { status: 'duplicate', bindingId: target.id };

    const mapped = this.#identity(target.account_id, target.kind, msg.sender.externalId);
    // An email sender whose address the receiving server could not authenticate is not the
    // identity it claims (a From address is easy to forge).
    const identity = msg.senderVerified === false ? null : mapped;
    const role: ChannelRole | 'guest' | null = identity
      ? identity.role
      : target.allow_unknown
        ? 'guest'
        : null;
    if (!role) {
      if (msg.action)
        await this.#refuseAction(target, msg.action, 'You cannot answer approvals here.');
      return this.#settle(
        target,
        logId,
        msg,
        'ignored',
        mapped && !identity ? 'unverified_sender' : 'unknown_sender',
      );
    }
    if (msg.action) {
      const outcome = await this.#answerAction(target, msg, msg.action, role);
      await this.#settleRow(logId, 'answered', outcome);
      return { status: 'answered', reason: outcome, bindingId: target.id };
    }
    if (target.audience === 'private' && role !== 'owner')
      return this.#settle(target, logId, msg, 'ignored', 'not_owner');
    if (!msg.addressed) return this.#settle(target, logId, msg, 'ignored', 'not_addressed');

    const answer = await this.#maybeAnswer(target, msg, role);
    if (answer) {
      await this.#settleRow(logId, 'answered', answer);
      return { status: 'answered', reason: answer, bindingId: target.id };
    }
    if (this.#guard) {
      const verdict = await this.#guard
        .inbound({
          accountId: target.account_id,
          agentId: target.agent_id,
          threadId: target.thread_id,
          source: 'channel',
          text: msg.text,
          sender: { id: msg.sender.externalId, name: msg.sender.displayName },
        })
        .catch((): { accept: false; reason: string } => ({
          accept: false,
          reason: 'the external-agent check failed',
        }));
      if (!verdict.accept) return this.#settle(target, logId, msg, 'ignored', 'external_agent');
    }
    if (this.#overRate(target, 'in'))
      return this.#settle(target, logId, msg, 'dropped', 'rate_limited');
    if (!this.#starter) return this.#settle(target, logId, msg, 'dropped', 'no_runtime');

    const threadId = await this.#threadFor(target);
    // Names from the service are untrusted: one line, bounded, so they cannot fake the framing.
    const who = (identity?.display_name ?? msg.sender.displayName ?? msg.sender.externalId)
      .replace(/[\s()]+/g, ' ')
      .trim()
      .slice(0, 80);
    const visibility = effectiveVisibility(target, msg.visibility);
    const files = await this.#storeAttachments(target.account_id, threadId, msg.attachments);
    let text = framed(target, msg, who, role, visibility);
    if (files.skipped.length) text += `\n[Attachments not accepted: ${files.skipped.join('; ')}]`;
    let started: StartedTurn;
    try {
      started = await this.#starter.startTurn({
        accountId: target.account_id,
        threadId,
        text,
        trigger: 'channel',
        triggerRef: target.id,
        // Channel content never carries the user's authority, even from the owner (FR-189).
        authority: { kind: 'none', origin: 'channel' },
        authorKind: 'user',
        ...(files.ids.length ? { attachmentIds: files.ids } : {}),
      });
    } catch (err) {
      this.#o.log?.warn('channel turn did not start', { err, bindingId: target.id });
      return this.#settle(target, logId, msg, 'dropped', 'turn_failed');
    }
    const ctx: TurnContext = {
      accountId: target.account_id,
      bindingId: target.id,
      threadId,
      turnId: started.turnId,
      conversation: msg.conversation,
      threadRef: msg.threadRef,
      visibility,
      replyTo: msg.messageId,
      subject: msg.subject ?? null,
      role,
    };
    this.#turns.set(started.turnId, ctx);
    const now = this.#now().toISOString();
    await this.#db.transaction(() => {
      this.#db.raw
        .prepare(
          `UPDATE channel_message SET status = 'started', reason = ?, thread_id = ?, turn_id = ?
           WHERE id = ?`,
        )
        // A message from a binding that skips the sender check says so in the log.
        .run(msg.senderUnchecked ? 'sender_unchecked' : null, threadId, started.turnId, logId);
      this.#db.raw
        .prepare('UPDATE channel_binding SET last_message_at = ? WHERE id = ?')
        .run(now, target.id);
    });
    await this.#o.events.emit({
      name: 'channel.message.received',
      accountId: target.account_id,
      actor: 'system',
      correlation: {
        threadId,
        turnId: started.turnId,
        ...(target.agent_id ? { agentId: target.agent_id } : {}),
      },
      payload: { bindingId: target.id, from: msg.sender.externalId, threadId },
    });
    this.#track(this.#follow(ctx, started.done));
    return { status: 'started', bindingId: target.id, threadId, turnId: started.turnId };
  }

  #isOwn(row: BindingRow, msg: InboundMessage): boolean {
    const config = parseConfig(row.config_json);
    if (config.botUserId && msg.sender.externalId === config.botUserId) return true;
    const sent = this.#db.raw
      .prepare(
        `SELECT 1 FROM channel_message WHERE account_id = ? AND direction = 'out' AND external_id = ?
         LIMIT 1`,
      )
      .get(row.account_id, msg.messageId.split(':').at(-1) ?? msg.messageId);
    return !!sent;
  }

  /** Inbound files become attachments of the thread (validated like uploads, FR-021). */
  async #storeAttachments(
    accountId: string,
    threadId: string,
    list: InboundAttachment[] | undefined,
  ): Promise<{ ids: string[]; skipped: string[] }> {
    const out = { ids: [] as string[], skipped: [] as string[] };
    if (!list?.length) return out;
    const dataDir = this.#o.dataDir;
    for (const a of list) {
      if (!dataDir) {
        out.skipped.push(`${a.name} (files are not kept here)`);
        continue;
      }
      try {
        const [p] = prepareAttachments([
          { name: a.name, mime: a.mime, data: a.bytes.toString('base64') },
        ]);
        const blob = writeAttachmentBlob(dataDir, p!.bytes);
        const id = uuidv7();
        await this.#db.transaction(() => {
          this.#db.raw
            .prepare(
              `INSERT INTO attachment (id, message_id, thread_id, name, mime, size, sha256, origin,
                 blob_path, extracted_text_path, created_at)
               VALUES (?, NULL, ?, ?, ?, ?, ?, 'import', ?, NULL, ?)`,
            )
            .run(
              id,
              threadId,
              p!.name,
              p!.mime,
              p!.bytes.length,
              blob.sha256,
              blob.blobPath,
              this.#now().toISOString(),
            );
        });
        out.ids.push(id);
      } catch (err) {
        out.skipped.push(`${a.name.slice(0, 80)} (${errText(err).slice(0, 120)})`);
      }
    }
    void accountId;
    return out;
  }

  async #refuseAction(row: BindingRow, action: ChannelAction, text: string): Promise<void> {
    await this.#adapters[row.kind]
      ?.refuse?.(row.id, action, text, AbortSignal.timeout(this.#o.sendTimeoutMs ?? 30_000))
      .catch(() => undefined);
  }

  /**
   * A button answer (Slack, Telegram): the same rules as a reply (the owner's mapped identity,
   * pre-approvable only, an offered choice), and the approval must belong to this binding's
   * conversation. The prompt is then updated with the outcome.
   */
  async #answerAction(
    row: BindingRow,
    msg: NovaInboundMessage,
    action: ChannelAction,
    role: ChannelRole | 'guest',
  ): Promise<string> {
    const refuse = async (reason: string, text: string, approval?: ApprovalView) => {
      await this.#o.audit?.append({
        accountId: row.account_id,
        actor: `channel:${row.id}`,
        kind: 'channel',
        action: 'channel.approval.refused',
        resource: `approval:${action.approvalId}`,
        decision: action.decision,
        threadId: approval?.threadId ?? row.thread_id,
        turnId: approval?.turnId ?? null,
        detail: {
          reason,
          via: 'button',
          tier: approval?.tier ?? null,
          sender: msg.sender.externalId,
        },
      });
      await this.#refuseAction(row, action, text);
      return `refused:${reason}`;
    };
    if (!this.#approvals) return refuse('unavailable', 'Approvals cannot be answered right now.');
    let approval: ApprovalView;
    try {
      approval = await this.#approvals.get(row.account_id, action.approvalId);
    } catch {
      return refuse('unknown', 'That approval is not known.');
    }
    // Before anything else: a Hub-only card is never answered from a channel (docs/23 §6.3).
    if (approval.answerIn === 'hub') return refuse('hub_only', HUB_ONLY_TEXT, approval);
    if (!row.thread_id || approval.threadId !== row.thread_id)
      return refuse(
        'other_conversation',
        'That approval belongs to another conversation.',
        approval,
      );
    if (approval.status !== 'pending' || approval.decision !== null)
      return refuse('already_decided', 'That approval was already answered.', approval);
    if (role !== 'owner')
      return refuse('not_owner', 'Only the owner can answer approvals.', approval);
    if (!answerableFromChannel(approval.tier))
      return refuse('native_client_only', 'This approval can only be answered in Nova.', approval);
    if (!approval.options.includes(action.decision))
      return refuse('not_offered', 'That choice is not offered for this approval.', approval);
    try {
      await this.#approvals.decide(
        row.account_id,
        { approvalId: approval.id, decision: action.decision },
        `channel:${row.id}`,
      );
    } catch (err) {
      return refuse('rejected', `The answer was not accepted: ${errText(err)}`, approval);
    }
    await this.#o.audit?.append({
      accountId: row.account_id,
      actor: `channel:${row.id}`,
      kind: 'channel',
      action: 'channel.approval.answered',
      resource: `approval:${approval.id}`,
      decision: action.decision,
      threadId: approval.threadId,
      turnId: approval.turnId,
      detail: { tier: approval.tier, sender: msg.sender.externalId, via: 'button' },
    });
    await this.#adapters[row.kind]
      ?.settle?.(
        row.id,
        action,
        answeredText(action.decision),
        AbortSignal.timeout(this.#o.sendTimeoutMs ?? 30_000),
      )
      .catch(() => undefined);
    return action.decision;
  }

  async #drop(row: BindingRow, msg: InboundMessage, reason: string): Promise<ReceiveOutcome> {
    await this.#audit(row.account_id, 'system', 'channel.message.dropped', row, {
      reason,
      messageId: msg.messageId,
    });
    return { status: reason === 'own_message' ? 'ignored' : 'dropped', reason, bindingId: row.id };
  }

  async #settle(
    row: BindingRow,
    logId: string,
    msg: InboundMessage,
    status: 'ignored' | 'dropped',
    reason: string,
  ): Promise<ReceiveOutcome> {
    await this.#settleRow(logId, status, reason);
    // Ignored messages (not addressed) are routine; refusals and drops are audited.
    if (reason !== 'not_addressed')
      await this.#audit(row.account_id, 'system', 'channel.message.dropped', row, {
        reason,
        sender: msg.sender.externalId,
      });
    return { status, reason, bindingId: row.id };
  }

  async #settleRow(logId: string, status: string, reason: string | null): Promise<void> {
    await this.#db.transaction(() => {
      this.#db.raw
        .prepare('UPDATE channel_message SET status = ?, reason = ? WHERE id = ?')
        .run(status, reason, logId);
    });
  }

  /** Inbound turns started or outbound messages sent in the last minute and hour. */
  #overRate(row: BindingRow, direction: 'in' | 'out'): boolean {
    const now = this.#now().getTime();
    const status = direction === 'in' ? 'started' : 'sent';
    const count = (since: number) =>
      (
        this.#db.raw
          .prepare(
            `SELECT count(*) AS n FROM channel_message
             WHERE binding_id = ? AND direction = ? AND status = ? AND created_at > ?`,
          )
          .get(row.id, direction, status, new Date(since).toISOString()) as { n: number }
      ).n;
    return count(now - MINUTE) >= row.rate_per_minute || count(now - HOUR) >= row.rate_per_hour;
  }

  async #threadFor(row: BindingRow): Promise<string> {
    let threadId: string | null = null;
    if (this.#resolver) {
      threadId = await this.#resolver({
        accountId: row.account_id,
        agentId: row.agent_id,
        binding: info(row),
      });
    } else {
      if (row.thread_id && this.#threadAlive(row.thread_id)) return row.thread_id;
      if (row.share_primary_thread) {
        // The owner's DM shares the agent's in-app thread.
        const primary = this.#db.raw
          .prepare(
            `SELECT thread_id FROM channel_binding WHERE account_id = ? AND kind = 'inapp'
               AND (agent_id IS ? OR agent_id = ?) AND thread_id IS NOT NULL
             ORDER BY created_at LIMIT 1`,
          )
          .get(row.account_id, row.agent_id, row.agent_id) as { thread_id: string } | undefined;
        if (primary && this.#threadAlive(primary.thread_id)) threadId = primary.thread_id;
      }
      if (!threadId) {
        if (!this.#o.createThread)
          throw new NovaError('capability_missing', 'channel threads cannot be created');
        threadId = await this.#o.createThread(row.account_id, {
          title: `${KIND_LABEL[row.kind]} · ${row.label}`,
          mode: row.agent_id ? 'agent' : 'chat',
        });
      }
    }
    if (threadId !== row.thread_id) {
      await this.#db.transaction(() => {
        this.#db.raw
          .prepare('UPDATE channel_binding SET thread_id = ?, updated_at = ? WHERE id = ?')
          .run(threadId, this.#now().toISOString(), row.id);
      });
      row.thread_id = threadId;
    }
    return threadId;
  }

  #threadAlive(threadId: string): boolean {
    return !!this.#db.raw
      .prepare('SELECT 1 FROM thread WHERE id = ? AND deleted_at IS NULL')
      .get(threadId);
  }

  /** After a channel turn: its reply goes back to the conversation it came from. */
  async #follow(ctx: TurnContext, done: Promise<TurnOutcome>): Promise<void> {
    let outcome: TurnOutcome;
    try {
      outcome = await done;
    } catch (err) {
      this.#o.log?.warn('channel turn failed', { err, bindingId: ctx.bindingId });
      this.#turns.delete(ctx.turnId);
      return;
    }
    this.#turns.delete(ctx.turnId);
    if (outcome.stop === 'cancelled' || outcome.status === 'failed' || !outcome.replyText.trim())
      return;
    await this.#reply(ctx, outcome.replyText, outcome.turnId);
  }

  // ---- outbound -------------------------------------------------------------------------------

  /**
   * ChannelSender (channels/types.ts): deliver a reply of a bound thread to its conversation.
   * Null when the thread has no connected binding or the reply was withheld.
   */
  async replyFor(
    accountId: string,
    threadId: string,
    text: string,
  ): Promise<ChannelReceipt | null> {
    const active = [...this.#turns.values()].reverse().find((c) => c.threadId === threadId);
    if (active) return this.#reply(active, text, null);
    const rows = this.#db.raw
      .prepare(
        `SELECT * FROM channel_binding WHERE account_id = ? AND thread_id = ? AND enabled = 1
           AND kind <> 'inapp'
         ORDER BY last_message_at DESC, created_at LIMIT 1`,
      )
      .all(accountId, threadId) as unknown as BindingRow[];
    const row = rows[0];
    if (!row) return null;
    // Continue in the conversation (and reply thread) of the last message received there.
    const last = this.#db.raw
      .prepare(
        `SELECT conversation, thread_ref, external_id FROM channel_message
         WHERE binding_id = ? AND direction = 'in' AND status = 'started'
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(row.id) as
      | { conversation: string | null; thread_ref: string | null; external_id: string | null }
      | undefined;
    return this.#reply(
      {
        accountId,
        bindingId: row.id,
        threadId,
        turnId: '',
        conversation: last?.conversation ?? row.external_ref,
        threadRef: last?.thread_ref ?? null,
        visibility: effectiveVisibility(row, 'private'),
        replyTo: row.kind === 'email' ? (last?.external_id ?? null) : null,
      },
      text,
      null,
    );
  }

  /** Send to a binding's conversation (notifications, schedule deliveries); throws on failure. */
  async sendTo(
    accountId: string,
    bindingId: string,
    text: string,
    opts: { kinds?: readonly ChannelKind[] } = {},
  ): Promise<ChannelReceipt> {
    const row = this.#row(accountId, bindingId);
    if (opts.kinds && !opts.kinds.includes(row.kind))
      throw new NovaError('validation', `that binding is not a ${opts.kinds.join(' or ')} binding`);
    if (!row.enabled) throw new NovaError('conflict', 'the channel is disconnected');
    if (this.#overRate(row, 'out'))
      throw new NovaError('rate_limited', 'the channel reached its message limit');
    return this.#send(row, { conversation: row.external_ref, text }, row.thread_id);
  }

  /**
   * Notification copies (FR-060): a private binding gets them; a shared one only when the
   * private-to-shared policy is `allow` (a notification cannot ask before each copy).
   */
  async mayNotify(accountId: string, bindingId: string): Promise<boolean> {
    const row = this.#row(accountId, bindingId);
    if (row.kind === 'inapp' || row.audience === 'private') return true;
    return (await this.#o.setting('channels.privateToShared')) === 'allow';
  }

  /** The agent a thread belongs to (the agents area's `agent_thread`), or null. */
  agentOfThread(threadId: string): string | null {
    try {
      const row = this.#db.raw
        .prepare('SELECT agent_id FROM agent_thread WHERE thread_id = ?')
        .get(threadId) as { agent_id: string } | undefined;
      if (row) return row.agent_id;
    } catch {
      // no agents table: fall back to the bindings
    }
    const b = this.#db.raw
      .prepare(
        'SELECT agent_id FROM channel_binding WHERE thread_id = ? AND agent_id IS NOT NULL LIMIT 1',
      )
      .get(threadId) as { agent_id: string } | undefined;
    return b?.agent_id ?? null;
  }

  /** The connected bindings a thread's agent may send to (`channel.send`). */
  sendTargets(accountId: string, threadId: string): ChannelBindingInfo[] {
    const agentId = this.agentOfThread(threadId);
    const rows = this.#db.raw
      .prepare(
        `SELECT * FROM channel_binding WHERE account_id = ? AND enabled = 1 AND kind <> 'inapp'
           AND agent_id IS ? ORDER BY created_at`,
      )
      .all(accountId, agentId) as unknown as BindingRow[];
    return rows.map(info);
  }

  /** A send target by binding id or label (case-insensitive) among `sendTargets`. */
  findTarget(accountId: string, threadId: string, ref: string): ChannelBindingInfo | null {
    const want = ref.trim().toLowerCase();
    const targets = this.sendTargets(accountId, threadId);
    return (
      targets.find((t) => t.id === ref) ??
      targets.find((t) => t.label.toLowerCase() === want || t.externalRef.toLowerCase() === want) ??
      null
    );
  }

  /**
   * An agent's own message to a channel (`channel.send`, after the gate allowed it): the same
   * private-to-shared check, rate cap and receipt as a reply.
   */
  async sendAsAgent(input: {
    accountId: string;
    threadId: string;
    turnId: string | null;
    bindingId: string;
    text: string;
  }): Promise<ChannelReceipt> {
    const row = this.#row(input.accountId, input.bindingId);
    if (!row.enabled) throw new NovaError('conflict', 'the channel is disconnected');
    const ctx: TurnContext = {
      accountId: input.accountId,
      bindingId: row.id,
      // The check compares with the target conversation's own thread, not the sender's.
      threadId: row.thread_id ?? input.threadId,
      turnId: input.turnId ?? '',
      conversation: row.external_ref,
      threadRef: null,
      visibility: effectiveVisibility(row, 'private'),
    };
    if (ctx.visibility === 'shared') {
      const decision = await this.#shareCheck(row, ctx, input.text, input.turnId);
      if (decision !== 'allow') {
        await this.#withhold(row, ctx, input.text, decision);
        throw new NovaError('policy_denied', 'the message uses private content and was not sent');
      }
    }
    if (this.#overRate(row, 'out'))
      throw new NovaError('rate_limited', 'the channel reached its message limit');
    return this.#send(row, { conversation: row.external_ref, text: input.text }, input.threadId);
  }

  async #reply(
    ctx: TurnContext,
    text: string,
    turnId: string | null,
  ): Promise<ChannelReceipt | null> {
    const row = this.#rowById(ctx.bindingId);
    if (!row?.enabled) {
      if (row) await this.#withhold(row, ctx, text, 'disconnected');
      return null;
    }
    if (ctx.visibility === 'shared') {
      const decision = await this.#shareCheck(row, ctx, text, turnId);
      if (decision !== 'allow') {
        await this.#withhold(row, ctx, text, decision);
        // Say that something was held back, never what.
        return this.#send(
          row,
          {
            conversation: ctx.conversation,
            threadRef: ctx.threadRef,
            text: "I can't share that here.",
          },
          ctx.threadId,
        ).catch(() => null);
      }
    }
    if (this.#overRate(row, 'out')) {
      await this.#withhold(row, ctx, text, 'rate_limited');
      return null;
    }
    try {
      return await this.#send(
        row,
        {
          conversation: ctx.conversation,
          threadRef: ctx.threadRef,
          text,
          inReplyTo: ctx.replyTo ?? null,
          subject: ctx.subject ?? null,
        },
        ctx.threadId,
      );
    } catch (err) {
      this.#o.log?.warn('channel reply failed', { err, bindingId: row.id });
      return null;
    }
  }

  /**
   * The private-to-shared policy check (docs/13 §4): `allow` when the reply carries no private
   * content or the policy allows it; otherwise the setting decides (default ask the owner).
   */
  async #shareCheck(
    row: BindingRow,
    ctx: TurnContext,
    text: string,
    turnId: string | null,
  ): Promise<'allow' | 'denied' | 'not_allowed'> {
    let sources: PrivateSource[];
    try {
      sources = await this.#privacy({
        accountId: row.account_id,
        agentId: row.agent_id,
        threadId: ctx.threadId,
        turnId,
        text,
      });
    } catch (err) {
      // Fail closed: an unknown origin is treated as private.
      this.#o.log?.warn('private content check failed', { err });
      sources = [{ kind: 'thread', id: 'unknown' }];
    }
    if (!sources.length) return 'allow';
    const policy = await this.#o.setting('channels.privateToShared');
    let decision: 'allow' | 'deny' = policy === 'allow' ? 'allow' : 'deny';
    let by = 'policy';
    if (policy === 'ask') {
      by = 'owner';
      decision = this.#ask
        ? await this.#ask({
            accountId: row.account_id,
            threadId: ctx.threadId,
            bindingId: row.id,
            label: row.label,
            sources,
          }).catch(() => 'deny' as const)
        : 'deny';
    }
    await this.#o.audit?.append({
      accountId: row.account_id,
      actor: by === 'owner' ? 'user' : 'system',
      kind: 'channel',
      action: 'channel.share.check',
      resource: `channel_binding:${row.id}`,
      decision,
      threadId: ctx.threadId,
      turnId: turnId ?? null,
      inputHash: sha256Hex(text),
      detail: { policy, sources: sources.map((s) => `${s.kind}:${s.id}`) },
    });
    if (decision === 'allow') return 'allow';
    return policy === 'ask' ? 'denied' : 'not_allowed';
  }

  async #withhold(row: BindingRow, ctx: TurnContext, text: string, reason: string): Promise<void> {
    await this.#record(row, {
      id: uuidv7(),
      direction: 'out',
      externalId: null,
      conversation: ctx.conversation,
      threadRef: ctx.threadRef,
      sender: null,
      status: 'withheld',
      reason,
      text,
      threadId: ctx.threadId,
    });
  }

  async #send(
    row: BindingRow,
    message: NovaOutboundMessage,
    threadId: string | null,
  ): Promise<ChannelReceipt> {
    const adapter = this.#adapter(row.kind);
    // Nothing leaves the Hub unredacted.
    message = {
      ...message,
      text: (this.#o.redactor ?? defaultRedactor).redactString(message.text),
    };
    let receipt: ChannelReceipt;
    try {
      receipt = await adapter.send(
        row.id,
        message,
        AbortSignal.timeout(this.#o.sendTimeoutMs ?? 30_000),
      );
    } catch (err) {
      await this.#record(row, {
        id: uuidv7(),
        direction: 'out',
        externalId: null,
        conversation: message.conversation,
        threadRef: message.threadRef ?? null,
        sender: null,
        status: 'failed',
        reason: errText(err).slice(0, 500),
        text: message.text,
        threadId,
      });
      throw err;
    }
    await this.#record(row, {
      id: uuidv7(),
      direction: 'out',
      externalId: receipt.id,
      conversation: message.conversation,
      threadRef: message.threadRef ?? null,
      sender: null,
      status: 'sent',
      reason: null,
      text: message.text,
      threadId,
    });
    await this.#o.events.emit({
      name: 'channel.message.sent',
      accountId: row.account_id,
      actor: 'system',
      ...(threadId ? { correlation: { threadId } } : {}),
      payload: { bindingId: row.id, to: message.conversation, threadId },
    });
    return receipt;
  }

  /** Insert a message row; false when the same external id was recorded before (dedupe). */
  async #record(
    row: BindingRow,
    m: {
      id: string;
      direction: 'in' | 'out';
      externalId: string | null;
      conversation: string | null;
      threadRef: string | null;
      sender: string | null;
      status: string;
      reason: string | null;
      text: string;
      threadId?: string | null;
    },
  ): Promise<boolean> {
    const changes = await this.#db.transaction(() =>
      Number(
        this.#db.raw
          .prepare(
            `INSERT OR IGNORE INTO channel_message (id, binding_id, account_id, direction, external_id,
               conversation, thread_ref, sender, thread_id, turn_id, status, reason, text_hash,
               created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
          )
          .run(
            m.id,
            row.id,
            row.account_id,
            m.direction,
            m.externalId,
            m.conversation,
            m.threadRef,
            m.sender,
            m.threadId ?? null,
            m.status,
            m.reason,
            sha256Hex(m.text),
            this.#now().toISOString(),
          ).changes,
      ),
    );
    return changes > 0;
  }

  // ---- approvals from channels ----------------------------------------------------------------

  /**
   * `approval.requested` for a thread: when a channel turn of that thread is waiting, post the
   * approval to its conversation (docs/13 §4).
   */
  async onApprovalRequested(e: {
    accountId: string;
    threadId: string | null;
    turnId: string | null;
    approvalId: string;
  }): Promise<void> {
    if (!e.threadId) return;
    const ctx =
      (e.turnId ? this.#turns.get(e.turnId) : undefined) ??
      [...this.#turns.values()].reverse().find((c) => c.threadId === e.threadId);
    if (!ctx || ctx.accountId !== e.accountId) return;
    const row = this.#rowById(ctx.bindingId);
    if (!row?.enabled || row.kind === 'inapp' || !this.#approvals) return;
    let approval: ApprovalView;
    try {
      approval = await this.#approvals.get(e.accountId, e.approvalId);
    } catch {
      return;
    }
    const adapter = this.#adapter(row.kind);
    const shared = ctx.visibility === 'shared';
    const answerable = answerableFromChannel(approval.tier, approval.answerIn ?? null);
    const options = approval.options.filter((o): o is ChannelAction['decision'] =>
      CHANNEL_DECISIONS.has(o),
    );
    const base = { conversation: ctx.conversation, threadRef: ctx.threadRef };
    let message: NovaOutboundMessage;
    if (adapter.textAnswers === false) {
      // Email: a signed one-use link, and only to the owner's own private conversation (a link
      // is a capability; a shared mailbox or list must never get one).
      const link =
        answerable &&
        options.length &&
        !shared &&
        row.audience === 'private' &&
        ctx.role === 'owner'
          ? await this.#approvalLink(row, approval).catch((err: unknown) => {
              this.#o.log?.warn('approval link not made', { err });
              return null;
            })
          : null;
      message = {
        ...base,
        text: approvalEmailText(approval, { shared, link: !!link }),
        inReplyTo: ctx.replyTo ?? null,
        subject: ctx.subject ?? null,
        ...(link
          ? { approval: { id: approval.id, code: approvalCode(approval.id), options, link } }
          : {}),
      };
    } else {
      const buttons: OutboundApproval | null =
        answerable && options.length && adapter.settle
          ? { id: approval.id, code: approvalCode(approval.id), options }
          : null;
      message = {
        ...base,
        text: approvalPrompt(approval, { shared }),
        ...(buttons ? { approval: buttons } : {}),
      };
    }
    await this.#send(row, message, ctx.threadId).catch((err: unknown) =>
      this.#o.log?.warn('approval prompt not delivered', { err }),
    );
  }

  /** A signed approval link at the public Hub address, valid until the approval or the setting ends. */
  async #approvalLink(row: BindingRow, approval: ApprovalView): Promise<string | null> {
    if (!this.#o.publicBase) return null;
    const minutes = await this.#o.setting('channels.approvalLinkMinutes');
    const until = Math.min(
      Date.parse(approval.expiresAt) || Infinity,
      this.#now().getTime() + minutes * 60_000,
    );
    const token = await this.#links.create({
      accountId: row.account_id,
      bindingId: row.id,
      approvalId: approval.id,
      expiresAt: new Date(until),
    });
    const base = (await this.#o.publicBase()).replace(/\/+$/, '');
    return `${base}/api/v1/channels/approval-links/${token}`;
  }

  /**
   * What a signed approval link would answer (its GET page; nothing changes). Any problem is
   * `not_found`, so a guessed or spent link learns nothing.
   */
  async approvalLinkView(token: string): Promise<{
    action: string;
    reason: string | null;
    label: string;
    options: ChannelAction['decision'][];
    expiresAt: string;
  }> {
    const { approval, row, link } = await this.#openLink(token);
    return {
      action: approval.action,
      reason: approval.reason || null,
      label: row.label,
      options: approval.options.filter((o): o is ChannelAction['decision'] =>
        CHANNEL_DECISIONS.has(o),
      ),
      expiresAt: link.expires_at,
    };
  }

  async #openLink(token: string, answering = false) {
    const gone = () => new NovaError('not_found', 'this approval link is not valid any more');
    const link = await this.#links.open(token);
    const row = this.#rowById(link.binding_id);
    if (!row?.enabled || row.audience !== 'private' || !this.#approvals) throw gone();
    let approval: ApprovalView;
    try {
      approval = await this.#approvals.get(link.account_id, link.approval_id);
    } catch {
      throw gone();
    }
    if (approval.status !== 'pending' || approval.decision !== null) throw gone();
    if (approval.answerIn === 'hub') {
      // A Hub-only card never gets a link; one made earlier answers nothing (docs/23 §6.3).
      if (answering)
        await this.#o.audit?.append({
          accountId: row.account_id,
          actor: `channel:${row.id}`,
          kind: 'channel',
          action: 'channel.approval.refused',
          resource: `approval:${approval.id}`,
          threadId: approval.threadId,
          turnId: approval.turnId,
          detail: { reason: 'hub_only', via: 'link', tier: approval.tier },
        });
      throw gone();
    }
    if (!answerableFromChannel(approval.tier)) throw gone();
    return { link, row, approval };
  }

  /** Answer an approval with its signed link (once): the POST from the link's page. */
  async answerByLink(token: string, decision: string): Promise<{ decision: string; text: string }> {
    const { link, row, approval } = await this.#openLink(token, true);
    if (!CHANNEL_DECISIONS.has(decision) || !approval.options.includes(decision as never))
      throw new NovaError('validation', 'that choice is not offered for this approval', {
        details: { field: 'decision' },
      });
    const choice = decision as ChannelAction['decision'];
    // Spent before deciding, so two posts of one link cannot both answer.
    if (!(await this.#links.spend(link.id, choice)))
      throw new NovaError('not_found', 'this approval link is not valid any more');
    try {
      await this.#approvals!.decide(
        row.account_id,
        { approvalId: approval.id, decision: choice },
        `channel:${row.id}`,
      );
    } catch (err) {
      await this.#o.audit?.append({
        accountId: row.account_id,
        actor: `channel:${row.id}`,
        kind: 'channel',
        action: 'channel.approval.refused',
        resource: `approval:${approval.id}`,
        decision: choice,
        threadId: approval.threadId,
        turnId: approval.turnId,
        detail: { reason: 'rejected', via: 'link', tier: approval.tier },
      });
      throw err;
    }
    await this.#o.audit?.append({
      accountId: row.account_id,
      actor: `channel:${row.id}`,
      kind: 'channel',
      action: 'channel.approval.answered',
      resource: `approval:${approval.id}`,
      decision: choice,
      threadId: approval.threadId,
      turnId: approval.turnId,
      detail: { tier: approval.tier, via: 'link' },
    });
    return { decision: choice, text: answeredText(choice) };
  }

  // ---- message log (M6 known gap) -------------------------------------------------------------

  /** A binding's messages, newest first. The log holds no text (the thread has it). */
  messages(accountId: string, bindingId: string, q: ChannelMessagesQuery): ChannelMessageView[] {
    return this.messagesPage(accountId, bindingId, q).items;
  }

  /**
   * A page of a binding's messages, newest first (M7): `nextCursor` names the position after the
   * last one (its time and id), so messages sharing a timestamp at a page boundary are never
   * skipped, which `before` (strictly older) can do.
   */
  messagesPage(
    accountId: string,
    bindingId: string,
    q: ChannelMessagesQuery,
  ): ChannelMessagesPageView {
    this.#row(accountId, bindingId);
    const where = ['binding_id = ?'];
    const params: (string | number)[] = [bindingId];
    if (q.direction) {
      where.push('direction = ?');
      params.push(q.direction);
    }
    if (q.status) {
      where.push('status = ?');
      params.push(q.status);
    }
    if (q.before) {
      where.push('created_at < ?');
      params.push(new Date(q.before).toISOString());
    }
    if (q.cursor) {
      const after = afterTimeCursor(q.cursor);
      where.push(after.sql);
      params.push(...after.args);
    }
    const rows = this.#db.raw
      .prepare(
        `SELECT * FROM channel_message WHERE ${where.join(' AND ')}
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(...params, q.limit + 1) as {
      id: string;
      binding_id: string;
      direction: 'in' | 'out';
      external_id: string | null;
      conversation: string | null;
      thread_ref: string | null;
      sender: string | null;
      thread_id: string | null;
      turn_id: string | null;
      status: ChannelMessageView['status'];
      reason: string | null;
      created_at: string;
    }[];
    const items = rows.slice(0, q.limit);
    const last = items.at(-1);
    return {
      items: items.map((r) => ({
        id: r.id,
        bindingId: r.binding_id,
        direction: r.direction,
        externalId: r.external_id,
        conversation: r.conversation,
        threadRef: r.thread_ref,
        sender: r.sender,
        threadId: r.thread_id,
        turnId: r.turn_id,
        status: r.status,
        reason: r.reason,
        createdAt: r.created_at,
      })),
      nextCursor: rows.length > q.limit && last ? encodeTimeCursor(last.created_at, last.id) : null,
    };
  }

  /** A reply that answers a pending approval of the binding's thread; the outcome, or null. */
  async #maybeAnswer(
    row: BindingRow,
    msg: InboundMessage,
    role: ChannelRole | 'guest',
  ): Promise<string | null> {
    const answer = parseAnswer(msg.text);
    if (!answer || !row.thread_id || !this.#approvals) return null;
    const pending = (await this.#approvals.pending(row.account_id, row.thread_id)).filter(
      (a) => a.status === 'pending' && a.decision === null,
    );
    const match = answer.code
      ? pending.filter((a) => approvalCode(a.id) === answer.code)
      : pending.length === 1
        ? pending
        : [];
    const approval = match[0];
    if (!approval || match.length > 1) return null;
    const respond = (text: string) =>
      this.#send(
        row,
        { conversation: msg.conversation, threadRef: msg.threadRef, text },
        row.thread_id,
      ).catch(() => null);
    const refuse = async (reason: string, text: string) => {
      await this.#o.audit?.append({
        accountId: row.account_id,
        actor: `channel:${row.id}`,
        kind: 'channel',
        action: 'channel.approval.refused',
        resource: `approval:${approval.id}`,
        decision: answer.decision,
        threadId: approval.threadId,
        turnId: approval.turnId,
        detail: { reason, tier: approval.tier, sender: msg.sender.externalId },
      });
      await respond(text);
      return `refused:${reason}`;
    };
    if (approval.answerIn === 'hub') return refuse('hub_only', HUB_ONLY_TEXT);
    // Email: reply text never answers (a From address is easy to forge); the signed link does.
    if (this.#adapters[row.kind]?.textAnswers === false)
      return refuse(
        'link_required',
        'Approvals sent by email are answered with the link in the approval email.',
      );
    if (role !== 'owner') return refuse('not_owner', 'Only the owner can answer approvals.');
    if (!answerableFromChannel(approval.tier))
      return refuse('native_client_only', 'This approval can only be answered in Nova.');
    if (!approval.options.includes(answer.decision))
      return refuse('not_offered', 'That choice is not offered for this approval.');
    try {
      await this.#approvals.decide(
        row.account_id,
        {
          approvalId: approval.id,
          decision: answer.decision,
          ...(answer.reason ? { reason: answer.reason } : {}),
        },
        `channel:${row.id}`,
      );
    } catch (err) {
      return refuse('rejected', `The answer was not accepted: ${errText(err)}`);
    }
    await this.#o.audit?.append({
      accountId: row.account_id,
      actor: `channel:${row.id}`,
      kind: 'channel',
      action: 'channel.approval.answered',
      resource: `approval:${approval.id}`,
      decision: answer.decision,
      threadId: approval.threadId,
      turnId: approval.turnId,
      detail: { tier: approval.tier, sender: msg.sender.externalId },
    });
    await respond(answeredText(answer.decision));
    return answer.decision;
  }

  // ---- housekeeping ---------------------------------------------------------------------------

  #track(p: Promise<unknown>): void {
    const tracked = p.catch((err: unknown) => this.#o.log?.warn('channel task failed', { err }));
    this.#pending.add(tracked);
    void tracked.finally(() => this.#pending.delete(tracked));
  }

  /** Wait for background replies (tests). */
  async idle(): Promise<void> {
    while (this.#pending.size) await Promise.all([...this.#pending]);
  }

  async close(): Promise<void> {
    this.#turns.clear();
    await Promise.race([this.idle(), new Promise((r) => setTimeout(r, 5_000).unref())]);
  }

  async #audit(
    accountId: string,
    actor: string,
    action: string,
    row: BindingRow,
    detail: Record<string, unknown>,
  ): Promise<void> {
    await this.#o.audit?.append({
      accountId,
      actor,
      kind: 'channel',
      action,
      resource: `channel_binding:${row.id}`,
      threadId: row.thread_id,
      detail: { kind: row.kind, ...detail },
    });
  }

  async #changed(row: BindingRow, change: string): Promise<void> {
    for (const l of this.#listeners) {
      try {
        l({ bindingId: row.id, kind: row.kind });
      } catch (err) {
        this.#o.log?.warn('binding listener failed', { err });
      }
    }
    await this.#o.events.emit({
      name: 'channel.binding.changed',
      accountId: row.account_id,
      actor: 'user',
      ...(row.agent_id ? { correlation: { agentId: row.agent_id } } : {}),
      payload: { bindingId: row.id, kind: row.kind, change },
    });
  }
}

interface IdentityRow {
  id: string;
  account_id: string;
  kind: ChannelKindM7;
  external_id: string;
  display_name: string | null;
  role: ChannelRole;
  created_at: string;
}

function identityView(r: IdentityRow): ChannelIdentityViewM7 {
  return {
    id: r.id,
    kind: r.kind,
    externalId: r.external_id,
    displayName: r.display_name,
    role: r.role,
    createdAt: r.created_at,
  };
}

function info(r: BindingRow): ChannelBindingInfo {
  return {
    id: r.id,
    kind: r.kind,
    label: r.label,
    externalRef: r.external_ref,
    audience: r.audience,
    sharePrimaryThread: r.share_primary_thread === 1,
    threadId: r.thread_id,
  };
}

/** Shared when the binding or the message says so (the stricter of the two). */
function effectiveVisibility(row: BindingRow, said: 'private' | 'shared'): 'private' | 'shared' {
  return row.audience === 'shared' || said === 'shared' ? 'shared' : 'private';
}

function framed(
  row: BindingRow,
  msg: InboundMessage,
  who: string,
  role: ChannelRole | 'guest',
  visibility: 'private' | 'shared',
): string {
  const where =
    visibility === 'private'
      ? `a direct message on ${KIND_LABEL[row.kind]}`
      : `${KIND_LABEL[row.kind]} (${row.label}, a shared conversation)`;
  const tag = role === 'owner' ? 'the owner' : role === 'member' ? 'a known member' : 'a guest';
  return `${who} (${tag}) wrote in ${where}:\n${msg.text}`;
}

function defaultLabel(kind: ChannelKind, externalRef: string): string {
  return kind === 'inapp' ? 'In-app' : `${KIND_LABEL[kind]} ${externalRef}`.slice(0, 200);
}

function fieldError(field: string, message: string): NovaError {
  return new NovaError('validation', message, { details: { field } });
}

/** An email binding's mailbox settings: both servers, and TLS unless on this machine. */
function mailboxCheck(config: Record<string, string | null | undefined>): void {
  if (!config.address || !config.imapHost || !config.smtpHost)
    throw fieldError(
      'config',
      'an email binding needs its mailbox: address, imapHost and smtpHost',
    );
  const sec = (v: string | null | undefined) =>
    v === 'starttls' || v === 'none' ? v : ('tls' as 'tls' | 'starttls' | 'none');
  assertSecure({ host: config.imapHost, security: sec(config.imapSecurity) }, 'IMAP');
  assertSecure({ host: config.smtpHost, security: sec(config.smtpSecurity) }, 'SMTP');
  if (config.authservId && !/^[a-z0-9.-]{1,253}$/i.test(config.authservId))
    throw fieldError('config.authservId', 'the authserv-id is a host name');
}

/** `senderCheck: none` takes every From address as it says: it must be confirmed. */
function senderCheckOff(): NovaError {
  return new NovaError(
    'validation',
    'turning the sender check off trusts every From address; confirm it with confirmSenderCheckNone',
    { details: { field: 'confirmSenderCheckNone', reason: 'confirm_required' } },
  );
}
