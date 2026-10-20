// Settings → Accounts (docs/14 §1.1): model providers. Providers can be added, tested and removed
// here as well as in onboarding (FR-014). With more than one account of a kind, one is active:
// new chats and the built-in presets prefer it (FR-115). Each account's limits, this month's spend
// and its spend cap (M8, FR-115, FR-116). Name, username and avatar moved to Profile & usage
// (FR-113).
import { useEffect, useState } from 'react';
import { defineMessages } from '@nova/i18n';
import type { ProviderAccountView, ProviderKind } from '@nova/shared';
import { Button, Dialog, RadioGroup, Spinner, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { ProviderLimitsSection } from '../datactl/ProviderLimits.tsx';
import { PROVIDER_NAMES } from '../providers/names.ts';
import { ProviderSetup } from '../providers/ProviderSetup.tsx';
import { navigate } from '../router.ts';
import { useServices } from '../services.tsx';
import { useModels } from '../stores.tsx';
import { embed } from './embed.tsx';

export const ACCOUNTS_TEXT = defineMessages('settings.accounts', {
  title: 'Accounts',
  profileIn: 'Your name, username and avatar are in {link}.',
  profileLink: 'Profile & usage',
  providers: 'Model providers',
  loadFailed: 'Could not load providers.',
  loading: 'Loading providers',
  none: 'No providers connected yet.',
  keyStored: 'key stored',
  active: 'Active',
  test: 'Test',
  remove: 'Remove',
  cancel: 'Cancel',
  add: 'Add a provider',
  connected: '{name} is connected.',
  connectedModels: '{name} is connected ({n, plural, one {# model} other {# models}}).',
  couldNotConnect: '{name} could not connect: {detail}',
  unknownError: 'unknown error',
  testFailed: 'Test failed: {error}',
  nowActive: '{name} is now the active {provider} account.',
  switchFailed: 'Could not switch accounts: {error}',
  added: '{name} connected.',
  addedModels: '{name} connected with {n, plural, one {# model} other {# models}}.',
  activeAccounts: 'Active accounts',
  activeHelp:
    'When you have more than one account with a provider, new chats and the built-in presets ' +
    'use the active one. Chats that already picked an account keep it.',
  activeLegend: 'Active {provider} account',
  noneChosen: 'None is chosen yet; Nova uses the first that works.',
  tools: 'Tools',
  toolsIn: 'MCP servers and tool defaults are in {link}.',
  toolsLink: 'Tools & MCP',
  removeTitle: 'Remove this provider?',
  removeBody:
    '{name} and its stored key are deleted. Chats that use its models will need another model.',
  removed: '{name} removed.',
  removeFailed: 'Could not remove: {error}',
  status: { active: 'active', expired: 'expired', revoked: 'revoked', error: 'needs attention' },
});
const S = ACCOUNTS_TEXT;

/** `active` arrives with M4 (PATCH /providers/:id); older Hubs leave it out. */
type Account = ProviderAccountView;

/** Provider kinds with more than one account, each with the account that is active. */
export function activeGroups(
  list: readonly Account[],
): { provider: ProviderKind; accounts: Account[]; activeId: string | null }[] {
  const by = new Map<ProviderKind, Account[]>();
  for (const p of list) by.set(p.provider, [...(by.get(p.provider) ?? []), p]);
  return [...by.entries()]
    .filter(([, accounts]) => accounts.length > 1)
    .map(([provider, accounts]) => ({
      provider,
      accounts,
      activeId: accounts.find((a) => a.active === true)?.id ?? null,
    }));
}

function SettingsLink({ section, children }: { section: string; children: string }) {
  return (
    <a
      href={`/settings/${section}`}
      onClick={(e) => {
        e.preventDefault();
        navigate(`/settings/${section}`);
      }}
    >
      {children}
    </a>
  );
}

export function AccountsPage() {
  const { api } = useServices();
  const toast = useToast();
  const models = useModels();
  const [providers, setProviders] = useState<Account[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<ProviderAccountView | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [switching, setSwitching] = useState<ProviderKind | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let alive = true;
    api.listProviders().then(
      ({ items }) => alive && setProviders(items),
      (err: unknown) => alive && setError(errorMessage(err, S.loadFailed)),
    );
    return () => {
      alive = false;
    };
  }, [api, version]);

  const reload = () => {
    setVersion((v) => v + 1);
    void models.refresh();
  };

  const test = async (p: ProviderAccountView) => {
    setTesting(p.id);
    try {
      const r = await api.testProvider(p.id);
      toast.show(
        r.ok
          ? r.models !== undefined
            ? S.connectedModels({ name: p.label, n: r.models })
            : S.connected({ name: p.label })
          : S.couldNotConnect({ name: p.label, detail: r.detail ?? S.unknownError }),
        { tone: r.ok ? 'success' : 'error' },
      );
      reload();
    } catch (err) {
      toast.show(S.testFailed({ error: errorMessage(err) }), { tone: 'error' });
    } finally {
      setTesting(null);
    }
  };

  const makeActive = async (kind: ProviderKind, id: string) => {
    const target = providers?.find((p) => p.id === id);
    if (!target) return;
    setSwitching(kind);
    try {
      await api.setActiveProvider(id);
      toast.show(S.nowActive({ name: target.label, provider: PROVIDER_NAMES[kind] ?? kind }), {
        tone: 'success',
      });
    } catch (err) {
      toast.show(S.switchFailed({ error: errorMessage(err) }), { tone: 'error' });
    } finally {
      setSwitching(null);
      reload();
    }
  };

  const groups = activeGroups(providers ?? []);

  return (
    <div className="settings-page">
      <h2>{S.title}</h2>
      <p className="muted">
        {embed(S.profileIn, {
          link: <SettingsLink section="profile">{S.profileLink}</SettingsLink>,
        })}
      </p>
      <section className="settings-section" aria-labelledby="acct-providers">
        <h3 id="acct-providers">{S.providers}</h3>
        {error ? <p role="alert">{error}</p> : null}
        {providers === null && !error ? <Spinner label={S.loading} /> : null}
        {providers?.length === 0 ? <p className="muted">{S.none}</p> : null}
        {providers?.length ? (
          <ul className="provider-list">
            {providers.map((p) => (
              <li key={p.id} className="provider-row">
                <div>
                  <strong>{p.label}</strong>{' '}
                  <span className="muted">
                    {PROVIDER_NAMES[p.provider] ?? p.provider}
                    {p.baseUrl ? ` · ${p.baseUrl}` : ''} · {S.status[p.status]}
                    {p.hasSecret ? ` · ${S.keyStored}` : ''}
                  </span>{' '}
                  {p.active === true && groups.some((g) => g.provider === p.provider) ? (
                    <span className="ws-badge" data-tone="ok">
                      {S.active}
                    </span>
                  ) : null}
                </div>
                <div className="row">
                  <Button onClick={() => void test(p)} disabled={testing === p.id}>
                    {testing === p.id ? <Spinner /> : null} {S.test}
                  </Button>
                  <Button variant="ghost" onClick={() => setRemoving(p)}>
                    {S.remove}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
        {adding ? (
          <div className="panel-inset">
            <ProviderSetup
              onConnected={({ account, test: t }) => {
                setAdding(false);
                toast.show(
                  t.models !== undefined
                    ? S.addedModels({ name: account.label, n: t.models })
                    : S.added({ name: account.label }),
                  { tone: 'success' },
                );
                reload();
              }}
            />
            <Button variant="ghost" onClick={() => setAdding(false)}>
              {S.cancel}
            </Button>
          </div>
        ) : (
          <Button variant="primary" onClick={() => setAdding(true)}>
            {S.add}
          </Button>
        )}
      </section>
      {groups.length ? (
        <section className="settings-section" aria-labelledby="acct-active">
          <h3 id="acct-active">{S.activeAccounts}</h3>
          <p className="muted">{S.activeHelp}</p>
          {groups.map((g) => {
            const kind = PROVIDER_NAMES[g.provider] ?? g.provider;
            return (
              <RadioGroup
                key={g.provider}
                legend={S.activeLegend({ provider: kind })}
                name={`active-${g.provider}`}
                value={g.activeId ?? ''}
                locked={switching === g.provider}
                hint={g.activeId ? undefined : S.noneChosen}
                onChange={(id) => void makeActive(g.provider, id)}
                options={g.accounts.map((a) => ({
                  value: a.id,
                  label: a.label,
                  description: [a.baseUrl, S.status[a.status]].filter(Boolean).join(' · '),
                }))}
              />
            );
          })}
        </section>
      ) : null}
      <ProviderLimitsSection key={version} />
      <section className="settings-section">
        <h3>{S.tools}</h3>
        <p className="muted">
          {embed(S.toolsIn, {
            link: <SettingsLink section="tools">{S.toolsLink}</SettingsLink>,
          })}
        </p>
      </section>
      <Dialog
        open={removing !== null}
        title={S.removeTitle}
        description={removing ? S.removeBody({ name: removing.label }) : undefined}
        onClose={() => setRemoving(null)}
        footer={
          <>
            <Button onClick={() => setRemoving(null)}>{S.cancel}</Button>
            <Button
              variant="danger"
              onClick={() => {
                const p = removing;
                setRemoving(null);
                if (!p) return;
                api.deleteProvider(p.id).then(
                  () => {
                    toast.show(S.removed({ name: p.label }), { tone: 'success' });
                    reload();
                  },
                  (err: unknown) =>
                    toast.show(S.removeFailed({ error: errorMessage(err) }), { tone: 'error' }),
                );
              }}
            >
              {S.remove}
            </Button>
          </>
        }
      />
    </div>
  );
}
