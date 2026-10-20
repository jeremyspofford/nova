// Settings → Plugins & skills (FR-045, FR-046, FR-197; docs/14 §5, docs/04 §2.10): installed
// plugins (status, permissions, on/off, update, uninstall), the catalogs with search, installing
// from a catalog, a folder on the Hub or a Git URL through a preview, the skills list and the
// hooks list with trust by content hash.
import { useEffect, useState } from 'react';
import { defineMessages, fmt } from '@nova/i18n';
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
import { ManagedNote } from '../managed/ManagedNote.tsx';
import { useServices } from '../services.tsx';
import { useSettings } from '../settings.tsx';
import { StateChip, VerifiedBadge } from './badges.tsx';
import { formatWhen } from './common.ts';
import { HooksSection } from './HooksSection.tsx';
import { isAbsolutePath } from './PermissionsPage.tsx';
import { PluginPreviewDialog } from './PluginInstall.tsx';
import { PLUGIN_STATUS, compareVersions, permissionLines } from './plugin-text.ts';
import { SkillsSection } from './SkillsSection.tsx';
import '../workspace.css';

type Previewing = { preview: PluginPreview; current: PluginView | null };

export const PLUGINS_TEXT = defineMessages('settings.plugins', {
  components: {
    skills: '{n, plural, one {# skill} other {# skills}}',
    commands: '{n, plural, one {# command} other {# commands}}',
    agents: '{n, plural, one {# agent role} other {# agent roles}}',
    hooks: '{n, plural, one {# hook} other {# hooks}}',
    mcpServers: '{n, plural, one {# MCP server} other {# MCP servers}}',
    uiEntryPoints: '{n, plural, one {# app screen} other {# app screens}}',
    none: 'No components',
  },
  loadFailed: 'Could not load plugins.',
  readFailed: 'Could not read the plugin.',
  previewFailed: 'Could not preview {name}: {error}',
  title: 'Plugins & skills',
  done: '{action, select, update {{name} updated.} other {{name} installed.}}',
  doneNeedsTrust:
    '{action, select, update {{name} updated. Some hooks still need your trust.} other {{name} installed. Some hooks still need your trust.}}',
  turnedOn: '{name} turned on.',
  turnedOff: '{name} turned off. Its servers and hooks stopped.',
  changeFailed: 'Could not change {name}: {error}',
  uninstalled: '{name} uninstalled.',
  uninstallFailed: 'Could not uninstall {name}: {error}',
  installed: 'Installed plugins',
  installedHint:
    'Plugins bring skills, commands, MCP servers, hooks and app screens. Each one runs within ' +
    'the permissions you confirmed when you installed it.',
  retry: 'Retry',
  loading: 'Loading plugins',
  none: 'No plugins installed',
  noneHint: 'Browse a catalog below, or install one from a folder on the Hub.',
  by: 'by {author}',
  installedAt: 'installed {when}',
  permissions: 'Permissions',
  turnOn: 'Turn on {name}',
  updateTo: 'Update {name} to {version}',
  updateToShort: 'Update to {version}',
  uninstall: 'Uninstall',
  uninstallTitle: 'Uninstall {name}?',
  uninstallThis: 'Uninstall this plugin?',
  uninstallBody:
    'Its skills, commands, agent roles, hooks, MCP servers and app screens are removed. Chats ' +
    'that used them are kept.',
  cancel: 'Cancel',
  catalogKind: { local: 'folder on the Hub', url: 'web address', git: 'Git repository' },
  searchFailed: 'Could not search the catalogs.',
  catalog: 'Catalog',
  from: 'From {catalogs}.',
  catalogItem: '{name} ({kind})',
  noCatalogs: 'No catalogs are set up. You can still install from a folder.',
  search: 'Search plugins',
  loadingCatalog: 'Loading the catalog',
  noMatch: 'No plugins match “{query}”.',
  catalogsEmpty: 'The catalogs are empty.',
  catalogPlugins: 'Catalog plugins',
  installedVersion: 'Installed: {version}',
  installName: '{action, select, update {Update {name}} other {Install {name}}}',
  update: 'Update',
  install: 'Install',
  isInstalled: 'Installed',
  catalogsSaveFailed: 'Could not save the catalogs: {error}',
  needCatalogName: 'Enter a name for the catalog.',
  needLocation: 'Enter a full folder path on the Hub or an https:// address.',
  added: '{name} added.',
  removed: '{name} removed.',
  yourCatalogs: 'Your catalogs',
  removeName: 'Remove {name}',
  remove: 'Remove',
  noOwnCatalogs: 'You have not added a catalog.',
  catalogName: 'Catalog name',
  catalogLocation: 'Catalog location',
  catalogLocationExample: '/srv/catalog or https://catalog.example.com',
  catalogLocationHint: 'A folder on the Hub, an https:// address or an https:// Git repository.',
  addCatalog: 'Add catalog',
  needPath:
    'Enter the full path of the plugin folder on the Hub, for example /home/me/plugins/notes.',
  needGit: 'Enter an https:// Git address.',
  local: 'Install from a folder or Git',
  where: 'Where the plugin is',
  aFolder: 'A folder on the Hub',
  aGit: 'A Git repository',
  folder: 'Plugin folder',
  folderExample: '/home/me/plugins/notes',
  folderHint: 'The folder that contains .nova-plugin/plugin.json.',
  git: 'Git address',
  gitExample: 'https://git.example.com/me/notes-plugin.git',
  ref: 'Branch, tag or commit (optional)',
  preview: 'Preview',
  previewHint: 'You see what it can do before anything is installed.',
});
const S = PLUGINS_TEXT;

/** "2 skills · 1 hook · 1 MCP server"; parts with zero are left out. */
export function componentsText(c: PluginView['components']): string {
  const C = S.components;
  const parts = [
    c.skills ? C.skills({ n: c.skills }) : null,
    c.commands ? C.commands({ n: c.commands }) : null,
    c.agents ? C.agents({ n: c.agents }) : null,
    c.hooks ? C.hooks({ n: c.hooks }) : null,
    c.mcpServers ? C.mcpServers({ n: c.mcpServers }) : null,
    c.uiEntryPoints ? C.uiEntryPoints({ n: c.uiEntryPoints }) : null,
  ].filter((p): p is string => p !== null);
  return parts.length ? parts.join(' · ') : C.none;
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
      (err: unknown) => alive && setError(errorMessage(err, S.loadFailed)),
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
      return errorMessage(err, S.readFailed);
    } finally {
      setLoadingPreview(null);
    }
  };

  const fromCatalog = async (e: CatalogEntryView) => {
    const failed = await preview(
      { kind: 'catalog', catalogId: e.catalogId, pluginId: e.pluginId, version: e.version },
      `${e.catalogId}/${e.pluginId}`,
    );
    if (failed) toast.show(S.previewFailed({ name: e.name, error: failed }), { tone: 'error' });
  };

  const newest = newestEntries(entries);

  return (
    <div className="settings-page">
      <h2>{S.title}</h2>
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
      {/* A plugin's status says whether its hooks still need trust, so trust reloads the list. */}
      <HooksSection version={changes} onTrustChanged={() => setVersion((v) => v + 1)} />
      {previewing ? (
        <PluginPreviewDialog
          preview={previewing.preview}
          current={previewing.current}
          onClose={() => setPreviewing(null)}
          onInstalled={(p) => {
            const update = previewing.preview.replaces !== null;
            setPreviewing(null);
            const done = { action: update ? 'update' : 'install', name: `${p.name} ${p.version}` };
            toast.show(p.status === 'needs_trust' ? S.doneNeedsTrust(done) : S.done(done), {
              tone: 'success',
            });
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
      toast.show(on ? S.turnedOn({ name: p.name }) : S.turnedOff({ name: p.name }), {
        tone: 'success',
      });
    } catch (err) {
      toast.show(S.changeFailed({ name: p.name, error: errorMessage(err) }), { tone: 'error' });
    } finally {
      setBusy(null);
    }
  };

  const uninstall = async (p: PluginView) => {
    setRemoving(null);
    try {
      await api.uninstallPlugin(p.id);
      toast.show(S.uninstalled({ name: p.name }), { tone: 'success' });
      onChanged();
    } catch (err) {
      toast.show(S.uninstallFailed({ name: p.name, error: errorMessage(err) }), { tone: 'error' });
    }
  };

  return (
    <section className="settings-section" aria-labelledby="plugins-installed">
      <h3 id="plugins-installed">{S.installed}</h3>
      <p className="muted">{S.installedHint}</p>
      {error ? (
        <div role="alert" className="ws-error">
          <p>{error}</p>
          <Button onClick={onRetry}>{S.retry}</Button>
        </div>
      ) : null}
      {plugins === null && !error ? <Spinner label={S.loading} /> : null}
      {plugins?.length === 0 ? (
        <EmptyState level={3} title={S.none} description={S.noneHint} />
      ) : null}
      {plugins?.length ? (
        <ul className="ws-list" aria-label={S.installed}>
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
                  {p.description ? (
                    <span className="muted" dir="auto">
                      {p.description}
                    </span>
                  ) : null}
                  <span className="muted ws-row-meta">
                    {componentsText(p.components)}
                    {p.author ? ` · ${S.by({ author: p.author })}` : ''}
                    {' · '}
                    {S.installedAt({ when: formatWhen(p.installedAt) })}
                  </span>
                  <code className="ws-code-inline" dir="ltr">
                    {p.origin}
                  </code>
                  {p.error ? (
                    <p className="ws-warning">
                      <Icon name="alert" /> <span>{p.error}</span>
                    </p>
                  ) : null}
                  <details className="ws-advanced">
                    <summary>{S.permissions}</summary>
                    <ul className="ws-plain-list">
                      {permissionLines(p.permissions).map((l) => (
                        <li key={l}>{l}</li>
                      ))}
                    </ul>
                  </details>
                </div>
                <div className="row ws-row-actions">
                  <Switch
                    label={S.turnOn({ name: p.name })}
                    checked={p.enabled}
                    disabled={busy === p.id}
                    onChange={(v) => void toggle(p, v)}
                  />
                  {update ? (
                    <Button
                      onClick={() => onUpdate(update)}
                      disabled={loadingPreview !== null}
                      aria-label={S.updateTo({ name: p.name, version: update.version })}
                    >
                      {loadingPreview === `${update.catalogId}/${update.pluginId}` ? (
                        <Spinner />
                      ) : null}{' '}
                      {S.updateToShort({ version: update.version })}
                    </Button>
                  ) : null}
                  <Button variant="ghost" onClick={() => setRemoving(p)}>
                    {S.uninstall}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
      <Dialog
        open={removing !== null}
        title={removing ? S.uninstallTitle({ name: removing.name }) : S.uninstallThis}
        description={S.uninstallBody}
        onClose={() => setRemoving(null)}
        footer={
          <>
            <Button onClick={() => setRemoving(null)}>{S.cancel}</Button>
            <Button variant="danger" onClick={() => removing && void uninstall(removing)}>
              {S.uninstall}
            </Button>
          </>
        }
      />
    </section>
  );
}

// ---- catalogs ----------------------------------------------------------------------------------

const CATALOG_KIND: Readonly<Record<CatalogView['kind'], string>> = S.catalogKind;

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
      (err: unknown) => alive && setError(errorMessage(err, S.searchFailed)),
    );
    return () => {
      alive = false;
    };
  }, [api, query, installedKey, retry, sourcesVersion, onEntries]);

  const names = new Map((catalogs ?? []).map((c) => [c.id, c.name]));

  return (
    <section className="settings-section" aria-labelledby="plugins-catalog">
      <h3 id="plugins-catalog">{S.catalog}</h3>
      {catalogs?.length ? (
        <p className="muted">
          {S.from({
            catalogs: fmt.list(
              catalogs.map((c) => S.catalogItem({ name: c.name, kind: CATALOG_KIND[c.kind] })),
              { type: 'unit' },
            ),
          })}
        </p>
      ) : catalogs ? (
        <p className="muted">{S.noCatalogs}</p>
      ) : null}
      <CatalogSources onChanged={() => setSourcesVersion((v) => v + 1)} />
      <TextField label={S.search} type="search" value={q} onChange={(e) => setQ(e.target.value)} />
      {error ? (
        <div role="alert" className="ws-error">
          <p>{error}</p>
          <Button onClick={() => setRetry((r) => r + 1)}>{S.retry}</Button>
        </div>
      ) : null}
      {entries === null && !error ? <Spinner label={S.loadingCatalog} /> : null}
      {entries?.length === 0 ? (
        <p className="muted">{query ? S.noMatch({ query }) : S.catalogsEmpty}</p>
      ) : null}
      {entries?.length ? (
        <ul className="ws-list" aria-label={S.catalogPlugins}>
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
                  {e.description ? (
                    <span className="muted" dir="auto">
                      {e.description}
                    </span>
                  ) : null}
                  {e.installedVersion ? (
                    <span className="muted">
                      {S.installedVersion({ version: e.installedVersion })}
                    </span>
                  ) : null}
                </div>
                <div className="row ws-row-actions">
                  {e.installedVersion === null || newer ? (
                    <Button
                      variant={newer ? 'default' : 'primary'}
                      disabled={loadingPreview !== null}
                      aria-label={S.installName({
                        action: newer ? 'update' : 'install',
                        name: e.name,
                      })}
                      onClick={() => onInstall(e)}
                    >
                      {loadingPreview === key ? <Spinner /> : null} {newer ? S.update : S.install}
                    </Button>
                  ) : (
                    <span className="muted">{S.isInstalled}</span>
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
        toast.show(S.catalogsSaveFailed({ error: errorMessage(err) }), { tone: 'error' });
        return false;
      },
    );

  const add = async () => {
    const n = name.trim();
    const loc = location.trim();
    if (!n) return setError(S.needCatalogName);
    if (!isCatalogLocation(loc)) return setError(S.needLocation);
    setError(null);
    const id = catalogId(
      n,
      entry.value.map((c) => c.id),
    );
    if (await save([...entry.value, { id, name: n, location: loc }], S.added({ name: n }))) {
      setName('');
      setLocation('');
    }
  };

  return (
    <details className="ws-advanced">
      <summary>{S.yourCatalogs}</summary>
      <div className="stack">
        {entry.locked ? <ManagedNote as="p" id="catalogs-lock" setting="plugins.catalogs" /> : null}
        {entry.value.length ? (
          <ul
            className="ws-list"
            aria-label={S.yourCatalogs}
            aria-describedby={entry.locked ? 'catalogs-lock' : undefined}
          >
            {entry.value.map((c) => (
              <li key={c.id} className="ws-list-row" aria-label={c.name}>
                <div className="ws-source-main">
                  <strong>{c.name}</strong>
                  <code className="ws-code-inline" dir="ltr">
                    {c.location}
                  </code>
                </div>
                <Button
                  variant="ghost"
                  disabled={entry.locked}
                  aria-label={S.removeName({ name: c.name })}
                  onClick={() =>
                    void save(
                      entry.value.filter((x) => x.id !== c.id),
                      S.removed({ name: c.name }),
                    )
                  }
                >
                  {S.remove}
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">{S.noOwnCatalogs}</p>
        )}
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <TextField
            label={S.catalogName}
            value={name}
            maxLength={100}
            disabled={entry.locked}
            aria-describedby={entry.locked ? 'catalogs-lock' : undefined}
            onChange={(e) => setName(e.target.value)}
          />
          <TextField
            label={S.catalogLocation}
            value={location}
            spellCheck={false}
            disabled={entry.locked}
            placeholder={S.catalogLocationExample}
            hint={S.catalogLocationHint}
            onChange={(e) => setLocation(e.target.value)}
          />
          {error ? (
            <p role="alert" className="nv-field-error">
              {error}
            </p>
          ) : null}
          <div className="row">
            <Button type="submit" disabled={entry.locked}>
              {S.addCatalog}
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
        setError(S.needPath);
        return;
      }
      source = { kind: 'path', path: p };
    } else {
      const u = url.trim();
      if (!isHttps(u)) {
        setError(S.needGit);
        return;
      }
      source = ref.trim() ? { kind: 'git', url: u, ref: ref.trim() } : { kind: 'git', url: u };
    }
    const failed = await onPreview(source);
    if (failed) setError(failed);
  };

  return (
    <section className="settings-section" aria-labelledby="plugins-local">
      <h3 id="plugins-local">{S.local}</h3>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <SelectField
          label={S.where}
          value={kind}
          onChange={(v) => {
            setKind(v as 'path' | 'git');
            setError(null);
          }}
          options={[
            { value: 'path', label: S.aFolder },
            { value: 'git', label: S.aGit },
          ]}
        />
        {kind === 'path' ? (
          <TextField
            label={S.folder}
            value={path}
            spellCheck={false}
            placeholder={S.folderExample}
            hint={S.folderHint}
            onChange={(e) => setPath(e.target.value)}
          />
        ) : (
          <>
            <TextField
              label={S.git}
              type="url"
              value={url}
              spellCheck={false}
              placeholder={S.gitExample}
              onChange={(e) => setUrl(e.target.value)}
            />
            <TextField
              label={S.ref}
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
            {busy ? <Spinner /> : null} {S.preview}
          </Button>
        </div>
        <p className="muted">{S.previewHint}</p>
      </form>
    </section>
  );
}
