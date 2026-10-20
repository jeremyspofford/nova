// The marketplace's Catalogs tab (FR-049; docs/14 §5 and §7 "Catalog", docs/08 §7, ADR-097 D2):
// every catalog with its kind, location, signature state, pinned key and commit, and how many items
// it has (or why it could not be read or was refused); adding a folder, web or Git catalog with the
// publisher key its index must be signed with and, for Git, a pinned commit; the trusted
// publishers (adding one is confirmed: its items then install as Verified); and the install rules
// (unverified items, which kinds). Every list is a Hub setting (`plugins.catalogs`,
// `plugins.trustedPublishers`, `market.allowSideload`, `market.allowedKinds`); managed policy locks
// them and says so with its source.
import { useState, type FormEvent } from 'react';
import type { MarketCatalogView, MarketItemKind } from '@nova/shared';
import { MARKET_KINDS } from '@nova/shared';
import { Button, Dialog, Spinner, TextField, useToast } from '@nova/ui';
import { useAnnounce } from '../services.tsx';
import { StateChip } from '../settings/badges.tsx';
import { SwitchField } from '../settings/controls.tsx';
import { useSettings } from '../settings.tsx';
import type { MarketApi } from './api-m8.ts';
import {
  CATALOG_KIND_TEXT,
  CATALOG_SIGNATURE_TEXT,
  CATALOG_TEXT,
  COMMIT_SHA,
  KIND_TEXT,
  PUBLISHER_KEY,
  isCatalogLocation,
  isGitLocation,
  marketErrorMessage,
  newCatalogId,
  marketPublisherText,
} from './format.ts';
import { ManagedNote } from '../managed/ManagedNote.tsx';
import { POLICY_TEXT, unverifiedForbidden, useRestrictions } from './policy.tsx';

const MAX_CATALOGS = 20;

export function CatalogsTab({
  catalogs,
  onChanged,
}: {
  market: MarketApi;
  catalogs: MarketCatalogView[] | null;
  onChanged: () => void;
}) {
  return (
    <div className="market-tab stack">
      <CatalogList catalogs={catalogs} onChanged={onChanged} />
      <Publishers />
      <InstallRules />
    </div>
  );
}

// ---- catalogs ---------------------------------------------------------------------------------

function CatalogList({
  catalogs,
  onChanged,
}: {
  catalogs: MarketCatalogView[] | null;
  onChanged: () => void;
}) {
  const settings = useSettings();
  const toast = useToast();
  const announce = useAnnounce();
  const entry = settings.get('plugins.catalogs');
  const mine = new Set(entry.value.map((c) => c.id));

  const save = (next: typeof entry.value, done: string) =>
    settings.set('plugins.catalogs', next).then(
      () => {
        toast.show(done, { tone: 'success' });
        announce(done);
        onChanged();
        return true;
      },
      (err: unknown) => {
        toast.show(marketErrorMessage(err, CATALOG_TEXT.saveFailed), { tone: 'error' });
        return false;
      },
    );

  return (
    <section className="settings-section" aria-labelledby="market-catalogs">
      <h3 id="market-catalogs">{CATALOG_TEXT.title}</h3>
      <p className="muted">{CATALOG_TEXT.intro}</p>
      {entry.locked ? <ManagedNote setting="plugins.catalogs" /> : null}
      {catalogs === null ? (
        <Spinner label={CATALOG_TEXT.loading} />
      ) : (
        <ul className="ws-list" aria-label={CATALOG_TEXT.title}>
          {catalogs.map((c) => {
            const sig = CATALOG_SIGNATURE_TEXT[c.signature];
            const own = mine.has(c.id);
            return (
              <li key={c.id} className="ws-list-row" aria-label={c.name}>
                <div className="ws-source-main">
                  <span className="ws-row-meta">
                    <strong dir="auto">{c.name}</strong>
                    <span>{CATALOG_KIND_TEXT[c.kind]}</span>
                    <StateChip text={sig.text} tone={sig.tone} icon={sig.icon} />
                    <span className="muted">{CATALOG_TEXT.items({ n: c.items })}</span>
                  </span>
                  <code className="ws-code-inline" dir="ltr">
                    {c.location}
                  </code>
                  {c.kind === 'builtin' ? (
                    <span className="muted">{CATALOG_TEXT.builtinNote}</span>
                  ) : null}
                  {c.publisher ? (
                    <span className="muted">{marketPublisherText(c.publisher)}</span>
                  ) : null}
                  {c.commit ? (
                    <span className="muted">
                      {CATALOG_TEXT.readAt({ commit: c.commit.slice(0, 12) })}
                    </span>
                  ) : null}
                  {c.error ? (
                    <span className="nv-field-error">
                      {CATALOG_TEXT.unreadable({ why: c.error })}
                    </span>
                  ) : null}
                </div>
                {own ? (
                  <Button
                    variant="ghost"
                    disabled={entry.locked}
                    aria-label={CATALOG_TEXT.remove({ name: c.name })}
                    onClick={() =>
                      void save(
                        entry.value.filter((x) => x.id !== c.id),
                        CATALOG_TEXT.removed({ name: c.name }),
                      )
                    }
                  >
                    {CATALOG_TEXT.removeButton}
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <AddCatalog
        disabled={entry.locked}
        taken={entry.value.map((c) => c.id)}
        full={entry.value.length >= MAX_CATALOGS}
        onAdd={(c) => save([...entry.value, c], CATALOG_TEXT.added({ name: c.name }))}
      />
    </section>
  );
}

function AddCatalog({
  disabled,
  taken,
  full,
  onAdd,
}: {
  disabled: boolean;
  taken: string[];
  full: boolean;
  onAdd: (c: {
    id: string;
    name: string;
    location: string;
    publisherKey?: string;
    commit?: string;
  }) => Promise<boolean>;
}) {
  const [name, setName] = useState('');
  const [location, setLocation] = useState('');
  const [key, setKey] = useState('');
  const [commit, setCommit] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    const loc = location.trim();
    const k = key.trim();
    const c = commit.trim().toLowerCase();
    const errs: Record<string, string> = {};
    if (!n) errs.name = CATALOG_TEXT.errName;
    if (!isCatalogLocation(loc)) errs.location = CATALOG_TEXT.errLocation;
    if (k && !PUBLISHER_KEY.test(k)) errs.key = CATALOG_TEXT.errKey;
    if (c && !COMMIT_SHA.test(c)) errs.commit = CATALOG_TEXT.errCommit;
    else if (c && !isGitLocation(loc)) errs.commit = CATALOG_TEXT.errCommitNotGit;
    if (full) errs.name = CATALOG_TEXT.errFull({ max: MAX_CATALOGS });
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    const ok = await onAdd({
      id: newCatalogId(n, taken),
      name: n,
      location: loc,
      ...(k ? { publisherKey: k } : {}),
      ...(c ? { commit: c } : {}),
    });
    setBusy(false);
    if (ok) {
      setName('');
      setLocation('');
      setKey('');
      setCommit('');
    }
  };

  return (
    <details className="ws-advanced">
      <summary>{CATALOG_TEXT.add}</summary>
      <form className="stack" onSubmit={(e) => void submit(e)} noValidate>
        <TextField
          label={CATALOG_TEXT.name}
          value={name}
          maxLength={100}
          disabled={disabled}
          error={errors.name}
          onChange={(e) => setName(e.target.value)}
        />
        <TextField
          label={CATALOG_TEXT.location}
          value={location}
          spellCheck={false}
          disabled={disabled}
          hint={CATALOG_TEXT.locationHint}
          error={errors.location}
          onChange={(e) => setLocation(e.target.value)}
        />
        <TextField
          label={CATALOG_TEXT.key}
          value={key}
          spellCheck={false}
          disabled={disabled}
          hint={CATALOG_TEXT.keyHint}
          error={errors.key}
          onChange={(e) => setKey(e.target.value)}
        />
        <TextField
          label={CATALOG_TEXT.commitLabel}
          value={commit}
          spellCheck={false}
          disabled={disabled}
          hint={CATALOG_TEXT.commitHint}
          error={errors.commit}
          onChange={(e) => setCommit(e.target.value)}
        />
        <div className="row">
          <Button type="submit" disabled={disabled || busy}>
            {CATALOG_TEXT.addButton}
          </Button>
        </div>
      </form>
    </details>
  );
}

// ---- trusted publishers -------------------------------------------------------------------------

function Publishers() {
  const settings = useSettings();
  const toast = useToast();
  const announce = useAnnounce();
  const entry = settings.get('plugins.trustedPublishers');
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState<{ name: string; key: string } | null>(null);
  const [removing, setRemoving] = useState<{ name: string; key: string } | null>(null);

  const save = (next: typeof entry.value, done: string) =>
    settings.set('plugins.trustedPublishers', next).then(
      () => {
        toast.show(done, { tone: 'success' });
        announce(done);
      },
      (err: unknown) =>
        toast.show(marketErrorMessage(err, CATALOG_TEXT.saveFailed), { tone: 'error' }),
    );

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    const k = key.trim();
    const errs: Record<string, string> = {};
    if (!n) errs.name = CATALOG_TEXT.errPublisherName;
    if (!PUBLISHER_KEY.test(k)) errs.key = CATALOG_TEXT.errKey;
    else if (entry.value.some((p) => p.key === k)) errs.key = CATALOG_TEXT.errPublisherDup;
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setConfirm({ name: n, key: k });
  };

  return (
    <section className="settings-section" aria-labelledby="market-publishers">
      <h3 id="market-publishers">{CATALOG_TEXT.publishers}</h3>
      <p className="muted">{CATALOG_TEXT.publishersIntro}</p>
      {entry.locked ? <ManagedNote setting="plugins.trustedPublishers" /> : null}
      {entry.value.length ? (
        <ul className="ws-list" aria-label={CATALOG_TEXT.publishers}>
          {entry.value.map((p) => (
            <li key={p.key} className="ws-list-row" aria-label={p.name}>
              <span className="ws-row-meta">
                <strong dir="auto">{p.name}</strong>
                <code className="ws-code-inline" dir="ltr">
                  {p.key}
                </code>
              </span>
              <Button
                variant="ghost"
                disabled={entry.locked}
                aria-label={CATALOG_TEXT.removePublisher({ name: p.name })}
                onClick={() => setRemoving(p)}
              >
                {CATALOG_TEXT.stopTrusting}
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">{CATALOG_TEXT.noPublishers}</p>
      )}
      <details className="ws-advanced">
        <summary>{CATALOG_TEXT.addPublisherSummary}</summary>
        <form className="stack" onSubmit={submit} noValidate>
          <TextField
            label={CATALOG_TEXT.publisherName}
            value={name}
            maxLength={100}
            disabled={entry.locked}
            error={errors.name}
            onChange={(e) => setName(e.target.value)}
          />
          <TextField
            label={CATALOG_TEXT.publisherKey}
            value={key}
            spellCheck={false}
            disabled={entry.locked}
            hint={CATALOG_TEXT.publisherKeyHint}
            error={errors.key}
            onChange={(e) => setKey(e.target.value)}
          />
          <div className="row">
            <Button type="submit" disabled={entry.locked}>
              {CATALOG_TEXT.addPublisher}
            </Button>
          </div>
        </form>
      </details>
      {confirm ? (
        <Dialog
          open
          title={CATALOG_TEXT.trustTitle({ name: confirm.name })}
          description={CATALOG_TEXT.trustBody}
          onClose={() => setConfirm(null)}
          footer={
            <>
              <Button onClick={() => setConfirm(null)}>{CATALOG_TEXT.cancel}</Button>
              <Button
                variant="primary"
                onClick={() => {
                  const c = confirm;
                  setConfirm(null);
                  void save(
                    [...entry.value, c],
                    CATALOG_TEXT.publisherAdded({ name: c.name }),
                  ).then(() => {
                    setName('');
                    setKey('');
                  });
                }}
              >
                {CATALOG_TEXT.trustConfirm}
              </Button>
            </>
          }
        >
          <dl className="ws-dl">
            <dt>{CATALOG_TEXT.publisherName}</dt>
            <dd dir="auto">{confirm.name}</dd>
            <dt>{CATALOG_TEXT.publisherKey}</dt>
            <dd>
              <code className="ws-code-inline" dir="ltr">
                {confirm.key}
              </code>
            </dd>
          </dl>
        </Dialog>
      ) : null}
      {removing ? (
        <Dialog
          open
          title={CATALOG_TEXT.untrustTitle({ name: removing.name })}
          description={CATALOG_TEXT.untrustBody}
          onClose={() => setRemoving(null)}
          footer={
            <>
              <Button onClick={() => setRemoving(null)}>{CATALOG_TEXT.cancel}</Button>
              <Button
                variant="danger"
                onClick={() => {
                  const r = removing;
                  setRemoving(null);
                  void save(
                    entry.value.filter((p) => p.key !== r.key),
                    CATALOG_TEXT.publisherRemoved({ name: r.name }),
                  );
                }}
              >
                {CATALOG_TEXT.stopTrusting}
              </Button>
            </>
          }
        />
      ) : null}
    </section>
  );
}

// ---- install rules ----------------------------------------------------------------------------

function InstallRules() {
  const settings = useSettings();
  const toast = useToast();
  const restrictions = useRestrictions();
  const sideload = settings.get('market.allowSideload');
  const kinds = settings.get('market.allowedKinds');
  const orgForbids = unverifiedForbidden(restrictions.layers);
  const failed = (err: unknown) =>
    toast.show(marketErrorMessage(err, CATALOG_TEXT.saveFailed), { tone: 'error' });

  const toggleKind = (k: MarketItemKind, on: boolean) => {
    const next = on
      ? MARKET_KINDS.filter((x) => x === k || kinds.value.includes(x))
      : kinds.value.filter((x) => x !== k);
    settings.set('market.allowedKinds', next).catch(failed);
  };

  return (
    <section className="settings-section" aria-labelledby="market-rules">
      <h3 id="market-rules">{CATALOG_TEXT.rules}</h3>
      <SwitchField
        label={CATALOG_TEXT.allowSideload}
        description={CATALOG_TEXT.allowSideloadHint}
        checked={sideload.value && !orgForbids}
        disabled={sideload.locked || orgForbids}
        onChange={(v) => {
          settings.set('market.allowSideload', v).catch(failed);
        }}
      />
      {sideload.locked ? <ManagedNote setting="market.allowSideload" /> : null}
      {orgForbids ? (
        <p className="ext-policy">
          <span>{POLICY_TEXT.unverifiedOff}</span>{' '}
          <ManagedNote setting="restrict.unverifiedInstalls" />
        </p>
      ) : null}
      <fieldset className="market-kinds">
        <legend className="nv-field-label">{CATALOG_TEXT.kinds}</legend>
        <p className="nv-field-hint">{CATALOG_TEXT.kindsHint}</p>
        <div className="ws-checks">
          {MARKET_KINDS.map((k) => (
            <label key={k} className="ws-check">
              <input
                type="checkbox"
                checked={kinds.value.includes(k)}
                disabled={kinds.locked}
                onChange={(e) => toggleKind(k, e.target.checked)}
              />
              <span>{KIND_TEXT[k].title}</span>
            </label>
          ))}
        </div>
        {kinds.locked ? <ManagedNote setting="market.allowedKinds" /> : null}
      </fieldset>
    </section>
  );
}
