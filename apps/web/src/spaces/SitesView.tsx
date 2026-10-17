// Sites (FR-037): a site is generated from a space or an artifact, with JSON or CSV project
// sources connected as data. Each build is a version: preview it (sandboxed, never same-origin;
// an HTML artifact's own scripts may run there), download it as a zip, or publish it to a folder
// on the Hub or as a zip. Publishing always asks first and can be undone: unpublishing brings
// back what was live before, and publishing an earlier version rolls the site back.
import { useEffect, useId, useRef, useState } from 'react';
import type {
  SiteDataConnection,
  SiteDataSourceView,
  SitePublishResult,
  SitePublishView,
  SiteTarget,
  SiteVersionView,
  SiteView,
  SpaceView,
} from '@nova/shared';
import {
  Button,
  Dialog,
  EmptyState,
  Icon,
  RadioGroup,
  SelectField,
  Spinner,
  TextField,
  useToast,
} from '@nova/ui';
import { ApiError, errorMessage } from '../api.ts';
import { formatBytes } from '../chat/attachments.ts';
import { navigate } from '../router.ts';
import { useAnnounce } from '../services.tsx';
import { formatWhen, plural } from '../settings/common.ts';
import { useDebounced } from '../work/events.ts';
import { followLink } from '../work/nav.tsx';
import { useSpacesApi } from './api.ts';
import { eventIds, SITES_EVENTS, useHubEvents } from './events.ts';
import {
  conflictReason,
  DATA_NAME_RE,
  FOLDER_RE,
  sitePath,
  slugName,
  targetText,
} from './format.ts';
import '../workspace.css';
import '../work/work.css';
import './spaces.css';

export function SitesView({ siteId }: { siteId: string | null }) {
  return siteId ? <SiteDetail key={siteId} siteId={siteId} /> : <SiteList />;
}

export function sourceText(s: Pick<SiteView, 'source' | 'sourceLabel'>): string {
  const kind = s.source.kind === 'space' ? 'space' : 'artifact';
  return s.sourceLabel ? `From the ${kind} “${s.sourceLabel}”` : `From a ${kind} that is gone`;
}

export function publishedText(s: SiteView): string {
  if (s.publishedVersion === null || !s.publishedTarget) return 'Not published';
  return `Version ${s.publishedVersion} published ${targetText(s.publishedTarget)}`;
}

/** Start a download the browser saves (a same-origin link with a file name). */
export function startDownload(href: string, name: string): void {
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function Breadcrumb() {
  return (
    <nav aria-label="Breadcrumb" className="ws-breadcrumb">
      <a href={sitePath()} onClick={(e) => followLink(e, sitePath())}>
        <Icon name="back" /> Sites
      </a>
    </nav>
  );
}

// ---- the list -------------------------------------------------------------------------------

function SiteList() {
  const api = useSpacesApi();
  const [items, setItems] = useState<SiteView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let alive = true;
    api.listSites().then(
      ({ items: list }) => {
        if (!alive) return;
        setItems(list);
        setError(null);
      },
      (err: unknown) => alive && setError(errorMessage(err, 'Could not load your sites.')),
    );
    return () => {
      alive = false;
    };
  }, [api, attempt]);

  const reload = useDebounced(() => setAttempt((n) => n + 1), 150);
  useHubEvents(SITES_EVENTS, reload);

  return (
    <div className="ws-page sites-page">
      <header className="ws-page-header">
        <h1>Sites</h1>
        <Button variant="primary" onClick={() => setCreating(true)}>
          <Icon name="plus" /> New site
        </Button>
      </header>
      <p className="muted ws-flush">
        A site turns a space or an artifact into web pages you can preview, download as a zip, or
        publish to a folder. Publishing is always your choice, and you can undo it.
      </p>
      {error ? (
        <div role="alert" className="ws-error">
          <p>{error}</p>
          <Button onClick={() => setAttempt((n) => n + 1)}>Retry</Button>
        </div>
      ) : null}
      {items === null && !error ? <Spinner label="Loading sites" /> : null}
      {items?.length === 0 ? (
        <EmptyState
          title="No sites yet"
          description="Make a site from a space, then build, preview and publish it."
          icon="external"
          level={2}
          action={<Button onClick={() => setCreating(true)}>Create a site</Button>}
        />
      ) : null}
      {items?.length ? (
        <ul className="ws-list" aria-label="Sites">
          {items.map((s) => (
            <li key={s.id} className="ws-list-row">
              <div className="spaces-row-main">
                <a
                  href={sitePath(s.id)}
                  className="ws-card-link"
                  onClick={(e) => followLink(e, sitePath(s.id))}
                >
                  {s.name}
                </a>
                <span className="muted ws-row-meta">
                  <span>{sourceText(s)}</span>
                  <span>
                    {s.latestVersion === null ? 'Not built yet' : `Version ${s.latestVersion}`}
                  </span>
                  <span>{publishedText(s)}</span>
                </span>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {creating ? (
        <SiteDialog
          onClose={() => setCreating(false)}
          onSaved={(s) => {
            setCreating(false);
            navigate(sitePath(s.id));
          }}
        />
      ) : null}
    </div>
  );
}

// ---- data connections -----------------------------------------------------------------------

/** The first problem with each connection's name, by source id. */
export function dataErrors(list: SiteDataConnection[]): Map<string, string> {
  const out = new Map<string, string>();
  const seen = new Map<string, number>();
  for (const d of list) seen.set(d.name, (seen.get(d.name) ?? 0) + 1);
  for (const d of list) {
    if (!DATA_NAME_RE.test(d.name))
      out.set(
        d.sourceId,
        'Use lowercase letters, digits, - and _ (up to 40), starting with a letter or digit.',
      );
    else if ((seen.get(d.name) ?? 0) > 1)
      out.set(d.sourceId, 'Each connection needs its own name.');
  }
  return out;
}

function DataPicker({
  value,
  onChange,
}: {
  value: SiteDataConnection[];
  onChange: (next: SiteDataConnection[]) => void;
}) {
  const api = useSpacesApi();
  const [sources, setSources] = useState<SiteDataSourceView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api.listSiteDataSources().then(
      ({ items }) => alive && setSources(items),
      (err: unknown) => alive && setError(errorMessage(err, 'Could not load the data sources.')),
    );
    return () => {
      alive = false;
    };
  }, [api]);
  const errors = dataErrors(value);
  const known = new Set(sources?.map((s) => s.id));
  // Connections whose source is gone stay listed so they can be removed.
  const orphans = sources ? value.filter((d) => !known.has(d.sourceId)) : [];
  return (
    <fieldset className="ws-fieldset">
      <legend>Connected data (optional)</legend>
      <p className="nv-field-hint">
        JSON and CSV sources from your projects. Pages read them by name, for example in a
        nova-table block or a chart’s data.
      </p>
      {error ? (
        <p role="alert" className="nv-field-error">
          {error}
        </p>
      ) : sources === null ? (
        <Spinner label="Loading data sources" />
      ) : sources.length === 0 && orphans.length === 0 ? (
        <p className="muted ws-flush">No JSON or CSV sources in your projects yet.</p>
      ) : (
        <ul className="sites-data">
          {[
            ...sources.map((s) => ({ id: s.id, text: `${s.name} (${s.projectName})` })),
            ...orphans.map((d) => ({ id: d.sourceId, text: `${d.name} (source removed)` })),
          ].map((s) => {
            const conn = value.find((d) => d.sourceId === s.id);
            return (
              <li key={s.id} className="sites-data-row">
                <label className="spaces-check">
                  <input
                    type="checkbox"
                    checked={!!conn}
                    onChange={(e) =>
                      onChange(
                        e.target.checked
                          ? [
                              ...value,
                              {
                                sourceId: s.id,
                                name: slugName(s.text.split(' (')[0] ?? '', 40, '_') || 'data',
                              },
                            ]
                          : value.filter((d) => d.sourceId !== s.id),
                      )
                    }
                  />
                  Connect {s.text}
                </label>
                {conn ? (
                  <TextField
                    label={`Name for ${s.text}`}
                    value={conn.name}
                    maxLength={40}
                    error={errors.get(s.id)}
                    onChange={(e) =>
                      onChange(
                        value.map((d) =>
                          d.sourceId === s.id ? { ...d, name: e.target.value.trim() } : d,
                        ),
                      )
                    }
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </fieldset>
  );
}

/** Create a site, or edit one's name and data (`editing`). */
function SiteDialog({
  editing,
  onClose,
  onSaved,
}: {
  editing?: SiteView;
  onClose: () => void;
  onSaved: (s: SiteView) => void;
}) {
  const api = useSpacesApi();
  const formId = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(editing?.name ?? '');
  const [kind, setKind] = useState<'space' | 'artifact'>('space');
  const [spaces, setSpaces] = useState<SpaceView[] | null>(null);
  const [spaceId, setSpaceId] = useState('');
  const [artifactId, setArtifactId] = useState('');
  const [data, setData] = useState<SiteDataConnection[]>(editing?.data ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (editing) return;
    let alive = true;
    api.listSpaces().then(
      ({ items }) => {
        if (!alive) return;
        setSpaces(items);
        setSpaceId((cur) => cur || (items[0]?.id ?? ''));
      },
      () => alive && setSpaces([]),
    );
    return () => {
      alive = false;
    };
  }, [api, editing]);

  const sourceReady = editing || (kind === 'space' ? !!spaceId : !!artifactId.trim());
  const valid = !!name.trim() && sourceReady && dataErrors(data).size === 0;

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      onSaved(
        editing
          ? await api.updateSite(editing.id, { name: name.trim(), data })
          : await api.createSite({
              name: name.trim(),
              source:
                kind === 'space'
                  ? { kind: 'space', spaceId }
                  : { kind: 'artifact', artifactId: artifactId.trim() },
              data,
            }),
      );
    } catch (err) {
      setError(errorMessage(err, 'Could not save the site.'));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={editing ? 'Edit site' : 'New site'}
      onClose={onClose}
      initialFocusRef={nameRef}
      className="ws-wide-dialog"
    >
      <form
        id={formId}
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <TextField
          ref={nameRef}
          label="Name"
          value={name}
          maxLength={200}
          onChange={(e) => setName(e.target.value)}
        />
        {editing ? (
          <p className="muted ws-flush">{sourceText(editing)}</p>
        ) : (
          <>
            <RadioGroup
              legend="Built from"
              name={`${formId}-source`}
              value={kind}
              onChange={(v) => setKind(v === 'artifact' ? 'artifact' : 'space')}
              options={[
                { value: 'space', label: 'A space', description: 'Each page becomes a web page.' },
                {
                  value: 'artifact',
                  label: 'An artifact',
                  description: 'A document, web page or visualization from a chat.',
                },
              ]}
            />
            {kind === 'space' ? (
              spaces === null ? (
                <Spinner label="Loading spaces" />
              ) : spaces.length === 0 ? (
                <p className="muted ws-flush">
                  You have no spaces yet. Create one in Spaces first.
                </p>
              ) : (
                <SelectField
                  label="Space"
                  value={spaceId}
                  onChange={setSpaceId}
                  options={spaces.map((s) => ({ value: s.id, label: s.name }))}
                />
              )
            ) : (
              <TextField
                label="Artifact id"
                hint="Copy it from the artifact in the Library or a chat’s Artifacts panel."
                value={artifactId}
                maxLength={100}
                onChange={(e) => setArtifactId(e.target.value)}
              />
            )}
          </>
        )}
        <DataPicker value={data} onChange={setData} />
        {error ? (
          <p className="nv-field-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="nv-dialog-footer">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy || !valid}>
            {busy ? <Spinner /> : null} {editing ? 'Save' : 'Create site'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

// ---- one site -------------------------------------------------------------------------------

type DialogState =
  | { kind: 'edit' }
  | { kind: 'delete' }
  | { kind: 'unpublish' }
  | { kind: 'publish'; version: number };

function SiteDetail({ siteId }: { siteId: string }) {
  const api = useSpacesApi();
  const toast = useToast();
  const announce = useAnnounce();
  const [site, setSite] = useState<SiteView | null>(null);
  const [versions, setVersions] = useState<SiteVersionView[] | null>(null);
  const [publishes, setPublishes] = useState<SitePublishView[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [note, setNote] = useState('');
  const [building, setBuilding] = useState(false);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [outcome, setOutcome] = useState<SitePublishResult | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([
      api.getSite(siteId),
      api.listSiteVersions(siteId),
      api.listSitePublishes(siteId),
    ]).then(
      ([s, v, p]) => {
        if (!alive) return;
        setSite(s);
        setVersions([...v.items].sort((a, b) => b.version - a.version));
        setPublishes([...p.items].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
        setError(null);
      },
      (err: unknown) => {
        if (!alive) return;
        if (err instanceof ApiError && err.status === 404) setGone(true);
        else setError(errorMessage(err, 'Could not load this site.'));
      },
    );
    return () => {
      alive = false;
    };
  }, [api, siteId, attempt]);

  const reload = useDebounced(() => setAttempt((n) => n + 1), 150);
  useHubEvents(SITES_EVENTS, (env) => {
    if (eventIds(env).siteId !== siteId) return;
    if (env.name === 'site.deleted') setGone(true);
    else reload();
  });

  const build = () => {
    if (building) return;
    setBuilding(true);
    api
      .buildSite(siteId, note.trim() ? { note: note.trim() } : {})
      .then(
        (v) => {
          setNote('');
          setSelected(v.version);
          setVersions((list) => [v, ...(list ?? []).filter((x) => x.version !== v.version)]);
          setSite((s) => (s ? { ...s, latestVersion: v.version } : s));
          announce(`Built version ${v.version}.`);
          toast.show(`Built version ${v.version}.`, { tone: 'success' });
        },
        (err: unknown) => toast.show(`Could not build it: ${errorMessage(err)}`, { tone: 'error' }),
      )
      .finally(() => {
        setBuilding(false);
        reload();
      });
  };

  const published = (r: SitePublishResult, version: number) => {
    setDialog(null);
    setSite(r.site);
    setOutcome(r);
    if (r.downloadUrl)
      startDownload(r.downloadUrl, `${slugName(r.site.name, 50) || 'site'}-v${version}.zip`);
    toast.show(`Published version ${version}.`, { tone: 'success' });
    reload();
  };

  if (gone)
    return (
      <div className="ws-page sites-page">
        <Breadcrumb />
        <EmptyState
          title="Site not found"
          description="It may have been deleted."
          level={2}
          action={<Button onClick={() => navigate(sitePath())}>All sites</Button>}
        />
      </div>
    );

  const latest = versions?.[0]?.version ?? null;
  const shownVersion = selected ?? latest;
  const shown = versions?.find((v) => v.version === shownVersion) ?? null;

  return (
    <div className="ws-page sites-page">
      <Breadcrumb />
      {error ? (
        <div role="alert" className="ws-error">
          <p>{error}</p>
          <Button onClick={() => setAttempt((n) => n + 1)}>Retry</Button>
        </div>
      ) : null}
      {!site && !error ? <Spinner label="Loading the site" /> : null}
      {site ? (
        <>
          <header className="ws-page-header">
            <h1>{site.name}</h1>
            <div className="spaces-actions">
              <Button onClick={() => setDialog({ kind: 'edit' })}>
                <Icon name="edit" /> Edit
              </Button>
              <Button variant="danger" onClick={() => setDialog({ kind: 'delete' })}>
                <Icon name="trash" /> Delete
              </Button>
            </div>
          </header>
          <p className="muted ws-row-meta">
            <span>{sourceText(site)}</span>
            {site.data.length ? <span>Data: {site.data.map((d) => d.name).join(', ')}</span> : null}
          </p>

          <section
            className="sites-live"
            data-published={site.publishedVersion !== null}
            aria-label="Publishing"
          >
            {site.publishedVersion !== null && site.publishedTarget ? (
              <>
                <p>
                  <strong>Live:</strong> version {site.publishedVersion}, published{' '}
                  {targetText(site.publishedTarget)}
                  {site.publishedAt ? ` ${formatWhen(site.publishedAt)}` : ''}.
                </p>
                <Button onClick={() => setDialog({ kind: 'unpublish' })}>Unpublish</Button>
              </>
            ) : (
              <p>Not published. Publishing is always your choice, and you can undo it.</p>
            )}
          </section>
          {outcome ? (
            <p className="sites-result" role="status">
              {outcome.publish === null ? (
                'Nothing is published now.'
              ) : outcome.downloadUrl ? (
                <>
                  Version {outcome.publish.version} is published as a zip.{' '}
                  <a href={outcome.downloadUrl} download>
                    Download it again
                  </a>
                  .
                </>
              ) : outcome.folderPath ? (
                <>
                  Version {outcome.publish.version} is published in the folder{' '}
                  <code>{outcome.folderPath}</code>.
                </>
              ) : (
                `Version ${outcome.publish.version} is live.`
              )}
            </p>
          ) : null}

          <section className="ws-section" aria-labelledby="site-versions">
            <h2 id="site-versions">Versions</h2>
            <form
              className="sites-build"
              onSubmit={(e) => {
                e.preventDefault();
                build();
              }}
            >
              <TextField
                label="Note for the new version (optional)"
                value={note}
                maxLength={500}
                onChange={(e) => setNote(e.target.value)}
              />
              <Button type="submit" variant="primary" disabled={building}>
                {building ? <Spinner /> : <Icon name="refresh" />} Build new version
              </Button>
            </form>
            {versions === null ? <Spinner label="Loading versions" /> : null}
            {versions?.length === 0 ? (
              <p className="muted ws-flush">
                Not built yet. Building makes a version from the {site.source.kind} as it is now.
              </p>
            ) : null}
            {versions?.length ? (
              <ol className="ws-list" aria-label="Versions">
                {versions.map((v) => {
                  const live = v.version === site.publishedVersion;
                  return (
                    <li
                      key={v.version}
                      className="ws-list-row sites-version"
                      aria-current={v.version === shownVersion || undefined}
                    >
                      <div className="spaces-row-main">
                        <span className="ws-card-link">
                          Version {v.version}{' '}
                          {live ? (
                            <span className="ws-badge" data-tone="ok">
                              Live
                            </span>
                          ) : null}
                        </span>
                        <span className="muted ws-row-meta">
                          <span>Built {formatWhen(v.createdAt)}</span>
                          <span>
                            {plural(v.files.length, 'file')}, {formatBytes(v.size)}
                          </span>
                          {v.note ? <span>{v.note}</span> : null}
                        </span>
                      </div>
                      <div className="spaces-actions">
                        <Button
                          variant="ghost"
                          aria-pressed={v.version === shownVersion}
                          aria-label={`Preview version ${v.version}`}
                          onClick={() => setSelected(v.version)}
                        >
                          <Icon name="eye" /> Preview
                        </Button>
                        <a
                          className="nv-btn"
                          data-variant="ghost"
                          href={api.siteZipUrl(siteId, v.version)}
                          download
                          aria-label={`Download version ${v.version} as a zip`}
                        >
                          <Icon name="download" /> Zip
                        </a>
                        <Button
                          onClick={() => setDialog({ kind: 'publish', version: v.version })}
                          aria-label={
                            v.version === latest
                              ? `Publish version ${v.version}`
                              : `Publish this version (${v.version})`
                          }
                        >
                          {v.version === latest ? 'Publish' : 'Publish this version'}
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ol>
            ) : null}
          </section>

          {shown ? (
            <section className="ws-section" aria-labelledby="site-preview">
              <h2 id="site-preview">Preview of version {shown.version}</h2>
              {shown.scripts ? (
                <p className="muted ws-flush">
                  This version comes from a web page artifact; its own scripts run in the preview,
                  kept apart from Nova.
                </p>
              ) : null}
              <iframe
                key={`${siteId}-${shown.version}`}
                className="sites-frame"
                title={`Preview of ${site.name}, version ${shown.version}`}
                src={api.sitePreviewUrl(siteId, shown.version)}
                sandbox={shown.scripts ? 'allow-scripts' : ''}
                referrerPolicy="no-referrer"
              />
            </section>
          ) : null}

          {publishes.length ? (
            <section className="ws-section" aria-labelledby="site-publishes">
              <h2 id="site-publishes">Publish history</h2>
              <ol className="ws-list" aria-label="Publish history">
                {publishes.map((p) => (
                  <li key={p.id} className="ws-list-row">
                    <span>
                      Version {p.version} published {targetText(p.target)},{' '}
                      {formatWhen(p.createdAt)}
                    </span>
                    {p.current ? (
                      <span className="ws-badge" data-tone="ok">
                        Live
                      </span>
                    ) : p.revertedAt ? (
                      <span className="ws-badge">Undone {formatWhen(p.revertedAt)}</span>
                    ) : (
                      <span className="ws-badge">Replaced</span>
                    )}
                  </li>
                ))}
              </ol>
            </section>
          ) : null}

          {dialog?.kind === 'edit' ? (
            <SiteDialog
              editing={site}
              onClose={() => setDialog(null)}
              onSaved={(s) => {
                setDialog(null);
                setSite(s);
                toast.show('Site saved.', { tone: 'success' });
              }}
            />
          ) : null}
          {dialog?.kind === 'publish' ? (
            <PublishDialog
              site={site}
              version={dialog.version}
              latest={latest}
              onClose={() => setDialog(null)}
              onPublished={(r) => published(r, dialog.version)}
            />
          ) : null}
          {dialog?.kind === 'unpublish' ? (
            <UnpublishDialog
              site={site}
              onClose={() => setDialog(null)}
              onDone={(r) => {
                setDialog(null);
                setSite(r.site);
                setOutcome(r);
                toast.show(
                  r.site.publishedVersion !== null
                    ? `Unpublished. Version ${r.site.publishedVersion} is live again.`
                    : 'Unpublished. Nothing is published now.',
                  { tone: 'success' },
                );
                reload();
              }}
            />
          ) : null}
          {dialog?.kind === 'delete' ? (
            <DeleteSiteDialog
              site={site}
              onClose={() => setDialog(null)}
              onDeleted={() => {
                toast.show(`Deleted “${site.name}”.`, { tone: 'success' });
                navigate(sitePath());
              }}
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function PublishDialog({
  site,
  version,
  latest,
  onClose,
  onPublished,
}: {
  site: SiteView;
  version: number;
  latest: number | null;
  onClose: () => void;
  onPublished: (r: SitePublishResult) => void;
}) {
  const api = useSpacesApi();
  const formId = useId();
  const prev = site.publishedTarget;
  const [kind, setKind] = useState<SiteTarget['kind']>(prev?.kind ?? 'folder');
  const [folder, setFolder] = useState(
    prev?.kind === 'folder' ? prev.folder : slugName(site.name, 63) || 'site',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const folderError = kind === 'folder' && !FOLDER_RE.test(folder) ? FOLDER_HINT : undefined;
  const rollback = latest !== null && version < latest;

  const submit = async () => {
    if (busy || folderError) return;
    setBusy(true);
    setError(null);
    try {
      onPublished(
        await api.publishSite(site.id, {
          version,
          target: kind === 'folder' ? { kind: 'folder', folder } : { kind: 'zip' },
          confirm: true,
        }),
      );
    } catch (err) {
      setError(
        conflictReason(err) === 'folder_in_use'
          ? 'That folder holds files Nova did not put there, or another site is published in it. Choose another name.'
          : errorMessage(err, 'Could not publish it.'),
      );
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={`Publish version ${version}?`}
      description={
        <>
          {rollback
            ? `This is an earlier version (the newest is ${latest}); publishing it rolls the site back. `
            : ''}
          You can unpublish to bring back what was there before.
        </>
      }
      onClose={onClose}
    >
      <form
        id={formId}
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <RadioGroup
          legend="Publish to"
          name={`${formId}-target`}
          value={kind}
          onChange={(v) => setKind(v === 'zip' ? 'zip' : 'folder')}
          options={[
            {
              value: 'folder',
              label: 'A folder on the Hub',
              description: 'Written into the Hub’s sites folder, ready for a web server.',
            },
            {
              value: 'zip',
              label: 'Download as a zip',
              description: 'Nothing is written on the Hub; you get the files.',
            },
          ]}
        />
        {kind === 'folder' ? (
          <TextField
            label="Folder name"
            value={folder}
            maxLength={63}
            error={folderError}
            onChange={(e) => setFolder(e.target.value.trim())}
          />
        ) : null}
        {error ? (
          <p className="nv-field-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="nv-dialog-footer">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy || !!folderError}>
            {busy ? <Spinner /> : null} Publish version {version}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

const FOLDER_HINT =
  'Use lowercase letters, digits and hyphens (up to 63), starting with a letter or digit.';

function UnpublishDialog({
  site,
  onClose,
  onDone,
}: {
  site: SiteView;
  onClose: () => void;
  onDone: (r: SitePublishResult) => void;
}) {
  const api = useSpacesApi();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      open
      title={`Unpublish version ${site.publishedVersion ?? ''}?`}
      description="What was published before comes back; if nothing was, the site is no longer published. The version itself is kept."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              api.unpublishSite(site.id).then(onDone, (err: unknown) => {
                setError(errorMessage(err, 'Could not unpublish it.'));
                setBusy(false);
              });
            }}
          >
            Unpublish
          </Button>
        </>
      }
    >
      {error ? (
        <p className="nv-field-error" role="alert">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}

function DeleteSiteDialog({
  site,
  onClose,
  onDeleted,
}: {
  site: SiteView;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const api = useSpacesApi();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      open
      title="Delete this site?"
      description={`“${site.name}” and all its versions are deleted. This cannot be undone.`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              api.deleteSite(site.id).then(onDeleted, (err: unknown) => {
                setError(
                  conflictReason(err) === 'published'
                    ? 'This site is published. Unpublish it first, then delete it.'
                    : errorMessage(err, 'Could not delete it.'),
                );
                setBusy(false);
              });
            }}
          >
            Delete site
          </Button>
        </>
      }
    >
      {error ? (
        <p className="nv-field-error" role="alert">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}
