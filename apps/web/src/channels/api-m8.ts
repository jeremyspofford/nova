// M8 Hub client calls of the channels area (FR-110; docs/13 §4), in the conventions of
// src/api.ts: an email binding that signs in with OAuth (SASL XOAUTH2) is authorized in the
// browser (start: the provider's page, single-use state, PKCE) and signed out (the tokens are
// revoked at the provider and deleted). `createApi` spreads `channelsM8Api(call)` into the client
// next to `channelsApi` and `channelsM7Api`; until then `useChannelsM8Api` reads them from the
// same services object.
import type { ChannelBindingViewM7, ChannelOAuthStartView } from '@nova/shared';
import { useServices } from '../services.tsx';
import type { ChannelsApi, HubCall } from './api.ts';
import type { ChannelsM7Api } from './api-m7.ts';

const V1 = '/api/v1';
const enc = encodeURIComponent;

/** Where the provider sends the browser back; the owner registers it with the provider. */
export const CHANNEL_OAUTH_CALLBACK_PATH = '/api/v1/channels/oauth/callback';

export function channelsM8Api(call: HubCall) {
  return {
    /**
     * Start authorizing a mailbox: the provider's page to open and the redirect URI it must know
     * (`no-store`). 400 `validation` for a binding that does not sign in with OAuth.
     */
    startChannelOAuth: (id: string) =>
      call<ChannelOAuthStartView>('POST', `${V1}/channels/${enc(id)}/oauth/start`, {}),
    /** Sign the mailbox out: its tokens are revoked at the provider and deleted. */
    revokeChannelOAuth: (id: string) =>
      call<ChannelBindingViewM7>('DELETE', `${V1}/channels/${enc(id)}/oauth`),
  };
}

export type ChannelsM8Api = ReturnType<typeof channelsM8Api>;

/** The channels calls, M6 to M8, of the app's client. */
export function useChannelsM8Api(): ChannelsApi & ChannelsM7Api & ChannelsM8Api {
  const api: unknown = useServices().api;
  return api as ChannelsApi & ChannelsM7Api & ChannelsM8Api;
}
