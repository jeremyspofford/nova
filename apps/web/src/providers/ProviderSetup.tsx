// Connect a model provider (FR-014, docs/04 §2.1 and §8): choose a provider, enter its base URL and
// API key, save, then test the connection. The key goes straight to the Hub's secret vault in the
// POST body; the browser never stores it and the Hub never returns it.
import { useState } from 'react';
import type { ProviderAccountView, ProviderKind, ProviderTestResult } from '@nova/shared';
import { Button, RadioGroup, Spinner, TextField } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { useServices } from '../services.tsx';

interface ProviderOption {
  kind: ProviderKind;
  name: string;
  blurb: string;
  help: string;
  key: 'none' | 'optional' | 'required';
  baseUrl: 'none' | 'optional' | 'required';
  defaultBaseUrl?: string;
}

export const PROVIDER_OPTIONS: ProviderOption[] = [
  {
    kind: 'mock',
    name: 'Mock',
    blurb: 'Works offline. Gives canned replies, so you can try Nova without an account.',
    help: 'No key needed. Switch to a real provider any time in Settings → Accounts.',
    key: 'none',
    baseUrl: 'none',
  },
  {
    kind: 'openai_compatible',
    name: 'OpenAI-compatible',
    blurb: 'Any server that speaks the OpenAI chat API, local or hosted.',
    help: 'Use the base URL your server documents, usually ending in /v1. Add a key only if the server asks for one.',
    key: 'optional',
    baseUrl: 'required',
  },
  {
    kind: 'openai',
    name: 'OpenAI',
    blurb: 'Hosted models with your OpenAI API key.',
    help: 'Create a key on the API keys page of your OpenAI account, then paste it here.',
    key: 'required',
    baseUrl: 'none',
  },
  {
    kind: 'ollama',
    name: 'Ollama (local)',
    blurb: 'Models running on this computer or your network. Nothing leaves your machines.',
    help: 'Install Ollama and pull a model. Nova connects to the address below; change it if Ollama runs elsewhere.',
    key: 'none',
    baseUrl: 'optional',
    defaultBaseUrl: 'http://127.0.0.1:11434',
  },
];

function isHttpUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export interface ConnectedProvider {
  account: ProviderAccountView;
  test: ProviderTestResult;
}

export function ProviderSetup({
  onConnected,
  submitLabel = 'Save and test',
}: {
  onConnected: (c: ConnectedProvider) => void;
  submitLabel?: string;
}) {
  const { api } = useServices();
  const [kind, setKind] = useState<ProviderKind>('mock');
  const option = PROVIDER_OPTIONS.find((o) => o.kind === kind) ?? PROVIDER_OPTIONS[0]!;
  const [label, setLabel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState<null | 'saving' | 'testing'>(null);
  const [error, setError] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ account: ProviderAccountView; detail: string } | null>(
    null,
  );

  const url = baseUrl.trim() || option.defaultBaseUrl || '';
  const urlError =
    option.baseUrl !== 'none' && url && !isHttpUrl(url)
      ? 'Enter a full URL, like http://host:port/v1'
      : undefined;
  const missing =
    (option.baseUrl === 'required' && !url) || (option.key === 'required' && !apiKey.trim());

  const test = async (account: ProviderAccountView) => {
    setBusy('testing');
    try {
      const result = await api.testProvider(account.id);
      if (result.ok) {
        setApiKey('');
        setFailed(null);
        onConnected({ account, test: result });
      } else {
        setFailed({
          account,
          detail: result.detail ?? 'The provider did not accept the connection.',
        });
      }
    } catch (err) {
      setFailed({ account, detail: errorMessage(err, 'The connection test failed.') });
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    setError(null);
    setBusy('saving');
    try {
      const account = await api.createProvider({
        provider: kind,
        label: label.trim() || option.name,
        ...(option.baseUrl !== 'none' && url ? { baseUrl: url } : {}),
        ...(option.key !== 'none' && apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      });
      await test(account);
    } catch (err) {
      setError(errorMessage(err, 'Could not save the provider.'));
      setBusy(null);
    }
  };

  const removeFailed = async () => {
    if (!failed) return;
    try {
      await api.deleteProvider(failed.account.id);
      setFailed(null);
    } catch (err) {
      setError(errorMessage(err, 'Could not remove the provider.'));
    }
  };

  if (failed) {
    return (
      <div className="stack provider-failed" role="alert">
        <p>
          <strong>{failed.account.label}</strong> could not connect: {failed.detail}
        </p>
        <div className="row">
          <Button
            variant="primary"
            onClick={() => void test(failed.account)}
            disabled={busy !== null}
          >
            {busy === 'testing' ? <Spinner /> : null} Test again
          </Button>
          <Button onClick={() => void removeFailed()} disabled={busy !== null}>
            Remove and edit
          </Button>
        </div>
        {error ? <p className="nv-field-error">{error}</p> : null}
      </div>
    );
  }

  return (
    <form
      className="stack provider-setup"
      onSubmit={(e) => {
        e.preventDefault();
        if (!missing && !urlError) void save();
      }}
    >
      <RadioGroup
        legend="Provider"
        name="provider-kind"
        value={kind}
        onChange={(v) => {
          setKind(v as ProviderKind);
          setError(null);
        }}
        options={PROVIDER_OPTIONS.map((o) => ({
          value: o.kind,
          label: o.name,
          description: o.blurb,
        }))}
        className="provider-cards"
      />
      <p className="muted">{option.help}</p>
      <TextField
        label="Name"
        hint={`Shown in model pickers. Defaults to “${option.name}”.`}
        value={label}
        maxLength={100}
        onChange={(e) => setLabel(e.target.value)}
      />
      {option.baseUrl !== 'none' ? (
        <TextField
          label={option.baseUrl === 'required' ? 'Base URL' : 'Base URL (optional)'}
          value={baseUrl}
          placeholder={option.defaultBaseUrl ?? 'http://127.0.0.1:8000/v1'}
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setBaseUrl(e.target.value)}
          error={urlError}
        />
      ) : null}
      {option.key !== 'none' ? (
        <TextField
          label={option.key === 'required' ? 'API key' : 'API key (optional)'}
          hint="Stored in the Hub's secret vault. It is never shown again or kept in this browser."
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
      ) : null}
      {error ? (
        <p className="nv-field-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="row">
        <Button type="submit" variant="primary" disabled={busy !== null || missing || !!urlError}>
          {busy ? <Spinner /> : null}
          {busy === 'testing' ? 'Testing connection…' : busy === 'saving' ? 'Saving…' : submitLabel}
        </Button>
      </div>
    </form>
  );
}
