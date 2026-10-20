// Publishing a site version (FR-037; M8 adds hosting targets and the plan). The dialog asks the
// Hub what publishing to the chosen place would do before anything happens: where the files go
// (the Hub's folder, a hosting target's address, or a zip), which files and how large, what is
// live now and is replaced or taken down, whether unpublishing takes it back, and whether the
// network policy lets Nova reach a hosting target. Publish stays off until that answer is in,
// so the confirmation always shows the target and what will be uploaded.
import { useEffect, useId, useState } from 'react';
import { defineMessages } from '@nova/i18n';
import type {
  SiteHostingTargetView,
  SitePublishPlanView,
  SitePublishResult,
  SiteTarget,
  SiteView,
} from '@nova/shared';
import { Button, Dialog, RadioGroup, SelectField, Spinner, TextField } from '@nova/ui';
import { formatBytes } from '../chat/attachments.ts';
import { followLink } from '../work/nav.tsx';
import { useSpacesApi } from './api.ts';
import { FOLDER_RE, TARGETS_PATH, refusalText, slugName, targetArgs } from './format.ts';

/** The publish dialog. {v} is a version number, {size} a size such as "12 KB". */
export const PUBLISH_TEXT = defineMessages('spaces.publish', {
  title: 'Publish version {v}?',
  rollback:
    'This is an earlier version (the newest is {latest}); publishing it rolls the site back.',
  undo: 'You can unpublish to bring back what was there before.',
  zipUndo:
    'A downloaded zip cannot be taken back: unpublishing only marks it undone and brings back what was there before.',
  to: 'Publish to',
  folder: 'A folder on the Hub',
  folderHelp: 'Written into the Hub’s sites folder, ready for a web server.',
  remote: 'A hosting target',
  remoteHelp: 'Uploaded to a web host you set up (WebDAV).',
  zip: 'Download as a zip',
  zipHelp: 'Nothing is written on the Hub; you get the files.',
  folderName: 'Folder name',
  folderHint:
    'Use lowercase letters, digits and hyphens (up to 63), starting with a letter or digit.',
  target: 'Hosting target',
  loadingTargets: 'Loading hosting targets',
  noTargets: 'You have no hosting targets yet.',
  addTarget: 'Add one under Publishing targets',
  planLabel: 'What publishing does',
  planLoading: 'Checking what publishing does',
  planFailed: 'Could not check what publishing does.',
  writes:
    '{n, plural, one {Writes # file ({size}) to this folder on the Hub:} other {Writes # files ({size}) to this folder on the Hub:}}',
  /** {name} is the hosting target's name. */
  uploads:
    '{n, plural, one {Uploads # file ({size}) to “{name}” at:} other {Uploads # files ({size}) to “{name}” at:}}',
  zipFiles:
    '{n, plural, one {Gives you # file ({size}) as a zip.} other {Gives you # files ({size}) as a zip.}}',
  /** Followed by the site's public address. */
  visitors: 'Visitors find it at',
  /** What is live now, and where ({where}: folder, zip, remote or removed). */
  live: '{where, select, folder {Now live: version {v}, published to the folder “{folder}”.} zip {Now live: version {v}, published as a zip download.} remote {Now live: version {v}, published to “{name}”, folder “{folder}”.} other {Now live: version {v}, published to a removed hosting target, folder “{folder}”.}}',
  takesDown:
    '{where, select, folder {The site is taken out of its place now, the folder “{folder}”.} zip {The site is taken out of its place now, a zip download.} remote {The site is taken out of its place now, “{name}”, folder “{folder}”.} other {The site is taken out of its place now, a removed hosting target, folder “{folder}”.}}',
  reversible: 'Unpublishing takes it back.',
  notReversible: 'A zip you download cannot be taken back.',
  /** {why} is the network policy's own words (English, D9). */
  egressDenied: 'Nova may not reach {host}: {why}.',
  showFiles: 'Show the files',
  hideFiles: 'Hide the files',
  files: 'Files',
  cancel: 'Cancel',
  confirm: 'Publish version {v}',
  failed: 'Could not publish it.',
});
const S = PUBLISH_TEXT;

type Kind = SiteTarget['kind'];

/** The target the form names, or null while it is incomplete. */
function chosenTarget(kind: Kind, folder: string, targetId: string): SiteTarget | null {
  if (kind === 'zip') return { kind: 'zip' };
  if (!FOLDER_RE.test(folder)) return null;
  if (kind === 'folder') return { kind: 'folder', folder };
  return targetId ? { kind: 'remote', targetId, folder } : null;
}

export function PublishDialog({
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
  const [kind, setKind] = useState<Kind>(prev?.kind ?? 'folder');
  const [folder, setFolder] = useState(
    prev && prev.kind !== 'zip' ? prev.folder : slugName(site.name, 63) || 'site',
  );
  const [targets, setTargets] = useState<SiteHostingTargetView[] | null>(null);
  const [targetId, setTargetId] = useState(prev?.kind === 'remote' ? prev.targetId : '');
  const [plan, setPlan] = useState<
    { key: string; plan: SitePublishPlanView } | { key: string; error: string } | null
  >(null);
  const [showFiles, setShowFiles] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api.listSiteTargets().then(
      ({ items }) => {
        if (!alive) return;
        setTargets(items);
        setTargetId((cur) => cur || (items[0]?.id ?? ''));
      },
      () => alive && setTargets([]),
    );
    return () => {
      alive = false;
    };
  }, [api]);

  const folderError = kind !== 'zip' && !FOLDER_RE.test(folder) ? S.folderHint : undefined;
  const target = chosenTarget(kind, folder, targetId);
  const key = target ? JSON.stringify(target) : '';

  // Ask the Hub what this publish would do, again whenever the choice changes.
  useEffect(() => {
    if (!key) return;
    let alive = true;
    const t = JSON.parse(key) as SiteTarget;
    api.planSitePublish(site.id, { version, target: t }).then(
      (p) => alive && setPlan({ key, plan: p }),
      (err: unknown) => alive && setPlan({ key, error: refusalText(err, S.planFailed) }),
    );
    return () => {
      alive = false;
    };
  }, [api, site.id, version, key]);

  const current = plan && plan.key === key ? plan : null;
  const ready = current !== null && 'plan' in current && (current.plan.egress?.allowed ?? true);
  const rollback = latest !== null && version < latest;

  const submit = async () => {
    if (busy || !target || !ready) return;
    setBusy(true);
    setError(null);
    try {
      onPublished(await api.publishSite(site.id, { version, target, confirm: true }));
    } catch (err) {
      setError(refusalText(err, S.failed));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={S.title({ v: version })}
      description={
        <>
          {rollback && latest !== null ? `${S.rollback({ latest })} ` : ''}
          {kind === 'zip' ? S.zipUndo : S.undo}
        </>
      }
      onClose={onClose}
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
        <RadioGroup
          legend={S.to}
          name={`${formId}-target`}
          value={kind}
          onChange={(v) => setKind(v === 'zip' ? 'zip' : v === 'remote' ? 'remote' : 'folder')}
          options={[
            { value: 'folder', label: S.folder, description: S.folderHelp },
            { value: 'remote', label: S.remote, description: S.remoteHelp },
            { value: 'zip', label: S.zip, description: S.zipHelp },
          ]}
        />
        {kind === 'remote' ? (
          targets === null ? (
            <Spinner label={S.loadingTargets} />
          ) : targets.length === 0 ? (
            <p className="muted ws-flush">
              {S.noTargets}{' '}
              <a href={TARGETS_PATH} onClick={(e) => followLink(e, TARGETS_PATH)}>
                {S.addTarget}
              </a>
            </p>
          ) : (
            <SelectField
              label={S.target}
              value={targetId}
              onChange={setTargetId}
              options={targets.map((t) => ({ value: t.id, label: t.name }))}
            />
          )
        ) : null}
        {kind !== 'zip' ? (
          <TextField
            label={S.folderName}
            value={folder}
            maxLength={63}
            error={folderError}
            onChange={(e) => setFolder(e.target.value.trim())}
          />
        ) : null}

        {target ? (
          <section className="sites-plan" aria-label={S.planLabel} aria-live="polite">
            {!current ? (
              <Spinner label={S.planLoading} />
            ) : 'error' in current ? (
              <p className="nv-field-error" role="alert">
                {current.error}
              </p>
            ) : (
              <PlanSummary
                plan={current.plan}
                showFiles={showFiles}
                onToggleFiles={() => setShowFiles((v) => !v)}
              />
            )}
          </section>
        ) : null}

        {error ? (
          <p className="nv-field-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="nv-dialog-footer">
          <Button onClick={onClose}>{S.cancel}</Button>
          <Button type="submit" variant="primary" disabled={busy || !ready}>
            {busy ? <Spinner /> : null} {S.confirm({ v: version })}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function PlanSummary({
  plan,
  showFiles,
  onToggleFiles,
}: {
  plan: SitePublishPlanView;
  showFiles: boolean;
  onToggleFiles: () => void;
}) {
  const n = plan.files.length;
  const size = formatBytes(plan.size);
  const t = plan.target;
  return (
    <>
      {t.kind === 'folder' ? <p>{S.writes({ n, size })}</p> : null}
      {t.kind === 'remote' ? <p>{S.uploads({ n, size, name: plan.remote?.name ?? '' })}</p> : null}
      {t.kind === 'zip' ? <p>{S.zipFiles({ n, size })}</p> : null}
      {plan.location ? (
        <p>
          <code dir="ltr">{plan.location}</code>
        </p>
      ) : null}
      {plan.remote?.publicUrl ? (
        <p>
          {S.visitors}{' '}
          <a href={plan.remote.publicUrl} target="_blank" rel="noopener noreferrer" dir="ltr">
            {plan.remote.publicUrl}
          </a>
        </p>
      ) : null}
      {plan.live ? (
        <p>{S.live({ v: plan.live.version, ...targetArgs(plan.live.target, plan.live.remote) })}</p>
      ) : null}
      {plan.takesDown ? (
        <p>{S.takesDown(targetArgs(plan.takesDown.target, plan.takesDown.remote))}</p>
      ) : null}
      <p>{plan.reversible ? S.reversible : S.notReversible}</p>
      {plan.egress && !plan.egress.allowed ? (
        <p className="nv-field-error" role="alert">
          {S.egressDenied({ host: plan.egress.host, why: plan.egress.message ?? '' })}
        </p>
      ) : null}
      {n ? (
        <div>
          <Button variant="ghost" aria-expanded={showFiles} onClick={onToggleFiles}>
            {showFiles ? S.hideFiles : S.showFiles}
          </Button>
          {showFiles ? (
            <ul className="sites-files" aria-label={S.files}>
              {plan.files.map((f) => (
                <li key={f.path}>
                  <code dir="ltr">{f.path}</code>{' '}
                  <span className="muted">{formatBytes(f.size)}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
