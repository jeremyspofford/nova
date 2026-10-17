// Settings → Accounts (docs/14 §1.1): your display name and model providers. Providers can be
// added, tested and removed here as well as in onboarding (FR-014).
import { useEffect, useState } from 'react';
import type { ProviderAccountView } from '@nova/shared';
import { Button, Dialog, Spinner, TextField, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { PROVIDER_NAMES } from '../chat/Composer.tsx';
import { ProviderSetup } from '../providers/ProviderSetup.tsx';
import { useServices } from '../services.tsx';
import { useModels } from '../stores.tsx';

export function AccountsPage({
  displayName,
  onDisplayName,
}: {
  displayName: string | null;
  onDisplayName: (name: string | null) => void;
}) {
  const { api } = useServices();
  const toast = useToast();
  const models = useModels();
  const [providers, setProviders] = useState<ProviderAccountView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<ProviderAccountView | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [name, setName] = useState(displayName ?? '');
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

  const saveName = async () => {
    try {
      const res = await api.updateAccount({ displayName: name.trim() });
      onDisplayName(res.displayName);
      toast.show('Name saved.', { tone: 'success' });
    } catch (err) {
      toast.show(`Could not save your name: ${errorMessage(err)}`, { tone: 'error' });
    }
  };

  return (
    <div className="settings-page">
      <h2>Accounts</h2>
      <section className="settings-section" aria-labelledby="acct-profile">
        <h3 id="acct-profile">Profile</h3>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void saveName();
          }}
        >
          <TextField
            label="Display name"
            value={name}
            maxLength={100}
            onChange={(e) => setName(e.target.value)}
          />
          <Button type="submit" disabled={name.trim() === (displayName ?? '')}>
            Save name
          </Button>
        </form>
      </section>
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
                  </span>
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
      <section className="settings-section">
        <h3>Tools</h3>
        <p className="muted">Connecting tools and MCP servers arrives in a later milestone.</p>
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
