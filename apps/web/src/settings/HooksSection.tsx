// Hooks (FR-197, docs/04 §2.10, docs/08 §4.1): every hook from every source with its event,
// matcher, handler, status and last run. A hook runs only once trusted by the content hash shown
// here; if the hook changed after the list loaded, the Hub refuses the old hash (409) and the new
// definition is shown for review. Managed hooks are trusted by policy.
import { useEffect, useState } from 'react';
import { defineMessages } from '@nova/i18n';
import type { HookView } from '@nova/shared';
import { Button, Dialog, EmptyState, Icon, Spinner, Switch, useToast } from '@nova/ui';
import { ApiError, errorMessage } from '../api.ts';
import { useServices } from '../services.tsx';
import { StateChip } from './badges.tsx';
import { formatWhen } from './common.ts';
import {
  HOOK_CANNOT_TEXT,
  HOOK_CAN_TEXT,
  HOOK_EFFECT_TEXT,
  HOOK_EVENT_TEXT,
  HOOK_STATUS,
  formatSeconds,
  hookHandlerText,
  hookSourceText,
  shortHash,
} from './plugin-text.ts';
import { embed } from './embed.tsx';

export const HOOKS_TEXT = defineMessages('settings.hooks', {
  loadFailed: 'Could not load hooks.',
  changeFailed: 'Could not change {id}: {error}',
  untrusted: 'Trust for {id} revoked. It stopped at once.',
  untrustFailed: 'Could not revoke trust for {id}: {error}',
  title: 'Hooks',
  intro:
    'Hooks run a command or an MCP tool at moments such as before a tool call. A hook never ' +
    'runs until you trust it by its hash, and a changed hook needs your trust again.',
  retry: 'Retry',
  loading: 'Loading hooks',
  none: 'No hooks',
  noneHint: 'Hooks come from your hooks file, project folders and plugins.',
  matches: '· matches {matcher}',
  runs: 'Runs {handler}',
  timeout: 'timeout {time}',
  hash: 'Hash {hash}',
  changedSinceTrust: 'Changed since you trusted it',
  lastRun: 'Last run {when}: {effect}',
  notRun: 'Not run yet',
  turnOn: 'Turn on {id}',
  trustedByOrg: 'Trusted by your organization',
  untrustName: 'Untrust {id}',
  untrust: 'Untrust',
  trustName: 'Trust {id}',
  trustEllipsis: 'Trust…',
  trusted: '{id} is trusted. It runs from now on.',
  trustFailed: 'Could not trust the hook.',
  gone: 'This hook no longer exists.',
  reloadFailed: 'The hook changed and could not be reloaded.',
  trustTitle: 'Trust this hook?',
  trustSubtitle: '{id} · {status}',
  keepDisabled: 'Keep disabled',
  trust: 'Trust',
  changed:
    'This hook changed since it was shown. Check what it runs and its new hash, then trust it ' +
    'only if you still want it.',
  from: 'From',
  event: 'Event',
  runsLabel: 'Runs',
  sandboxed: '{handler} (sandboxed, timeout {time})',
  hashLabel: 'Hash',
  can: 'Can',
  cannot: 'Cannot',
});
const S = HOOKS_TEXT;

export function HooksSection({
  version,
  onTrustChanged,
}: {
  version: number;
  /** A hook was trusted or its trust revoked: a plugin's status depends on its hooks' trust. */
  onTrustChanged?: () => void;
}) {
  const { api } = useServices();
  const toast = useToast();
  const [hooks, setHooks] = useState<HookView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [trusting, setTrusting] = useState<HookView | null>(null);

  useEffect(() => {
    let alive = true;
    api.listHooks().then(
      ({ items }) => {
        if (!alive) return;
        setHooks(items);
        setError(null);
      },
      (err: unknown) => alive && setError(errorMessage(err, S.loadFailed)),
    );
    return () => {
      alive = false;
    };
  }, [api, version, reload]);

  const replace = (h: HookView) =>
    setHooks((list) => list?.map((x) => (x.id === h.id ? h : x)) ?? null);

  const toggle = async (h: HookView, on: boolean) => {
    try {
      replace(await api.updateHook(h.id, { enabled: on }));
    } catch (err) {
      toast.show(S.changeFailed({ id: h.id, error: errorMessage(err) }), { tone: 'error' });
    }
  };

  const untrust = async (h: HookView) => {
    try {
      replace(await api.untrustHook(h.id));
      onTrustChanged?.();
      toast.show(S.untrusted({ id: h.id }), { tone: 'success' });
    } catch (err) {
      toast.show(S.untrustFailed({ id: h.id, error: errorMessage(err) }), { tone: 'error' });
    }
  };

  return (
    <section className="settings-section" aria-labelledby="plugins-hooks">
      <h3 id="plugins-hooks">{S.title}</h3>
      <p className="muted">{S.intro}</p>
      {error ? (
        <div role="alert" className="ws-error">
          <p>{error}</p>
          <Button onClick={() => setReload((r) => r + 1)}>{S.retry}</Button>
        </div>
      ) : null}
      {hooks === null && !error ? <Spinner label={S.loading} /> : null}
      {hooks?.length === 0 ? (
        <EmptyState level={3} title={S.none} description={S.noneHint} />
      ) : null}
      {hooks?.length ? (
        <ul className="ws-list" aria-label={S.title}>
          {hooks.map((h) => {
            const s = HOOK_STATUS[h.status];
            const managed = h.source === 'managed';
            return (
              <li key={h.id} className="ws-list-row" aria-label={h.id}>
                <div className="ws-source-main">
                  <span className="ws-row-meta">
                    <strong>{h.id}</strong>
                    <StateChip {...s} />
                    <span className="muted">{hookSourceText(h)}</span>
                  </span>
                  <span className="ws-row-meta">
                    {HOOK_EVENT_TEXT[h.event]}
                    {h.matcher ? (
                      <span>
                        {embed(S.matches, {
                          matcher: (
                            <code className="ws-code-inline" dir="ltr">
                              {h.matcher}
                            </code>
                          ),
                        })}
                      </span>
                    ) : null}
                  </span>
                  <span className="ws-row-meta">
                    <span>
                      {embed(S.runs, {
                        handler: (
                          <code className="ws-code-inline" dir="ltr">
                            {hookHandlerText(h)}
                          </code>
                        ),
                      })}
                    </span>
                    <span className="muted">
                      {S.timeout({ time: formatSeconds(h.timeoutMs / 1000) })}
                    </span>
                  </span>
                  <span className="muted ws-row-meta">
                    <span title={h.contentHash}>{S.hash({ hash: shortHash(h.contentHash) })}</span>
                    {h.changedSinceTrust ? <span>{S.changedSinceTrust}</span> : null}
                    <span>
                      {h.lastRun
                        ? S.lastRun({
                            when: formatWhen(h.lastRun.at),
                            effect: HOOK_EFFECT_TEXT[h.lastRun.effect],
                          })
                        : S.notRun}
                    </span>
                  </span>
                </div>
                <div className="row ws-row-actions">
                  {h.source === 'user' ? (
                    <Switch
                      label={S.turnOn({ id: h.id })}
                      checked={h.enabled}
                      onChange={(v) => void toggle(h, v)}
                    />
                  ) : null}
                  {managed ? (
                    <span className="muted">{S.trustedByOrg}</span>
                  ) : h.status === 'trusted' ? (
                    <Button
                      variant="ghost"
                      aria-label={S.untrustName({ id: h.id })}
                      onClick={() => void untrust(h)}
                    >
                      {S.untrust}
                    </Button>
                  ) : (
                    <Button aria-label={S.trustName({ id: h.id })} onClick={() => setTrusting(h)}>
                      {S.trustEllipsis}
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
      {trusting ? (
        <TrustDialog
          hook={trusting}
          onClose={() => setTrusting(null)}
          onTrusted={(h) => {
            setTrusting(null);
            replace(h);
            onTrustChanged?.();
            toast.show(S.trusted({ id: h.id }), { tone: 'success' });
          }}
          onChanged={(list) => setHooks(list)}
        />
      ) : null}
    </section>
  );
}

function TrustDialog({
  hook: initial,
  onClose,
  onTrusted,
  onChanged,
}: {
  hook: HookView;
  onClose: () => void;
  onTrusted: (h: HookView) => void;
  /** The hooks list as reloaded after the hook changed under review. */
  onChanged: (list: HookView[]) => void;
}) {
  const { api } = useServices();
  const [hook, setHook] = useState(initial);
  const [changed, setChanged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const trust = async () => {
    setBusy(true);
    setError(null);
    try {
      onTrusted(await api.trustHook(hook.id, hook.contentHash));
    } catch (err) {
      setBusy(false);
      if (!(err instanceof ApiError && err.status === 409)) {
        setError(errorMessage(err, S.trustFailed));
        return;
      }
      // The definition changed since it was shown: show the new one; never trust it blindly.
      try {
        const { items } = await api.listHooks();
        onChanged(items);
        const next = items.find((h) => h.id === hook.id);
        if (!next) {
          setError(S.gone);
          return;
        }
        setHook(next);
        setChanged(true);
      } catch (e) {
        setError(errorMessage(e, S.reloadFailed));
      }
    }
  };

  return (
    <Dialog
      open
      title={S.trustTitle}
      description={S.trustSubtitle({ id: hook.id, status: HOOK_STATUS[hook.status].text })}
      onClose={onClose}
      className="ws-wide-dialog"
      footer={
        <>
          <Button onClick={onClose}>{S.keepDisabled}</Button>
          <Button variant="primary" disabled={busy} onClick={() => void trust()}>
            {busy ? <Spinner /> : null} {S.trust}
          </Button>
        </>
      }
    >
      <div className="stack">
        {changed ? (
          <p role="alert" className="ws-warning">
            <Icon name="alert" />
            <span>{S.changed}</span>
          </p>
        ) : null}
        <dl className="ws-dl">
          <dt>{S.from}</dt>
          <dd>{hookSourceText(hook)}</dd>
          <dt>{S.event}</dt>
          <dd>
            {HOOK_EVENT_TEXT[hook.event]}{' '}
            <code className="ws-code-inline" dir="ltr">
              {hook.event}
            </code>
            {hook.matcher ? (
              <>
                {' '}
                {embed(S.matches, {
                  matcher: (
                    <code className="ws-code-inline" dir="ltr">
                      {hook.matcher}
                    </code>
                  ),
                })}
              </>
            ) : null}
          </dd>
          <dt>{S.runsLabel}</dt>
          <dd>
            {embed(S.sandboxed, {
              handler: (
                <code className="ws-code-inline" dir="ltr">
                  {hookHandlerText(hook)}
                </code>
              ),
              time: formatSeconds(hook.timeoutMs / 1000),
            })}
          </dd>
          <dt>{S.hashLabel}</dt>
          <dd>
            <code className="ws-code-inline" data-testid="trust-hash">
              {hook.contentHash}
            </code>
          </dd>
          <dt>{S.can}</dt>
          <dd>{HOOK_CAN_TEXT[hook.event]}</dd>
          <dt>{S.cannot}</dt>
          <dd>{HOOK_CANNOT_TEXT}</dd>
        </dl>
        {error ? (
          <p role="alert" className="nv-field-error">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
