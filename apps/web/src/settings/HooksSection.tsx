// Hooks (FR-197, docs/04 §2.10, docs/08 §4.1): every hook from every source with its event,
// matcher, handler, status and last run. A hook runs only once trusted by the content hash shown
// here; if the hook changed after the list loaded, the Hub refuses the old hash (409) and the new
// definition is shown for review. Managed hooks are trusted by policy.
import { useEffect, useState } from 'react';
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

export function HooksSection({ version }: { version: number }) {
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
      (err: unknown) => alive && setError(errorMessage(err, 'Could not load hooks.')),
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
      toast.show(`Could not change ${h.id}: ${errorMessage(err)}`, { tone: 'error' });
    }
  };

  const untrust = async (h: HookView) => {
    try {
      replace(await api.untrustHook(h.id));
      toast.show(`Trust for ${h.id} revoked. It stopped at once.`, { tone: 'success' });
    } catch (err) {
      toast.show(`Could not revoke trust for ${h.id}: ${errorMessage(err)}`, { tone: 'error' });
    }
  };

  return (
    <section className="settings-section" aria-labelledby="plugins-hooks">
      <h3 id="plugins-hooks">Hooks</h3>
      <p className="muted">
        Hooks run a command or an MCP tool at moments such as before a tool call. A hook never runs
        until you trust it by its hash, and a changed hook needs your trust again.
      </p>
      {error ? (
        <div role="alert" className="ws-error">
          <p>{error}</p>
          <Button onClick={() => setReload((r) => r + 1)}>Retry</Button>
        </div>
      ) : null}
      {hooks === null && !error ? <Spinner label="Loading hooks" /> : null}
      {hooks?.length === 0 ? (
        <EmptyState
          level={3}
          title="No hooks"
          description="Hooks come from your hooks file, project folders and plugins."
        />
      ) : null}
      {hooks?.length ? (
        <ul className="ws-list" aria-label="Hooks">
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
                      <>
                        · matches <code className="ws-code-inline">{h.matcher}</code>
                      </>
                    ) : null}
                  </span>
                  <span className="ws-row-meta">
                    Runs <code className="ws-code-inline">{hookHandlerText(h)}</code>
                    <span className="muted">timeout {formatSeconds(h.timeoutMs / 1000)}</span>
                  </span>
                  <span className="muted ws-row-meta">
                    <span title={h.contentHash}>Hash {shortHash(h.contentHash)}</span>
                    {h.changedSinceTrust ? <span>Changed since you trusted it</span> : null}
                    <span>
                      {h.lastRun
                        ? `Last run ${formatWhen(h.lastRun.at)}: ${HOOK_EFFECT_TEXT[h.lastRun.effect]}`
                        : 'Not run yet'}
                    </span>
                  </span>
                </div>
                <div className="row ws-row-actions">
                  {h.source === 'user' ? (
                    <Switch
                      label={`Turn on ${h.id}`}
                      checked={h.enabled}
                      onChange={(v) => void toggle(h, v)}
                    />
                  ) : null}
                  {managed ? (
                    <span className="muted">Trusted by your organization</span>
                  ) : h.status === 'trusted' ? (
                    <Button
                      variant="ghost"
                      aria-label={`Untrust ${h.id}`}
                      onClick={() => void untrust(h)}
                    >
                      Untrust
                    </Button>
                  ) : (
                    <Button aria-label={`Trust ${h.id}`} onClick={() => setTrusting(h)}>
                      Trust…
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
            toast.show(`${h.id} is trusted. It runs from now on.`, { tone: 'success' });
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
        setError(errorMessage(err, 'Could not trust the hook.'));
        return;
      }
      // The definition changed since it was shown: show the new one; never trust it blindly.
      try {
        const { items } = await api.listHooks();
        onChanged(items);
        const next = items.find((h) => h.id === hook.id);
        if (!next) {
          setError('This hook no longer exists.');
          return;
        }
        setHook(next);
        setChanged(true);
      } catch (e) {
        setError(errorMessage(e, 'The hook changed and could not be reloaded.'));
      }
    }
  };

  return (
    <Dialog
      open
      title="Trust this hook?"
      description={`${hook.id} · ${HOOK_STATUS[hook.status].text}`}
      onClose={onClose}
      className="ws-wide-dialog"
      footer={
        <>
          <Button onClick={onClose}>Keep disabled</Button>
          <Button variant="primary" disabled={busy} onClick={() => void trust()}>
            {busy ? <Spinner /> : null} Trust
          </Button>
        </>
      }
    >
      <div className="stack">
        {changed ? (
          <p role="alert" className="ws-warning">
            <Icon name="alert" />
            <span>
              This hook changed since it was shown. Check what it runs and its new hash, then trust
              it only if you still want it.
            </span>
          </p>
        ) : null}
        <dl className="ws-dl">
          <dt>From</dt>
          <dd>{hookSourceText(hook)}</dd>
          <dt>Event</dt>
          <dd>
            {HOOK_EVENT_TEXT[hook.event]} <code className="ws-code-inline">{hook.event}</code>
            {hook.matcher ? (
              <>
                {' '}
                · matches <code className="ws-code-inline">{hook.matcher}</code>
              </>
            ) : null}
          </dd>
          <dt>Runs</dt>
          <dd>
            <code className="ws-code-inline">{hookHandlerText(hook)}</code> (sandboxed, timeout{' '}
            {formatSeconds(hook.timeoutMs / 1000)})
          </dd>
          <dt>Hash</dt>
          <dd>
            <code className="ws-code-inline" data-testid="trust-hash">
              {hook.contentHash}
            </code>
          </dd>
          <dt>Can</dt>
          <dd>{HOOK_CAN_TEXT[hook.event]}</dd>
          <dt>Cannot</dt>
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
