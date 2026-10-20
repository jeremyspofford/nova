// Changing what a site is built from (FR-037, M8): another space or an HTML or Markdown artifact.
// Before the change is saved the Hub builds from the new source without storing anything and
// compares the files with the latest version, so the user sees which pages appear, change or go.
// Saving changes only the source: nothing is rebuilt, and what is published stays until the next
// publish.
import { useEffect, useId, useState } from 'react';
import { defineMessages } from '@nova/i18n';
import type { SiteSource, SiteSourcePreviewView, SiteView, SpaceView } from '@nova/shared';
import { Button, Dialog, RadioGroup, SelectField, Spinner, TextField } from '@nova/ui';
import { formatBytes } from '../chat/attachments.ts';
import { useSpacesApi } from './api.ts';
import { refusalText } from './format.ts';

/** Changing a site's source. {label} is the source's name (data). */
export const SOURCE_TEXT = defineMessages('spaces.source', {
  title: 'Change the source',
  current: 'Built now from “{label}”.',
  currentGone: 'Built now from a source that is gone.',
  builtFrom: 'Build it from',
  space: 'A space',
  spaceHelp: 'Each page becomes a web page.',
  artifact: 'An artifact',
  artifactHelp: 'A document, web page or visualization from a chat.',
  spaceLabel: 'Space',
  loadingSpaces: 'Loading spaces',
  noSpaces: 'You have no spaces yet. Create one in Spaces first.',
  artifactLabel: 'Artifact id',
  artifactHint: 'Copy it from the artifact in the Library or a chat’s Artifacts panel.',
  preview: 'Preview the change',
  previewing: 'Building a preview',
  previewFailed: 'Could not preview the change.',
  same: 'That is the source it is built from now.',
  previewLabel: 'What changes',
  compared: 'Compared with version {v}, a build from the new source:',
  notBuilt: 'The site has no version yet. A build from the new source makes these files:',
  /** Items of a list after `compared`. */
  added: '{n, plural, one {adds # file} other {adds # files}}',
  changed: '{n, plural, one {changes # file} other {changes # files}}',
  removed: '{n, plural, one {removes # file} other {removes # files}}',
  unchanged: '{n, plural, one {keeps # file as it is} other {keeps # files as they are}}',
  scripts: 'Its preview may run the artifact’s own scripts, kept apart from Nova.',
  /** {size} is a size, such as "12 KB". */
  size: 'In all {size}.',
  change: { added: 'new', changed: 'changed', removed: 'removed', same: 'unchanged' },
  after:
    'Saving changes only the source. Build a new version to use it; what is published stays until you publish again.',
  files: 'Files',
  cancel: 'Cancel',
  save: 'Change the source',
  failed: 'Could not change the source.',
});
const S = SOURCE_TEXT;

export function ChangeSourceDialog({
  site,
  onClose,
  onSaved,
}: {
  site: SiteView;
  onClose: () => void;
  onSaved: (s: SiteView) => void;
}) {
  const api = useSpacesApi();
  const formId = useId();
  const [kind, setKind] = useState<SiteSource['kind']>(site.source.kind);
  const [spaces, setSpaces] = useState<SpaceView[] | null>(null);
  const [spaceId, setSpaceId] = useState(site.source.kind === 'space' ? site.source.spaceId : '');
  const [artifactId, setArtifactId] = useState(
    site.source.kind === 'artifact' ? site.source.artifactId : '',
  );
  const [preview, setPreview] = useState<
    { key: string; view: SiteSourcePreviewView } | { key: string; error: string } | null
  >(null);
  const [previewing, setPreviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
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
  }, [api]);

  const next: SiteSource | null =
    kind === 'space'
      ? spaceId
        ? { kind: 'space', spaceId }
        : null
      : artifactId.trim()
        ? { kind: 'artifact', artifactId: artifactId.trim() }
        : null;
  const key = next ? JSON.stringify(next) : '';
  const same = key === JSON.stringify(site.source);
  const shown = preview && preview.key === key ? preview : null;
  const canSave = !!shown && 'view' in shown && !same && !busy;

  const runPreview = () => {
    if (!next || same || previewing) return;
    setPreviewing(true);
    const k = key;
    api
      .previewSiteSource(site.id, { source: next })
      .then(
        (view) => setPreview({ key: k, view }),
        (err: unknown) => setPreview({ key: k, error: refusalText(err, S.previewFailed) }),
      )
      .finally(() => setPreviewing(false));
  };

  const save = async () => {
    if (!canSave || !next) return;
    setBusy(true);
    setError(null);
    try {
      onSaved(await api.updateSite(site.id, { source: next }));
    } catch (err) {
      setError(refusalText(err, S.failed));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={S.title}
      description={site.sourceLabel ? S.current({ label: site.sourceLabel }) : S.currentGone}
      onClose={onClose}
      className="ws-wide-dialog"
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
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
            label={S.artifactLabel}
            hint={S.artifactHint}
            value={artifactId}
            maxLength={100}
            dir="ltr"
            onChange={(e) => setArtifactId(e.target.value)}
          />
        )}
        <div className="spaces-actions">
          <Button onClick={runPreview} disabled={!next || same || previewing}>
            {previewing ? <Spinner /> : null} {S.preview}
          </Button>
          {same && next ? <span className="nv-field-hint">{S.same}</span> : null}
        </div>
        {shown ? (
          <section className="sites-plan" aria-label={S.previewLabel} aria-live="polite">
            {'error' in shown ? (
              <p className="nv-field-error" role="alert">
                {shown.error}
              </p>
            ) : (
              <PreviewSummary view={shown.view} />
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
          <Button type="submit" variant="primary" disabled={!canSave}>
            {busy ? <Spinner /> : null} {S.save}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function PreviewSummary({ view }: { view: SiteSourcePreviewView }) {
  const count = (c: keyof typeof S.change) => view.files.filter((f) => f.change === c).length;
  const counts = [
    count('added') ? S.added({ n: count('added') }) : null,
    count('changed') ? S.changed({ n: count('changed') }) : null,
    count('removed') ? S.removed({ n: count('removed') }) : null,
    count('same') ? S.unchanged({ n: count('same') }) : null,
  ].filter((x): x is string => x !== null);
  return (
    <>
      <p>{view.comparedWith === null ? S.notBuilt : S.compared({ v: view.comparedWith })}</p>
      {view.comparedWith !== null ? (
        <ul className="sites-plan-list">
          {counts.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      ) : null}
      <ul className="sites-files" aria-label={S.files}>
        {view.files.map((f) => (
          <li key={f.path}>
            <code dir="ltr">{f.path}</code> <span className="muted">{formatBytes(f.size)}</span>
            {view.comparedWith !== null ? (
              <span className="ws-badge sites-file-change" data-change={f.change}>
                {S.change[f.change]}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      <p>{S.size({ size: formatBytes(view.size) })}</p>
      {view.scripts ? <p>{S.scripts}</p> : null}
      <p className="muted">{S.after}</p>
    </>
  );
}
