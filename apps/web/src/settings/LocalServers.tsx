// Local model servers (docs/07 §12): probe this computer for Ollama and llama.cpp servers (plus any
// addresses the Hub is told to check) and connect one as a provider with its address filled in.
// The probe only asks each server for its model list and never sends a credential.
import { useState } from 'react';
import type { DetectedServer, ProviderAccountView } from '@nova/shared';
import { Button, Icon, Spinner, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { PROVIDER_NAMES } from '../providers/names.ts';
import { ProviderSetup } from '../providers/ProviderSetup.tsx';
import { useServices } from '../services.tsx';
import { useModels } from '../stores.tsx';
import { plural } from './common.ts';

type State =
  | { kind: 'idle' }
  | { kind: 'detecting' }
  | { kind: 'error'; message: string }
  | { kind: 'done'; items: DetectedServer[] };

/** Compare server addresses loosely: no trailing slash, no trailing /v1, lower-case host. */
export function sameServer(a: string | null, b: string): boolean {
  if (!a) return false;
  const norm = (u: string) => u.trim().replace(/\/+$/, '').replace(/\/v1$/, '').toLowerCase();
  return norm(a) === norm(b);
}

const MAX_NAMES = 5;

export function LocalServers() {
  const { api } = useServices();
  const models = useModels();
  const toast = useToast();
  const [state, setState] = useState<State>({ kind: 'idle' });
  const [accounts, setAccounts] = useState<ProviderAccountView[]>([]);
  const [connecting, setConnecting] = useState<DetectedServer | null>(null);

  const detect = async () => {
    setState({ kind: 'detecting' });
    setConnecting(null);
    try {
      const [found, providers] = await Promise.all([
        api.detectServers(),
        api.listProviders().catch(() => ({ items: [] as ProviderAccountView[] })),
      ]);
      setAccounts(providers.items);
      setState({ kind: 'done', items: found.items });
    } catch (err) {
      setState({ kind: 'error', message: errorMessage(err, 'Could not look for servers.') });
    }
  };

  return (
    <div className="stack">
      <p className="muted">
        Find model servers running on this computer, such as Ollama or a llama.cpp server. Nova only
        asks each one for its list of models.
      </p>
      <div className="row">
        <Button onClick={() => void detect()} disabled={state.kind === 'detecting'}>
          {state.kind === 'detecting' ? <Spinner /> : <Icon name="search" />} Detect
        </Button>
        {state.kind === 'detecting' ? (
          <span role="status" className="muted">
            Looking for local model servers…
          </span>
        ) : null}
      </div>
      {state.kind === 'error' ? (
        <div role="alert" className="ws-error">
          <p>{state.message}</p>
          <Button onClick={() => void detect()}>Try again</Button>
        </div>
      ) : null}
      {state.kind === 'done' && state.items.length === 0 ? (
        <p role="status" className="muted">
          No local model servers found. Start Ollama or a llama.cpp server and detect again, or add
          any OpenAI-compatible server in Accounts.
        </p>
      ) : null}
      {state.kind === 'done' && state.items.length > 0 ? (
        <>
          <p role="status" className="muted">
            Found {plural(state.items.length, 'server')}.
          </p>
          <ul className="ws-list" aria-label="Detected servers">
            {state.items.map((s) => {
              const name = PROVIDER_NAMES[s.kind] ?? s.kind;
              const connected = accounts.some((a) => sameServer(a.baseUrl, s.baseUrl));
              const names = s.models.slice(0, MAX_NAMES).join(', ');
              const more = s.models.length - MAX_NAMES;
              return (
                <li
                  key={`${s.kind}:${s.baseUrl}`}
                  className="ws-list-row"
                  aria-label={`${name} at ${s.baseUrl}`}
                >
                  <div className="ws-source-main">
                    <strong>{name}</strong>
                    <code className="ws-code-inline">{s.baseUrl}</code>
                    <span className="muted ws-row-meta">
                      {s.models.length
                        ? `${plural(s.models.length, 'model')}: ${names}${more > 0 ? ` and ${more} more` : ''}`
                        : 'No models installed yet'}
                    </span>
                    {connected ? (
                      <span className="nv-chip" data-status="ready">
                        <Icon name="check" /> <span>Already connected</span>
                      </span>
                    ) : null}
                  </div>
                  <Button
                    variant={connected ? 'ghost' : 'primary'}
                    onClick={() => setConnecting(s)}
                    disabled={connecting === s}
                  >
                    {connected ? 'Connect again' : 'Connect'}
                  </Button>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
      {connecting ? (
        <div className="panel-inset" aria-label="Connect a detected server" role="group">
          <ProviderSetup
            key={`${connecting.kind}:${connecting.baseUrl}`}
            initial={{ kind: connecting.kind, baseUrl: connecting.baseUrl }}
            onConnected={({ account, test }) => {
              setConnecting(null);
              setAccounts((list) => [...list, account]);
              toast.show(
                `${account.label} connected${test.models !== undefined ? ` with ${plural(test.models, 'model')}` : ''}.`,
                { tone: 'success' },
              );
              void models.refresh();
            }}
          />
          <div className="row">
            <Button variant="ghost" onClick={() => setConnecting(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
