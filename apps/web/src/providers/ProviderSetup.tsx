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
import { embed } from '../settings/embed.tsx';
import { PROVIDER_NAMES } from './names.ts';
import { PROVIDER_TEXT } from './strings.ts';

export { PROVIDER_TEXT };

// Example addresses for the Base URL field: URLs, the same in every language.
const GATEWAY_EXAMPLE = 'https://gateway.example.com';
const SERVER_EXAMPLE = 'http://127.0.0.1:8000/v1';

interface ProviderSpec {
  kind: ProviderKind;
  key: 'none' | 'optional' | 'required';
  /** `advanced`: optional, behind an Advanced disclosure (hosted APIs rarely need it). */
  baseUrl: 'none' | 'optional' | 'required' | 'advanced';
  defaultBaseUrl?: string;
  /** Runs on this computer or the network: the name says "(local)". */
  local?: boolean;
}

export interface ProviderOption extends ProviderSpec {
  /** The words, read in the active locale each time. */
  readonly name: string;
  readonly blurb: string;
  readonly help: string;
}

function withText(spec: ProviderSpec): ProviderOption {
  return {
    ...spec,
    get name() {
      const name = PROVIDER_NAMES[spec.kind] ?? spec.kind;
      return spec.local ? PROVIDER_TEXT.local({ name }) : name;
    },
    get blurb() {
      return PROVIDER_TEXT.kinds[spec.kind].blurb;
    },
    get help() {
      return PROVIDER_TEXT.kinds[spec.kind].help;
    },
  };
}

export const PROVIDER_OPTIONS: ProviderOption[] = [
  withText({ kind: 'mock', key: 'none', baseUrl: 'none' }),
  withText({
    kind: 'ollama',
    local: true,
    key: 'none',
    baseUrl: 'optional',
    defaultBaseUrl: 'http://127.0.0.1:11434',
  }),
  withText({
    kind: 'llamacpp',
    local: true,
    key: 'optional',
    baseUrl: 'optional',
    defaultBaseUrl: 'http://127.0.0.1:8080',
  }),
  withText({ kind: 'openai_compatible', key: 'optional', baseUrl: 'required' }),
  withText({ kind: 'anthropic', key: 'required', baseUrl: 'advanced' }),
  withText({ kind: 'openai', key: 'required', baseUrl: 'advanced' }),
  withText({ kind: 'openrouter', key: 'required', baseUrl: 'advanced' }),
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
  submitLabel,
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
    option.baseUrl !== 'none' && url && !isHttpUrl(url) ? PROVIDER_TEXT.urlInvalid : undefined;
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
          detail: result.detail ?? PROVIDER_TEXT.rejected,
        });
      }
    } catch (err) {
      setFailed({ account, detail: errorMessage(err, PROVIDER_TEXT.testFailed) });
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
      setError(errorMessage(err, PROVIDER_TEXT.saveFailed));
      setBusy(null);
    }
  };

  const removeFailed = async () => {
    if (!failed) return;
    try {
      await api.deleteProvider(failed.account.id);
      setFailed(null);
    } catch (err) {
      setError(errorMessage(err, PROVIDER_TEXT.removeFailed));
    }
  };

  if (failed) {
    return (
      <div className="stack provider-failed" role="alert">
        <p>
          {embed(PROVIDER_TEXT.couldNotConnect, {
            name: <strong>{failed.account.label}</strong>,
            detail: failed.detail,
          })}
        </p>
        <div className="row">
          <Button
            variant="primary"
            onClick={() => void test(failed.account)}
            disabled={busy !== null}
          >
            {busy === 'testing' ? <Spinner /> : null} {PROVIDER_TEXT.testAgain}
          </Button>
          <Button onClick={() => void removeFailed()} disabled={busy !== null}>
            {PROVIDER_TEXT.removeAndEdit}
          </Button>
        </div>
        {error ? <p className="nv-field-error">{error}</p> : null}
      </div>
    );
  }

  const urlField = (
    <TextField
      label={PROVIDER_TEXT.baseUrl}
      hint={
        option.baseUrl === 'required'
          ? undefined
          : option.baseUrl === 'advanced'
            ? PROVIDER_TEXT.baseUrlAdvancedHint
            : option.defaultBaseUrl
              ? PROVIDER_TEXT.baseUrlDefaultHint({ url: option.defaultBaseUrl })
              : PROVIDER_TEXT.baseUrlProviderHint
      }
      value={baseUrl}
      placeholder={
        option.defaultBaseUrl ?? (option.baseUrl === 'advanced' ? GATEWAY_EXAMPLE : SERVER_EXAMPLE)
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
        legend={PROVIDER_TEXT.provider}
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
        label={PROVIDER_TEXT.name}
        hint={PROVIDER_TEXT.nameHint({ name: option.name })}
        value={label}
        maxLength={100}
        onChange={(e) => setLabel(e.target.value)}
      />
      {option.baseUrl === 'optional' || option.baseUrl === 'required' ? urlField : null}
      {option.key !== 'none' ? (
        <TextField
          label={PROVIDER_TEXT.apiKey}
          hint={
            option.key === 'optional' ? PROVIDER_TEXT.apiKeyOptionalHint : PROVIDER_TEXT.apiKeyHint
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
          <summary>{PROVIDER_TEXT.advanced}</summary>
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
          {busy === 'testing'
            ? PROVIDER_TEXT.testing
            : busy === 'saving'
              ? PROVIDER_TEXT.saving
              : (submitLabel ?? PROVIDER_TEXT.saveAndTest)}
        </Button>
      </div>
    </form>
  );
}
