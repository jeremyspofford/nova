// Connect a model provider (FR-014, docs/04 §2.1 and §8, docs/07 §3): choose a provider, enter its
// base URL and API key, save, then test the connection. The key goes straight to the Hub's secret
// vault in the POST body; the browser never stores it and the Hub never returns it. Field labels
// stay the same for every provider ("Provider", "Name", "Base URL", "API key"); whether a field is
// optional is said in its hint.
import { useState } from 'react';
import type { ProviderAccountView, ProviderKind, ProviderTestResult } from '@nova/shared';
import { Button, RadioGroup, Spinner, TextField } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { useServices } from '../services.tsx';
import { PROVIDER_NAMES } from './names.ts';

export interface ProviderOption {
  kind: ProviderKind;
  name: string;
  blurb: string;
  help: string;
  key: 'none' | 'optional' | 'required';
  /** `advanced`: optional, behind an Advanced disclosure (hosted APIs rarely need it). */
  baseUrl: 'none' | 'optional' | 'required' | 'advanced';
  defaultBaseUrl?: string;
}

const name = (kind: ProviderKind) => PROVIDER_NAMES[kind] ?? kind;

export const PROVIDER_OPTIONS: ProviderOption[] = [
  {
    kind: 'mock',
    name: name('mock'),
    blurb: 'Works offline. Gives canned replies, so you can try Nova without an account.',
    help: 'No key needed. Switch to a real provider any time in Settings → Accounts.',
    key: 'none',
    baseUrl: 'none',
  },
  {
    kind: 'ollama',
    name: `${name('ollama')} (local)`,
    blurb: 'Models running on this computer or your network. Nothing leaves your machines.',
    help: 'Install Ollama and pull a model. Nova connects to the address below; change it if Ollama runs elsewhere.',
    key: 'none',
    baseUrl: 'optional',
    defaultBaseUrl: 'http://127.0.0.1:11434',
  },
  {
    kind: 'llamacpp',
    name: `${name('llamacpp')} (local)`,
    blurb: 'A llama.cpp server on this computer or your network. Nothing leaves your machines.',
    help: 'Start llama-server with a model. Nova connects to the address below; change it if the server runs elsewhere. Add a key only if you started the server with one.',
    key: 'optional',
    baseUrl: 'optional',
    defaultBaseUrl: 'http://127.0.0.1:8080',
  },
  {
    kind: 'openai_compatible',
    name: name('openai_compatible'),
    blurb: 'Any server that speaks the OpenAI chat API, local or hosted.',
    help: 'Use the base URL your server documents, usually ending in /v1. Add a key only if the server asks for one.',
    key: 'optional',
    baseUrl: 'required',
  },
  {
    kind: 'anthropic',
    name: name('anthropic'),
    blurb: 'Hosted models with your Anthropic API key.',
    help: 'Create a key in the API keys section of your Anthropic account, then paste it here.',
    key: 'required',
    baseUrl: 'advanced',
  },
  {
    kind: 'openai',
    name: name('openai'),
    blurb: 'Hosted models with your OpenAI API key.',
    help: 'Create a key on the API keys page of your OpenAI account, then paste it here.',
    key: 'required',
    baseUrl: 'advanced',
  },
  {
    kind: 'openrouter',
    name: name('openrouter'),
    blurb: 'Many hosted models through one OpenRouter API key.',
    help: 'Create a key on the Keys page of your OpenRouter account, then paste it here.',
    key: 'required',
    baseUrl: 'advanced',
  },
];

export function providerOption(kind: ProviderKind): ProviderOption {
  return PROVIDER_OPTIONS.find((o) => o.kind === kind) ?? PROVIDER_OPTIONS[0]!;
}

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

/** Pre-filled values, e.g. from a detected local server (docs/07 §12). */
export interface ProviderPrefill {
  kind: ProviderKind;
  baseUrl?: string;
  label?: string;
}

export function ProviderSetup({
  onConnected,
  submitLabel = 'Save and test',
  initial,
}: {
  onConnected: (c: ConnectedProvider) => void;
  submitLabel?: string;
  initial?: ProviderPrefill;
}) {
  const { api } = useServices();
  const [kind, setKind] = useState<ProviderKind>(initial?.kind ?? 'mock');
  const option = providerOption(kind);
  const [label, setLabel] = useState(initial?.label ?? '');
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  // Open once when a prefilled URL would otherwise be hidden; afterwards the user toggles it.
  const [advancedOpen] = useState(() => !!initial?.baseUrl || undefined);
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

  const urlField = (
    <TextField
      label="Base URL"
      hint={
        option.baseUrl === 'required'
          ? undefined
          : option.baseUrl === 'advanced'
            ? 'Optional. Only for a proxy or a self-hosted gateway; leave empty to use the provider directly.'
            : `Optional. Defaults to ${option.defaultBaseUrl ?? 'the provider address'}.`
      }
      value={baseUrl}
      placeholder={
        option.defaultBaseUrl ??
        (option.baseUrl === 'advanced' ? 'https://gateway.example.com' : 'http://127.0.0.1:8000/v1')
      }
      inputMode="url"
      autoComplete="off"
      spellCheck={false}
      required={option.baseUrl === 'required'}
      onChange={(e) => setBaseUrl(e.target.value)}
      error={urlError}
    />
  );

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
      {option.baseUrl === 'optional' || option.baseUrl === 'required' ? urlField : null}
      {option.key !== 'none' ? (
        <TextField
          label="API key"
          hint={
            option.key === 'optional'
              ? "Optional. Stored in the Hub's secret vault; it is never shown again or kept in this browser."
              : "Stored in the Hub's secret vault. It is never shown again or kept in this browser."
          }
          type="password"
          autoComplete="off"
          spellCheck={false}
          required={option.key === 'required'}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
      ) : null}
      {option.baseUrl === 'advanced' ? (
        <details className="ws-advanced" open={advancedOpen}>
          <summary>Advanced</summary>
          {urlField}
        </details>
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
