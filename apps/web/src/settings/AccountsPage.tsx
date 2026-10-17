// Settings → Accounts (docs/14 §1.1): model providers. Providers can be added, tested and removed
// here as well as in onboarding (FR-014). With more than one account of a kind, one is active:
// new chats and the built-in presets prefer it (FR-115). Name, username and avatar moved to
// Profile & usage (FR-113).
import { useEffect, useState } from 'react';
import type { ProviderAccountView, ProviderKind } from '@nova/shared';
import { Button, Dialog, RadioGroup, Spinner, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { PROVIDER_NAMES } from '../providers/names.ts';
import { ProviderSetup } from '../providers/ProviderSetup.tsx';
import { navigate } from '../router.ts';
import { useServices } from '../services.tsx';
import { useModels } from '../stores.tsx';

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
      (err: unknown) => alive && setError(errorMessage(err, 'Could not load providers.')),
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
          ? `${p.label} is connected${r.models !== undefined ? ` (${r.models} models)` : ''}.`
          : `${p.label} could not connect: ${r.detail ?? 'unknown error'}`,
        { tone: r.ok ? 'success' : 'error' },
      );
      reload();
    } catch (err) {
      toast.show(`Test failed: ${errorMessage(err)}`, { tone: 'error' });
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
      toast.show(`${target.label} is now the active ${PROVIDER_NAMES[kind] ?? kind} account.`, {
        tone: 'success',
      });
    } catch (err) {
      toast.show(`Could not switch accounts: ${errorMessage(err)}`, { tone: 'error' });
    } finally {
      setSwitching(null);
      reload();
    }
  };

  const groups = activeGroups(providers ?? []);

  return (
    <div className="settings-page">
      <h2>Accounts</h2>
      <p className="muted">
        Your name, username and avatar are in{' '}
        <SettingsLink section="profile">Profile &amp; usage</SettingsLink>.
      </p>
      <section className="settings-section" aria-labelledby="acct-providers">
        <h3 id="acct-providers">Model providers</h3>
        {error ? <p role="alert">{error}</p> : null}
        {providers === null && !error ? <Spinner label="Loading providers" /> : null}
        {providers?.length === 0 ? <p className="muted">No providers connected yet.</p> : null}
        {providers?.length ? (
          <ul className="provider-list">
            {providers.map((p) => (
              <li key={p.id} className="provider-row">
                <div>
                  <strong>{p.label}</strong>{' '}
                  <span className="muted">
                    {PROVIDER_NAMES[p.provider] ?? p.provider}
                    {p.baseUrl ? ` · ${p.baseUrl}` : ''} · {STATUS_TEXT[p.status]}
                    {p.hasSecret ? ' · key stored' : ''}
                  </span>{' '}
                  {p.active === true && groups.some((g) => g.provider === p.provider) ? (
                    <span className="ws-badge" data-tone="ok">
                      Active
                    </span>
                  ) : null}
                </div>
                <div className="row">
                  <Button onClick={() => void test(p)} disabled={testing === p.id}>
                    {testing === p.id ? <Spinner /> : null} Test
                  </Button>
                  <Button variant="ghost" onClick={() => setRemoving(p)}>
                    Remove
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
                  `${account.label} connected${t.models !== undefined ? ` with ${t.models} models` : ''}.`,
                  { tone: 'success' },
                );
                reload();
              }}
            />
            <Button variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <Button variant="primary" onClick={() => setAdding(true)}>
            Add a provider
          </Button>
        )}
      </section>
      {groups.length ? (
        <section className="settings-section" aria-labelledby="acct-active">
          <h3 id="acct-active">Active accounts</h3>
          <p className="muted">
            When you have more than one account with a provider, new chats and the built-in presets
            use the active one. Chats that already picked an account keep it.
          </p>
          {groups.map((g) => {
            const kind = PROVIDER_NAMES[g.provider] ?? g.provider;
            return (
              <RadioGroup
                key={g.provider}
                legend={`Active ${kind} account`}
                name={`active-${g.provider}`}
                value={g.activeId ?? ''}
                locked={switching === g.provider}
                hint={
                  g.activeId ? undefined : 'None is chosen yet; Nova uses the first that works.'
                }
                onChange={(id) => void makeActive(g.provider, id)}
                options={g.accounts.map((a) => ({
                  value: a.id,
                  label: a.label,
                  description: [a.baseUrl, STATUS_TEXT[a.status]].filter(Boolean).join(' · '),
                }))}
              />
            );
          })}
        </section>
      ) : null}
      <section className="settings-section">
        <h3>Tools</h3>
        <p className="muted">
          MCP servers and tool defaults are in{' '}
          <SettingsLink section="tools">Tools &amp; MCP</SettingsLink>.
        </p>
      </section>
      <Dialog
        open={removing !== null}
        title="Remove this provider?"
        description={
          removing
            ? `${removing.label} and its stored key are deleted. Chats that use its models will need another model.`
            : undefined
        }
        onClose={() => setRemoving(null)}
        footer={
          <>
            <Button onClick={() => setRemoving(null)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={() => {
                const p = removing;
                setRemoving(null);
                if (!p) return;
                api.deleteProvider(p.id).then(
                  () => {
                    toast.show(`${p.label} removed.`, { tone: 'success' });
                    reload();
                  },
                  (err: unknown) =>
                    toast.show(`Could not remove: ${errorMessage(err)}`, { tone: 'error' }),
                );
              }}
            >
              Remove
            </Button>
          </>
        }
      />
    </div>
  );
}

const STATUS_TEXT: Record<ProviderAccountView['status'], string> = {
  active: 'active',
  expired: 'expired',
  revoked: 'revoked',
  error: 'needs attention',
};
