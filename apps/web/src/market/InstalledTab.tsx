// The marketplace's Installed tab and Remove (FR-049; docs/14 §5): everything installed from a
// catalog, with its kind, version, Verified or Unverified, where it came from (the catalog, item,
// version and Git commit), what it can do, and Remove after a confirmation that says what goes.
// Removing the pet that is the companion turns the companion off.
import { useCallback, useEffect, useState } from 'react';
import type { MarketInstallView, MarketItemKind } from '@nova/shared';
import { Button, Dialog, EmptyState, Spinner, useToast } from '@nova/ui';
import { useHubStream } from '../hub-events.ts';
import { useAnnounce } from '../services.tsx';
import { VerifiedBadge } from '../settings/badges.tsx';
import { formatWhen } from '../settings/common.ts';
import { useSettings } from '../settings.tsx';
import type { MarketApi } from './api-m8.ts';
import { KIND_TEXT, MARKET_TEXT, marketErrorMessage } from './format.ts';
import { MarketPermissions } from './InstallDialog.tsx';

export interface RemoveTarget {
  kind: MarketItemKind;
  id: string;
  name: string;
}

const INSTALLED_EVENTS = ['market.installed', 'market.updated', 'market.removed'] as const;

export function InstalledTab({ market }: { market: MarketApi }) {
  const toast = useToast();
  const announce = useAnnounce();
  const [items, setItems] = useState<MarketInstallView[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const [removing, setRemoving] = useState<RemoveTarget | null>(null);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  useEffect(() => {
    let alive = true;
    market.listMarketInstalled().then(
      ({ items: list }) => {
        if (!alive) return;
        setItems(list);
        setError(null);
      },
      (err: unknown) => alive && setError(err),
    );
    return () => {
      alive = false;
    };
  }, [market, attempt]);
  useHubStream(INSTALLED_EVENTS, reload);

  let body;
  if (error)
    body = (
      <div role="alert" className="ws-error">
        <p>{marketErrorMessage(error, MARKET_TEXT.loadFailed)}</p>
        <Button onClick={reload}>{MARKET_TEXT.retry}</Button>
      </div>
    );
  else if (items === null) body = <Spinner label={MARKET_TEXT.loading} />;
  else if (items.length === 0) body = <EmptyState title={MARKET_TEXT.noneInstalled} level={3} />;
  else
    body = (
      <ul className="ws-list" aria-label={MARKET_TEXT.installedTab}>
        {items.map((it) => (
          <li
            key={`${it.kind}:${it.itemId}`}
            className="ws-card market-installed-row"
            aria-label={it.name}
          >
            <div className="ws-source-main">
              <span className="ws-row-meta">
                <strong>{it.name}</strong>
                <span>{KIND_TEXT[it.kind].one}</span>
                <span>{MARKET_TEXT.version(it.version)}</span>
                <VerifiedBadge verified={it.verified} />
              </span>
              <span className="muted">
                {MARKET_TEXT.from(it.origin)} · {formatWhen(it.updatedAt)}
              </span>
              <details className="ws-advanced">
                <summary>{MARKET_TEXT.canAccess}</summary>
                <MarketPermissions
                  lines={it.permissions}
                  label={`${MARKET_TEXT.canAccess}: ${it.name}`}
                />
              </details>
            </div>
            <Button
              variant="ghost"
              aria-label={MARKET_TEXT.removeOf(it.name)}
              onClick={() => setRemoving({ kind: it.kind, id: it.itemId, name: it.name })}
            >
              {MARKET_TEXT.remove}
            </Button>
          </li>
        ))}
      </ul>
    );

  return (
    <div className="market-tab">
      {body}
      {removing ? (
        <RemoveDialog
          market={market}
          target={removing}
          onClose={() => setRemoving(null)}
          onRemoved={() => {
            const msg = MARKET_TEXT.removed(removing.name);
            setRemoving(null);
            toast.show(msg, { tone: 'success' });
            announce(msg);
            reload();
          }}
        />
      ) : null}
    </div>
  );
}

/** Remove an installed item after saying what goes; a refusal stays in the dialog. */
export function RemoveDialog({
  market,
  target,
  onClose,
  onRemoved,
}: {
  market: MarketApi;
  target: RemoveTarget;
  onClose: () => void;
  onRemoved: () => void;
}) {
  const settings = useSettings();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      await market.removeMarketItem(target.kind, target.id);
    } catch (err) {
      setBusy(false);
      setError(marketErrorMessage(err, MARKET_TEXT.removeFailed));
      return;
    }
    // The removed pet was the companion: turn the companion off rather than leave it blank.
    const pet = settings.get('appearance.pet');
    if (target.kind === 'pet' && pet.value === `market:${target.id}` && !pet.locked)
      await settings.set('appearance.pet', 'off').catch(() => undefined);
    onRemoved();
  };
  return (
    <Dialog
      open
      title={MARKET_TEXT.removeTitle(target.name)}
      description={MARKET_TEXT.removeBody(target.kind)}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{MARKET_TEXT.cancel}</Button>
          <Button variant="danger" disabled={busy} onClick={() => void go()}>
            {busy ? <Spinner /> : null} {MARKET_TEXT.removeConfirm}
          </Button>
        </>
      }
    >
      {error ? (
        <p role="alert" className="nv-field-error">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}
