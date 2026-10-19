// Slack adapter (FR-088, docs/13 §4): Events API deliveries in, chat.postMessage out. Every
// delivery must carry the app's signing signature (`v0=` HMAC-SHA256 over `v0:<ts>:<body>`) and
// a timestamp inside the five-minute replay window. Direct messages are private, everything else
// is shared; a DM or a mention of the bot addresses the agent. Messages written by bots (the
// agent's own replies included) and edits are never returned, so they cannot start a turn. The
// bot token and signing secret come from the secret store on each use. Since M7 approval prompts
// carry buttons; a press arrives as a signed interaction payload (form-encoded, same signature,
// at the same inbound URL) naming the user who pressed it, and the prompt is then updated.
import { uuidv7 } from '@nova/shared';
import type { ChannelReceipt } from '../types.ts';
import { freshTimestamp, hmacHex, headerOf, safeEqual, unauthorized } from '../signing.ts';
import {
  jsonBody,
  notConfigured,
  obj,
  sendFailed,
  str,
  type AdapterProbe,
  type BindingCredentials,
  type ChannelAction,
  type FetchLike,
  type NovaChannelAdapter,
  type NovaInboundMessage,
  type NovaOutboundMessage,
} from './common.ts';

export const SLACK_API = 'https://slack.com/api';

export interface SlackAdapterOptions {
  credentials: BindingCredentials;
  /** The Web API base (tests point it at a mock server). */
  apiBase?: string;
  fetch?: FetchLike;
  now?: () => Date;
}

/** Message subtypes that are still a person writing (others are edits, joins, bots). */
const PERSON_SUBTYPES = new Set(['thread_broadcast', 'file_share']);

/** Slack escapes &, < and > in message text. */
function decode(text: string): string {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function encode(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const LETTERS: Record<ChannelAction['decision'], string> = {
  allow_once: 'o',
  allow_session: 's',
  deny_continue: 'd',
  deny_stop: 'x',
};
const BUTTONS: Record<ChannelAction['decision'], { text: string; style?: 'primary' | 'danger' }> = {
  allow_once: { text: 'Allow', style: 'primary' },
  allow_session: { text: 'Allow for session' },
  deny_continue: { text: 'Deny', style: 'danger' },
  deny_stop: { text: 'Deny and stop', style: 'danger' },
};
const BUTTON_VALUE = /^nova:a:([0-9a-f-]{36}):([osdx])$/;

/** The Block Kit message of an approval prompt: its text and one button per offered decision. */
function approvalBlocks(text: string, approval: NonNullable<NovaOutboundMessage['approval']>) {
  return [
    { type: 'section', text: { type: 'mrkdwn', text: encode(text).slice(0, 2900) } },
    {
      type: 'actions',
      block_id: `nova_approval_${approval.code}`,
      elements: approval.options.map((d) => ({
        type: 'button',
        action_id: `nova_approval_${LETTERS[d]}`,
        text: { type: 'plain_text', text: BUTTONS[d].text },
        value: `nova:a:${approval.id}:${LETTERS[d]}`,
        ...(BUTTONS[d].style ? { style: BUTTONS[d].style } : {}),
      })),
    },
  ];
}

export class SlackAdapter implements NovaChannelAdapter {
  readonly kind = 'slack' as const;
  readonly credentialNames = ['botToken', 'signingSecret'] as const;
  readonly #creds: BindingCredentials;
  readonly #api: string;
  readonly #fetch: FetchLike;
  readonly #now: () => Date;

  constructor(opts: SlackAdapterOptions) {
    this.#creds = opts.credentials;
    this.#api = (opts.apiBase ?? SLACK_API).replace(/\/+$/, '');
    this.#fetch = opts.fetch ?? ((input, init) => fetch(input, init));
    this.#now = opts.now ?? (() => new Date());
  }

  async parse(input: {
    bindingId: string;
    headers: Record<string, string | undefined>;
    rawBody: Uint8Array;
  }): Promise<NovaInboundMessage | null> {
    const secret = await this.#creds.secret(input.bindingId, 'signingSecret');
    if (!secret) throw unauthorized('no signing secret is configured');
    const ts = headerOf(input.headers, 'x-slack-request-timestamp');
    const sig = headerOf(input.headers, 'x-slack-signature');
    if (!ts || !sig) throw unauthorized('missing signature');
    if (!/^\d{1,12}$/.test(ts) || !freshTimestamp(ts, this.#now().getTime()))
      throw unauthorized('stale timestamp');
    const base = Buffer.concat([Buffer.from(`v0:${ts}:`), Buffer.from(input.rawBody)]);
    if (!safeEqual(`v0=${hmacHex(secret, base)}`, sig)) throw unauthorized('bad signature');

    const interaction = interactionOf(input.rawBody);
    if (interaction) return this.#interaction(interaction);
    const body = jsonBody(input.rawBody);
    if (body.type !== 'event_callback') return null;
    const ev = obj(body.event);
    if (ev.type !== 'message' && ev.type !== 'app_mention') return null;
    const subtype = str(ev.subtype);
    if (subtype && !PERSON_SUBTYPES.has(subtype)) return null;
    // Loop prevention: nothing a bot wrote (our own replies included) is a message to answer.
    if (ev.bot_id !== undefined || ev.bot_profile !== undefined) return null;
    const user = str(ev.user);
    const channel = str(ev.channel);
    const ts2 = str(ev.ts);
    if (!user || !channel || !ts2) return null;
    const config = await this.#creds.config(input.bindingId);
    const botUserId = config.botUserId ?? null;
    if (botUserId && user === botUserId) return null;

    const raw = decode(typeof ev.text === 'string' ? ev.text : '');
    const direct = ev.channel_type === 'im';
    const mention = botUserId ? `<@${botUserId}>` : null;
    const mentioned = ev.type === 'app_mention' || (mention !== null && raw.includes(mention));
    const text = (mention ? raw.split(mention).join(' ') : raw).replace(/\s+/g, ' ').trim();
    return {
      kind: 'slack',
      conversation: channel,
      visibility: direct ? 'private' : 'shared',
      sender: { externalId: user, displayName: null },
      addressed: direct || mentioned,
      text,
      // A mention arrives as both `message` and `app_mention`; the ts identifies the message.
      messageId: `${channel}:${ts2}`,
      threadRef: str(ev.thread_ts) ?? (direct ? null : ts2),
      receivedAt: this.#now().toISOString(),
    };
  }

  /** A button press on an approval prompt (`block_actions`), after the signature check. */
  #interaction(p: Record<string, unknown>): NovaInboundMessage | null {
    if (p.type !== 'block_actions') return null;
    const action = obj(Array.isArray(p.actions) ? p.actions[0] : null);
    const m = BUTTON_VALUE.exec(str(action.value) ?? '');
    const user = str(obj(p.user).id);
    const channel = str(obj(p.channel).id) ?? str(obj(p.container).channel_id);
    const message = obj(p.message);
    const ts = str(message.ts) ?? str(obj(p.container).message_ts);
    const actionTs = str(action.action_ts);
    if (!m || !user || !channel || !ts || !actionTs) return null;
    const decision = (Object.keys(LETTERS) as ChannelAction['decision'][]).find(
      (d) => LETTERS[d] === m[2],
    )!;
    return {
      kind: 'slack',
      conversation: channel,
      visibility: channel.startsWith('D') ? 'private' : 'shared',
      sender: { externalId: user, displayName: str(obj(p.user).name) },
      addressed: true,
      text: '',
      messageId: `${channel}:act:${user}:${actionTs}`,
      threadRef: str(message.thread_ts),
      receivedAt: this.#now().toISOString(),
      action: {
        kind: 'approval',
        approvalId: m[1]!,
        decision,
        ref: { channel, ts, user },
        promptText: typeof message.text === 'string' ? decode(message.text) : null,
      },
    };
  }

  /** Replace the prompt's buttons with the outcome. */
  async settle(
    bindingId: string,
    action: ChannelAction,
    outcome: string,
    signal: AbortSignal,
  ): Promise<void> {
    const { channel, ts } = action.ref;
    if (!channel || !ts) return;
    const text = action.promptText ? `${action.promptText}\n${outcome}` : outcome;
    await this.#call(
      bindingId,
      'chat.update',
      {
        channel,
        ts,
        text: encode(text),
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: encode(text).slice(0, 2900) } }],
      },
      signal,
    ).catch(() => undefined);
  }

  /** Tell only the person who pressed a button that their answer did not count. */
  async refuse(
    bindingId: string,
    action: ChannelAction,
    text: string,
    signal: AbortSignal,
  ): Promise<void> {
    const { channel, user } = action.ref;
    if (!channel || !user) return;
    await this.#call(
      bindingId,
      'chat.postEphemeral',
      { channel, user, text: encode(text) },
      signal,
    ).catch(() => undefined);
  }

  /** The URL verification Slack sends when the Request URL is set (after the signature check). */
  handshake(rawBody: Uint8Array): Record<string, unknown> | null {
    try {
      const body = jsonBody(rawBody);
      if (body.type === 'url_verification' && typeof body.challenge === 'string')
        return { challenge: body.challenge };
    } catch {
      // not JSON: no handshake
    }
    return null;
  }

  async send(
    bindingId: string,
    message: NovaOutboundMessage,
    signal: AbortSignal,
  ): Promise<ChannelReceipt> {
    const res = await this.#call(
      bindingId,
      'chat.postMessage',
      {
        channel: message.conversation,
        text: encode(message.text),
        ...(message.threadRef ? { thread_ts: message.threadRef } : {}),
        ...(message.approval?.options.length
          ? { blocks: approvalBlocks(message.text, message.approval) }
          : {}),
      },
      signal,
    );
    const ts = str(res.ts);
    return { id: ts ?? `slack:${uuidv7()}`, at: this.#now().toISOString() };
  }

  /** `auth.test`: the token works; learns the bot user id (mentions, loop prevention) and team. */
  async probe(bindingId: string, signal: AbortSignal): Promise<AdapterProbe> {
    try {
      const res = await this.#call(bindingId, 'auth.test', {}, signal);
      const learned: Record<string, string> = {};
      const userId = str(res.user_id);
      const team = str(res.team_id);
      if (userId) learned.botUserId = userId;
      if (team) learned.teamId = team;
      return { ok: true, detail: `connected as ${str(res.user) ?? userId ?? 'the bot'}`, learned };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  async #call(
    bindingId: string,
    method: string,
    payload: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const token = await this.#creds.secret(bindingId, 'botToken');
    if (!token) throw notConfigured('the Slack bot token');
    let res: Response;
    try {
      res = await this.#fetch(`${this.#api}/${method}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify(payload),
        signal,
        redirect: 'error',
      });
    } catch (err) {
      throw sendFailed(`Slack ${method}`, err instanceof Error ? err.message : String(err));
    }
    let body: Record<string, unknown> = {};
    try {
      body = obj(await res.json());
    } catch {
      // handled below
    }
    if (!res.ok || body.ok !== true)
      throw sendFailed(`Slack ${method}`, str(body.error) ?? `HTTP ${res.status}`);
    return body;
  }
}

/** A form-encoded interaction delivery (`payload=<json>`), or null for an Events API body. */
function interactionOf(rawBody: Uint8Array): Record<string, unknown> | null {
  const text = Buffer.from(rawBody).toString('utf8');
  if (!text.startsWith('payload=')) return null;
  const payload = new URLSearchParams(text).get('payload');
  if (!payload) return null;
  try {
    const v = JSON.parse(payload) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
