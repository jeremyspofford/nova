// Settings → Plugins & skills (FR-045, FR-046, FR-197; docs/14 §5, docs/04 §2.10): installed
// plugins (status, permissions, on/off, update, uninstall), the catalogs with search, installing
// from a catalog, a folder on the Hub or a Git URL through a preview, the skills list and the
// hooks list with trust by content hash.
import { useEffect, useState } from 'react';
import type { CatalogEntryView, CatalogView, PluginPreview, PluginView } from '@nova/shared';
import {
  Button,
  Dialog,
  EmptyState,
  Icon,
  SelectField,
  Spinner,
  Switch,
  TextField,
  useToast,
} from '@nova/ui';
import { errorMessage, type PluginSourceRequest } from '../api.ts';
import { useServices } from '../services.tsx';
import { useSettings } from '../settings.tsx';
import { StateChip, VerifiedBadge } from './badges.tsx';
import { MANAGED, formatWhen, plural } from './common.ts';
import { HooksSection } from './HooksSection.tsx';
import { isAbsolutePath } from './PermissionsPage.tsx';
import { PluginPreviewDialog } from './PluginInstall.tsx';
import { PLUGIN_STATUS, compareVersions, permissionLines } from './plugin-text.ts';
import { SkillsSection } from './SkillsSection.tsx';
import '../workspace.css';

type Previewing = { preview: PluginPreview; current: PluginView | null };

/** "2 skills · 1 hook · 1 MCP server"; parts with zero are left out. */
export function componentsText(c: PluginView['components']): string {
  const parts = [
    c.skills ? plural(c.skills, 'skill') : null,
    c.commands ? plural(c.commands, 'command') : null,
    c.agents ? plural(c.agents, 'agent role') : null,
    c.hooks ? plural(c.hooks, 'hook') : null,
    c.mcpServers ? plural(c.mcpServers, 'MCP server') : null,
    c.uiEntryPoints ? plural(c.uiEntryPoints, 'app screen') : null,
  ].filter((p): p is string => p !== null);
  return parts.length ? parts.join(' · ') : 'No components';
}

/** The newest catalog entry for each plugin id. */
export function newestEntries(entries: readonly CatalogEntryView[]): Map<string, CatalogEntryView> {
  const out = new Map<string, CatalogEntryView>();
  for (const e of entries) {
    const have = out.get(e.pluginId);
    if (!have || compareVersions(e.version, have.version) > 0) out.set(e.pluginId, e);
  }
  return out;
}

export function PluginsPage() {
  const { api } = useServices();
  const toast = useToast();
  const [plugins, setPlugins] = useState<PluginView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  // Bumped after an install, update, toggle or uninstall: skills and hooks come and go with it.
  const [changes, setChanges] = useState(0);
  const [entries, setEntries] = useState<CatalogEntryView[]>([]);
  const [previewing, setPreviewing] = useState<Previewing | null>(null);
  const [loadingPreview, setLoadingPreview] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api.listPlugins().then(
      ({ items }) => {
        if (!alive) return;
        setPlugins(items);
        setError(null);
      },
      (err: unknown) => alive && setError(errorMessage(err, 'Could not load plugins.')),
    );
    return () => {
      alive = false;
    };
  }, [api, version]);

  const changed = () => {
    setVersion((v) => v + 1);
    setChanges((c) => c + 1);
  };

  /** Ask the Hub what installing would do; nothing is installed yet. */
  const preview = async (source: PluginSourceRequest, key: string): Promise<string | null> => {
    setLoadingPreview(key);
    try {
      const p = await api.previewPlugin(source);
      const id = typeof p.manifest.id === 'string' ? p.manifest.id : null;
      setPreviewing({ preview: p, current: plugins?.find((x) => x.id === id) ?? null });
      return null;
    } catch (err) {
      return errorMessage(err, 'Could not read the plugin.');
    } finally {
      setLoadingPreview(null);
    }
  };

  const fromCatalog = async (e: CatalogEntryView) => {
    const failed = await preview(
      { kind: 'catalog', catalogId: e.catalogId, pluginId: e.pluginId, version: e.version },
      `${e.catalogId}/${e.pluginId}`,
    );
    if (failed) toast.show(`Could not preview ${e.name}: ${failed}`, { tone: 'error' });
  };

  const newest = newestEntries(entries);

  return (
    <div className="settings-page">
      <h2>Plugins &amp; skills</h2>
      <InstalledSection
        plugins={plugins}
        error={error}
        newest={newest}
        loadingPreview={loadingPreview}
        onRetry={() => setVersion((v) => v + 1)}
        onUpdate={(e) => void fromCatalog(e)}
        onChanged={changed}
        onReplace={(p) => {
          setPlugins((list) => list?.map((x) => (x.id === p.id ? p : x)) ?? null);
          setChanges((c) => c + 1);
        }}
      />
      <CatalogSection
        installedKey={plugins?.map((p) => `${p.id}@${p.version}`).join(',') ?? ''}
        onEntries={setEntries}
        loadingPreview={loadingPreview}
        onInstall={(e) => void fromCatalog(e)}
      />
      <LocalInstall
        onPreview={(source) => preview(source, 'local')}
        busy={loadingPreview === 'local'}
      />
      <SkillsSection version={changes} />
      <HooksSection version={changes} />
      {previewing ? (
        <PluginPreviewDialog
          preview={previewing.preview}
          current={previewing.current}
          onClose={() => setPreviewing(null)}
          onInstalled={(p) => {
            const update = previewing.preview.replaces !== null;
            setPreviewing(null);
            toast.show(
              `${p.name} ${p.version} ${update ? 'updated' : 'installed'}${p.status === 'needs_trust' ? '. Some hooks still need your trust' : ''}.`,
              { tone: 'success' },
            );
            changed();
          }}
        />
      ) : null}
    </div>
  );
}

// ---- installed plugins ---------------------------------------------------------------------

function InstalledSection({
  plugins,
  error,
  newest,
  loadingPreview,
  onRetry,
  onUpdate,
  onChanged,
  onReplace,
}: {
  plugins: PluginView[] | null;
  error: string | null;
  newest: Map<string, CatalogEntryView>;
  loadingPreview: string | null;
  onRetry: () => void;
  onUpdate: (e: CatalogEntryView) => void;
  onChanged: () => void;
  onReplace: (p: PluginView) => void;
}) {
  const { api } = useServices();
  const toast = useToast();
  const [removing, setRemoving] = useState<PluginView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const toggle = async (p: PluginView, on: boolean) => {
    setBusy(p.id);
    try {
      onReplace(await api.updatePlugin(p.id, { enabled: on }));
      toast.show(
        on ? `${p.name} turned on.` : `${p.name} turned off. Its servers and hooks stopped.`,
        {
          tone: 'success',
        },
      );
    } catch (err) {
      toast.show(`Could not change ${p.name}: ${errorMessage(err)}`, { tone: 'error' });
    } finally {
      setBusy(null);
    }
  };

  const uninstall = async (p: PluginView) => {
    setRemoving(null);
    try {
      await api.uninstallPlugin(p.id);
      toast.show(`${p.name} uninstalled.`, { tone: 'success' });
      onChanged();
    } catch (err) {
      toast.show(`Could not uninstall ${p.name}: ${errorMessage(err)}`, { tone: 'error' });
    }
  };

  return (
    <section className="settings-section" aria-labelledby="plugins-installed">
      <h3 id="plugins-installed">Installed plugins</h3>
      <p className="muted">
        Plugins bring skills, commands, MCP servers, hooks and app screens. Each one runs within the
        permissions you confirmed when you installed it.
      </p>
      {error ? (
        <div role="alert" className="ws-error">
          <p>{error}</p>
          <Button onClick={onRetry}>Retry</Button>
        </div>
      ) : null}
      {plugins === null && !error ? <Spinner label="Loading plugins" /> : null}
      {plugins?.length === 0 ? (
        <EmptyState
          level={3}
          title="No plugins installed"
          description="Browse a catalog below, or install one from a folder on the Hub."
        />
      ) : null}
      {plugins?.length ? (
        <ul className="ws-list" aria-label="Installed plugins">
          {plugins.map((p) => {
            const s = PLUGIN_STATUS[p.status];
            const entry = newest.get(p.id);
            const update = entry && compareVersions(entry.version, p.version) > 0 ? entry : null;
            return (
              <li key={p.id} className="ws-list-row" aria-label={p.name}>
                <div className="ws-source-main">
                  <span className="ws-row-meta">
                    <strong>{p.name}</strong>
                    <span className="muted">{p.version}</span>
                    <StateChip {...s} />
                    <VerifiedBadge verified={p.verified} />
                  </span>
                  {p.description ? <span className="muted">{p.description}</span> : null}
                  <span className="muted ws-row-meta">
                    {componentsText(p.components)}
                    {p.author ? ` · by ${p.author}` : ''} · installed {formatWhen(p.installedAt)}
                  </span>
                  <code className="ws-code-inline">{p.origin}</code>
                  {p.error ? (
                    <p className="ws-warning">
                      <Icon name="alert" /> <span>{p.error}</span>
                    </p>
                  ) : null}
                  <details className="ws-advanced">
                    <summary>Permissions</summary>
                    <ul className="ws-plain-list">
                      {permissionLines(p.permissions).map((l) => (
                        <li key={l}>{l}</li>
                      ))}
                    </ul>
                  </details>
                </div>
                <div className="row ws-row-actions">
                  <Switch
                    label={`Turn on ${p.name}`}
                    checked={p.enabled}
                    disabled={busy === p.id}
                    onChange={(v) => void toggle(p, v)}
                  />
                  {update ? (
                    <Button
                      onClick={() => onUpdate(update)}
                      disabled={loadingPreview !== null}
                      aria-label={`Update ${p.name} to ${update.version}`}
                    >
                      {loadingPreview === `${update.catalogId}/${update.pluginId}` ? (
                        <Spinner />
                      ) : null}{' '}
                      Update to {update.version}
                    </Button>
                  ) : null}
                  <Button variant="ghost" onClick={() => setRemoving(p)}>
                    Uninstall
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
      <Dialog
        open={removing !== null}
        title={removing ? `Uninstall ${removing.name}?` : 'Uninstall this plugin?'}
        description="Its skills, commands, agent roles, hooks, MCP servers and app screens are removed. Chats that used them are kept."
        onClose={() => setRemoving(null)}
        footer={
          <>
            <Button onClick={() => setRemoving(null)}>Cancel</Button>
            <Button variant="danger" onClick={() => removing && void uninstall(removing)}>
              Uninstall
            </Button>
          </>
        }
      />
    </section>
  );
}

// ---- catalogs ----------------------------------------------------------------------------------

const CATALOG_KIND: Record<CatalogView['kind'], string> = {
  local: 'folder on the Hub',
  url: 'web address',
  git: 'Git repository',
};

function CatalogSection({
  installedKey,
  onEntries,
  loadingPreview,
  onInstall,
}: {
  /** Changes when the installed set changes, so installed versions are fetched again. */
  installedKey: string;
  onEntries: (e: CatalogEntryView[]) => void;
  loadingPreview: string | null;
  onInstall: (e: CatalogEntryView) => void;
}) {
  const { api } = useServices();
  const [catalogs, setCatalogs] = useState<CatalogView[] | null>(null);
  const [q, setQ] = useState('');
  const [entries, setEntries] = useState<CatalogEntryView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  const [sourcesVersion, setSourcesVersion] = useState(0);

  useEffect(() => {
    let alive = true;
    api.listCatalogs().then(
      ({ items }) => alive && setCatalogs(items),
      () => alive && setCatalogs([]),
    );
    return () => {
      alive = false;
    };
  }, [api, sourcesVersion]);

  const query = q.trim();
  useEffect(() => {
    let alive = true;
    api.searchCatalog(query).then(
      ({ items }) => {
        if (!alive) return;
        setEntries(items);
        setError(null);
        // Update offers use the full list, not a filtered one.
        if (!query) onEntries(items);
      },
      (err: unknown) => alive && setError(errorMessage(err, 'Could not search the catalogs.')),
    );
    return () => {
      alive = false;
    };
  }, [api, query, installedKey, retry, sourcesVersion, onEntries]);

  const names = new Map((catalogs ?? []).map((c) => [c.id, c.name]));

  return (
    <section className="settings-section" aria-labelledby="plugins-catalog">
      <h3 id="plugins-catalog">Catalog</h3>
      {catalogs?.length ? (
        <p className="muted">
          From{' '}
          {catalogs.map((c, i) => (
            <span key={c.id}>
              {i ? ', ' : ''}
              {c.name} ({CATALOG_KIND[c.kind]})
            </span>
          ))}
          .
        </p>
      ) : catalogs ? (
        <p className="muted">No catalogs are set up. You can still install from a folder.</p>
      ) : null}
      <CatalogSources onChanged={() => setSourcesVersion((v) => v + 1)} />
      <TextField
        label="Search plugins"
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {error ? (
        <div role="alert" className="ws-error">
          <p>{error}</p>
          <Button onClick={() => setRetry((r) => r + 1)}>Retry</Button>
        </div>
      ) : null}
      {entries === null && !error ? <Spinner label="Loading the catalog" /> : null}
      {entries?.length === 0 ? (
        <p className="muted">
          {query ? `No plugins match “${query}”.` : 'The catalogs are empty.'}
        </p>
      ) : null}
      {entries?.length ? (
        <ul className="ws-list" aria-label="Catalog plugins">
          {entries.map((e) => {
            const key = `${e.catalogId}/${e.pluginId}`;
            const newer =
              e.installedVersion !== null && compareVersions(e.version, e.installedVersion) > 0;
            return (
              <li key={`${key}@${e.version}`} className="ws-list-row" aria-label={e.name}>
                <div className="ws-source-main">
                  <span className="ws-row-meta">
                    <strong>{e.name}</strong>
                    <span className="muted">{e.version}</span>
                    <VerifiedBadge verified={e.verified} />
                    <span className="muted">{names.get(e.catalogId) ?? e.catalogId}</span>
                  </span>
                  {e.description ? <span className="muted">{e.description}</span> : null}
                  {e.installedVersion ? (
                    <span className="muted">Installed: {e.installedVersion}</span>
                  ) : null}
                </div>
                <div className="row ws-row-actions">
                  {e.installedVersion === null || newer ? (
                    <Button
                      variant={newer ? 'default' : 'primary'}
                      disabled={loadingPreview !== null}
                      aria-label={`${newer ? 'Update' : 'Install'} ${e.name}`}
                      onClick={() => onInstall(e)}
                    >
                      {loadingPreview === key ? <Spinner /> : null} {newer ? 'Update' : 'Install'}
                    </Button>
                  ) : (
                    <span className="muted">Installed</span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

/** A catalog id from its name: lowercase words joined by hyphens, unique among `taken`. */
export function catalogId(name: string, taken: readonly string[]): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 34) || 'catalog';
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
}

function isHttps(v: string): boolean {
  try {
    return new URL(v).protocol === 'https:';
  } catch {
    return false;
  }
}

/** A folder on the Hub, an https URL or a Git URL (docs/14 §5). */
export function isCatalogLocation(v: string): boolean {
  return isAbsolutePath(v) || isHttps(v);
}

/** The user's own catalogs (`plugins.catalogs`); the built-in sample catalog is always listed. */
function CatalogSources({ onChanged }: { onChanged: () => void }) {
  const settings = useSettings();
  const toast = useToast();
  const entry = settings.get('plugins.catalogs');
  const [name, setName] = useState('');
  const [location, setLocation] = useState('');
  const [error, setError] = useState<string | null>(null);

  const save = (next: typeof entry.value, done: string) =>
    settings.set('plugins.catalogs', next).then(
      () => {
        toast.show(done, { tone: 'success' });
        onChanged();
        return true;
      },
      (err: unknown) => {
        toast.show(`Could not save the catalogs: ${errorMessage(err)}`, { tone: 'error' });
        return false;
      },
    );

  const add = async () => {
    const n = name.trim();
    const loc = location.trim();
    if (!n) return setError('Enter a name for the catalog.');
    if (!isCatalogLocation(loc))
      return setError('Enter a full folder path on the Hub or an https:// address.');
    setError(null);
    const id = catalogId(
      n,
      entry.value.map((c) => c.id),
    );
    if (await save([...entry.value, { id, name: n, location: loc }], `${n} added.`)) {
      setName('');
      setLocation('');
    }
  };

  return (
    <details className="ws-advanced">
      <summary>Your catalogs</summary>
      <div className="stack">
        {entry.locked ? <p className="muted">{MANAGED}.</p> : null}
        {entry.value.length ? (
          <ul className="ws-list" aria-label="Your catalogs">
            {entry.value.map((c) => (
              <li key={c.id} className="ws-list-row" aria-label={c.name}>
                <div className="ws-source-main">
                  <strong>{c.name}</strong>
                  <code className="ws-code-inline">{c.location}</code>
                </div>
                <Button
                  variant="ghost"
                  disabled={entry.locked}
                  aria-label={`Remove ${c.name}`}
                  onClick={() =>
                    void save(
                      entry.value.filter((x) => x.id !== c.id),
                      `${c.name} removed.`,
                    )
                  }
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">You have not added a catalog.</p>
        )}
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <TextField
            label="Catalog name"
            value={name}
            maxLength={100}
            disabled={entry.locked}
            onChange={(e) => setName(e.target.value)}
          />
          <TextField
            label="Catalog location"
            value={location}
            spellCheck={false}
            disabled={entry.locked}
            placeholder="/srv/catalog or https://catalog.example.com"
            hint="A folder on the Hub, an https:// address or an https:// Git repository."
            onChange={(e) => setLocation(e.target.value)}
          />
          {error ? (
            <p role="alert" className="nv-field-error">
              {error}
            </p>
          ) : null}
          <div className="row">
            <Button type="submit" disabled={entry.locked}>
              Add catalog
            </Button>
          </div>
        </form>
      </div>
    </details>
  );
}

// ---- install from a folder or Git ----------------------------------------------------------------

function LocalInstall({
  onPreview,
  busy,
}: {
  onPreview: (source: PluginSourceRequest) => Promise<string | null>;
  busy: boolean;
}) {
  const [kind, setKind] = useState<'path' | 'git'>('path');
  const [path, setPath] = useState('');
  const [url, setUrl] = useState('');
  const [ref, setRef] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    let source: PluginSourceRequest;
    if (kind === 'path') {
      const p = path.trim();
      if (!isAbsolutePath(p)) {
        setError(
          'Enter the full path of the plugin folder on the Hub, for example /home/me/plugins/notes.',
        );
        return;
      }
      source = { kind: 'path', path: p };
    } else {
      const u = url.trim();
      if (!isHttps(u)) {
        setError('Enter an https:// Git address.');
        return;
      }
      source = ref.trim() ? { kind: 'git', url: u, ref: ref.trim() } : { kind: 'git', url: u };
    }
    const failed = await onPreview(source);
    if (failed) setError(failed);
  };

  return (
    <section className="settings-section" aria-labelledby="plugins-local">
      <h3 id="plugins-local">Install from a folder or Git</h3>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <SelectField
          label="Where the plugin is"
          value={kind}
          onChange={(v) => {
            setKind(v as 'path' | 'git');
            setError(null);
          }}
          options={[
            { value: 'path', label: 'A folder on the Hub' },
            { value: 'git', label: 'A Git repository' },
          ]}
        />
        {kind === 'path' ? (
          <TextField
            label="Plugin folder"
            value={path}
            spellCheck={false}
            placeholder="/home/me/plugins/notes"
            hint="The folder that contains .nova-plugin/plugin.json."
            onChange={(e) => setPath(e.target.value)}
          />
        ) : (
          <>
            <TextField
              label="Git address"
              type="url"
              value={url}
              spellCheck={false}
              placeholder="https://git.example.com/me/notes-plugin.git"
              onChange={(e) => setUrl(e.target.value)}
            />
            <TextField
              label="Branch, tag or commit (optional)"
              value={ref}
              spellCheck={false}
              onChange={(e) => setRef(e.target.value)}
            />
          </>
        )}
        {error ? (
          <p role="alert" className="nv-field-error">
            {error}
          </p>
        ) : null}
        <div className="row">
          <Button type="submit" disabled={busy}>
            {busy ? <Spinner /> : null} Preview
          </Button>
        </div>
        <p className="muted">You see what it can do before anything is installed.</p>
      </form>
    </section>
  );
}
