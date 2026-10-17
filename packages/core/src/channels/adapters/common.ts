// What the channels area gives its adapters, and what it asks of them beyond the seam
// (channels/types.ts): credential lookup by binding, a probe for connect and test, and the
// handshake answers some services expect before they send messages.
import { NovaError } from '@nova/shared';
import type { ChannelAdapter } from '../types.ts';

/** Credentials and settings of a binding; secrets come from the secret store on each use. */
export interface BindingCredentials {
  /** A secret of the binding (bot token, signing secret), or null when none is stored. */
  secret(bindingId: string, name: string): Promise<string | null>;
  /** The binding's settings without secrets. */
  config(bindingId: string): Promise<Record<string, string | null>>;
  /** Remember a setting learned from a verified request (a Teams service URL). */
  remember(bindingId: string, key: string, value: string): Promise<void>;
}

export interface AdapterProbe {
  ok: boolean;
  detail: string;
  /** Settings the probe learned (Slack bot user id and team); stored on the binding. */
  learned?: Record<string, string>;
}

/** Optional parts of an adapter (the seam stays minimal). */
export interface ChannelAdapterExtras {
  /** The secrets a binding of this kind needs, by name. */
  readonly credentialNames?: readonly string[];
  /** Whether the adapter can work at all; email is modelled but not configured yet. */
  availability?(): { available: boolean; detail: string | null };
  /** Check the credentials (connect, test). */
  probe?(bindingId: string, signal: AbortSignal): Promise<AdapterProbe>;
  /** The answer to a verified request that is not a message (Slack URL verification). */
  handshake?(rawBody: Uint8Array): Record<string, unknown> | null;
}

export type NovaChannelAdapter = ChannelAdapter & ChannelAdapterExtras;

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** Parse a JSON body, or a validation error (after authentication only). */
export function jsonBody(rawBody: Uint8Array): Record<string, unknown> {
  try {
    const v = JSON.parse(Buffer.from(rawBody).toString('utf8')) as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new NovaError('validation', 'the body is not a JSON object');
}

export function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** The service refused or could not be reached: the send failed. */
export function sendFailed(what: string, detail: string): NovaError {
  return new NovaError('server_error', `${what} failed: ${detail}`, {
    retryable: true,
    details: { reason: detail },
  });
}

export function notConfigured(what: string): NovaError {
  return new NovaError('capability_missing', `${what} is not configured`, {
    action: 'Add the credentials in Settings → Channels',
  });
}
