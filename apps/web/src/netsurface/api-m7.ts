// M7 Hub client call of the Relay section (FR-137; docs/22 §3): the registration token a private
// Relay asks for when this Hub registers. It goes into the Hub's vault and is never answered back;
// the Relay view only says whether one is set. `createApi` spreads `relayTokenApi(call)` into the
// client next to `networkSurfaceApi(call)`; until then `useRelayTokenApi` reads it from the same
// services object.
import type { RelayConfigView } from '@nova/shared';
import { useServices } from '../services.tsx';
import type { HubCall } from './api.ts';

export function relayTokenApi(call: HubCall) {
  return {
    /**
     * Store the token (8-512 printable characters, no spaces) or, with null, remove it. The Hub
     * registers with the Relay again at once. 400 `validation` for a token it refuses.
     */
    setRelayRegistrationToken: (token: string | null) =>
      call<RelayConfigView>('PUT', '/api/v1/relay/registration-token', { token }),
  };
}

export type RelayTokenApi = ReturnType<typeof relayTokenApi>;

export function useRelayTokenApi(): RelayTokenApi {
  const api: unknown = useServices().api;
  return api as RelayTokenApi;
}
