// Settings → Managed policy (FR-106; docs/12 §10, docs/14 §1; ADR-097 D4) at /settings/managed:
// what your organization's policy applies on this Hub and where it comes from. How a setting is
// decided (defaults, then this Hub's settings, then the policy, which locks it); whether a policy
// is in force or failing closed; each source (the OS-protected policy file, the signed remote
// policy) with its status and why it is ignored, invalid, refused or unreachable; the
// restrictions in plain sentences; the settings it sets with their source; and the keys it does
// not apply, with why. Everyone sees it (the policy applies to everyone); only the owner can make
// the Hub read the policy again.
import { useEffect, useId, useState } from 'react';
import type { ManagedPolicyView } from '@nova/shared';
import { Button, Icon, Spinner } from '@nova/ui';
import { useHubStream } from '../hub-events.ts';
import { useServices } from '../services.tsx';
import { StateChip } from '../settings/badges.tsx';
import { formatWhen } from '../settings/common.ts';
import { useTeamRole } from '../team/role.tsx';
import { useManagedApi } from './api-m8.ts';
import {
  CHANNEL_LABEL,
  IGNORE_REASON,
  MANAGED_STRINGS as S,
  SOURCE_STATUS,
  derivedText,
  formatPolicyValue,
  isOwnerOnlyError,
  managedErrorMessage,
  restrictionLines,
  sourceStatusText,
} from './format.ts';
import { useManagedView } from './store.ts';
import '../workspace.css';
import './managed.css';

/** The same policy applies (timestamps aside): a reload that changed nothing says so. */
export function sameApplied(a: ManagedPolicyView, b: ManagedPolicyView): boolean {
  const strip = (v: ManagedPolicyView) => ({
    active: v.active,
    failClosed: v.failClosed,
    settings: v.settings,
    restrict: v.restrict,
    ignored: v.ignored,
    sources: v.sources.map(({ checkedAt: _c, loadedAt: _l, ...rest }) => rest),
  });
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
}

export function ManagedPolicyPage() {
  const { api } = useServices();
  const client = useManagedApi();
  const { isMember } = useTeamRole();
  const m = useManagedView(api);
  const { refresh, put } = m;
  const [reloading, setReloading] = useState(false);
  const [status, setStatus] = useState('');
  const [reloadError, setReloadError] = useState<string | null>(null);
  useHubStream(['managed.policy.changed'], () => void refresh());
  // The page reads the policy fresh when it opens (the shared view may be older).
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const reload = async () => {
    if (!client.reloadManagedPolicy) return;
    const before = m.view;
    setReloading(true);
    setReloadError(null);
    setStatus('');
    try {
      const view = await client.reloadManagedPolicy();
      put(view);
      setStatus(before && sameApplied(before, view) ? S.reloadedSame : S.reloaded);
    } catch (err) {
      setReloadError(managedErrorMessage(err, 'Could not check the policy.'));
    } finally {
      setReloading(false);
    }
  };

  const view = m.view;
  const hidden = !view && isOwnerOnlyError(m.error);
  return (
    <div className="settings-page">
      <h2>{S.title}</h2>
      <p className="muted">{S.intro}</p>
      <Precedence />
      {hidden ? (
        <div className="ws-callout" role="note">
          <Icon name="shield" />
          <p>{S.memberHidden}</p>
        </div>
      ) : null}
      {!view && !hidden && m.error ? (
        <div role="alert" className="ws-error">
          <p>{managedErrorMessage(m.error, S.loadError)}</p>
          <Button onClick={() => void refresh()}>Retry</Button>
        </div>
      ) : null}
      {!view && !m.error && m.supported ? <Spinner label="Loading the managed policy" /> : null}
      {!m.supported ? <p>{S.none}</p> : null}
      {view ? (
        <>
          <Summary view={view} />
          <div className="mg-actions">
            {isMember ? (
              <p className="muted">{S.ownerReloads}</p>
            ) : (
              <Button onClick={() => void reload()} disabled={reloading}>
                {reloading ? <Spinner /> : <Icon name="refresh" />}{' '}
                {reloading ? S.reloading : S.reload}
              </Button>
            )}
            <span className="muted">
              {S.checkedAt}: {formatWhen(view.checkedAt)}
            </span>
          </div>
          <p role="status" className="muted">
            {status}
          </p>
          {reloadError ? (
            <p role="alert" className="nv-field-error">
              {reloadError}
            </p>
          ) : null}
          <Sources view={view} />
          {view.active ? <Restrictions view={view} /> : null}
          {view.active ? <SettingsTable view={view} /> : null}
          {view.ignored.length ? <Ignored view={view} /> : null}
        </>
      ) : null}
    </div>
  );
}

function Precedence() {
  const id = useId();
  return (
    <section className="settings-section" aria-labelledby={id}>
      <h3 id={id}>{S.precedenceTitle}</h3>
      <ol className="mg-lines">
        {S.precedence.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ol>
      <p className="muted">{S.precedenceBoth}</p>
    </section>
  );
}

function Summary({ view }: { view: ManagedPolicyView }) {
  if (view.failClosed !== null)
    return (
      <div className="ws-callout mg-banner" data-tone="danger" role="note">
        <Icon name="alert" />
        <div className="stack">
          <p className="mg-strong">{S.failClosedTitle}</p>
          <p>{S.failClosed}</p>
          <p className="muted mg-detail">{view.failClosed}</p>
        </div>
      </div>
    );
  return (
    <div className="ws-callout" role="note">
      <Icon name={view.active ? 'shield' : 'check'} />
      <p>{view.active ? S.active : S.none}</p>
    </div>
  );
}

function Sources({ view }: { view: ManagedPolicyView }) {
  const id = useId();
  return (
    <section className="settings-section" aria-labelledby={id}>
      <h3 id={id}>{S.sourcesTitle}</h3>
      <ul className="mg-sources">
        {view.sources.map((s) => {
          const spec = SOURCE_STATUS[s.status];
          return (
            <li key={s.channel} className="mg-source">
              <div className="mg-source-head">
                <h4>{CHANNEL_LABEL[s.channel]}</h4>
                <StateChip text={spec.text} tone={spec.tone} icon={spec.icon} />
              </div>
              <p>{sourceStatusText(s)}</p>
              {s.inForce && s.cached ? <p className="muted">{S.inForceCached}</p> : null}
              {s.inForce && !s.cached && s.status !== 'active' ? (
                <p className="muted">{S.inForceLastGood}</p>
              ) : null}
              <dl className="ws-dl">
                <dt>{S.location}</dt>
                <dd>
                  <code className="mg-code">{s.location}</code>
                </dd>
                {s.serial !== null ? (
                  <>
                    <dt>{S.serial}</dt>
                    <dd>{s.serial}</dd>
                  </>
                ) : null}
                {s.loadedAt ? (
                  <>
                    <dt>{S.loadedAt}</dt>
                    <dd>{formatWhen(s.loadedAt)}</dd>
                  </>
                ) : null}
                <dt>{S.checkedAt}</dt>
                <dd>{formatWhen(s.checkedAt)}</dd>
              </dl>
              {s.testOverride ? <p className="muted">{S.testOverride}</p> : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Restrictions({ view }: { view: ManagedPolicyView }) {
  const id = useId();
  const groups = view.restrict
    .map((r) => ({ channel: r.channel, lines: restrictionLines(r.restrict) }))
    .filter((g) => g.lines.length);
  return (
    <section className="settings-section" aria-labelledby={id}>
      <h3 id={id}>{S.restrictTitle}</h3>
      {groups.length === 0 ? <p className="muted">{S.restrictNone}</p> : null}
      {groups.length > 1 ? <p className="muted">{S.restrictBoth}</p> : null}
      {groups.map((g) => (
        <div key={g.channel} className="mg-channel">
          {groups.length > 1 ? <h4>{CHANNEL_LABEL[g.channel]}</h4> : null}
          <ul className="mg-lines" aria-label={`${S.restrictTitle}: ${CHANNEL_LABEL[g.channel]}`}>
            {g.lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

function SettingsTable({ view }: { view: ManagedPolicyView }) {
  const id = useId();
  return (
    <section className="settings-section" aria-labelledby={id}>
      <h3 id={id}>{S.settingsTitle}</h3>
      {view.settings.length === 0 ? (
        <p className="muted">{S.settingsNone}</p>
      ) : (
        <div className="mg-table-wrap">
          <table className="ws-table">
            <caption className="nv-vh">{S.settingsCaption}</caption>
            <thead>
              <tr>
                <th scope="col">{S.colSetting}</th>
                <th scope="col">{S.colValue}</th>
                <th scope="col">{S.colSource}</th>
              </tr>
            </thead>
            <tbody>
              {view.settings.map((s) => (
                <tr key={s.key}>
                  <th scope="row">
                    <code className="mg-code">{s.key}</code>
                    {s.derivedFrom ? (
                      <span className="muted mg-detail"> {derivedText(s.derivedFrom)}</span>
                    ) : null}
                  </th>
                  <td>{formatPolicyValue(s.value)}</td>
                  <td>{CHANNEL_LABEL[s.channel]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Ignored({ view }: { view: ManagedPolicyView }) {
  const id = useId();
  return (
    <section className="settings-section" aria-labelledby={id}>
      <h3 id={id}>{S.ignoredTitle}</h3>
      <p className="muted">{S.ignoredIntro}</p>
      <div className="mg-table-wrap">
        <table className="ws-table">
          <caption className="nv-vh">{S.ignoredTitle}</caption>
          <thead>
            <tr>
              <th scope="col">{S.colSetting}</th>
              <th scope="col">{S.colSource}</th>
              <th scope="col">{S.colWhy}</th>
            </tr>
          </thead>
          <tbody>
            {view.ignored.map((i) => (
              <tr key={`${i.channel}:${i.key}`}>
                <th scope="row">
                  <code className="mg-code">{i.key}</code>
                </th>
                <td>{CHANNEL_LABEL[i.channel]}</td>
                <td>
                  {IGNORE_REASON[i.reason]}
                  {i.reason === 'invalid_value' ? (
                    <span className="muted mg-detail"> {i.message}</span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
