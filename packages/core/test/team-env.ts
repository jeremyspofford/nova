// Shared set-up of the team tests (FR-217, FR-091, FR-113; decision 5): a tool environment whose
// gate records every call, the team services over it, and helpers to add people of the Hub.
import { EventBus, makeEvent, type EventEnvelope, type NewEvent } from '@nova/shared';
import type { NovaDatabase } from '@nova/storage';
import {
  SharedThreadService,
  TeamService,
  allowAllGate,
  type GateRequest,
  type TeamSessions,
  type ToolGate,
} from '../src/index.ts';
import { ACCOUNT, makeToolEnv, type ToolEnv, type ToolEnvOptions } from './helpers.ts';

/** Migration 0037_team made the team tables (a missing table is a broken build, not a skip). */
export function ensureTeamTables(db: NovaDatabase): void {
  const has = db.raw
    .prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'team_member'")
    .get();
  if (!has) throw new Error('migration 0037_team is missing');
}

export interface GateCall {
  accountId: string;
  threadId: string;
  tool: string;
  userInstruction: string | null;
}

export interface TeamEnv extends ToolEnv {
  team: TeamService;
  shared: SharedThreadService;
  gateCalls: GateCall[];
  /** Every event as the Hub's bus would carry it (with its account). */
  bus: EventBus;
  envelopes: EventEnvelope[];
  sessions: { issued: string[]; revoked: string[] };
  /** Add a member (a new account) and return its id. */
  addMember(name: string): Promise<string>;
}

/** A gate that allows everything and records who asked, for what, with which instruction. */
export function recordingGate(calls: GateCall[], inner: ToolGate = allowAllGate): ToolGate {
  const note = (req: Omit<GateRequest, 'callId' | 'turnId' | 'argsPreview'>) =>
    calls.push({
      accountId: req.accountId,
      threadId: req.threadId,
      tool: req.tool.name,
      userInstruction: req.provenance.userInstruction?.messageId ?? null,
    });
  return {
    check: (req, signal) => {
      note(req);
      return inner.check(req, signal);
    },
    preview: (req) => inner.preview(req),
  };
}

export async function makeTeamEnv(opts: ToolEnvOptions = {}): Promise<TeamEnv> {
  const gateCalls: GateCall[] = [];
  const env = await makeToolEnv({ ...opts, gate: recordingGate(gateCalls, opts.gate) });
  ensureTeamTables(env.db);
  // The memory sink keeps no account; tap it into a bus of full envelopes, as the Hub's store.
  const bus = new EventBus();
  const envelopes: EventEnvelope[] = [];
  const emit = env.events.emit.bind(env.events);
  const ephemeral = env.events.emitEphemeral.bind(env.events);
  const tap = (e: NewEvent<Record<string, unknown>>) => {
    const full = makeEvent(e);
    envelopes.push(full);
    bus.publish(full);
  };
  env.events.emit = <P extends Record<string, unknown>>(e: NewEvent<P>) => {
    const out = emit(e);
    tap(e);
    return out;
  };
  env.events.emitEphemeral = <P extends Record<string, unknown>>(e: NewEvent<P>) => {
    const out = ephemeral(e);
    tap(e);
    return out;
  };
  const issued: string[] = [];
  const revoked: string[] = [];
  const sessions: TeamSessions = {
    issue: (accountId) => {
      issued.push(accountId);
      return Promise.resolve({ token: `session-${issued.length}`, maxAgeS: 60 });
    },
    revokeAll: (accountId) => {
      revoked.push(accountId);
      return Promise.resolve(1);
    },
  };
  const team = new TeamService({ db: env.db, events: env.events, sessions });
  const shared = new SharedThreadService({
    db: env.db,
    events: env.events,
    threads: env.threads,
    team,
  });
  shared.start(bus);
  env.chat.useAccess(shared.access);
  const addMember = async (name: string) => {
    const inv = await team.createInvitation(ACCOUNT, {}, 'http://hub.test');
    const out = await team.redeem(inv.token, name);
    await env.registry.ensureDefaultProvider(out.accountId);
    return out.accountId;
  };
  return {
    ...env,
    team,
    shared,
    gateCalls,
    bus,
    envelopes,
    sessions: { issued, revoked },
    addMember,
  };
}

type Part = { type: string; text?: string };
const textOf = (p: Part) => (p.type === 'text' ? (p.text ?? '') : '');

/** The system prompt of a recorded request. */
export function systemText(req: { messages: { role: string; content: Part[] }[] }): string {
  const sys = req.messages.find((m) => m.role === 'system');
  return (sys?.content ?? []).map(textOf).join('');
}

/** Every text the model was sent, all messages. */
export function allText(req: { messages: { content: Part[] }[] }): string {
  return req.messages
    .flatMap((m) => m.content)
    .map(textOf)
    .join('\n');
}
