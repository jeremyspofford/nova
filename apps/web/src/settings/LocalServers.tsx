// Local model servers (docs/07 §12): probe this computer for Ollama and llama.cpp servers (plus any
// addresses the Hub is told to check) and connect one as a provider with its address filled in.
// The probe only asks each server for its model list and never sends a credential.
import { useState } from 'react';
import { defineMessages, fmt } from '@nova/i18n';
import type { DetectedServer, ProviderAccountView } from '@nova/shared';
import { Button, Icon, Spinner, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { PROVIDER_NAMES } from '../providers/names.ts';
import { ProviderSetup } from '../providers/ProviderSetup.tsx';
import { useServices } from '../services.tsx';
import { useModels } from '../stores.tsx';

const S = defineMessages('settings.localServers', {
  lookFailed: 'Could not look for servers.',
  intro:
    'Find model servers running on this computer, such as Ollama or a llama.cpp server. Nova ' +
    'only asks each one for its list of models.',
  detect: 'Detect',
  detecting: 'Looking for local model servers…',
  tryAgain: 'Try again',
  noneFound:
    'No local model servers found. Start Ollama or a llama.cpp server and detect again, or add ' +
    'any OpenAI-compatible server in Accounts.',
  found: '{n, plural, one {Found # server.} other {Found # servers.}}',
  detected: 'Detected servers',
  serverAt: '{name} at {url}',
  models: '{n, plural, one {# model: {names}} other {# models: {names}}}',
  modelsMore:
    '{n, plural, one {# model: {names} and {more} more} other {# models: {names} and {more} more}}',
  noModels: 'No models installed yet',
  alreadyConnected: 'Already connected',
  connectAgain: 'Connect again',
  connect: 'Connect',
  connectDetected: 'Connect a detected server',
  connected: '{name} connected.',
  connectedModels: '{name} connected with {n, plural, one {# model} other {# models}}.',
  cancel: 'Cancel',
});

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
      setState({ kind: 'error', message: errorMessage(err, S.lookFailed) });
    }
  };

  return (
    <div className="stack">
      <p className="muted">{S.intro}</p>
      <div className="row">
        <Button onClick={() => void detect()} disabled={state.kind === 'detecting'}>
          {state.kind === 'detecting' ? <Spinner /> : <Icon name="search" />} {S.detect}
        </Button>
        {state.kind === 'detecting' ? (
          <span role="status" className="muted">
            {S.detecting}
          </span>
        ) : null}
      </div>
      {state.kind === 'error' ? (
        <div role="alert" className="ws-error">
          <p>{state.message}</p>
          <Button onClick={() => void detect()}>{S.tryAgain}</Button>
        </div>
      ) : null}
      {state.kind === 'done' && state.items.length === 0 ? (
        <p role="status" className="muted">
          {S.noneFound}
        </p>
      ) : null}
      {state.kind === 'done' && state.items.length > 0 ? (
        <>
          <p role="status" className="muted">
            {S.found({ n: state.items.length })}
          </p>
          <ul className="ws-list" aria-label={S.detected}>
            {state.items.map((s) => {
              const name = PROVIDER_NAMES[s.kind] ?? s.kind;
              const connected = accounts.some((a) => sameServer(a.baseUrl, s.baseUrl));
              const names = fmt.list(s.models.slice(0, MAX_NAMES), { type: 'unit' });
              const more = s.models.length - MAX_NAMES;
              return (
                <li
                  key={`${s.kind}:${s.baseUrl}`}
                  className="ws-list-row"
                  aria-label={S.serverAt({ name, url: s.baseUrl })}
                >
                  <div className="ws-source-main">
                    <strong>{name}</strong>
                    <code className="ws-code-inline">{s.baseUrl}</code>
                    <span className="muted ws-row-meta">
                      {!s.models.length
                        ? S.noModels
                        : more > 0
                          ? S.modelsMore({ n: s.models.length, names, more })
                          : S.models({ n: s.models.length, names })}
                    </span>
                    {connected ? (
                      <span className="nv-chip" data-status="ready">
                        <Icon name="check" /> <span>{S.alreadyConnected}</span>
                      </span>
                    ) : null}
                  </div>
                  <Button
                    variant={connected ? 'ghost' : 'primary'}
                    onClick={() => setConnecting(s)}
                    disabled={connecting === s}
                  >
                    {connected ? S.connectAgain : S.connect}
                  </Button>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
      {connecting ? (
        <div className="panel-inset" aria-label={S.connectDetected} role="group">
          <ProviderSetup
            key={`${connecting.kind}:${connecting.baseUrl}`}
            initial={{ kind: connecting.kind, baseUrl: connecting.baseUrl }}
            onConnected={({ account, test }) => {
              setConnecting(null);
              setAccounts((list) => [...list, account]);
              toast.show(
                test.models !== undefined
                  ? S.connectedModels({ name: account.label, n: test.models })
                  : S.connected({ name: account.label }),
                { tone: 'success' },
              );
              void models.refresh();
            }}
          />
          <div className="row">
            <Button variant="ghost" onClick={() => setConnecting(null)}>
              {S.cancel}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
