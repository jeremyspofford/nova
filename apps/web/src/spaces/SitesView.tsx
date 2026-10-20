// Sites (FR-037): a site is generated from a space or an artifact, with JSON or CSV project
// sources connected as data. Each build is a version: preview it (sandboxed, never same-origin;
// an HTML artifact's own scripts may run there), download it as a zip, or publish it to a folder
// on the Hub or as a zip. Publishing always asks first and can be undone: unpublishing brings
// back what was live before, and publishing an earlier version rolls the site back. M8: a site's
// source can change after a preview of what changes, publishing can go to the owner's hosting
// targets (/sites/targets) after the dialog shows what will be uploaded, and members, who cannot
// publish, are told so instead of meeting a refusal.
import { useEffect, useId, useRef, useState } from 'react';
import { defineMessages, fmt } from '@nova/i18n';
import type {
  SiteDataConnection,
  SiteDataSourceView,
  SitePublishResult,
  SitePublishView,
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
import { formatWhen } from '../settings/common.ts';
import { rich } from '../i18n/rich.tsx';
import { useTeamRole } from '../team/role.tsx';
import { useDebounced } from '../work/events.ts';
import { followLink } from '../work/nav.tsx';
import { useSpacesApi } from './api.ts';
import { eventIds, SITES_EVENTS, useHubEvents } from './events.ts';
import {
  conflictReason,
  DATA_NAME_RE,
  SPACES_TEXT,
  sitePath,
  slugName,
  TARGETS_PATH,
  targetArgs,
} from './format.ts';
import { PublishDialog } from './SitePublish.tsx';
import { ChangeSourceDialog } from './SiteSource.tsx';
import { SiteTargetsView } from './SiteTargets.tsx';
import '../workspace.css';
import '../work/work.css';
import './spaces.css';

/** M8 words of the sites views: targets, the source, members, remote outcomes. */
export const SITES_M8_TEXT = defineMessages('spaces.sitesM8', {
  targets: 'Publishing targets',
  changeSource: 'Change source…',
  sourceChanged: 'Source changed. Build a new version to use it.',
  memberNote:
    'Only the owner of this Hub can publish sites. You can build, preview and download them.',
  /** A publish to a hosting target ({name}) that worked. */
  remoteDone:
    '{where, select, remote {Version {v} is published to “{name}”, folder “{folder}”.} other {Version {v} is published to a removed hosting target, folder “{folder}”.}}',
  visitors: 'Visitors find it at',
  /** {location} is an address and {why} the target's own words (English). */
  leftBehind:
    'The earlier copy at {location} could not be removed ({why}). Remove it there yourself.',
  leftBehindUnknown:
    'An earlier copy on a hosting target could not be removed ({why}). Remove it there yourself.',
});
const M = SITES_M8_TEXT;

/** The sites list and one site. {name} is a site's name, {v} a version number. */
export const SITES_TEXT = defineMessages('spaces.sites', {
  /** Where a site is built from; {label} is the space's or artifact's name. */
  source: '{kind, select, space {From the space “{label}”} other {From the artifact “{label}”}}',
  sourceGone:
    '{kind, select, space {From a space that is gone} other {From an artifact that is gone}}',
  notPublished: 'Not published',
  /** A site's published version and where it went. */
  published:
    '{where, select, folder {Version {v} published to the folder “{folder}”} zip {Version {v} published as a zip download} remote {Version {v} published to “{name}”, folder “{folder}”} other {Version {v} published to a removed hosting target, folder “{folder}”}}',
  breadcrumb: 'Breadcrumb',
  sites: 'Sites',
  loadFailed: 'Could not load your sites.',
  newSite: 'New site',
  intro:
    'A site turns a space or an artifact into web pages you can preview, download as a zip, or publish to a folder. Publishing is always your choice, and you can undo it.',
  loading: 'Loading sites',
  empty: 'No sites yet',
  emptyHint: 'Make a site from a space, then build, preview and publish it.',
  create: 'Create a site',
  notBuilt: 'Not built yet',
  version: 'Version {v}',
  dataNameRule:
    'Use lowercase letters, digits, - and _ (up to 40), starting with a letter or digit.',
  dataNameTwice: 'Each connection needs its own name.',
  dataFailed: 'Could not load the data sources.',
  data: 'Connected data (optional)',
  dataHint:
    'JSON and CSV sources from your projects. Pages read them by name, for example in a nova-table block or a chart’s data.',
  dataLoading: 'Loading data sources',
  noData: 'No JSON or CSV sources in your projects yet.',
  /** A data source and its project, as names. */
  sourceOf: '{name} ({project})',
  sourceRemoved: '{name} (source removed)',
  connect: 'Connect {source}',
  nameFor: 'Name for {source}',
  saveFailed: 'Could not save the site.',
  editSite: 'Edit site',
  name: 'Name',
  builtFrom: 'Built from',
  space: 'A space',
  spaceHelp: 'Each page becomes a web page.',
  artifact: 'An artifact',
  artifactHelp: 'A document, web page or visualization from a chat.',
  loadingSpaces: 'Loading spaces',
  noSpaces: 'You have no spaces yet. Create one in Spaces first.',
  spaceLabel: 'Space',
  artifactId: 'Artifact id',
  artifactHint: 'Copy it from the artifact in the Library or a chat’s Artifacts panel.',
  createSite: 'Create site',
  siteFailed: 'Could not load this site.',
  built: 'Built version {v}.',
  /** {why} is the Hub's own words (English, D9). */
  buildFailed: 'Could not build it: {why}',
  publishedToast: 'Published version {v}.',
  notFound: 'Site not found',
  notFoundHint: 'It may have been deleted.',
  allSites: 'All sites',
  loadingSite: 'Loading the site',
  edit: 'Edit',
  /** {names} lists the names of the connected data. */
  dataNames: 'Data: {names}',
  publishing: 'Publishing',
  live: 'Live:',
  /** What is live, after "Live:"; {when} is when it was published. */
  liveVersion:
    '{where, select, folder {version {v}, published to the folder “{folder}”.} zip {version {v}, published as a zip download.} remote {version {v}, published to “{name}”, folder “{folder}”.} other {version {v}, published to a removed hosting target, folder “{folder}”.}}',
  liveVersionAt:
    '{where, select, folder {version {v}, published to the folder “{folder}” {when}.} zip {version {v}, published as a zip download {when}.} remote {version {v}, published to “{name}”, folder “{folder}” {when}.} other {version {v}, published to a removed hosting target, folder “{folder}” {when}.}}',
  unpublish: 'Unpublish',
  notLive: 'Not published. Publishing is always your choice, and you can undo it.',
  nothingNow: 'Nothing is published now.',
  /** {link} is a link named "Download it again". */
  asZip: 'Version {v} is published as a zip. {link}.',
  downloadAgain: 'Download it again',
  /** {folder} is the folder's path, shown as code. */
  inFolder: 'Version {v} is published in the folder {folder}.',
  isLive: 'Version {v} is live.',
  versions: 'Versions',
  note: 'Note for the new version (optional)',
  build: 'Build new version',
  loadingVersions: 'Loading versions',
  notBuiltHint:
    '{kind, select, space {Not built yet. Building makes a version from the space as it is now.} other {Not built yet. Building makes a version from the artifact as it is now.}}',
  liveBadge: 'Live',
  builtWhen: 'Built {when}',
  /** A version's files and their size, such as "3 files, 12 KB". */
  files: '{n, plural, one {# file, {size}} other {# files, {size}}}',
  previewOf: 'Preview version {v}',
  preview: 'Preview',
  zipOf: 'Download version {v} as a zip',
  zip: 'Zip',
  publishOf: 'Publish version {v}',
  publishThisOf: 'Publish this version ({v})',
  publish: 'Publish',
  publishThis: 'Publish this version',
  previewHeading: 'Preview of version {v}',
  scripts:
    'This version comes from a web page artifact; its own scripts run in the preview, kept apart from Nova.',
  frame: 'Preview of {name}, version {v}',
  history: 'Publish history',
  /** A past publish: what and where, then when. */
  historyItem:
    '{where, select, folder {Version {v} published to the folder “{folder}”, {when}} zip {Version {v} published as a zip download, {when}} remote {Version {v} published to “{name}”, folder “{folder}”, {when}} other {Version {v} published to a removed hosting target, folder “{folder}”, {when}}}',
  undone: 'Undone {when}',
  replaced: 'Replaced',
  saved: 'Site saved.',
  liveAgain: 'Unpublished. Version {v} is live again.',
  nothingLive: 'Unpublished. Nothing is published now.',
  deleted: 'Deleted “{name}”.',
  unpublishTitle: 'Unpublish version {v}?',
  unpublishBody:
    'What was published before comes back; if nothing was, the site is no longer published. The version itself is kept.',
  unpublishFailed: 'Could not unpublish it.',
  deleteTitle: 'Delete this site?',
  deleteBody: '“{name}” and all its versions are deleted. This cannot be undone.',
  deletePublished: 'This site is published. Unpublish it first, then delete it.',
  deleteFailed: 'Could not delete it.',
  deleteSite: 'Delete site',
});
const S = SITES_TEXT;

export function SitesView({ siteId }: { siteId: string | null }) {
  // `/sites/targets` is the owner's list of hosting targets (M8); site ids never take that name.
  if (siteId === 'targets') return <SiteTargetsView />;
  return siteId ? <SiteDetail key={siteId} siteId={siteId} /> : <SiteList />;
}

export function sourceText(s: Pick<SiteView, 'source' | 'sourceLabel'>): string {
  const kind = s.source.kind === 'space' ? 'space' : 'artifact';
  return s.sourceLabel ? S.source({ kind, label: s.sourceLabel }) : S.sourceGone({ kind });
}

export function publishedText(s: SiteView): string {
  if (s.publishedVersion === null || !s.publishedTarget) return S.notPublished;
  return S.published({
    v: s.publishedVersion,
    ...targetArgs(s.publishedTarget, s.publishedRemote),
  });
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
    <nav aria-label={S.breadcrumb} className="ws-breadcrumb">
      <a href={sitePath()} onClick={(e) => followLink(e, sitePath())}>
        <Icon name="back" /> {S.sites}
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
  const { isMember } = useTeamRole();

  useEffect(() => {
    let alive = true;
    api.listSites().then(
      ({ items: list }) => {
        if (!alive) return;
        setItems(list);
        setError(null);
      },
      (err: unknown) => alive && setError(errorMessage(err, S.loadFailed)),
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
        <h1>{S.sites}</h1>
        <div className="spaces-actions">
          {isMember ? null : (
            <a className="nv-btn" href={TARGETS_PATH} onClick={(e) => followLink(e, TARGETS_PATH)}>
              <Icon name="server" /> {M.targets}
            </a>
          )}
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Icon name="plus" /> {S.newSite}
          </Button>
        </div>
      </header>
      <p className="muted ws-flush">{S.intro}</p>
      {error ? (
        <div role="alert" className="ws-error">
          <p>{error}</p>
          <Button onClick={() => setAttempt((n) => n + 1)}>{SPACES_TEXT.retry}</Button>
        </div>
      ) : null}
      {items === null && !error ? <Spinner label={S.loading} /> : null}
      {items?.length === 0 ? (
        <EmptyState
          title={S.empty}
          description={S.emptyHint}
          icon="external"
          level={2}
          action={<Button onClick={() => setCreating(true)}>{S.create}</Button>}
        />
      ) : null}
      {items?.length ? (
        <ul className="ws-list" aria-label={S.sites}>
          {items.map((s) => (
            <li key={s.id} className="ws-list-row">
              <div className="spaces-row-main">
                <a
                  href={sitePath(s.id)}
                  className="ws-card-link"
                  onClick={(e) => followLink(e, sitePath(s.id))}
                  dir="auto"
                >
                  {s.name}
                </a>
                <span className="muted ws-row-meta">
                  <span>{sourceText(s)}</span>
                  <span>
                    {s.latestVersion === null ? S.notBuilt : S.version({ v: s.latestVersion })}
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
    if (!DATA_NAME_RE.test(d.name)) out.set(d.sourceId, S.dataNameRule);
    else if ((seen.get(d.name) ?? 0) > 1) out.set(d.sourceId, S.dataNameTwice);
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
      (err: unknown) => alive && setError(errorMessage(err, S.dataFailed)),
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
      <legend>{S.data}</legend>
      <p className="nv-field-hint">{S.dataHint}</p>
      {error ? (
        <p role="alert" className="nv-field-error">
          {error}
        </p>
      ) : sources === null ? (
        <Spinner label={S.dataLoading} />
      ) : sources.length === 0 && orphans.length === 0 ? (
        <p className="muted ws-flush">{S.noData}</p>
      ) : (
        <ul className="sites-data">
          {[
            ...sources.map((s) => ({
              id: s.id,
              name: s.name,
              text: S.sourceOf({ name: s.name, project: s.projectName }),
            })),
            ...orphans.map((d) => ({
              id: d.sourceId,
              name: d.name,
              text: S.sourceRemoved({ name: d.name }),
            })),
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
                                name: slugName(s.name, 40, '_') || 'data',
                              },
                            ]
                          : value.filter((d) => d.sourceId !== s.id),
                      )
                    }
                  />
                  {S.connect({ source: s.text })}
                </label>
                {conn ? (
                  <TextField
                    label={S.nameFor({ source: s.text })}
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
      setError(errorMessage(err, S.saveFailed));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={editing ? S.editSite : S.newSite}
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
          label={S.name}
          value={name}
          maxLength={200}
          onChange={(e) => setName(e.target.value)}
        />
        {editing ? (
          <p className="muted ws-flush">{sourceText(editing)}</p>
        ) : (
          <>
            <RadioGroup
              legend={S.builtFrom}
              name={`${formId}-source`}
              value={kind}
              onChange={(v) => setKind(v === 'artifact' ? 'artifact' : 'space')}
              options={[
                { value: 'space', label: S.space, description: S.spaceHelp },
                { value: 'artifact', label: S.artifact, description: S.artifactHelp },
              ]}
            />
            {kind === 'space' ? (
              spaces === null ? (
                <Spinner label={S.loadingSpaces} />
              ) : spaces.length === 0 ? (
                <p className="muted ws-flush">{S.noSpaces}</p>
              ) : (
                <SelectField
                  label={S.spaceLabel}
                  value={spaceId}
                  onChange={setSpaceId}
                  options={spaces.map((s) => ({ value: s.id, label: s.name }))}
                />
              )
            ) : (
              <TextField
                label={S.artifactId}
                hint={S.artifactHint}
                value={artifactId}
                maxLength={100}
                dir="ltr"
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
          <Button onClick={onClose}>{SPACES_TEXT.cancel}</Button>
          <Button type="submit" variant="primary" disabled={busy || !valid}>
            {busy ? <Spinner /> : null} {editing ? SPACES_TEXT.save : S.createSite}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

// ---- one site -------------------------------------------------------------------------------

type DialogState =
  | { kind: 'edit' }
  | { kind: 'source' }
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
  const { isMember } = useTeamRole();

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
        else setError(errorMessage(err, S.siteFailed));
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
          announce(S.built({ v: v.version }));
          toast.show(S.built({ v: v.version }), { tone: 'success' });
        },
        (err: unknown) => toast.show(S.buildFailed({ why: errorMessage(err) }), { tone: 'error' }),
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
    toast.show(S.publishedToast({ v: version }), { tone: 'success' });
    reload();
  };

  if (gone)
    return (
      <div className="ws-page sites-page">
        <Breadcrumb />
        <EmptyState
          title={S.notFound}
          description={S.notFoundHint}
          level={2}
          action={<Button onClick={() => navigate(sitePath())}>{S.allSites}</Button>}
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
          <Button onClick={() => setAttempt((n) => n + 1)}>{SPACES_TEXT.retry}</Button>
        </div>
      ) : null}
      {!site && !error ? <Spinner label={S.loadingSite} /> : null}
      {site ? (
        <>
          <header className="ws-page-header">
            <h1 dir="auto">{site.name}</h1>
            <div className="spaces-actions">
              <Button onClick={() => setDialog({ kind: 'edit' })}>
                <Icon name="edit" /> {S.edit}
              </Button>
              <Button onClick={() => setDialog({ kind: 'source' })}>
                <Icon name="refresh" /> {M.changeSource}
              </Button>
              <Button variant="danger" onClick={() => setDialog({ kind: 'delete' })}>
                <Icon name="trash" /> {SPACES_TEXT.delete}
              </Button>
            </div>
          </header>
          <p className="muted ws-row-meta">
            <span>{sourceText(site)}</span>
            {site.data.length ? (
              <span>
                {S.dataNames({
                  names: fmt.list(
                    site.data.map((d) => d.name),
                    { type: 'unit', style: 'short' },
                  ),
                })}
              </span>
            ) : null}
          </p>

          <section
            className="sites-live"
            data-published={site.publishedVersion !== null}
            aria-label={S.publishing}
          >
            {site.publishedVersion !== null && site.publishedTarget ? (
              <>
                <p>
                  <strong>{S.live}</strong>{' '}
                  {site.publishedAt
                    ? S.liveVersionAt({
                        v: site.publishedVersion,
                        when: formatWhen(site.publishedAt),
                        ...targetArgs(site.publishedTarget, site.publishedRemote),
                      })
                    : S.liveVersion({
                        v: site.publishedVersion,
                        ...targetArgs(site.publishedTarget, site.publishedRemote),
                      })}
                </p>
                {site.publishedRemote?.publicUrl ? (
                  <p>
                    {M.visitors}{' '}
                    <a
                      href={site.publishedRemote.publicUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      dir="ltr"
                    >
                      {site.publishedRemote.publicUrl}
                    </a>
                  </p>
                ) : null}
                {isMember ? null : (
                  <Button onClick={() => setDialog({ kind: 'unpublish' })}>{S.unpublish}</Button>
                )}
              </>
            ) : (
              <p>{S.notLive}</p>
            )}
            {isMember ? <p className="muted">{M.memberNote}</p> : null}
          </section>
          {outcome ? (
            <p className="sites-result" role="status">
              {outcome.publish === null
                ? S.nothingNow
                : outcome.downloadUrl
                  ? rich(S.asZip, {
                      v: String(outcome.publish.version),
                      link: (
                        <a href={outcome.downloadUrl} download>
                          {S.downloadAgain}
                        </a>
                      ),
                    })
                  : outcome.folderPath
                    ? rich(S.inFolder, {
                        v: String(outcome.publish.version),
                        folder: <code dir="ltr">{outcome.folderPath}</code>,
                      })
                    : outcome.publish.target.kind === 'remote'
                      ? M.remoteDone({
                          v: outcome.publish.version,
                          ...targetArgs(outcome.publish.target, outcome.publish.remote),
                        })
                      : S.isLive({ v: outcome.publish.version })}
            </p>
          ) : null}
          {outcome?.leftBehind ? (
            <p className="ws-callout" role="alert" data-tone="warn">
              {outcome.leftBehind.location
                ? M.leftBehind({
                    location: outcome.leftBehind.location,
                    why: outcome.leftBehind.reason,
                  })
                : M.leftBehindUnknown({ why: outcome.leftBehind.reason })}
            </p>
          ) : null}

          <section className="ws-section" aria-labelledby="site-versions">
            <h2 id="site-versions">{S.versions}</h2>
            <form
              className="sites-build"
              onSubmit={(e) => {
                e.preventDefault();
                build();
              }}
            >
              <TextField
                label={S.note}
                value={note}
                maxLength={500}
                onChange={(e) => setNote(e.target.value)}
              />
              <Button type="submit" variant="primary" disabled={building}>
                {building ? <Spinner /> : <Icon name="refresh" />} {S.build}
              </Button>
            </form>
            {versions === null ? <Spinner label={S.loadingVersions} /> : null}
            {versions?.length === 0 ? (
              <p className="muted ws-flush">{S.notBuiltHint({ kind: site.source.kind })}</p>
            ) : null}
            {versions?.length ? (
              <ol className="ws-list" aria-label={S.versions}>
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
                          {S.version({ v: v.version })}{' '}
                          {live ? (
                            <span className="ws-badge" data-tone="ok">
                              {S.liveBadge}
                            </span>
                          ) : null}
                        </span>
                        <span className="muted ws-row-meta">
                          <span>{S.builtWhen({ when: formatWhen(v.createdAt) })}</span>
                          <span>{S.files({ n: v.files.length, size: formatBytes(v.size) })}</span>
                          {v.note ? <span dir="auto">{v.note}</span> : null}
                        </span>
                      </div>
                      <div className="spaces-actions">
                        <Button
                          variant="ghost"
                          aria-pressed={v.version === shownVersion}
                          aria-label={S.previewOf({ v: v.version })}
                          onClick={() => setSelected(v.version)}
                        >
                          <Icon name="eye" /> {S.preview}
                        </Button>
                        <a
                          className="nv-btn"
                          data-variant="ghost"
                          href={api.siteZipUrl(siteId, v.version)}
                          download
                          aria-label={S.zipOf({ v: v.version })}
                        >
                          <Icon name="download" /> {S.zip}
                        </a>
                        {isMember ? null : (
                          <Button
                            onClick={() => setDialog({ kind: 'publish', version: v.version })}
                            aria-label={
                              v.version === latest
                                ? S.publishOf({ v: v.version })
                                : S.publishThisOf({ v: v.version })
                            }
                          >
                            {v.version === latest ? S.publish : S.publishThis}
                          </Button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
            ) : null}
          </section>

          {shown ? (
            <section className="ws-section" aria-labelledby="site-preview">
              <h2 id="site-preview">{S.previewHeading({ v: shown.version })}</h2>
              {shown.scripts ? <p className="muted ws-flush">{S.scripts}</p> : null}
              <iframe
                key={`${siteId}-${shown.version}`}
                className="sites-frame"
                title={S.frame({ name: site.name, v: shown.version })}
                src={api.sitePreviewUrl(siteId, shown.version)}
                sandbox={shown.scripts ? 'allow-scripts' : ''}
                referrerPolicy="no-referrer"
              />
            </section>
          ) : null}

          {publishes.length ? (
            <section className="ws-section" aria-labelledby="site-publishes">
              <h2 id="site-publishes">{S.history}</h2>
              <ol className="ws-list" aria-label={S.history}>
                {publishes.map((p) => (
                  <li key={p.id} className="ws-list-row">
                    <span>
                      {S.historyItem({
                        v: p.version,
                        when: formatWhen(p.createdAt),
                        ...targetArgs(p.target, p.remote),
                      })}
                    </span>
                    {p.current ? (
                      <span className="ws-badge" data-tone="ok">
                        {S.liveBadge}
                      </span>
                    ) : p.revertedAt ? (
                      <span className="ws-badge">
                        {S.undone({ when: formatWhen(p.revertedAt) })}
                      </span>
                    ) : (
                      <span className="ws-badge">{S.replaced}</span>
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
                toast.show(S.saved, { tone: 'success' });
              }}
            />
          ) : null}
          {dialog?.kind === 'source' ? (
            <ChangeSourceDialog
              site={site}
              onClose={() => setDialog(null)}
              onSaved={(s) => {
                setDialog(null);
                setSite(s);
                toast.show(M.sourceChanged, { tone: 'success' });
                announce(M.sourceChanged);
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
                    ? S.liveAgain({ v: r.site.publishedVersion })
                    : S.nothingLive,
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
                toast.show(S.deleted({ name: site.name }), { tone: 'success' });
                navigate(sitePath());
              }}
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}

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
      title={S.unpublishTitle({ v: site.publishedVersion ?? '' })}
      description={S.unpublishBody}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{SPACES_TEXT.cancel}</Button>
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              api.unpublishSite(site.id).then(onDone, (err: unknown) => {
                setError(errorMessage(err, S.unpublishFailed));
                setBusy(false);
              });
            }}
          >
            {S.unpublish}
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
      title={S.deleteTitle}
      description={S.deleteBody({ name: site.name })}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{SPACES_TEXT.cancel}</Button>
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              api.deleteSite(site.id).then(onDeleted, (err: unknown) => {
                setError(
                  conflictReason(err) === 'published'
                    ? S.deletePublished
                    : errorMessage(err, S.deleteFailed),
                );
                setBusy(false);
              });
            }}
          >
            {S.deleteSite}
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
